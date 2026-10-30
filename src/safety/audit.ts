/**
 * Append-only JSONL audit log (mode 0600), rotated at 5 MB keeping 3 old files:
 * audit.log → audit.log.1 → audit.log.2 → audit.log.3 (dropped).
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
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
 * typed values become their length only, secret-named keys are dropped.
 */
export function sanitizeEntry(entry: AuditEntry): AuditEntry {
  const out: AuditEntry = { ...entry };
  if (out.urlBefore !== undefined) out.urlBefore = redactUrl(out.urlBefore);
  if (out.urlAfter !== undefined) out.urlAfter = redactUrl(out.urlAfter);
  if (out.intent !== undefined) out.intent = clean(redactUrlsIn(out.intent), AUDIT_INTENT_MAX);
  if (out.element !== undefined) out.element = clean(out.element, 120);
  if (out.error !== undefined) out.error = clean(redactUrlsIn(out.error), 800);
  if (out.args) out.args = sanitizeArgs(scrubSecrets(out.args), '', 0) as Record<string, unknown>;
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
}

export class AuditLog implements IAuditLog {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private permsChecked = false;

  constructor(opts: AuditLogOptions) {
    this.path = opts.path;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
    this.now = opts.now ?? (() => new Date());
  }

  append(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    const full: AuditEntry = sanitizeEntry({ ...entry, ts: entry.ts ?? this.now().toISOString() });
    const line = `${JSON.stringify(full)}\n`;
    // Serialize writes so rotation never races an append.
    const run = this.queue.then(() => this.write(line));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(line: string): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = (await fs.stat(this.path)).size;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      await this.rotate();
      size = 0;
    }
    await fs.appendFile(this.path, line, { mode: 0o600 });
    if (!this.permsChecked || size === 0) {
      await fs.chmod(this.path, 0o600);
      this.permsChecked = true;
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
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (e) {
        if (isEnoent(e)) continue;
        throw e;
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        const l = lines[i]?.trim();
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
}
