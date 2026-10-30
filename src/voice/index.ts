/**
 * "Hey Stephen" voice listener: wake word → speech-to-text → Claude Code headless (with this MCP server)
 * → spoken reply. Owned by the voice workstream; see docs/STEPHEN.md and docs/VOICE.md.
 *
 * Contract: `stephen listen [options]` calls runListen(argv) and exits with the returned code.
 * `stephen voice-setup` (or `stephen listen --setup`) calls runVoiceSetup(argv).
 * Config comes from loadConfig().voice — the raw "voice" section of config.json, validated here.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { LISTEN_USAGE, parseListenArgs } from './args.js';
import { Assistant, type CommandRunner } from './assistant.js';
import { MicrophoneSource, listInputDevices, resolveDeviceIndex, wavFileSource, type AudioSource } from './audio.js';
import {
  ClaudeRunner,
  buildClaudeArgs,
  mcpConfig,
  stephenCliBuilt,
  stephenCliPath,
  writeMcpConfig,
  type ClaudeOutcome,
  type ClaudeSettings,
  type SpawnFn,
} from './claude.js';
import { VoiceConfigError, parseVoiceConfig, type VoiceConfig } from './config.js';
import { SherpaSpotter, SherpaTranscriber, SherpaVad, writeKeywordsFile, type Spotter, type Transcriber, type Vad } from './engine.js';
import { Listener } from './listener.js';
import { ensureModels, modelPaths, modelsDir, requiredArchives, type Downloader, type ModelPaths } from './models.js';
import { AfplayChimes, SaySpeaker, silentChimes, silentSpeaker, type Chimes, type Speaker } from './speech.js';
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

export const FOLLOW_UP_IGNORED_NOTE =
  'Note: "voice.followUpWindowSec" is ignored in phase 1 — every voice command starts a fresh Claude session, ' +
  "because each one also starts a fresh Stephen server whose safety checks don't remember the earlier commands. " +
  'Follow-ups return in phase 3 (see docs/VOICE.md). You can remove the setting.';

export async function createEngines(paths: ModelPaths, cfg: VoiceConfig, workDir: string): Promise<Engines> {
  const spotter = new SherpaSpotter(paths, {
    wakePhrase: cfg.wakePhrase,
    stopPhrase: cfg.stopPhrase,
    threshold: cfg.keywordsThreshold,
    score: cfg.keywordsScore,
    workDir,
  });
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

async function setupModels(root: string, cfg: VoiceConfig, workDir: string, env: ListenEnv, out: (l: string) => void): Promise<ModelPaths> {
  const installed = await ensureModels(root, requiredArchives(cfg.asrModel), { log: out, download: env.download });
  const paths = modelPaths(root, cfg.asrModel);
  // Tokenize the configured phrases now, so a phrase the model can't spot fails here with a clear message.
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  writeKeywordsFile(paths, { wakePhrase: cfg.wakePhrase, stopPhrase: cfg.stopPhrase, threshold: cfg.keywordsThreshold, score: cfg.keywordsScore, workDir });
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
    await setupModels(root, loaded.cfg, join(loaded.home, 'voice'), env, out);
    out(`Models: ${root} (speech-to-text: ${loaded.cfg.asrModel}). Wake phrase "${loaded.cfg.wakePhrase}", stop phrase "${loaded.cfg.stopPhrase}".`);
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
  if (loaded.cfg.followUpWindowSec !== null) err(FOLLOW_UP_IGNORED_NOTE);
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
  const mcpConfigPath = await writeMcpConfig(voiceDir, process.execPath, cliPath);
  const settings: ClaudeSettings = { claudePath: cfg.claudePath, maxTurns: cfg.maxTurns, model: cfg.claudeModel, mcpConfigPath };
  if (args.dryRun) out(`MCP config (${mcpConfigPath}): ${JSON.stringify(mcpConfig(process.execPath, cliPath))}`);
  else if (!stephenCliBuilt(cliPath)) err(`Note: ${cliPath} does not exist yet — run \`npm run build\` first, or Claude can't start Stephen's tools.`);

  const claude = args.dryRun
    ? null
    : new ClaudeRunner({ ...settings, cwd: workDir, env: env.env, spawn: env.spawn, killGraceMs: env.killGraceMs });
  const runner: CommandRunner = claude ?? new DryRunRunner(settings, out);
  const speak = cfg.speak && !args.dryRun;
  const speaker = speak ? (env.speaker ?? new SaySpeaker(cfg.voice, cfg.rate, err)) : silentSpeaker;
  const chimes = cfg.chimes && !args.dryRun ? (env.chimes ?? new AfplayChimes()) : silentChimes;
  const assistant = new Assistant({ runner, speaker, chimes, speak, status: out });

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

    const root = env.modelsRoot ?? modelsDir(home);
    let engines: Engines;
    try {
      const paths = await setupModels(root, cfg, voiceDir, env, out);
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
        silenceSec: cfg.silenceSec,
        maxCommandSec: cfg.maxCommandSec,
        noSpeechTimeoutSec: cfg.noSpeechTimeoutSec,
        verifyWake: cfg.verifyWake,
        once: args.once,
        cooldownSec: cfg.cooldownSec,
      },
      { source, ...engines, assistant, chimes, status: out, onTranscript: env.onTranscript },
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
    if (signals) {
      process.off('SIGINT', onSigint);
      process.off('exit', onExit);
    }
  }
}
