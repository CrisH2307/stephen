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
}

export interface ConversationOptions {
  /** `<home>/voice`. */
  dir: string;
  /** voice.followUpWindowSec; 0 = off. */
  windowSec: number;
  now?: () => number;
  log?: (line: string) => void;
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
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join(',') !== 'endedAt,sessionId') return null;
    if (typeof s.sessionId !== 'string' || !SESSION_ID_RE.test(s.sessionId)) return null;
    if (typeof s.endedAt !== 'number' || !Number.isSafeInteger(s.endedAt) || s.endedAt <= 0) return null;
    return { sessionId: s.sessionId, endedAt: s.endedAt };
  }

  /**
   * Called right before a command runs. Returns the session id to resume, or null — and then the conversation is
   * reset first (state file deleted, session id forgotten). Throws if the reset fails (the command must not run).
   */
  begin(): string | null {
    if (this.enabled) {
      const s = this.load();
      const age = s ? this.now() - s.endedAt : -1;
      if (s && age >= 0 && age <= this.o.windowSec * 1000) return s.sessionId;
    }
    this.reset();
    return null;
  }

  /** Called with every finished run: OK with a session id → remember it (and now as the end); else end the conversation. */
  finish(out: ClaudeOutcome): void {
    if (this.enabled && out.kind === 'ok' && out.sessionId && SESSION_ID_RE.test(out.sessionId)) {
      try {
        writePrivateJsonFileSync(this.filePath, { sessionId: out.sessionId, endedAt: this.now() } satisfies Saved);
        return;
      } catch (e) {
        this.o.log?.(`could not save the conversation (${(e as Error).message}) — the next command starts fresh`);
      }
    }
    this.end();
  }

  /** The command's reply finished (spoken or shown): the window counts from now. No-op if the conversation ended. */
  touch(): void {
    if (!this.enabled) return;
    const s = this.load();
    if (!s) return;
    try {
      writePrivateJsonFileSync(this.filePath, { sessionId: s.sessionId, endedAt: Math.max(s.endedAt, this.now()) } satisfies Saved);
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
    removeSessionStateFile(this.filePath);
    removeSessionStateFile(this.statePath);
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
    let out: ClaudeOutcome;
    try {
      out = await this.inner.run(prompt, resume ? { resume } : {});
    } catch (e) {
      this.conversation.end();
      throw e;
    }
    this.conversation.finish(out);
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
