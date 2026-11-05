/**
 * Things the user asked Stephen to remember: `<home>/memory.json` (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 2).
 *
 * Only the user writes here: by saying "remember …" (routed before Claude, see intent.ts), with
 * `stephen memory add`, or in the Stephen app. Nothing Claude reads or decides can reach this module: the
 * boundary test (test/memory/boundary.test.ts) fails if the MCP server, the safety gate, the desktop actions, the
 * drivers or the page engine import it.
 *
 * Rules:
 *  - At most `maxItems` (≤ MAX_MEMORY_ITEMS) items of 1 to MAX_MEMORY_CHARS characters, one line each.
 *  - Text is cleaned (control / bidi characters removed, whitespace collapsed, `<` `>` become `‹` `›`, so it can
 *    never close the `<user_memory>` block it is sent in).
 *  - Secret-looking text (passwords, codes, card numbers, 6+ digits in a row) is refused: memory is sent to
 *    Anthropic with every command.
 *  - Every change takes `memory.json.lock` (O_EXCL, pid inside; a lock whose pid is gone or that is older than
 *    LOCK_STALE_MS is removed) and writes atomically, 0600 (src/lib/fs.ts helpers: O_NOFOLLOW reads,
 *    owner + mode checks, temp file + rename).
 *  - Every change (and refusal) is audited with the text's length only, never the text.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from '../lib/process.js';
import { readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { charLength, stripUnsafe } from '../safety/text.js';
import type { IAuditLog } from '../types.js';

export const MEMORY_FILE = 'memory.json';
export const MEMORY_LOCK_FILE = 'memory.json.lock';
/** Hard cap on items (config `memory.maxItems` can only lower it). */
export const MAX_MEMORY_ITEMS = 30;
/** Longest item, in characters (code points). */
export const MAX_MEMORY_CHARS = 200;
/** A lock older than this is stale (a crashed writer), whatever its pid. */
export const LOCK_STALE_MS = 10_000;
/** How long a writer waits for another writer's lock before giving up. */
export const LOCK_WAIT_MS = 3_000;

export const MEMORY_SOURCES = ['voice-ptt', 'voice-wake', 'app', 'cli'] as const;
/** How an item was saved: push-to-talk, wake word (asked in a dialog first), the Stephen app, or the CLI. */
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export interface MemoryItem {
  /** "m7" */
  id: string;
  text: string;
  source: MemorySource;
  /** ISO time */
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFile {
  version: 1;
  nextId: number;
  items: MemoryItem[];
}

/** Why a change was refused. `message` is short and fit to say aloud or show the user. */
export type MemoryRefusal = 'empty' | 'too-long' | 'secret' | 'full' | 'not-found' | 'busy' | 'unreadable' | 'write-failed';

export type MemoryResult =
  | {
      ok: true;
      /** The item added / updated / forgotten (absent for clear). */
      item?: MemoryItem;
      /** add only: the same text was already saved; nothing changed. */
      duplicate?: boolean;
      /** Every item after the change, oldest first. */
      items: MemoryItem[];
    }
  | { ok: false; reason: MemoryRefusal; message: string };

/** list() could not read memory.json (symlink, wrong owner or mode, bad JSON …). */
export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryStoreError';
  }
}

export const MEMORY_MESSAGES: Record<MemoryRefusal, string> = {
  empty: "There's nothing to remember there.",
  'too-long': `That's too long to remember (${MAX_MEMORY_CHARS} characters at most).`,
  secret: "I don't save passwords, codes or card numbers.",
  full: 'My memory is full. Forget something first.',
  'not-found': "I don't have that memory.",
  busy: 'Memory is busy right now. Try again in a moment.',
  unreadable: "I can't read my memory file right now.",
  'write-failed': "I couldn't save my memory file.",
};

const ID_RE = /^m[1-9]\d{0,8}$/;
/**
 * Memory goes to Anthropic with every command, so secrets are refused. Narrower than the page-field check
 * (textLooksSecret), which also flags harmless words like "expires", "routing" or "pin it": owner feedback, a course
 * code ("sofe 3980") or a year must save. Refused: secret words, codes next to a lock/login word, 6+ digit runs
 * (card, account and phone numbers, one-time codes).
 */
const MEMORY_SECRET_RE = new RegExp(
  [
    String.raw`\b(?:pass\s?word|passwd|pass\s?code|pass\s?phrase|cvv|cvc|otp|2fa|ssn|api\s?key|secret\s?key|access\s?token|private\s?key)s?\b`,
    String.raw`\bpin(?:'s)?\b(?=\s*(?:code|number|no\b|is|was|=|:|\d))`,
    String.raw`\bcode\s+(?:for|to|of)\s+(?:the\s+|my\s+)?(?:door|locker|gate|alarm|garage|lock|safe|building|wifi|wi-fi)\b`,
    String.raw`\b(?:opens?|unlocks?)\s+with\s+(?:the\s+)?(?:code\s+)?\d`,
    String.raw`\b(?:bank|card|atm|debit|phone|sim)\s+pin\b`,
    String.raw`\b(?:door|locker|gate|alarm|access|entry|lock|garage|verification|security|one[- ]time|login|confirmation|recovery|backup|wifi|wi-fi)\s+(?:code|key|password|combo)\b`,
    String.raw`\b(?:combo|combination)\b`,
    String.raw`\b(?:card|account|routing|transit|institution|social\s+insurance|sin|social\s+security|health\s+card|passport|licen[cs]e)\s+(?:number|no\b|#)`,
  ].join('|'),
  'i',
);
/** 6+ digits in a row, also spoken apart ("1 2 3 4 5 6", "1234-5678"). */
const DIGIT_RUN_RE = /\d(?:[ .-]?\d){5,}/;
/** 8+ digits in comma/space groups, the way speech-to-text writes card numbers ("4512, 3456, 7890, 1234"). */
const DIGIT_GROUPS_RE = /\d(?:[\s,.\-/]{0,2}\d){7,}/;
/** 4+ single digits in a comma list ("1, 2, 3, 4"): a spoken code. */
const DIGIT_LIST_RE = /(?<!\d)\d(?:\s?,\s?\d(?!\d)){3,}/;

/** Memory text as stored: unsafe characters removed, one line, collapsed spaces, `<` `>` → `‹` `›`. */
export function cleanMemoryText(text: string): string {
  return stripUnsafe(String(text)).replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›');
}

/** True for text that looks like a password, code, card or account number (refused). */
export function memoryTextLooksSecret(text: string): boolean {
  // NFKC first: full-width digits ("４５１２") become ASCII so the digit rules see them; curly apostrophes too.
  const t = String(text).normalize('NFKC').replace(/[’‘]/g, "'");
  return MEMORY_SECRET_RE.test(t) || DIGIT_RUN_RE.test(t) || DIGIT_GROUPS_RE.test(t) || DIGIT_LIST_RE.test(t);
}

/** Clean and check one memory text: the stored form, or why it is refused. */
export function checkMemoryText(text: string): { text: string } | { reason: 'empty' | 'too-long' | 'secret' } {
  const t = cleanMemoryText(text);
  if (!t) return { reason: 'empty' };
  if (charLength(t) > MAX_MEMORY_CHARS) return { reason: 'too-long' };
  if (memoryTextLooksSecret(t)) return { reason: 'secret' };
  return { text: t };
}

export function isMemoryId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

/** A file on disk → a valid MemoryFile (bad items dropped, text re-checked: the file may be hand-edited), or null. */
export function parseMemoryFile(raw: unknown, maxItems = MAX_MEMORY_ITEMS): MemoryFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.items)) return null;
  const items: MemoryItem[] = [];
  const seen = new Set<string>();
  let maxN = 0;
  for (const it of r.items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (!isMemoryId(o.id) || seen.has(o.id) || typeof o.text !== 'string') continue;
    if (!MEMORY_SOURCES.includes(o.source as MemorySource) || !isIso(o.createdAt) || !isIso(o.updatedAt)) continue;
    const c = checkMemoryText(o.text);
    if (!('text' in c)) continue;
    seen.add(o.id);
    maxN = Math.max(maxN, Number(o.id.slice(1)));
    items.push({ id: o.id, text: c.text, source: o.source as MemorySource, createdAt: o.createdAt, updatedAt: o.updatedAt });
  }
  const next = typeof r.nextId === 'number' && Number.isInteger(r.nextId) && r.nextId > maxN && r.nextId < 1e9 ? r.nextId : maxN + 1;
  return { version: 1, nextId: next, items: items.slice(0, Math.min(maxItems, MAX_MEMORY_ITEMS)) };
}

export interface MemoryStoreOptions {
  /** Stephen home (`resolveStephenHome` / `cfg.home`). */
  home: string;
  /** Config `memory.maxItems` (clamped to 1 … MAX_MEMORY_ITEMS). */
  maxItems?: number;
  /** Where changes are recorded (text length only). */
  audit?: IAuditLog;
  now?: () => Date;
  /** Override LOCK_WAIT_MS / LOCK_STALE_MS (tests). */
  lockWaitMs?: number;
  lockStaleMs?: number;
}

type Op = 'add' | 'update' | 'forget' | 'clear';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MemoryStore {
  readonly path: string;
  readonly lockPath: string;
  readonly maxItems: number;
  private readonly home: string;
  private readonly audit: IAuditLog | undefined;
  private readonly now: () => Date;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;

  constructor(o: MemoryStoreOptions) {
    this.home = o.home;
    this.path = join(o.home, MEMORY_FILE);
    this.lockPath = join(o.home, MEMORY_LOCK_FILE);
    this.maxItems = Math.max(1, Math.min(MAX_MEMORY_ITEMS, Math.floor(o.maxItems ?? MAX_MEMORY_ITEMS)));
    this.audit = o.audit;
    this.now = o.now ?? (() => new Date());
    this.lockWaitMs = o.lockWaitMs ?? LOCK_WAIT_MS;
    this.lockStaleMs = o.lockStaleMs ?? LOCK_STALE_MS;
  }

  /** Every item, oldest first. Throws MemoryStoreError when memory.json exists but can't be used. */
  async list(): Promise<MemoryItem[]> {
    return this.listSync();
  }

  /** list(), synchronously (the voice runner reads memory right before spawning Claude). Same errors. */
  listSync(): MemoryItem[] {
    const f = this.read();
    if ('error' in f) throw new MemoryStoreError(f.error);
    return f.file.items;
  }

  async add(text: string, source: MemorySource): Promise<MemoryResult> {
    const c = checkMemoryText(text);
    if (!('text' in c)) return this.refuse('add', c.reason, text);
    if (!MEMORY_SOURCES.includes(source)) throw new Error(`unknown memory source ${JSON.stringify(source)}`);
    return this.change('add', c.text, (f) => {
      const same = f.items.find((i) => i.text.toLowerCase() === c.text.toLowerCase());
      if (same) return { item: same, duplicate: true };
      if (f.items.length >= this.maxItems) return 'full';
      const ts = this.now().toISOString();
      const item: MemoryItem = { id: `m${f.nextId}`, text: c.text, source, createdAt: ts, updatedAt: ts };
      f.nextId += 1;
      f.items.push(item);
      return { item };
    });
  }

  async update(id: string, text: string): Promise<MemoryResult> {
    if (!isMemoryId(id)) return this.refuse('update', 'not-found', text);
    const c = checkMemoryText(text);
    if (!('text' in c)) return this.refuse('update', c.reason, text, id);
    return this.change('update', c.text, (f) => {
      const item = f.items.find((i) => i.id === id);
      if (!item) return 'not-found';
      item.text = c.text;
      item.updatedAt = this.now().toISOString();
      return { item };
    }, id);
  }

  async forget(id: string): Promise<MemoryResult> {
    if (!isMemoryId(id)) return this.refuse('forget', 'not-found', '', id);
    return this.change('forget', '', (f) => {
      const i = f.items.findIndex((x) => x.id === id);
      if (i < 0) return 'not-found';
      const [item] = f.items.splice(i, 1);
      return { item: item! };
    }, id);
  }

  async clear(): Promise<MemoryResult> {
    return this.change('clear', '', (f) => {
      f.items = [];
      return {};
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private read(): { file: MemoryFile } | { error: string } {
    const r = readPrivateJsonFile(this.path);
    if ('missing' in r) return { file: { version: 1, nextId: 1, items: [] } };
    if ('error' in r) return { error: `${this.path} ${r.error}` };
    const file = parseMemoryFile(r.state, MAX_MEMORY_ITEMS);
    return file ? { file } : { error: `${this.path} is not a Stephen memory file` };
  }

  private async change(
    op: Op,
    text: string,
    apply: (f: MemoryFile) => { item?: MemoryItem; duplicate?: boolean } | 'full' | 'not-found',
    id?: string,
  ): Promise<MemoryResult> {
    const token = await this.lock();
    if (!token) return this.refuse(op, 'busy', text, id);
    let res: MemoryResult;
    try {
      const f = this.read();
      if ('error' in f) return await this.refuse(op, 'unreadable', text, id, f.error);
      const out = apply(f.file);
      if (out === 'full' || out === 'not-found') return await this.refuse(op, out, text, id);
      if (!out.duplicate) {
        try {
          writePrivateJsonFileSync(this.path, f.file);
        } catch (e) {
          return await this.refuse(op, 'write-failed', text, id, (e as Error).message);
        }
      }
      res = { ok: true, ...out, items: f.file.items };
    } finally {
      this.unlock(token);
    }
    if (!res.duplicate) {
      await this.record(op, 'ok', { id: res.item?.id ?? id, source: res.item?.source, length: text ? charLength(text) : undefined, items: res.items.length });
    }
    return res;
  }

  private async refuse(op: Op, reason: MemoryRefusal, text: string, id?: string, detail?: string): Promise<MemoryResult> {
    const length = text ? charLength(cleanMemoryText(text)) : undefined;
    await this.record(op, reason === 'secret' || reason === 'too-long' || reason === 'empty' || reason === 'full' ? 'denied' : 'error', {
      id,
      length,
      reason,
      ...(detail ? { detail } : {}),
    });
    return { ok: false, reason, message: MEMORY_MESSAGES[reason] };
  }

  private async record(op: Op, outcome: 'ok' | 'denied' | 'error', args: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const clean: Record<string, unknown> = { op };
    for (const [k, v] of Object.entries(args)) if (v !== undefined && k !== 'detail') clean[k] = v;
    try {
      await this.audit.append({
        tool: 'memory',
        args: clean,
        outcome,
        ...(outcome !== 'ok' ? { error: typeof args.detail === 'string' ? `${String(args.reason)}: ${args.detail}` : String(args.reason) } : {}),
      });
    } catch {
      /* auditing never blocks a memory change */
    }
  }

  /** Take memory.json.lock; null if another writer holds it for longer than lockWaitMs. */
  private async lock(): Promise<string | null> {
    try {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
    } catch {
      /* the open below reports it */
    }
    const token = `${process.pid} ${randomBytes(6).toString('hex')}`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try {
          writeSync(fd, `${token}\n`);
        } finally {
          closeSync(fd);
        }
        return token;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      }
      if (this.removeIfStale()) continue;
      if (Date.now() >= deadline) return null;
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }

  /** Remove the lock if its writer is gone (dead pid) or it is older than lockStaleMs. True if removed. */
  private removeIfStale(): boolean {
    let st;
    try {
      st = lstatSync(this.lockPath);
    } catch {
      return true; // released meanwhile: try again
    }
    const age = Date.now() - st.mtimeMs;
    const pid = Number(this.readLock()?.split(' ')[0]);
    const hasPid = st.isFile() && Number.isInteger(pid) && pid > 0;
    // No pid yet: maybe a writer between open and write, so only stale after a second.
    const stale = age > this.lockStaleMs || (hasPid ? !isPidAlive(pid) : age > 1000);
    if (!stale) return false;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* someone else removed it */
    }
    return true;
  }

  private readLock(): string | null {
    try {
      const fd = openSync(this.lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        return readFileSync(fd, 'utf8').trim();
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private unlock(token: string): void {
    if (this.readLock() !== token) return; // stolen as stale: not ours to remove
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* gone */
    }
  }
}
