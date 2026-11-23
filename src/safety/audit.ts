/**
 * Append-only JSONL audit log (mode 0600), rotated at 5 MB keeping 3 old files:
 * audit.log → audit.log.1 → audit.log.2 → audit.log.3 (dropped).
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { validCommandId } from '../lib/command-id.js';
import type { AuditEntry, IAuditLog } from '../types.js';
import { charLength, clean, digest, redactUrl, stripUnsafe, truncate } from './text.js';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 3;

/** Keys that must never reach disk, even if a caller forgets to redact. */
const SECRET_KEY_RE = /^(?:password|passwd|pwd|otp|code|cvv|cvc|csc|card|cardnumber|card_number|pin|secret)$|password|passwd|cvv|cvc/i;

/** Deep copy with secret-named keys dropped (defensive; callers already pass redacted args). */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = scrubSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ───────────────────────────── Privacy sanitization (review R1) ─────────────────────────────

/** Max intent chars kept (control/bidi chars stripped). */
export const AUDIT_INTENT_MAX = 200;
const URL_IN_TEXT_RE = /\b(?:https?|wss?|ftp|file|chrome|data|javascript|blob):[^\s"'<>]*/gi;
/** Keys whose values are code / dialog text: kept only as length + hash. */
const DIGEST_KEY_RE = /^(?:expression|code|script|prompt_?text|promptText)$/i;
/** Keys holding typed values: kept only as their length — no preview (a refused or partly typed value may be a secret). */
const TYPED_KEY_RE = /^(?:text|value|values|typed)$/i;
const DIGEST_FORM_RE = /^\[\d+ chars?, sha256:[0-9a-f]+\]$/;
const REDACTED_FORM_RE = /^\[(?:redacted, )?(\d+) chars?\](?: "[^"]{0,12}")?$/;

/** Replace every URL inside free text by its redacted form (origin + path, ?…/#…). */
export function redactUrlsIn(s: string): string {
  return s.replace(URL_IN_TEXT_RE, (m) => redactUrl(m));
}

function sanitizeString(key: string, v: string): string {
  if (DIGEST_KEY_RE.test(key)) {
    if (DIGEST_FORM_RE.test(v)) return v;
    const m = REDACTED_FORM_RE.exec(v); // a caller-redacted preview: drop the preview too
    return m ? `[${m[1]} chars]` : digest(v);
  }
  if (TYPED_KEY_RE.test(key)) {
    if (REDACTED_FORM_RE.test(v)) return v.replace(/ "[^"]{0,12}"$/, ''); // caller-redacted: drop any preview
    const n = charLength(v);
    return `[${n} ${n === 1 ? 'char' : 'chars'}]`;
  }
  if (/url|href|action/i.test(key)) return redactUrl(v);
  return truncate(redactUrlsIn(stripUnsafe(v)), 300);
}

function sanitizeArgs(value: unknown, key: string, depth: number): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return sanitizeString(key, value);
  if (Array.isArray(value)) return value.map((v) => sanitizeArgs(v, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeArgs(v, k, depth + 1);
    return out;
  }
  return value;
}

/**
 * Defense in depth for every entry written (gate's and the server's): URLs lose query/fragment,
 * intent is capped and stripped of control characters, code/prompt text become length + hash,
 * typed values become their length only, secret-named keys are dropped. `cmd` stays only as a valid command id.
 */
export function sanitizeEntry(entry: AuditEntry): AuditEntry {
  const out: AuditEntry = { ...entry };
  if (out.urlBefore !== undefined) out.urlBefore = redactUrl(out.urlBefore);
  if (out.urlAfter !== undefined) out.urlAfter = redactUrl(out.urlAfter);
  if (out.intent !== undefined) out.intent = clean(redactUrlsIn(out.intent), AUDIT_INTENT_MAX);
  if (out.element !== undefined) out.element = clean(out.element, 120);
  if (out.error !== undefined) out.error = clean(redactUrlsIn(out.error), 800);
  if (out.args) out.args = sanitizeArgs(scrubSecrets(out.args), '', 0) as Record<string, unknown>;
  if ('cmd' in out && !validCommandId(out.cmd)) delete out.cmd;
  return out;
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

export interface AuditLogOptions {
  path: string;
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
  /**
   * `serve --command-file`: asked once per entry, when append() is called. Its id is written as `cmd`.
   * A throw or a bad id means the entry is written without `cmd`. An entry never brings its own `cmd`.
   */
  commandId?: () => string | undefined;
  /** Internal: bytes per read in `recent()`. Tests set it small to hit chunk edges. */
  readChunkBytes?: number;
}

const READ_CHUNK_BYTES = 64 * 1024;

export class AuditLog implements IAuditLog {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;
  private readonly commandId: (() => string | undefined) | undefined;
  private readonly readChunkBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: AuditLogOptions) {
    this.path = opts.path;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
    this.now = opts.now ?? (() => new Date());
    this.commandId = opts.commandId;
    this.readChunkBytes = Math.max(1, opts.readChunkBytes ?? READ_CHUNK_BYTES);
  }

  append(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    let cmd: string | undefined;
    try {
      cmd = this.commandId?.();
    } catch {
      cmd = undefined;
    }
    // `cmd` comes from this log's own reader only, so a caller can't label an entry itself.
    const { cmd: _ignored, ...rest } = entry as AuditEntry;
    const full: AuditEntry = sanitizeEntry({ ...rest, ts: entry.ts ?? this.now().toISOString(), ...(cmd !== undefined ? { cmd } : {}) });
    const line = `${JSON.stringify(full)}\n`;
    // Serialize writes so rotation never races an append.
    const run = this.queue.then(() => this.write(line));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Size of the current file as last seen; undefined = stat again (first write, after a rotate or any error). */
  private size: number | undefined;

  private async knownSize(): Promise<number> {
    if (this.size === undefined) {
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        this.size = (await fs.stat(this.path)).size;
      } catch (e) {
        if (!isEnoent(e)) throw e;
        this.size = 0;
      }
    }
    return this.size;
  }

  private async write(line: string, retry = true): Promise<void> {
    const bytes = Buffer.byteLength(line);
    let writing = false; // set once the line may be (partly) on disk: a failure after that is never retried
    try {
      let size = await this.knownSize();
      if (size > 0 && size + bytes > this.maxBytes) {
        this.size = undefined; // the file may have been rotated or removed from outside: check before rotating
        size = await this.knownSize();
        if (size > 0 && size + bytes > this.maxBytes) {
          await this.rotate();
          this.size = undefined;
          size = await this.knownSize();
        }
      }
      // fstat the open file on every write: a file recreated from outside (logrotate `create 0644`) gets 0600 back
      // before our line goes in, and the size kept in memory comes from the file we really write to.
      // 'a+' (not 'a') so the last byte can be read: a torn line from an earlier failed write has no "\n" at its end,
      // and the next line must start on a line of its own, never join the torn one.
      const fh = await fs.open(this.path, 'a+', 0o600);
      try {
        const st = await fh.stat();
        if ((st.mode & 0o777) !== 0o600) await fh.chmod(0o600);
        let prefix = '';
        if (st.size > 0) {
          const last = Buffer.alloc(1);
          await fh.read(last, 0, 1, st.size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        }
        writing = true;
        await fh.appendFile(prefix + line);
        size = st.size + prefix.length;
      } finally {
        await fh.close();
      }
      this.size = size + bytes;
    } catch (e) {
      this.size = undefined;
      // A stale size or a removed dir must not lose the entry: stat again and try once more.
      if (retry && !writing) return this.write(line, false);
      throw e;
    }
  }

  private async rotate(): Promise<void> {
    await fs.rm(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        await fs.rename(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }
    await fs.rename(this.path, `${this.path}.1`);
  }

  /** Newest first, at most `limit`: audit.log, then audit.log.1, .2 … until satisfied. Malformed lines are skipped. */
  async recent(limit: number): Promise<AuditEntry[]> {
    await this.queue;
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    const out: AuditEntry[] = [];
    const files = [this.path, ...Array.from({ length: this.keep }, (_, i) => `${this.path}.${i + 1}`)];
    for (const file of files) {
      for await (const line of this.linesFromEnd(file)) {
        if (out.length >= n) break;
        const l = line.trim();
        if (!l) continue;
        try {
          const parsed: unknown = JSON.parse(l);
          if (parsed && typeof parsed === 'object' && typeof (parsed as AuditEntry).ts === 'string') {
            out.push(parsed as AuditEntry);
          }
        } catch {
          /* skip malformed line */
        }
      }
      if (out.length >= n) break;
    }
    return out;
  }

  /**
   * The lines of `file`, last first, read from the end in byte chunks. A line cut at a chunk edge
   * is joined with the rest before it is decoded, so UTF-8 is decoded per whole line. Missing file = no lines.
   */
  private async *linesFromEnd(file: string): AsyncGenerator<string> {
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(file, 'r');
    } catch (e) {
      if (isEnoent(e)) return;
      throw e;
    }
    try {
      let pos = (await fh.stat()).size;
      let carry = Buffer.alloc(0); // start of a line whose beginning is in an earlier chunk
      while (pos > 0) {
        const len = Math.min(this.readChunkBytes, pos);
        pos -= len;
        const chunk = Buffer.alloc(len);
        const { bytesRead } = await fh.read(chunk, 0, len, pos);
        // ponytail: a line longer than the chunk is joined by concat, O(line^2 / chunk); fine for audit lines.
        const buf = carry.length ? Buffer.concat([chunk.subarray(0, bytesRead), carry]) : chunk.subarray(0, bytesRead);
        let end = buf.length;
        let nl = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1;
        while (nl !== -1) {
          yield buf.toString('utf8', nl + 1, end);
          end = nl;
          nl = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1;
        }
        carry = buf.subarray(0, end);
      }
      yield carry.toString('utf8');
    } finally {
      await fh.close();
    }
  }
}
