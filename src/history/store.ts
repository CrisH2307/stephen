/**
 * Local command history (docs/PLAN-1.9-MEMORY-DASHBOARD.md sections 2 and 5): one JSON line per command in
 * `<home>/history/YYYY-MM-DD.jsonl` (local date). A log for the owner only: it is never sent back to Claude.
 *
 *  - Folder 0700, files 0600, opened with O_NOFOLLOW; each entry is ONE O_APPEND write.
 *  - `retentionDays` (config `history.retentionDays`, default 7, 0 to 30): a rolling window (same time N days ago).
 *    Older entries are deleted on every append, list() and purge() (listener start, `stephen history`).
 *    0 = history off: nothing is written and purge deletes every day file.
 *  - Caps: said 2000 chars, reply 4000 chars, 100 tool calls, 40 steps of 160 chars, 5 MB per day file (a full day
 *    drops new entries).
 *  - Optional `conv` (conversation id) and `steps` (what chat.done showed), ADR-007. Old lines without them still read.
 *    Stored text is data for the owner to look at, never instructions: nothing reads it to decide anything.
 *  - Malformed lines are skipped when reading.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { appendPrivateLineCapped, readPrivateRegularFile, writePrivateFileAtomicSync } from '../lib/fs.js';
import { truncate } from '../safety/text.js';
import { parseToolCallRecord, type ToolCallRecord } from '../server/tool-log.js';

export const HISTORY_SOURCES = ['voice-ptt', 'voice-wake', 'app', 'cli', 'phone'] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];
export const HISTORY_OUTCOMES = ['ok', 'error', 'cancelled', 'memory'] as const;
export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];

/** One line of a command's action chain (src/app/steps.ts builds them; chat.done and the history line carry them). */
export interface ChatStep {
  text: string;
  status: 'ok' | 'refused' | 'failed';
}
export const CHAT_STEP_STATUSES = ['ok', 'refused', 'failed'] as const;
/** At most this many steps per command (maxTurns bounds a command; this keeps one push small). */
export const MAX_CHAT_STEPS = 40;
/** Each step's text is cut to this many characters. */
export const MAX_STEP_CHARS = 160;

/** One command, exactly as stored (section 2). */
export interface HistoryEntry {
  id: string;
  /** ISO 8601 time the command finished (UTC). */
  ts: string;
  source: HistorySource;
  said: string;
  reply: string;
  outcome: HistoryOutcome;
  tools: ToolCallRecord[];
  /** true = a follow-up in an ongoing conversation (`--resume`). */
  followUp: boolean;
  /** Total time of the command in milliseconds. */
  ms: number;
  /** Claude turns used (0 for memory commands handled locally). */
  turns: number;
  /** Conversation id (newConversationId), the same on every line of one conversation. Absent on older lines. */
  conv?: string;
  /** The steps chat.done carried for this command (ADR-007 point 6). Absent when there were none or the audit read failed. */
  steps?: ChatStep[];
}

/** What callers pass to append: id and ts are filled in when absent. */
export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'ts'> & { id?: string; ts?: string };

export const MAX_SAID_CHARS = 2000;
export const MAX_REPLY_CHARS = 4000;
export const MAX_TOOLS_PER_ENTRY = 100;
export const MAX_DAY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONV_RE = /^c_[0-9a-f]{16}$/;

/** `<home>/history` */
export function historyDir(home: string): string {
  return join(resolve(home), 'history');
}

/** A fresh history entry id ("h_" + 16 hex digits). The Assistant picks it when a command starts (app chat.accepted). */
export function newHistoryId(): string {
  return `h_${randomBytes(8).toString('hex')}`;
}

/** A fresh conversation id ("c_" + 16 hex digits). The Assistant mints it when a conversation starts. */
export function newConversationId(): string {
  return `c_${randomBytes(8).toString('hex')}`;
}

/** Valid steps from parsed JSON, cut to the caps (bad lines are dropped). */
export function parseSteps(v: unknown): ChatStep[] {
  if (!Array.isArray(v)) return [];
  const out: ChatStep[] = [];
  for (const s of v) {
    if (out.length >= MAX_CHAT_STEPS) break;
    if (!s || typeof s !== 'object') continue;
    const { text, status } = s as Record<string, unknown>;
    if (typeof text !== 'string' || !CHAT_STEP_STATUSES.includes(status as ChatStep['status'])) continue;
    out.push({ text: truncate(text, MAX_STEP_CHARS), status: status as ChatStep['status'] });
  }
  return out;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

export interface HistoryStoreOptions {
  home: string;
  /** 0 to 30 (see parseHistoryConfig). */
  retentionDays: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * Also run on purge (with the cutoff time in ms) and on clear (null = everything): deletes Claude Code's own
   * transcripts of voice sessions (review 5, R5-1; see src/voice/transcripts.ts).
   */
  onPurge?: (olderThanMs: number | null) => void;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

/** A valid entry from parsed JSON, or null. */
export function parseHistoryEntry(v: unknown): HistoryEntry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (typeof o.ts !== 'string' || Number.isNaN(Date.parse(o.ts))) return null;
  if (!HISTORY_SOURCES.includes(o.source as HistorySource)) return null;
  if (!HISTORY_OUTCOMES.includes(o.outcome as HistoryOutcome)) return null;
  if (typeof o.said !== 'string' || typeof o.reply !== 'string') return null;
  if (!Array.isArray(o.tools)) return null;
  const tools = o.tools.map(parseToolCallRecord).filter((t): t is ToolCallRecord => t !== null);
  const steps = parseSteps(o.steps);
  return {
    id: o.id,
    ts: o.ts,
    source: o.source as HistorySource,
    said: truncate(o.said, MAX_SAID_CHARS),
    reply: truncate(o.reply, MAX_REPLY_CHARS),
    outcome: o.outcome as HistoryOutcome,
    tools: tools.slice(0, MAX_TOOLS_PER_ENTRY),
    followUp: o.followUp === true,
    ms: nonNegInt(o.ms),
    turns: nonNegInt(o.turns),
    ...(typeof o.conv === 'string' && CONV_RE.test(o.conv) ? { conv: o.conv } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

export class HistoryStore {
  readonly dir: string;
  readonly retentionDays: number;
  private readonly now: () => Date;

  private readonly onPurge?: (olderThanMs: number | null) => void;
  constructor(opts: HistoryStoreOptions) {
    if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 0 || opts.retentionDays > 30) {
      throw new HistoryError('retentionDays must be a whole number from 0 to 30');
    }
    this.dir = historyDir(opts.home);
    this.retentionDays = opts.retentionDays;
    this.now = opts.now ?? (() => new Date());
    this.onPurge = opts.onPurge;
  }

  /** Run the onPurge hook (Claude transcripts, review 5 R5-1); a failure never breaks history. */
  private extraPurge(olderThanMs: number | null): void {
    try {
      this.onPurge?.(olderThanMs);
    } catch {
      /* best effort */
    }
  }

  /** History is off (retentionDays 0). */
  get enabled(): boolean {
    return this.retentionDays > 0;
  }

  /**
   * Store one entry (truncated to the caps) and purge old day files. Returns the stored entry, or null when history
   * is off or today's file is full. Throws HistoryError if the folder or file is unsafe or can't be written.
   */
  append(entry: NewHistoryEntry): HistoryEntry | null {
    this.purge();
    if (!this.enabled) return null;
    const now = this.now();
    const stored = parseHistoryEntry({
      ...entry,
      id: entry.id ?? newHistoryId(),
      ts: entry.ts ?? now.toISOString(),
    });
    if (!stored) throw new HistoryError('invalid history entry');
    const line = `${JSON.stringify(stored)}\n`;
    this.ensureDir();
    const file = join(this.dir, `${localDate(now)}.jsonl`);
    try {
      if (!appendPrivateLineCapped(file, line, MAX_DAY_FILE_BYTES)) return null;
    } catch (e) {
      throw new HistoryError((e as Error).message);
    }
    return stored;
  }

  /** Entries newest first. `before`: only entries with ts earlier than this ISO time. `limit`: 1 to 100 (default 20). */
  list(opts: { before?: string; limit?: number } = {}): HistoryEntry[] {
    this.purge();
    if (!this.enabled) return [];
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT));
    const before = opts.before !== undefined ? Date.parse(opts.before) : null;
    if (before !== null && Number.isNaN(before)) throw new HistoryError('before must be an ISO date/time');
    const cutoff = this.cutoff();
    const oldestMs = this.cutoffMs();
    const out: HistoryEntry[] = [];
    for (const name of this.dayFiles().sort().reverse()) {
      if (name.slice(0, 10) < cutoff) break;
      const lines = this.readDayFile(join(this.dir, name));
      for (let i = lines.length - 1; i >= 0; i--) {
        let e: HistoryEntry | null = null;
        try {
          e = parseHistoryEntry(JSON.parse(lines[i]!));
        } catch {
          e = null;
        }
        if (!e || Date.parse(e.ts) < oldestMs || (before !== null && Date.parse(e.ts) >= before)) continue;
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Delete every day file. Returns how many were deleted. */
  clear(): number {
    this.extraPurge(null);
    return this.remove(() => true);
  }

  /** Delete day files older than retentionDays (all of them when history is off). Returns how many were deleted. */
  purge(): number {
    const cutoff = this.cutoff();
    const oldestMs = this.cutoffMs();
    this.extraPurge(this.enabled ? oldestMs : null);
    const n = this.remove((date) => date < cutoff);
    if (this.enabled) this.trimDayFile(cutoff, oldestMs);
    return n;
  }

  /**
   * Retention is a rolling window: entries older than the same time retentionDays days ago are dropped (review 5, R5-6; "1 day"
   * used to keep up to ~48 h). Whole day files before the cutoff's day are deleted; the cutoff's own day file is
   * rewritten without the expired entries.
   */
  private cutoffMs(): number {
    // Same local wall-clock time `retentionDays` calendar days ago (so a DST change doesn't shift it by an hour).
    const n = this.now();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() - this.retentionDays, n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds()).getTime();
  }

  /** Oldest day file kept: the local date of the cutoff (a date later than today when history is off). */
  private cutoff(): string {
    const n = this.now();
    if (!this.enabled) return localDate(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
    return localDate(new Date(this.cutoffMs()));
  }

  /** Rewrite one day file keeping only entries at or after `oldestMs` (deleted when none are left). */
  private trimDayFile(date: string, oldestMs: number): void {
    const file = join(this.dir, `${date}.jsonl`);
    const lines = this.readDayFile(file);
    if (!lines.length) return;
    const keep = lines.filter((l) => {
      try {
        const e = parseHistoryEntry(JSON.parse(l));
        return e !== null && Date.parse(e.ts) >= oldestMs;
      } catch {
        return false;
      }
    });
    if (keep.length === lines.length) return;
    try {
      if (!keep.length) {
        unlinkSync(file);
        return;
      }
      writePrivateFileAtomicSync(file, keep.map((l) => `${l}\n`).join(''));
    } catch {
      // best effort: the next purge tries again; list() hides expired entries anyway
    }
  }

  private dayFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((n) => DAY_FILE_RE.test(n));
    } catch {
      return [];
    }
  }

  private remove(match: (date: string) => boolean): number {
    let n = 0;
    for (const name of this.dayFiles()) {
      if (!match(name.slice(0, 10))) continue;
      try {
        unlinkSync(join(this.dir, name));
        n += 1;
      } catch {
        // already gone
      }
    }
    return n;
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new HistoryError(`cannot create ${this.dir}: ${(e as Error).message}`);
    }
    const st = lstatSync(this.dir);
    if (!st.isDirectory()) throw new HistoryError(`${this.dir} must be a real folder (not a symlink)`);
    if ((st.mode & 0o777) !== 0o700) chmodSync(this.dir, 0o700);
  }

  /** Lines of one day file; a missing, symlinked, non-regular or oversized file reads as empty. */
  private readDayFile(file: string): string[] {
    const text = readPrivateRegularFile(file, MAX_DAY_FILE_BYTES);
    if (text === null) return [];
    return text.split('\n').filter((l) => l.trim());
  }
}
