/**
 * Follow-up conversations: "Hey Stephen, how long to TMU station?" … "Hey Stephen, what about by car?".
 *
 * A conversation = commands that each start within `voice.followUpWindowSec` of the previous command's END (default
 * 180 s; 0 = every command is fresh). Inside one, the next `claude -p` gets `--resume <session id>` (from the
 * previous run's JSON result) and its Stephen server shares the gate's memory through
 * `<home>/voice/conversation-state.json` (`serve --session-state`). The conversation ENDS — the state file is
 * deleted and the session id forgotten, before anything else runs — when the window expired, the previous run
 * errored or was cancelled, or the user pressed Esc / said "Stephen stop". So Claude's memory and the gate's memory
 * live and die together (see buildClaudeArgs in claude.ts for why that matters).
 *
 * The session id and end time are kept in `<home>/voice/conversation.json` (0600, atomic), so `stephen listen
 * --text` follow-ups work across processes too.
 *
 * Trust follows the conversation (docs/REVIEW-7.md R7-2): the file also names the trust the conversation was started
 * with (`trusted` or `wake`), and a command of another trust never resumes it: it starts a fresh conversation (reset
 * first). So a wake-word command never sees what an F5 command read, and its words never become turns an F5
 * conversation inherits. A file without a trust is never resumed.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_STATE_FILE, readPrivateJsonFile, removeSessionStateFile, writePrivateJsonFileSync } from '../safety/session-state.js';
import type { CommandRunner, RunHooks, Trust } from './assistant.js';
import { SESSION_ID_RE, type ClaudeOutcome, type ClaudeTiming, type RunOptions } from './claude.js';
import type { WarmProcess } from './warm-claude.js';

export const CONVERSATION_FILE = 'conversation.json';
/** Default and maximum `voice.followUpWindowSec`. */
export const DEFAULT_FOLLOW_UP_WINDOW_SEC = 180;
export const MAX_FOLLOW_UP_WINDOW_SEC = 1800;

interface Saved {
  sessionId: string;
  endedAt: number;
  /** Hash of the memory list the session's system prompt was built with (review 5, R5-2). */
  memory?: string;
  /** Who the conversation was started by (R7-2): only a command of the same trust resumes it. */
  trust: Trust;
}

/** The trust when a caller gives none: the most cautious. */
const DEFAULT_TRUST: Trust = 'wake';
const isTrust = (t: unknown): t is Trust => t === 'trusted' || t === 'wake';

/** A short stable hash of a memory list (what the persona's <user_memory> block was built from). */
export function memoryKey(texts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 32);
}
const MEMORY_KEY_RE = /^[0-9a-f]{32}$/;

export interface ConversationOptions {
  /** `<home>/voice`. */
  dir: string;
  /** voice.followUpWindowSec; 0 = off. */
  windowSec: number;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Called with a session id that will never be resumed again (the conversation ended, or a run returned a new id).
   * Used to delete Claude Code's transcript of that session (review 5, R5-1). Errors are logged, never thrown.
   */
  onSessionDropped?: (sessionId: string) => void;
  /**
   * The current memory list's key (memoryKey). Claude Code snapshots the system prompt, so a session built with
   * other memory must not be resumed: begin() starts fresh when the key changed, whoever changed memory (router,
   * app, `stephen memory`, a hand edit). Review 5, R5-2.
   */
  memoryKey?: () => string;
}

export class Conversation {
  readonly statePath: string;
  readonly filePath: string;
  constructor(private readonly o: ConversationOptions) {
    this.statePath = join(o.dir, SESSION_STATE_FILE);
    this.filePath = join(o.dir, CONVERSATION_FILE);
  }

  get enabled(): boolean {
    return this.o.windowSec > 0;
  }

  /** voice.followUpWindowSec. */
  get windowSec(): number {
    return this.o.windowSec;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private load(): Saved | null {
    const r = readPrivateJsonFile(this.filePath);
    if ('missing' in r) return null;
    if ('error' in r) {
      this.o.log?.(`conversation file ${this.filePath} ${r.error} — starting a new conversation`);
      return null;
    }
    const s = r.state as Partial<Saved> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const keys = Object.keys(s).sort().join(',');
    if (keys !== 'endedAt,sessionId,trust' && keys !== 'endedAt,memory,sessionId,trust') return null;
    if (typeof s.sessionId !== 'string' || !SESSION_ID_RE.test(s.sessionId)) return null;
    if (typeof s.endedAt !== 'number' || !Number.isSafeInteger(s.endedAt) || s.endedAt <= 0) return null;
    if (s.memory !== undefined && (typeof s.memory !== 'string' || !MEMORY_KEY_RE.test(s.memory))) return null;
    if (!isTrust(s.trust)) return null;
    return this.saved(s.sessionId, s.endedAt, s.memory, s.trust);
  }

  /**
   * Called right before a command of this trust runs. Returns the session id to resume, or null, and then the
   * conversation is reset first (state file deleted, session id forgotten). Throws if the reset fails (the command
   * must not run).
   */
  begin(trust: Trust = DEFAULT_TRUST): string | null {
    const id = this.peek(trust);
    if (id !== null) return id;
    this.reset();
    return null;
  }

  /**
   * The session id begin() would resume (inside the window, same memory key, same trust, valid file), without
   * changing anything. The warm runner uses it to decide whether its live process may take the next command.
   */
  peek(trust: Trust = DEFAULT_TRUST): string | null {
    if (!this.enabled) return null;
    const s = this.load();
    const age = s ? this.now() - s.endedAt : -1;
    return s && s.trust === trust && age >= 0 && age <= this.o.windowSec * 1000 && this.sameMemory(s) ? s.sessionId : null;
  }

  /** The memory key right now (taken right before a run, so the saved key matches that run's system prompt). */
  currentMemoryKey(): string | undefined {
    if (!this.o.memoryKey) return undefined;
    try {
      return this.o.memoryKey();
    } catch {
      return 'unreadable';
    }
  }

  /** Same memory as when the session was saved? (No memoryKey option → always true.) Unreadable → false. */
  private sameMemory(s: Saved): boolean {
    if (!this.o.memoryKey) return true;
    const now = this.currentMemoryKey();
    if (s.memory !== now) this.o.log?.('memory changed since the last command — starting a new conversation');
    return s.memory === now;
  }

  private saved(sessionId: string, endedAt: number, memory: string | undefined, trust: Trust): Saved {
    return memory !== undefined && MEMORY_KEY_RE.test(memory) ? { sessionId, endedAt, memory, trust } : { sessionId, endedAt, trust };
  }

  /** The live conversation's session id (null when none). */
  current(): string | null {
    return this.enabled ? (this.load()?.sessionId ?? null) : null;
  }

  /** Drop a session id that will never be resumed (its transcript is deleted). Never throws. */
  drop(id: string): void {
    this.dropped(id);
  }

  private dropped(id: string | null | undefined): void {
    if (!id || !this.o.onSessionDropped) return;
    try {
      this.o.onSessionDropped(id);
    } catch (e) {
      this.o.log?.(`could not clean up session ${id} (${(e as Error).message})`);
    }
  }

  /** Called with every finished run: OK with a session id → remember it (and now as the end); else end the conversation. */
  finish(out: ClaudeOutcome, memory: string | undefined = this.currentMemoryKey(), trust: Trust = DEFAULT_TRUST): void {
    if (out.kind === 'ok' && out.sessionId && this.remember(out.sessionId, memory, trust)) return;
    this.end();
    // A failed or cancelled run may still have written a transcript under its own id.
    const failedId = 'sessionId' in out ? out.sessionId : null;
    if (failedId && SESSION_ID_RE.test(failedId)) this.dropped(failedId);
  }

  /**
   * Save `sessionId` (ended now, built with memory key `memory`, started with `trust`) as the live conversation; a
   * replaced id is dropped. False when follow-ups are off, the id is invalid or the file can't be written: nothing is
   * reset here, the caller ends the conversation (the warm runner kills its process first).
   */
  remember(sessionId: string, memory: string | undefined, trust: Trust = DEFAULT_TRUST): boolean {
    if (!this.enabled || !SESSION_ID_RE.test(sessionId)) return false;
    const before = this.load()?.sessionId ?? null;
    try {
      writePrivateJsonFileSync(this.filePath, this.saved(sessionId, this.now(), memory, trust));
    } catch (e) {
      this.o.log?.(`could not save the conversation (${(e as Error).message}) — the next command starts fresh`);
      return false;
    }
    if (before !== sessionId) this.dropped(before);
    return true;
  }

  /** The command's reply finished (spoken or shown): the window counts from now. No-op if the conversation ended. */
  touch(): void {
    if (!this.enabled) return;
    const s = this.load();
    if (!s) return;
    try {
      writePrivateJsonFileSync(this.filePath, this.saved(s.sessionId, Math.max(s.endedAt, this.now()), s.memory, s.trust));
    } catch {
      /* the earlier end time stays: a shorter window, never a longer one */
    }
  }

  /** End the conversation (Esc, "Stephen stop", cancel, error). Never throws; a failure is logged. */
  end(): void {
    try {
      this.reset();
    } catch (e) {
      this.o.log?.(`could not reset the conversation (${(e as Error).message})`);
    }
  }

  /** Delete the session id FIRST (so a half-done reset never resumes), then the gate state. Throws on failure. */
  reset(): void {
    const old = this.load()?.sessionId ?? null;
    removeSessionStateFile(this.filePath);
    removeSessionStateFile(this.statePath);
    this.dropped(old);
  }
}

/** Minimal runner interface the conversation wraps (ClaudeRunner). */
export interface ResumableRunner {
  run(prompt: string, run?: RunOptions): Promise<ClaudeOutcome>;
  cancel(): boolean;
}

/** A CommandRunner that resumes inside a conversation and resets it whenever the conversation ends. */
export class ConversationRunner implements CommandRunner {
  /** The decision taken by followUp() for the next run (undefined = not decided yet), and the trust it was for. */
  private plan: string | null | undefined = undefined;
  private planTrust: Trust = DEFAULT_TRUST;
  constructor(
    private readonly inner: ResumableRunner,
    readonly conversation: Conversation,
  ) {}

  /** Decide now whether the next run (of this trust) is a follow-up (the Assistant shows "(follow-up)"). */
  followUp(trust: Trust = DEFAULT_TRUST): boolean {
    this.planTrust = trust;
    try {
      this.plan = this.conversation.begin(trust);
    } catch {
      this.plan = undefined; // run() tries again and reports the error
      return false;
    }
    return this.plan !== null;
  }

  /** A run never resumes a conversation of another trust (R7-2): begin() resets it and the run starts fresh. */
  async run(prompt: string, hooks: RunHooks = {}): Promise<ClaudeOutcome> {
    const trust = hooks.trust ?? DEFAULT_TRUST;
    const resume = this.plan !== undefined && this.planTrust === trust ? this.plan : this.conversation.begin(trust);
    this.plan = undefined;
    const memory = this.conversation.currentMemoryKey();
    let out: ClaudeOutcome;
    try {
      out = await this.inner.run(prompt, resume ? { resume, trust } : { trust });
    } catch (e) {
      this.conversation.end();
      throw e;
    }
    this.conversation.finish(out, memory, trust);
    return out;
  }

  cancel(): boolean {
    return this.inner.cancel();
  }

  endConversation(): void {
    this.plan = undefined;
    this.conversation.end();
  }

  commandEnded(): void {
    this.conversation.touch();
  }
}

// ───────────────────────────── the warm runner (phase 3, docs/ADR-003) ─────────────────────────────

/** An unused pre-warmed process is killed after this long. */
export const PREWARM_UNUSED_MS = 60_000;
/** A live process ends after this many commands… */
export const MAX_WARM_COMMANDS = 25;
/** …or once it is this old (checked between commands; an idle one ends with the follow-up window first). */
export const MAX_WARM_AGE_MS = MAX_FOLLOW_UP_WINDOW_SEC * 1000;

export interface WarmRunnerOptions {
  conversation: Conversation;
  /**
   * Start one warm process whose persona is built with the memory as it is now (`memoryKey` = its key), for a
   * conversation of this trust (`wake`: its serve runs with `--trust wake`).
   */
  start: (memoryKey: string | undefined, trust: Trust) => WarmProcess;
  /** Called after every OK command with where the time went. */
  onTiming?: (t: ClaudeTiming) => void;
  now?: () => number;
  log?: (line: string) => void;
}

const CANCELLED: ClaudeOutcome = { kind: 'cancelled' };

/**
 * A CommandRunner over ONE long-lived warm process per conversation (src/voice/warm-claude.ts). It owns the end
 * rules, always in this order: kill the process group → wait until it is gone → Conversation.end() (session id first,
 * then the state file, then the transcript). The next process is spawned only by the next prewarm() (wake word, F5)
 * or run(). Kill before reset: a serve that is still alive could write the state file again after it was deleted,
 * and the next serve would import that old taint. A conversation ends on:
 *  - the follow-up window running out (a timer after each command and touch(), checked again before a command);
 *  - a memory change (endConversation() from the router, or a memory key that differs from the process's);
 *  - a command or pre-warm of another trust than the process's (R7-2: a wake-word command never continues an F5
 *    conversation, nor the other way round; a typed command after a wake-word pre-warm replaces that process);
 *  - a cancel (cancel() / endConversation(): Esc, "Stephen stop", wake word while running, F5 while busy, Ctrl-C);
 *  - any error (an error result, a protocol error, an exit, MCP not connected, a serve that died or was restarted
 *    behind Claude Code's back: docs/REVIEW-7.md R7-1) and a state save that failed;
 *  - the caps: an unused pre-warm after PREWARM_UNUSED_MS, MAX_WARM_COMMANDS commands, MAX_WARM_AGE_MS, listener exit.
 * Window 0: the process ends after every command (the next one is still pre-warmed).
 * Every end also drops the session id the process announced on its first line (R7-3), so a cancelled or failed
 * first command leaves no transcript.
 */
export class WarmConversationRunner implements CommandRunner {
  private proc: WarmProcess | null = null;
  /** Commands finished OK on `proc`. */
  private commands = 0;
  private sessionId: string | null = null;
  private busy = false;
  private cancelRequested = false;
  private ending: Promise<void> = Promise.resolve();
  private unusedTimer: NodeJS.Timeout | null = null;
  private windowTimer: NodeJS.Timeout | null = null;
  constructor(private readonly o: WarmRunnerOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get conversation(): Conversation {
    return this.o.conversation;
  }

  /** May the live process take the next command, of this trust? Pure: nothing is killed or reset here. */
  private reusable(trust: Trust): boolean {
    const p = this.proc;
    if (!p || p.exited || p.trust !== trust) return false;
    const key = this.conversation.currentMemoryKey();
    if (key === 'unreadable' || key !== p.memoryKey) return false;
    const age = this.now() - p.spawnedAt;
    if (this.commands >= MAX_WARM_COMMANDS || age >= MAX_WARM_AGE_MS) return false;
    if (this.commands === 0) return age < PREWARM_UNUSED_MS;
    return this.sessionId !== null && this.conversation.peek(trust) === this.sessionId;
  }

  /**
   * The wake word fired (`wake`) or F5 went down (`trusted`): start a process of that trust now, unless one that can
   * take the command is up. A live process of the other trust ends first (kill, wait, reset).
   */
  prewarm(trust: Trust = DEFAULT_TRUST): void {
    if (this.busy) return;
    if (this.proc && this.reusable(trust)) return;
    if (this.proc) void this.endProcess();
    this.ending = this.ending.then(() => {
      if (this.proc || this.busy) return;
      try {
        this.spawn(trust);
      } catch (e) {
        this.o.log?.(`could not pre-warm Claude Code (${(e as Error).message})`);
      }
    });
  }

  followUp(trust: Trust = DEFAULT_TRUST): boolean {
    return this.commands > 0 && this.reusable(trust);
  }

  async run(prompt: string, hooks: RunHooks = {}): Promise<ClaudeOutcome> {
    if (this.busy) throw new Error('a command is already running');
    const trust = hooks.trust ?? DEFAULT_TRUST;
    this.busy = true;
    this.cancelRequested = false;
    this.clearTimers();
    const t0 = this.now();
    try {
      let p: WarmProcess | null = null;
      // At most twice: if the memory changes while a process starts, it is replaced once.
      for (let attempt = 0; attempt < 2 && !p; attempt++) {
        await this.ending;
        if (this.cancelRequested) return CANCELLED;
        // Another trust, the window ran out, memory changed or a cap: this process can't take it (kill, wait, reset).
        if (this.proc && !this.reusable(trust)) await this.endProcess();
        if (this.cancelRequested) return CANCELLED;
        const next = this.proc ?? this.spawn(trust);
        try {
          await next.ready();
        } catch (e) {
          if (this.cancelRequested) return CANCELLED;
          if (this.proc === next) void this.endProcess();
          return { kind: 'error', message: (e as Error).message, sessionId: null };
        }
        if (this.cancelRequested || this.proc !== next) return CANCELLED;
        if (this.reusable(trust)) p = next;
      }
      if (!p) {
        void this.endProcess();
        return { kind: 'error', message: 'Your memory changed while Claude Code was starting. Try again.', sessionId: null };
      }
      const command = this.commands + 1;
      // Every earlier group is gone by now (awaited above), so nothing of a cancelled command can log after this.
      hooks.beforeSend?.();
      const out = await p.turn(prompt);
      if (this.cancelRequested || out.kind === 'cancelled') return CANCELLED;
      if (out.kind === 'ok') {
        this.o.onTiming?.({
          wallMs: this.now() - t0,
          durationMs: out.durationMs ?? null,
          apiMs: out.apiMs ?? null,
          turns: out.turns,
          warm: { command, leadMs: command === 1 ? t0 - p.spawnedAt : null },
        });
      }
      const kept = out.kind === 'ok' && this.proc === p && out.sessionId !== null && this.conversation.remember(out.sessionId, p.memoryKey, p.trust);
      if (!kept) {
        // An error, window 0, a failed save: the conversation ends (a failed run's own id is dropped too).
        const failedId = out.kind === 'error' ? out.sessionId : null;
        if (this.proc === p) void this.endProcess();
        if (failedId && SESSION_ID_RE.test(failedId)) this.ending = this.ending.then(() => this.conversation.drop(failedId));
        return out;
      }
      this.commands = command;
      this.sessionId = out.sessionId;
      if (!this.reusable(trust)) void this.endProcess(); // a cap was reached
      else this.armWindow();
      return out;
    } finally {
      this.busy = false;
    }
  }

  /** Kill the running command's process group; the conversation ends with it. */
  cancel(): boolean {
    if (!this.busy) return false;
    this.cancelRequested = true;
    void this.endProcess();
    return true;
  }

  /** Esc, "Stephen stop", a memory change, the app's "new conversation": kill the process (if any), then reset. */
  endConversation(): void {
    void this.endProcess();
  }

  commandEnded(): void {
    this.conversation.touch();
    if (this.proc && this.commands > 0 && !this.busy) this.armWindow();
  }

  /** Listener exit: end the conversation (kill → close → reset). */
  shutdown(): Promise<void> {
    return this.endProcess();
  }

  /** Synchronous last resort (process exit handler). */
  killNow(): void {
    this.clearTimers();
    this.proc?.killNow();
  }

  /** The live process, if any (tests). */
  get process(): WarmProcess | null {
    return this.proc;
  }

  private spawn(trust: Trust): WarmProcess {
    this.conversation.reset(); // fresh gate, no session id; throws if that fails, and then nothing runs
    const p = this.o.start(this.conversation.currentMemoryKey(), trust);
    this.proc = p;
    this.commands = 0;
    this.sessionId = null;
    // An exit while idle ends the conversation now (while busy, run() gets the error and ends it).
    p.onExit(() => {
      if (this.proc === p && !this.busy) void this.endProcess();
    });
    this.unusedTimer = setTimeout(() => {
      if (this.proc === p && this.commands === 0 && !this.busy) void this.endProcess();
    }, PREWARM_UNUSED_MS);
    this.unusedTimer.unref?.();
    return p;
  }

  /** End the conversation in the safe order: kill → gone → reset (session id, state file, transcript). */
  private endProcess(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    this.commands = 0;
    this.sessionId = null;
    this.clearTimers();
    this.ending = this.ending.then(async () => {
      if (p) await p.kill();
      this.conversation.end();
      // The id from the process's first line: a cancelled / failed first command never saved one (R7-3).
      if (p?.sessionId && SESSION_ID_RE.test(p.sessionId)) this.conversation.drop(p.sessionId);
    });
    return this.ending;
  }

  private armWindow(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      if (!this.busy && this.proc && !this.reusable(this.proc.trust)) void this.endProcess();
    }, this.conversation.windowSec * 1000 + 1);
    this.windowTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.unusedTimer) clearTimeout(this.unusedTimer);
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.unusedTimer = null;
    this.windowTimer = null;
  }
}
