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
