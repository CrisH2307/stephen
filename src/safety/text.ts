/** Display-safe text helpers shared by policy messages, prompts and audit entries. */
import { createHash } from 'node:crypto';

// C0/C1 controls, bidi embeddings/overrides/isolates, zero-width chars, BOM, line/paragraph separators.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Replace control / bidi / zero-width characters with spaces (no collapsing, no truncation). */
export function stripUnsafe(s: string): string {
  return s.replace(UNSAFE_CHARS, ' ');
}

/** Strip control / bidi / zero-width characters, collapse whitespace, truncate to `max` code points (… appended). */
export function clean(s: string | null | undefined, max = 120): string {
  if (!s) return '';
  const flat = stripUnsafe(s).replace(/\s+/g, ' ').trim();
  return truncate(flat, max);
}

/** Truncate to at most `max` code points, ending with '…' when cut. */
export function truncate(s: string, max: number): string {
  const cps = [...s];
  if (cps.length <= max) return s;
  return `${cps.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Code-point length (so emoji count as one char). */
export function charLength(s: string): number {
  return [...s].length;
}

const UNSAFE_ONE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** UNSAFE_ONE minus \n and \t. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

function escapeCp(c: string): string {
  return `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`;
}

/**
 * Make every character visible for a human approving it: line breaks → '⏎', tabs → '⇥', other
 * control / bidi / zero-width characters → '\u{202E}'-style escapes. Nothing is dropped, so what
 * the human reads is exactly what will be sent (unlike `clean`, which removes such characters).
 */
export function visible(s: string): string {
  return s.replace(/\r\n|[\r\n]/g, '⏎').replace(/\t/g, '⇥').replace(UNSAFE_ONE, escapeCp);
}

/** Like `visible`, but keeps line breaks and tabs (for multi-line code shown in full). */
export function visibleCode(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(HIDDEN, escapeCp);
}

/** True when `s` holds control / bidi / zero-width characters other than \n and \t. */
export function hasHiddenChars(s: string): boolean {
  return new RegExp(HIDDEN.source).test(s);
}

/** '[123 chars, sha256:0a1b2c3d4e5f]' — lets an audit reader match a value without storing it. */
export function digest(s: string): string {
  const n = charLength(s);
  return `[${n} ${n === 1 ? 'char' : 'chars'}, sha256:${createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)}]`;
}

/** Path chars kept by redactUrl. */
export const URL_PATH_MAX = 80;

/**
 * URL safe to log: origin + path (path capped at URL_PATH_MAX), query string → '?…', fragment → '#…',
 * credentials dropped. Non-web URLs keep only their scheme (+ 'blank'/'srcdoc' for about:).
 */
export function redactUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return `[unparsable URL, ${charLength(raw)} chars]`;
  }
  if (u.protocol === 'about:') return u.pathname === 'blank' || u.pathname === 'srcdoc' ? `about:${u.pathname}` : 'about:…';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const host = u.host ? `//${u.host}` : '';
    return `${u.protocol}${host}${u.pathname || u.search || u.hash ? '…' : ''}`;
  }
  const path = truncate(stripUnsafe(u.pathname), URL_PATH_MAX);
  return `${u.origin}${path}${u.search ? '?…' : ''}${u.hash ? '#…' : ''}`;
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
