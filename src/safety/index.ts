// Safety layer entry point — owned by worktree wt-safety. Export signatures are a frozen contract.
import type { ConfirmPrompt, Confirmer, IAuditLog, ISafetyGate, ResolvedConfig } from '../types.js';
import { AuditLog } from './audit.js';
import { buildConfirmer, redactValue as redact } from './confirm.js';
import { SafetyGate } from './gate.js';
import type { LandingVerdict } from './policy.js';

export type ElicitFn = (prompt: ConfirmPrompt) => Promise<'accept' | 'decline' | 'cancel'>;

export interface SafetyDeps {
  /** Present when the MCP client advertised the elicitation capability. */
  elicit?: ElicitFn;
  /** Override the confirmer entirely (tests). */
  confirmer?: Confirmer;
  /** Defaults to process.platform; 'darwin' enables the osascript dialog. */
  platform?: NodeJS.Platform;
  /** Clock for rate limiting (tests). */
  now?: () => number;
  /** `serve --trust wake`: written on the private-read audit lines (absent = trusted). */
  trust?: 'wake';
  /**
   * `serve --command-file`: the listener's command id, asked by the audit log for each entry it writes (`cmd`).
   * A label only. It goes to the audit log and nowhere else: the gate is built without it.
   */
  commandId?: () => string | undefined;
}

export function createSafety(cfg: ResolvedConfig, deps?: SafetyDeps): { gate: ISafetyGate; audit: IAuditLog } {
  const audit = new AuditLog({ path: cfg.auditLogPath, ...(deps?.commandId ? { commandId: deps.commandId } : {}) });
  const confirmer =
    deps?.confirmer ?? buildConfirmer(cfg.safety, { elicit: deps?.elicit, platform: deps?.platform, home: cfg.home });
  const gate = new SafetyGate({ safety: cfg.safety, confirmer, audit, now: deps?.now, ...(deps?.trust ? { trust: deps.trust } : {}) });
  return { gate, audit };
}

export type { LandingVerdict };

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Opening-bracket lookalikes that NFKC does not fold to "<" (NFKC does fold U+FF1C and U+FE64).
const BRACKET_LOOKALIKES = new Set(['\u2039', '\u2329', '\u276c', '\u27e8', '\u3008', '\u300a']);
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/;
// '<' + optional whitespace + optional '/' + 'untrusted_web_content', any case. Runs on the folded copy only.
const DELIMITER_RE = /<\s*\/?\s*untrusted_web_content/gi;

/** One UTF-16 unit for matching: lookalike brackets become "<", compatibility forms (fullwidth letters, solidus) fold to ASCII. */
function fold(ch: string): string {
  if (BRACKET_LOOKALIKES.has(ch)) return '<';
  const n = ch.normalize('NFKC');
  return n.length === 1 ? n : ch;
}

/**
 * Neutralize each "<" that opens a delimiter-like sequence as "&lt;". Matching runs on a folded copy (any case,
 * lookalike brackets and fullwidth forms folded, zero-width characters skipped). Only the opening character of each
 * match is replaced in the original text, so everything else stays as written.
 */
function escapeDelimiters(text: string): string {
  let folded = '';
  const origin = new Uint32Array(text.length); // folded index -> original index (one unit per kept character)
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ZERO_WIDTH.test(ch)) continue;
    folded += ch < '\x80' ? ch : fold(ch);
    origin[n++] = i;
  }
  const opens = new Set<number>();
  for (const m of folded.matchAll(DELIMITER_RE)) opens.add(origin[m.index ?? 0] ?? 0);
  if (opens.size === 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) out += opens.has(i) ? '&lt;' : text.charAt(i);
  return out;
}

/**
 * Wrap page-derived text so the model treats it as data:
 * <untrusted_web_content source="z1" origin="https://example.com">…</untrusted_web_content>
 * Any occurrence of "</untrusted_web_content" (or an opening tag) inside `text` is neutralized as "&lt;…".
 */
export function wrapUntrusted(source: string, url: string, text: string): string {
  let origin = 'unknown';
  try {
    const u = new URL(url);
    origin = u.origin !== 'null' ? u.origin : u.protocol === 'about:' ? u.href.split(/[?#]/)[0] ?? u.protocol : u.protocol;
  } catch {
    /* unknown */
  }
  const safe = escapeDelimiters(text);
  return `<untrusted_web_content source="${escapeAttr(source)}" origin="${escapeAttr(origin)}">\n${safe}\n</untrusted_web_content>`;
}

/** Redact a typed value for logs/prompts: '[23 chars] "Hello Mar…"' — secrets become '[redacted, 12 chars]'. */
export function redactValue(value: string, secret: boolean): string {
  return redact(value, secret);
}

/** Log-safe URL: origin + capped path, query → '?…', fragment → '#…' (for server-side audit args / recent_actions). */
export { redactUrl, digest } from './text.js';
