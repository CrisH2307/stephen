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
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_STATE_FILE, readPrivateJsonFile, removeSessionStateFile, writePrivateJsonFileSync } from '../safety/session-state.js';
import type { CommandRunner } from './assistant.js';
import { SESSION_ID_RE, type ClaudeOutcome, type RunOptions } from './claude.js';

export const CONVERSATION_FILE = 'conversation.json';
/** Default and maximum `voice.followUpWindowSec`. */
export const DEFAULT_FOLLOW_UP_WINDOW_SEC = 180;
export const MAX_FOLLOW_UP_WINDOW_SEC = 1800;

interface Saved {
  sessionId: string;
  endedAt: number;
  /** Hash of the memory list the session's system prompt was built with (review 5, R5-2). */
  memory?: string;
}

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
    if (keys !== 'endedAt,sessionId' && keys !== 'endedAt,memory,sessionId') return null;
    if (typeof s.sessionId !== 'string' || !SESSION_ID_RE.test(s.sessionId)) return null;
    if (typeof s.endedAt !== 'number' || !Number.isSafeInteger(s.endedAt) || s.endedAt <= 0) return null;
    if (s.memory !== undefined && (typeof s.memory !== 'string' || !MEMORY_KEY_RE.test(s.memory))) return null;
    return s.memory !== undefined ? { sessionId: s.sessionId, endedAt: s.endedAt, memory: s.memory } : { sessionId: s.sessionId, endedAt: s.endedAt };
  }

  /**
   * Called right before a command runs. Returns the session id to resume, or null — and then the conversation is
   * reset first (state file deleted, session id forgotten). Throws if the reset fails (the command must not run).
   */
  begin(): string | null {
    if (this.enabled) {
      const s = this.load();
      const age = s ? this.now() - s.endedAt : -1;
      if (s && age >= 0 && age <= this.o.windowSec * 1000 && this.sameMemory(s)) return s.sessionId;
    }
    this.reset();
    return null;
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

  private saved(sessionId: string, endedAt: number, memory: string | undefined): Saved {
    return memory !== undefined && MEMORY_KEY_RE.test(memory) ? { sessionId, endedAt, memory } : { sessionId, endedAt };
  }

  /** The live conversation's session id (null when none). */
  current(): string | null {
    return this.enabled ? (this.load()?.sessionId ?? null) : null;
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
  finish(out: ClaudeOutcome, memory: string | undefined = this.currentMemoryKey()): void {
    if (this.enabled && out.kind === 'ok' && out.sessionId && SESSION_ID_RE.test(out.sessionId)) {
      const before = this.load()?.sessionId ?? null;
      try {
        writePrivateJsonFileSync(this.filePath, this.saved(out.sessionId, this.now(), memory));
        if (before !== out.sessionId) this.dropped(before);
        return;
      } catch (e) {
        this.o.log?.(`could not save the conversation (${(e as Error).message}) — the next command starts fresh`);
      }
    }
    this.end();
    // A failed or cancelled run may still have written a transcript under its own id.
    const failedId = 'sessionId' in out ? out.sessionId : null;
    if (failedId && SESSION_ID_RE.test(failedId)) this.dropped(failedId);
  }

  /** The command's reply finished (spoken or shown): the window counts from now. No-op if the conversation ended. */
  touch(): void {
    if (!this.enabled) return;
    const s = this.load();
    if (!s) return;
    try {
      writePrivateJsonFileSync(this.filePath, this.saved(s.sessionId, Math.max(s.endedAt, this.now()), s.memory));
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
  /** The decision taken by followUp() for the next run (undefined = not decided yet). */
  private plan: string | null | undefined = undefined;
  constructor(
    private readonly inner: ResumableRunner,
    readonly conversation: Conversation,
  ) {}

  /** Decide now whether the next run is a follow-up (the Assistant shows "(follow-up)"). */
  followUp(): boolean {
    try {
      this.plan = this.conversation.begin();
    } catch {
      this.plan = undefined; // run() tries again and reports the error
      return false;
    }
    return this.plan !== null;
  }

  async run(prompt: string): Promise<ClaudeOutcome> {
    const resume = this.plan !== undefined ? this.plan : this.conversation.begin();
    this.plan = undefined;
    const memory = this.conversation.currentMemoryKey();
    let out: ClaudeOutcome;
    try {
      out = await this.inner.run(prompt, resume ? { resume } : {});
    } catch (e) {
      this.conversation.end();
      throw e;
    }
    this.conversation.finish(out, memory);
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
