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

// "<" lookalikes: characters a reader sees as an opening angle bracket. NFKC already folds U+FF1C and U+FE64. This is a
// reasoned subset of the UTS #39 confusables for "<", not the whole table (the rest is a follow-up).
export const LT_LOOKALIKES: readonly number[] = [
  0x00ab, // \u00ab left-pointing double angle quotation mark
  0x02c2, // \u02c2 modifier letter left arrowhead
  0x1438, // \u1438 canadian syllabics pa
  0x2039, // \u2039 single left-pointing angle quotation mark
  0x2329, // \u3008 left-pointing angle bracket
  0x22d6, // \u22d6 less-than with dot
  0x22d8, // \u22d8 very much less-than
  0x276c, // \u276c medium left-pointing angle bracket ornament
  0x276e, // \u276e heavy left-pointing angle quotation mark ornament
  0x2770, // \u2770 heavy left-pointing angle bracket ornament
  0x27e8, // \u27e8 mathematical left angle bracket
  0x27ea, // \u27ea mathematical left double angle bracket
  0x29fc, // \u29fc left-pointing curved angle bracket
  0x2aa1, // \u2aa1 double nested less-than
  0x3008, // \u3008 cjk left angle bracket
  0x300a, // \u300a left double angle bracket
];
// "/" lookalikes that may follow "<" in a closing tag. U+FF0F folds by NFKC; the rest need this list.
export const SLASH_LOOKALIKES: readonly number[] = [
  0x1735, // \u1735 philippine single punctuation
  0x2044, // \u2044 fraction slash
  0x2215, // \u2215 division slash
  0x2571, // \u2571 box drawings light diagonal upper right to lower left
  0x27cb, // \u27cb mathematical rising diagonal
  0x29f8, // \u29f8 big solidus
  0x2afd, // \u2afd double solidus operator
  0x3033, // \u3033 vertical kana repeat mark upper half
];
const LOOKALIKE_FOLD = new Map<number, string>([
  ...LT_LOOKALIKES.map((c): [number, string] => [c, '<']),
  ...SLASH_LOOKALIKES.map((c): [number, string] => [c, '/']),
]);
// Invisible to a reader and skipped by the match: default-ignorable code points (format characters, variation
// selectors, hangul fillers), format (Cf) characters and combining marks (Mn). Property classes, not a hand list.
const IGNORABLE_RE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}]/u;
// '<' + optional whitespace + optional '/' + 'untrusted_', any case. Runs on the folded copy only.
const DELIMITER_RE = /<\s*\/?\s*untrusted_/gi;

/** One code point for matching: lookalikes become "<" or "/", compatibility forms (fullwidth letters) fold to ASCII. */
function fold(cp: string): string {
  const hit = LOOKALIKE_FOLD.get(cp.codePointAt(0) ?? 0);
  if (hit) return hit;
  const n = cp.normalize('NFKC');
  return n.length === 1 ? n : cp;
}

/**
 * Neutralize each "<" that opens an `untrusted_` tag (web content and account data alike) as "&lt;". Matching runs on a
 * folded copy: ignorable characters dropped, lookalike brackets and slashes folded, fullwidth forms folded. Only the
 * opening character of each match is replaced in the original text, so everything else stays as written.
 */
export function escapeUntrustedTags(text: string): string {
  let folded = '';
  const origin = new Uint32Array(text.length); // folded unit -> original unit (folded is never longer than text)
  let n = 0;
  let at = 0;
  for (const cp of text) {
    const i = at;
    at += cp.length;
    if (cp < '\x80') {
      folded += cp;
      origin[n++] = i;
      continue;
    }
    if (IGNORABLE_RE.test(cp)) continue;
    const f = fold(cp);
    folded += f;
    for (let k = 0; k < f.length; k++) origin[n++] = i;
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
  const safe = escapeUntrustedTags(text);
  return `<untrusted_web_content source="${escapeAttr(source)}" origin="${escapeAttr(origin)}">\n${safe}\n</untrusted_web_content>`;
}

/** Redact a typed value for logs/prompts: '[23 chars] "Hello Mar…"' — secrets become '[redacted, 12 chars]'. */
export function redactValue(value: string, secret: boolean): string {
  return redact(value, secret);
}

/** Log-safe URL: origin + capped path, query → '?…', fragment → '#…' (for server-side audit args / recent_actions). */
export { redactUrl, digest } from './text.js';
