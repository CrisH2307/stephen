/**
 * "Hey Stephen" voice listener: wake word → speech-to-text → Claude Code headless (with this MCP server)
 * → spoken reply. Owned by the voice workstream; see docs/STEPHEN.md and docs/VOICE.md.
 *
 * Contract: `stephen listen [options]` calls runListen(argv) and exits with the returned code.
 * `stephen voice-setup` (or `stephen listen --setup`) calls runVoiceSetup(argv).
 * Config comes from loadConfig().voice — the raw "voice" section of config.json, validated here.
 */
import { createTts } from './tts/index.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { LISTEN_USAGE, parseListenArgs } from './args.js';
import { Assistant, type CommandRunner } from './assistant.js';
import { MicrophoneSource, listInputDevices, resolveDeviceIndex, wavFileSource, type AudioSource } from './audio.js';
import {
  ClaudeRunner,
  buildClaudeArgs,
  formatTiming,
  mcpConfig,
  stephenCliBuilt,
  stephenCliPath,
  writeMcpConfig,
  type ClaudeOutcome,
  type ClaudeSettings,
  type SpawnFn,
  probeClaudeFlags,
} from './claude.js';
import { Conversation, ConversationRunner } from './conversation.js';
import { DEFAULT_ASR_MODEL, VoiceConfigError, parseVoiceConfig, type AsrModelId, type VoiceConfig } from './config.js';
import { SherpaSpotter, SherpaTranscriber, SherpaVad, writeKeywordsFile, type Spotter, type Transcriber, type Vad } from './engine.js';
import { HELPER_HINT, HelperBridge, PTT_NEEDS_HELPER, assistantHooks, loadHelperClient, type HelperLink } from './helper-link.js';
import { Listener } from './listener.js';
import { ensureModels, modelPaths, modelsDir, requiredArchives, resolveAsrModel, type Downloader, type ModelPaths } from './models.js';
import { AfplayChimes, silentChimes, silentSpeaker, type Chimes, type Speaker } from './speech.js';
import { cleanTypedCommand } from './transcript.js';

export { LISTEN_USAGE } from './args.js';

export const MIC_PERMISSION_HINT =
  'The microphone is sending pure silence. On macOS that usually means your terminal app has no Microphone ' +
  'permission: System Settings → Privacy & Security → Microphone → turn on your terminal (Terminal, iTerm…), then restart it.';

export interface Engines {
  spotter: Spotter;
  vad: Vad;
  transcriber: Transcriber;
}

/** Everything runListen touches outside itself — injectable for tests. */
export interface ListenEnv {
  loadConfig?: () => { home: string; voice: Record<string, unknown> };
  out?: (line: string) => void;
  err?: (line: string) => void;
  speaker?: Speaker;
  chimes?: Chimes;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  source?: AudioSource;
  engines?: (paths: ModelPaths, cfg: VoiceConfig, workDir: string) => Promise<Engines>;
  download?: Downloader;
  /** Models folder (default <home>/models). */
  modelsRoot?: string;
  /** Path of dist/cli.js for the MCP config (default: this install's). */
  cliPath?: string;
  /** Install SIGINT/exit handlers (default true). */
  signals?: boolean;
  onTranscript?: (raw: string, command: string, ms: number) => void;
  killGraceMs?: number;
  /**
   * Calls `onEnter` when the user presses Enter (re-arms the wake word during the post-command cooldown);
   * returns an unsubscribe function. Default: watch stdin when it is a terminal and `signals` is on.
   */
  keys?: (onEnter: () => void) => () => void;
  /**
   * Stephen Helper (push-to-talk, Esc, audio.playing, menu-bar state): returns an un-started link, or null when
   * there is none. Default: the real client from src/helper/client.ts, loaded lazily (missing → null).
   */
  helper?: (home: string) => Promise<HelperLink | null> | HelperLink | null;
  /** Clock for the follow-up window (tests). */
  now?: () => number;
}

/** Start the helper link; null when unavailable (never throws). */
async function connectHelper(env: ListenEnv, home: string): Promise<{ bridge: HelperBridge } | { reason: string }> {
  let link: HelperLink | null;
  try {
    link = await (env.helper ?? loadHelperClient)(home);
  } catch (e) {
    return { reason: (e as Error).message };
  }
  if (!link) return { reason: 'Stephen Helper is not installed' };
  return HelperBridge.connect(link);
}

/** Enter on a terminal stdin (line mode, so Ctrl-C still raises SIGINT). No-op when stdin isn't a terminal. */
export function watchEnterKey(onEnter: () => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => undefined;
  const onData = () => onEnter();
  stdin.on('data', onData);
  stdin.resume();
  return () => {
    stdin.off('data', onData);
    stdin.pause(); // let the process exit once listening ends
  };
}

function spotterOptions(cfg: VoiceConfig, workDir: string) {
  return {
    wakePhrases: cfg.wakePhrases,
    stopPhrase: cfg.stopPhrase,
    threshold: cfg.keywordsThreshold,
    bareThreshold: cfg.bareWakeThreshold,
    score: cfg.keywordsScore,
    workDir,
  };
}

export async function createEngines(paths: ModelPaths, cfg: VoiceConfig, workDir: string): Promise<Engines> {
  const spotter = new SherpaSpotter(paths, spotterOptions(cfg, workDir));
  const vad = new SherpaVad(paths.vad, cfg.silenceSec);
  const transcriber = await SherpaTranscriber.create(paths);
  return { spotter, vad, transcriber };
}

/** `--dry-run`: print the exact claude argv instead of running it. */
class DryRunRunner implements CommandRunner {
  constructor(
    private readonly settings: ClaudeSettings,
    private readonly out: (line: string) => void,
  ) {}
  async run(prompt: string): Promise<ClaudeOutcome> {
    const argv = [this.settings.claudePath, ...buildClaudeArgs(prompt, this.settings)];
    this.out(`claude argv (dry run): ${JSON.stringify(argv)}`);
    return { kind: 'ok', text: 'Dry run: Claude was not started.', sessionId: null, costUsd: null, turns: null };
  }
  cancel(): boolean {
    return false;
  }
}

function loadVoice(env: ListenEnv, err: (l: string) => void): { home: string; cfg: VoiceConfig } | null {
  try {
    const c = (env.loadConfig ?? loadConfig)();
    return { home: c.home, cfg: parseVoiceConfig(c.voice) };
  } catch (e) {
    err(e instanceof VoiceConfigError ? e.message : `Config: ${(e as Error).message}`);
    return null;
  }
}

async function setupModels(
  root: string,
  cfg: VoiceConfig,
  asr: AsrModelId,
  workDir: string,
  env: ListenEnv,
  out: (l: string) => void,
): Promise<ModelPaths> {
  const installed = await ensureModels(root, requiredArchives(asr), { log: out, download: env.download });
  const paths = modelPaths(root, asr);
  // Tokenize the configured phrases now, so a phrase the model can't spot fails here with a clear message.
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  writeKeywordsFile(paths, spotterOptions(cfg, workDir));
  if (installed.length) out(`Speech models ready in ${root}.`);
  return paths;
}

/** `stephen voice-setup`: download + verify + extract the speech models (never re-downloads). */
export async function runVoiceSetup(argv: string[], env: ListenEnv = {}): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const err = env.err ?? ((l: string) => console.error(l));
  if (argv.includes('--help') || argv.includes('-h')) {
    out('stephen voice-setup   Download the "Hey Stephen" speech models (wake word, VAD, speech-to-text) into <stephen home>/models');
    return 0;
  }
  if (argv.length) {
    err(`Unknown option "${argv[0]}". Usage: stephen voice-setup`);
    return 2;
  }
  const loaded = loadVoice(env, err);
  if (!loaded) return 2;
  const root = env.modelsRoot ?? modelsDir(loaded.home);
  try {
    const asr = loaded.cfg.asrModel ?? DEFAULT_ASR_MODEL;
    await setupModels(root, loaded.cfg, asr, join(loaded.home, 'voice'), env, out);
    const wakes = loaded.cfg.wakePhrases.map((p) => `"${p}"`).join(', ');
    out(`Models: ${root} (speech-to-text: ${asr}). Wake phrases ${wakes}; stop phrase "${loaded.cfg.stopPhrase}".`);
    out('Next: `stephen listen` (allow Microphone access for your terminal app when macOS asks).');
    return 0;
  } catch (e) {
    err(`voice-setup failed: ${(e as Error).message}`);
    return 1;
  }
}

export async function runListen(argv: string[], env: ListenEnv = {}): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const err = env.err ?? ((l: string) => console.error(l));
  const args = parseListenArgs(argv);
  if ('error' in args) {
    err(`${args.error}\n\n${LISTEN_USAGE}`);
    return 2;
  }
  if (args.help) {
    out(LISTEN_USAGE);
    return 0;
  }
  if (args.setup) return runVoiceSetup([], env);
  const loaded = loadVoice(env, err);
  if (!loaded) return 2;
  const { home } = loaded;
  const cfg: VoiceConfig = {
    ...loaded.cfg,
    device: args.device ?? loaded.cfg.device,
    speak: args.speak ?? loaded.cfg.speak,
    chimes: args.chimes ?? loaded.cfg.chimes,
  };

  if (args.listDevices) {
    try {
      const devices = listInputDevices();
      if (!devices.length) out('No microphones found.');
      devices.forEach((d, i) => out(`${i}: ${d}`));
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }

  const voiceDir = join(home, 'voice');
  const workDir = join(voiceDir, 'workdir');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const cliPath = env.cliPath ?? stephenCliPath();
  // Follow-ups: one constant gate-state path for every server (the Conversation deletes it when a conversation ends).
  const conversation = new Conversation({ dir: voiceDir, windowSec: cfg.followUpWindowSec, log: err, now: env.now });
  const sessionStatePath = conversation.enabled ? conversation.statePath : null;
  if (!conversation.enabled) conversation.end(); // window 0: no leftovers from an earlier setting
  const mcpConfigPath = await writeMcpConfig(voiceDir, process.execPath, cliPath, sessionStatePath);
  const settings: ClaudeSettings = {
    claudePath: cfg.claudePath,
    maxTurns: cfg.maxTurns,
    model: cfg.claudeModel,
    mcpConfigPath,
    followUps: conversation.enabled,
  };
  // Check once that this Claude Code knows our lock-down flags: required ones missing → refuse (update Claude Code);
  // optional ones (--no-chrome, --no-session-persistence) missing → leave them out instead of failing every command.
  if (!args.dryRun && !env.spawn) {
    const probe = await probeClaudeFlags(cfg.claudePath);
    if (probe && !probe.ok) {
      err(`Your Claude Code is too old for Stephen's voice lock-down (missing ${probe.missing.join(', ')}). Update it (claude update) and try again.`);
      return 1;
    }
    if (probe?.ok && probe.unsupportedOptional.size) {
      settings.unsupportedOptionalFlags = probe.unsupportedOptional;
      err(`Note: this Claude Code doesn't know ${[...probe.unsupportedOptional].join(', ')}; running without them (update Claude Code for the faster lock-down).`);
    }
  }
  if (args.dryRun) out(`MCP config (${mcpConfigPath}): ${JSON.stringify(mcpConfig(process.execPath, cliPath, sessionStatePath))}`);
  else if (!stephenCliBuilt(cliPath)) err(`Note: ${cliPath} does not exist yet — run \`npm run build\` first, or Claude can't start Stephen's tools.`);

  const claude = args.dryRun
    ? null
    : new ClaudeRunner({ ...settings, cwd: workDir, env: env.env, spawn: env.spawn, killGraceMs: env.killGraceMs, onTiming: (t) => out(formatTiming(t)) });
  // Dry runs never resume (nothing ran before them); real runs continue a conversation inside the follow-up window.
  const runner: CommandRunner = claude ? new ConversationRunner(claude, conversation) : new DryRunRunner(settings, out);
  const speak = cfg.speak && !args.dryRun;
  // Voice output: ElevenLabs → Kokoro → say fallback chain (src/voice/tts). Tests inject env.speaker.
  let speaker: Speaker = silentSpeaker;
  if (speak) {
    if (env.speaker) speaker = env.speaker;
    else {
      const tts = createTts(cfg, { home, log: err });
      void tts.warm().catch(() => {});
      speaker = tts;
    }
  }
  const chimes = cfg.chimes && !args.dryRun ? (env.chimes ?? new AfplayChimes()) : silentChimes;
  const makeAssistant = (bridge: HelperBridge | null) => new Assistant({ runner, speaker, chimes, speak, status: out, ...assistantHooks(bridge) });
  let assistant = makeAssistant(null);
  let bridge: HelperBridge | null = null;
  let listener: Listener | null = null;
  let lastSigint = 0;
  const onSigint = () => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      claude?.killNow();
      process.exit(130);
    }
    lastSigint = now;
    if (listener ? listener.cancel('Ctrl-C') : assistant.cancel()) return;
    if (listener) {
      out('Bye.');
      listener.requestExit();
    } else {
      claude?.killNow();
      process.exit(130);
    }
  };
  const onExit = () => claude?.killNow();
  const signals = env.signals ?? true;
  if (signals) {
    process.on('SIGINT', onSigint);
    process.on('exit', onExit);
  }
  try {
    if (args.text !== null) {
      const text = cleanTypedCommand(args.text);
      if (!text) {
        err('--text is empty.');
        return 2;
      }
      out(`Heard: "${text}"`);
      const r = await assistant.handle(text);
      return r === 'ok' ? 0 : 1;
    }

    // Stephen Helper: push-to-talk, Esc, menu-bar state, and "is the Mac playing sound?". Not with --wav (a file
    // has no keyboard) or --no-helper; without it the wake word falls back to the fixed cooldown.
    const wakeWord = cfg.wakeWord && !args.pttOnly;
    const wantHelper = !args.noHelper && !(args.wav && !env.source);
    if (wantHelper) {
      const h = await connectHelper(env, home);
      if ('bridge' in h) bridge = h.bridge;
      else if (!wakeWord) {
        err(`${PTT_NEEDS_HELPER} (${h.reason})`);
        return 1;
      }
    }
    if (!bridge) {
      if (!wakeWord) {
        err(PTT_NEEDS_HELPER);
        return 1;
      }
      if (!args.noHelper && !args.wav) out(HELPER_HINT);
    }
    assistant = makeAssistant(bridge);

    const root = env.modelsRoot ?? modelsDir(home);
    let engines: Engines;
    try {
      const asr = await resolveAsrModel(root, cfg.asrModel);
      if (asr.note) out(asr.note);
      const paths = await setupModels(root, cfg, asr.id, voiceDir, env, out);
      engines = await (env.engines ?? createEngines)(paths, cfg, voiceDir);
    } catch (e) {
      err(`Could not start the speech engine: ${(e as Error).message}`);
      return 1;
    }
    let source: AudioSource;
    try {
      source = env.source ?? (args.wav ? await wavFileSource(args.wav) : new MicrophoneSource(resolveDeviceIndex(cfg.device, listInputDevices()), () => err(MIC_PERMISSION_HINT)));
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    listener = new Listener(
      {
        wakePhrase: cfg.wakePhrase,
        wakePhrases: cfg.wakePhrases,
        stopPhrase: cfg.stopPhrase,
        silenceSec: cfg.silenceSec,
        maxCommandSec: cfg.maxCommandSec,
        noSpeechTimeoutSec: cfg.noSpeechTimeoutSec,
        verifyWake: cfg.verifyWake,
        once: args.once,
        cooldownSec: cfg.cooldownSec,
        wakeWord,
      },
      { source, ...engines, assistant, chimes, status: out, onTranscript: env.onTranscript, helper: bridge },
    );
    const keys = env.keys ?? (signals ? watchEnterKey : null);
    const live = listener;
    const unwatch = keys ? keys(() => void live.rearm()) : () => undefined;
    try {
      return await listener.run();
    } finally {
      unwatch();
    }
  } finally {
    bridge?.close();
    if (signals) {
      process.off('SIGINT', onSigint);
      process.off('exit', onExit);
    }
  }
}
