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
import { AppConfigError, parseAppConfig, type AppConfig } from '../app/config.js';
import { AppServer, listenerQueue } from '../app/server.js';
import { appSettings } from '../app/settings.js';
import { configFilePath, loadConfig } from '../config.js';
import { HistoryConfigError, parseHistoryConfig, type HistoryConfig } from '../history/config.js';
import { HistoryStore } from '../history/store.js';
import { MemoryConfigError, parseMemoryConfig, type MemoryConfig } from '../memory/config.js';
import { MemoryStore } from '../memory/store.js';
import { AuditLog } from '../safety/audit.js';
import { DialogConfirmer } from '../safety/confirm.js';
import { newServeInstance, serveLockPath, sweepServeLocks } from '../server/instance.js';
import { toolLogPath } from '../server/tool-log.js';
import type { Confirmer } from '../types.js';
import { LISTEN_USAGE, parseListenArgs } from './args.js';
import { Assistant, type CommandReport, type CommandRunner, type Trust } from './assistant.js';
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
  type ServeInstance,
  type SpawnFn,
  type ClaudeFlagProbe,
  PERSONA_FILE,
  removePersonaFile,
  probeClaudeFlags,
  resolvePersonaFile,
} from './claude.js';
import { ToolLogRunner, historyRecorder } from './command-log.js';
import { Conversation, ConversationRunner, WarmConversationRunner, memoryKey } from './conversation.js';
import { WarmClaude, probeWarmProtocol, type WarmClaudeOptions } from './warm-claude.js';
import { claudeTranscriptDir, purgeTranscripts, removeSessionTranscript } from './transcripts.js';
import { DEFAULT_ASR_MODEL, VoiceConfigError, parseVoiceConfig, type AsrModelId, type VoiceConfig } from './config.js';
import { SherpaSpotter, SherpaTranscriber, SherpaVad, writeKeywordsFile, type Spotter, type Transcriber, type Vad } from './engine.js';
import { HELPER_HINT, HelperBridge, PTT_NEEDS_HELPER, assistantHooks, loadHelperClient, type HelperLink } from './helper-link.js';
import { Listener } from './listener.js';
import { MemoryRouter } from './memory-router.js';
import { ensureModels, modelPaths, modelsDir, requiredArchives, resolveAsrModel, type Downloader, type ModelPaths } from './models.js';
import { AfplayChimes, silentChimes, silentSpeaker, type Chimes, type Speaker } from './speech.js';
import { cleanTypedCommand } from './transcript.js';
import { ownerZone } from '../accounts/calendar.js';
import { accountsStatus } from '../app/accounts-status.js';
import { macNotify, macNotifyTitled, type NotifyFn, type NotifyTitledFn } from '../timers/notify.js';
import { TimerRouter } from '../timers/router.js';
import { TimerStore } from '../timers/store.js';
import { JobsConfigError, parseJobsConfig, type JobsConfig } from '../jobs/config.js';
import { appJobs } from './job-rows.js';
import { FinishWatcher } from '../jobs/finish.js';
import { JobManager } from '../jobs/manager.js';
import { purgeJobs } from '../jobs/state.js';
import { JobRouter } from '../jobs/router.js';
import { PhoneServer } from '../phone/server.js';
import { isPhoneOn } from '../phone/setup.js';
import type { SpawnFn as JobSpawnFn } from '../jobs/runner.js';

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
  loadConfig?: () => {
    home: string;
    voice: Record<string, unknown>;
    memory?: Record<string, unknown>;
    history?: Record<string, unknown>;
    app?: Record<string, unknown>;
    accounts?: Record<string, unknown>;
    jobs?: Record<string, unknown>;
    auditLogPath?: string;
  };
  /** Shown in the Stephen window's Settings (default: configFilePath()). */
  configPath?: string;
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
  /** Timer/reminder notification (tests); default: macOS notification. */
  notify?: (text: string) => void;
  /** Job-finished notification (tests); default: macOS notification with a title. */
  jobNotify?: NotifyTitledFn;
  /** Notices for phone requests (tests); default macOS notifications. */
  phoneNotify?: NotifyTitledFn;
  /** How often finished jobs are looked for, ms (tests); default 10 s. */
  jobPollMs?: number;
  /**
   * Stephen Helper (push-to-talk, Esc, audio.playing, menu-bar state): returns an un-started link, or null when
   * there is none. Default: the real client from src/helper/client.ts, loaded lazily (missing → null).
   */
  helper?: (home: string) => Promise<HelperLink | null> | HelperLink | null;
  /** Clock for the follow-up window (tests). */
  now?: () => number;
  /** Asks before a wake-word "remember …" and "forget everything" (default: a macOS dialog, Deny default, 120 s). */
  confirmer?: Confirmer;
  /** Clock for memory and history (tests). */
  date?: () => Date;
  /** Starts a job's supervisor (tests); default: `node dist/cli.js jobs _run <meta folder>`, detached. */
  jobSpawn?: JobSpawnFn;
}

/** How long the memory dialogs wait before they count as Deny. */
export const MEMORY_DIALOG_TIMEOUT_SEC = 120;

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

interface LoadedVoice {
  home: string;
  /** accounts.timeZone if valid, else the Mac's zone (timers, reminders). */
  timeZone: string;
  cfg: VoiceConfig;
  memory: MemoryConfig;
  history: HistoryConfig;
  app: AppConfig;
  jobs: JobsConfig;
  /** Raw "accounts" section (accounts.status). */
  accounts: unknown;
  auditLogPath: string | null;
}

function loadVoice(env: ListenEnv, err: (l: string) => void): LoadedVoice | null {
  try {
    const c = (env.loadConfig ?? loadConfig)();
    return {
      home: c.home,
      timeZone: ownerZone(typeof c.accounts?.timeZone === 'string' ? c.accounts.timeZone : undefined),
      cfg: parseVoiceConfig(c.voice),
      memory: parseMemoryConfig(c.memory),
      history: parseHistoryConfig(c.history),
      app: parseAppConfig(c.app),
      jobs: parseJobsConfig(c.jobs),
      accounts: c.accounts ?? {},
      auditLogPath: c.auditLogPath ?? null,
    };
  } catch (e) {
    const known = e instanceof VoiceConfigError || e instanceof MemoryConfigError || e instanceof HistoryConfigError || e instanceof AppConfigError || e instanceof JobsConfigError;
    err(known ? (e as Error).message : `Config: ${(e as Error).message}`);
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
  // Claude Code's own transcript of each voice session is deleted when the session is dropped and on history
  // purge/clear (review 5, R5-1).
  const transcripts = claudeTranscriptDir(workDir, env.env ?? process.env);
  const conversation = new Conversation({
    dir: voiceDir,
    windowSec: cfg.followUpWindowSec,
    log: err,
    now: env.now,
    onSessionDropped: (id) => void removeSessionTranscript(transcripts, id),
    // Memory changed anywhere (router, app, `stephen memory`, a hand edit) → don't resume (review 5, R5-2).
    memoryKey: () => memoryKey(memoryStore ? memoryStore.listSync().map((i) => i.text) : []),
  });
  // Always named, also with follow-ups off (window 0: deleted before and after every command), so a serve that Claude
  // Code restarts behind our back still starts with the taint (docs/REVIEW-7.md R7-1).
  const sessionStatePath = conversation.statePath;
  if (!conversation.enabled) conversation.end(); // window 0: no leftovers from an earlier setting
  // History: one entry per command; the tool log (names only) is only written when history is on.
  const history = new HistoryStore({
    home,
    retentionDays: loaded.history.retentionDays,
    now: env.date,
    onPurge: (olderThanMs) => void purgeTranscripts(transcripts, olderThanMs, conversation.current()),
  });
  if (!args.dryRun) history.purge(); // drop expired history (and old Claude transcripts) at start, not only on the next command (R5-6)
  const toolLog = history.enabled ? toolLogPath(home) : null;
  const mcpConfigPath = await writeMcpConfig(voiceDir, process.execPath, cliPath, sessionStatePath, toolLog);
  // A fresh `serve --instance` per Claude process (R7-1): the config is rewritten before each spawn (one Claude
  // process at a time: the next spawns only after the previous group is gone), and the runner checks the serve's lock.
  // A wake-word conversation's serve also gets `--trust wake` (R7-2: email shows only who and when).
  const serveInstance = async (trust: Trust): Promise<ServeInstance> => {
    const id = newServeInstance();
    return { id, lockPath: serveLockPath(home, id), mcpConfigPath: await writeMcpConfig(voiceDir, process.execPath, cliPath, sessionStatePath, toolLog, id, trust) };
  };
  if (!args.dryRun) sweepServeLocks(home, Date.now() - 24 * 3600_000); // file times are real time: left behind by a killed listener
  const settings: ClaudeSettings = {
    claudePath: cfg.claudePath,
    maxTurns: cfg.maxTurns,
    model: cfg.claudeModel,
    mcpConfigPath,
    followUps: conversation.enabled,
    aboutMe: cfg.aboutMe ?? null,
    ...(args.dryRun ? {} : { serveInstance }),
  };
  // Check once that this Claude Code knows our lock-down flags: required ones missing → refuse (update Claude Code);
  // optional ones (--no-chrome, --no-session-persistence) missing → leave them out instead of failing every command.
  let probe: ClaudeFlagProbe | null = null;
  if (!args.dryRun && !env.spawn) {
    probe = await probeClaudeFlags(cfg.claudePath);
    if (probe && !probe.ok) {
      err(`Your Claude Code is too old for Stephen's voice lock-down (missing ${probe.missing.join(', ')}). Update it (claude update) and try again.`);
      return 1;
    }
    if (probe?.ok && probe.unsupportedOptional.size) {
      settings.unsupportedOptionalFlags = probe.unsupportedOptional;
      err(`Note: this Claude Code doesn't know ${[...probe.unsupportedOptional].join(', ')}; running without them (update Claude Code for the faster lock-down).`);
    }
  }
  // Persona (+ aboutMe + memory) in a 0600 file instead of argv when this Claude Code takes the flag (voice.personaFile).
  if (resolvePersonaFile(cfg.personaFile, probe)) settings.personaFile = join(voiceDir, PERSONA_FILE);
  if (args.dryRun) out(`MCP config (${mcpConfigPath}): ${JSON.stringify(mcpConfig(process.execPath, cliPath, sessionStatePath, toolLog))}`);
  else if (!stephenCliBuilt(cliPath)) err(`Note: ${cliPath} does not exist yet — run \`npm run build\` first, or Claude can't start Stephen's tools.`);

  // Memory (memory.enabled): "remember …" / "forget …" are handled before Claude, and the saved texts reach Claude
  // through the persona, read fresh before every run.
  const audit = loaded.auditLogPath ? new AuditLog({ path: loaded.auditLogPath }) : null;
  const memoryStore = loaded.memory.enabled
    ? new MemoryStore({ home, maxItems: loaded.memory.maxItems, audit: audit ?? undefined, now: env.date })
    : null;
  // A dry run changes nothing: no memory commands (they would save), no history.
  const memoryRouter = memoryStore && !args.dryRun
    ? new MemoryRouter({
        store: memoryStore,
        confirmWakeWord: loaded.memory.confirmWakeWord,
        confirmer: env.confirmer ?? new DialogConfirmer({ timeoutSec: MEMORY_DIALOG_TIMEOUT_SEC }),
        now: env.date,
        log: err,
      })
    : null;
  const memoryTexts = memoryStore ? () => memoryStore.listSync().map((i) => i.text) : undefined;
  const claude = args.dryRun
    ? null
    : new ClaudeRunner({
        ...settings,
        cwd: workDir,
        env: env.env,
        spawn: env.spawn,
        killGraceMs: env.killGraceMs,
        onTiming: (t) => out(formatTiming(t)),
        memory: memoryTexts,
      });
  // Phase 3 (voice.warm, docs/ADR-003): the live listener keeps ONE warm Claude Code per conversation, started on the
  // wake word / F5. Checked once here; if the stream protocol doesn't answer, every command uses one claude -p as
  // before. `--text` (one command, follow-ups across processes) and `--dry-run` stay one-shot.
  let warm: WarmConversationRunner | null = null;
  if (claude && cfg.warm && args.text === null) {
    const warmOpts: WarmClaudeOptions = { ...settings, cwd: workDir, env: env.env, spawn: env.spawn, killGraceMs: env.killGraceMs, now: env.now };
    const why = await probeWarmProtocol(warmOpts);
    if (why) err(`Note: Claude Code's stream mode didn't answer (${why}); using one claude -p per command instead. Set "voice": {"warm": false} to skip this check.`);
    else {
      const memoryNow = (): readonly string[] => {
        try {
          return memoryTexts?.() ?? [];
        } catch {
          return [];
        }
      };
      warm = new WarmConversationRunner({
        conversation,
        start: (key, trust) => new WarmClaude(warmOpts, key, memoryNow(), trust),
        onTiming: (t) => out(formatTiming(t)),
        now: env.now,
        log: err,
      });
    }
  }
  // Dry runs never resume (nothing ran before them); real runs continue a conversation inside the follow-up window.
  const inner: CommandRunner | null = warm ?? (claude ? new ConversationRunner(claude, conversation) : null);
  const toolRunner = inner && toolLog ? new ToolLogRunner(inner, toolLog, err) : null;
  const runner: CommandRunner = toolRunner ?? inner ?? new DryRunRunner(settings, out);
  const recordHistory = args.dryRun ? undefined : historyRecorder(history, toolRunner ? () => toolRunner.tools() : null, err);
  // The Stephen window (app.sock): started once the listener exists; until then (and with --text) it stays null.
  let app: AppServer | null = null;
  let phone: PhoneServer | null = null;
  const onDone = (r: CommandReport) => {
    recordHistory?.(r);
    app?.commandDone(r, r.ranClaude && toolRunner ? toolRunner.tools().map((t) => t.tool) : []);
  };
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
  // Timers and reminders ("set a timer for 10 minutes", "remind me at 5 to …"): handled before Claude, fired by
  // this process while it listens. A dry run changes nothing.
  let alertTimers: (text: string) => void = () => undefined;
  const timerStore = args.dryRun ? null : new TimerStore({ home, now: env.now, log: err, onFire: (items) => alertTimers(timerRouter!.alertText(items)) });
  const timerRouter = timerStore
    ? new TimerRouter({
        store: timerStore,
        timeZone: loaded.timeZone,
        confirmer: env.confirmer ?? new DialogConfirmer({ timeoutSec: MEMORY_DIALOG_TIMEOUT_SEC }),
        ...(env.now ? { now: env.now } : {}),
      })
    : null;
  // Background jobs ("start a job to …", docs/ADR-004): handled before Claude, and every start asks in a native dialog.
  // A dry run changes nothing.
  const jobManager =
    args.dryRun || !loaded.jobs.enabled
      ? null
      : new JobManager({
          home,
          config: loaded.jobs,
          timeZone: loaded.timeZone,
          claudePath: cfg.claudePath,
          auditLogPath: loaded.auditLogPath,
          audit,
          env: env.env ?? process.env,
          cliPath,
          ...(env.jobSpawn ? { spawn: env.jobSpawn } : {}),
          ...(env.now ? { now: env.now } : {}),
        });
  if (jobManager) {
    try {
      purgeJobs(home, loaded.jobs.keepDays, env.now?.());
    } catch (e) {
      err(`Note: couldn't clear old job logs (${(e as Error).message}).`);
    }
  }
  const jobRouter = jobManager
    ? new JobRouter({
        jobs: jobManager,
        confirmer: env.confirmer ?? new DialogConfirmer({ timeoutSec: MEMORY_DIALOG_TIMEOUT_SEC }),
        print: out,
        ...(env.now ? { now: env.now } : {}),
      })
    : null;
  let finishWatcher: FinishWatcher | null = null;
  const makeAssistant = (bridge: HelperBridge | null) => {
    const hooks = assistantHooks(bridge);
    return new Assistant({
      runner,
      speaker,
      chimes,
      speak,
      status: out,
      memory: memoryRouter,
      timers: timerRouter,
      jobs: jobRouter,
      onDone,
      onStart: (c) => app?.heard(c.said, c.source),
      ...hooks,
      onPhase: (p) => {
        hooks.onPhase?.(p);
        if (p === 'running') app?.setState('working');
        else if (p === 'speaking') app?.setState('speaking');
      },
    });
  };
  const configPath = env.configPath ?? configFilePath(env.env ?? process.env);
  /** Serve <home>/run/app.sock for the Stephen window; null (with a note) when that isn't possible. */
  const startApp = async (l: Listener, a: Assistant, b: HelperBridge | null): Promise<AppServer | null> => {
    const server = new AppServer({
      home,
      queue: listenerQueue(l, a),
      listening: () => true,
      model: cfg.claudeModel ?? 'default',
      memory: memoryStore,
      endConversation: () => a.endConversation(),
      history,
      audit,
      settings: () => appSettings({ voice: cfg, memory: loaded.memory, history: loaded.history, app: loaded.app, configPath }),
      accounts: () => accountsStatus(loaded.accounts),
      ...(jobManager ? { jobs: appJobs(jobManager) } : {}),
      speakReplies: loaded.app.speakReplies && speak,
      openWindow: () => (b?.openWindow() ? null : "Stephen Helper isn't connected to stephen listen"),
      log: err,
    });
    try {
      await server.start();
    } catch (e) {
      err(`Note: the Stephen window can't connect to this listener (${(e as Error).message}).`);
      return null;
    }
    return server;
  };
  /**
   * Serve <home>/run/phone.sock for the phone bridge (docs/ADR-005): phone commands go through the same listener queue
   * as voice and typed ones, as source 'phone'. Requests are refused unless `stephen phone on`. null (with a note)
   * when the socket can't be made.
   */
  const startPhone = async (l: Listener, a: Assistant): Promise<PhoneServer | null> => {
    const server = new PhoneServer({
      home,
      isOn: () => isPhoneOn(home),
      ask: (text) => l.submit(() => a.command(text, { source: 'phone', raw: text, speak: false }))?.then((r) => r.reply) ?? null,
      ...(jobRouter ? { jobStatus: async () => (await jobRouter.route("how's the job going", { source: 'phone' }))?.reply ?? 'No jobs.' } : {}),
      audit,
      notify: env.phoneNotify ?? macNotifyTitled,
      log: err,
    });
    try {
      await server.start();
    } catch (e) {
      err(`Note: the phone link can't connect to this listener (${(e as Error).message}).`);
      return null;
    }
    return server;
  };
  let assistant = makeAssistant(null);
  let bridge: HelperBridge | null = null;
  let listener: Listener | null = null;
  let lastSigint = 0;
  const onSigint = () => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      claude?.killNow();
      warm?.killNow();
      process.exit(130);
    }
    lastSigint = now;
    if (listener ? listener.cancel('Ctrl-C') : assistant.cancel()) return;
    if (listener) {
      out('Bye.');
      listener.requestExit();
    } else {
      claude?.killNow();
      warm?.killNow();
      process.exit(130);
    }
  };
  const onExit = () => {
    claude?.killNow();
    warm?.killNow();
    app?.closeSync();
    phone?.closeSync();
    if (settings.personaFile) removePersonaFile(settings.personaFile);
  };
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
      const r = await assistant.handle(text, { source: 'cli', raw: text });
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
        longSilenceSec: cfg.longSilenceSec,
        continueSec: cfg.continueSec,
        maxCommandSec: cfg.maxCommandSec,
        noSpeechTimeoutSec: cfg.noSpeechTimeoutSec,
        verifyWake: cfg.verifyWake,
        once: args.once,
        cooldownSec: cfg.cooldownSec,
        wakeWord,
      },
      { source, ...engines, assistant, chimes, status: out, onTranscript: env.onTranscript, helper: bridge, onState: (s) => app?.setState(s) },
    );
    if (loaded.app.enabled) app = await startApp(listener, assistant, bridge);
    phone = await startPhone(listener, assistant);
    // Fire timers only while listening. The notification shows at once; the spoken alert waits in ONE queue until the
    // listener is idle (not recording, no command, nobody talking) and runs through listener.submit, so it counts as
    // busy while it speaks (review 6, R6-5). Gives up speaking after 10 minutes (the notification already showed).
    const notify: NotifyFn = env.notify ?? macNotify;
    const pending: string[] = [];
    let pumping = false;
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        const deadline = Date.now() + 10 * 60_000;
        while (pending.length && Date.now() < deadline) {
          const l = listener;
          const text = pending.join(' '); // read now: submit() runs the callback later, after pending is cleared
          const run = l ? l.submit(() => assistant.announce(text)) : null;
          if (run) {
            pending.length = 0;
            await run.catch(() => undefined);
          } else await new Promise((r) => setTimeout(r, 500));
        }
        pending.length = 0;
      } finally {
        pumping = false;
      }
    };
    alertTimers = (text) => {
      out(`Timer: ${text}`);
      notify(text);
      pending.push(text);
      void pump();
    };
    // A job that finished while you were away (or just now): a notification, then the spoken summary when idle. The
    // summary is the job's own words (cleaned, untrusted): shown and spoken only, never given to Claude.
    const jobNotify: NotifyTitledFn = env.jobNotify ?? macNotifyTitled;
    if (jobManager) {
      finishWatcher = new FinishWatcher({
        home,
        list: () => jobManager.list(),
        notify: jobNotify,
        say: (text) => {
          out(`Job: ${text}`);
          pending.push(text);
          void pump();
        },
        log: err,
        ...(env.now ? { now: env.now } : {}),
        ...(env.jobPollMs ? { pollMs: env.jobPollMs } : {}),
      });
      finishWatcher.start();
    }
    timerStore?.start();
    const keys = env.keys ?? (signals ? watchEnterKey : null);
    const current = listener;
    const unwatch = keys ? keys(() => void current.rearm()) : () => undefined;
    try {
      return await listener.run();
    } finally {
      unwatch();
    }
  } finally {
    timerStore?.stop();
    finishWatcher?.stop();
    await warm?.shutdown(); // listener exit ends the conversation: kill → close → reset
    if (settings.personaFile) removePersonaFile(settings.personaFile);
    await app?.close();
    app = null;
    await phone?.close();
    phone = null;
    bridge?.close();
    if (signals) {
      process.off('SIGINT', onSigint);
      process.off('exit', onExit);
    }
  }
}
