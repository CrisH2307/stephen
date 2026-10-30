/**
 * open_url scheme rules. Only web pages: `https:` opens (after the safety gate), `http:` asks the human
 * first, every other scheme is refused — `open` hands non-web URLs to whatever app claims the scheme
 * (file:, custom app schemes, mailto:, tel:, facetime:, zoommtg:, vscode:…), which turns "open a URL"
 * into running code or placing calls.
 */
import { HubError } from '../errors.js';
import { compilePatterns, findMatch, OPEN_ENDPOINT_DOMAINS, parseUrl } from '../safety/domains.js';

export const MAX_URL_CHARS = 4096;

export type UrlRule = 'https' | 'http';

export interface ParsedOpenUrl {
  /** Canonical href (spaces and quotes percent-encoded) — passed to `open` as ONE argv element. */
  href: string;
  host: string;
  rule: UrlRule;
}

/** Thrown for a URL that is refused by the scheme rules (audited as denied). */
export class UrlDenied extends HubError {
  constructor(message: string, readonly scheme: string) {
    super('DENIED', message);
  }
}

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

/**
 * Parse and classify a model-supplied URL. A bare host ("youtube.com", "www.youtube.com/watch?v=…") gets
 * https://. Throws UrlDenied for any scheme other than http(s), embedded credentials, or control characters;
 * HubError('INVALID_ARG') for something that is not a URL at all.
 */
export function parseOpenUrl(input: string): ParsedOpenUrl {
  const s = input.trim();
  if (!s) throw new HubError('INVALID_ARG', 'url is empty. Pass a full https:// address, e.g. https://www.youtube.com');
  if (s.length > MAX_URL_CHARS) throw new HubError('INVALID_ARG', `url is longer than ${MAX_URL_CHARS} characters.`);
  if (CONTROL_RE.test(s)) {
    throw new UrlDenied('The URL contains control or invisible formatting characters, so Stephen will not open it.', '');
  }
  let candidate: string;
  const m = SCHEME_RE.exec(s);
  if (s.startsWith('//')) candidate = `https:${s}`;
  else if (m) {
    const scheme = m[1]!.toLowerCase();
    // "example.com:8443/x" or "localhost:3000" is a host with a port, not a scheme.
    const hostPort = /^[A-Za-z0-9.-]+:\d{1,5}(?:[/?#]|$)/.test(s) && (scheme.includes('.') || scheme === 'localhost');
    if (scheme === 'http' || scheme === 'https') candidate = s;
    else if (hostPort) candidate = `https://${s}`;
    else {
      throw new UrlDenied(
        `${scheme}: links are not allowed. open_url only opens web pages (https://, or http:// with the user's OK); ` +
          `other schemes hand the link to another app (files, scripts, calls, messages, meetings, editors…). Ask the user to do this themselves.`,
        scheme,
      );
    }
  } else candidate = `https://${s}`;

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    throw new HubError('INVALID_ARG', `"${s.slice(0, 100)}" is not a valid URL. Pass a full address such as https://www.youtube.com`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new UrlDenied(`${u.protocol} links are not allowed; open_url only opens web pages.`, u.protocol.replace(/:$/, ''));
  }
  if (!u.hostname) throw new HubError('INVALID_ARG', `"${s.slice(0, 100)}" has no host name.`);
  if (u.username || u.password) {
    throw new UrlDenied(
      'URLs with a user name or password before the host ("https://name@host/") are not allowed — they are a common way to disguise the real site.',
      u.protocol.replace(/:$/, ''),
    );
  }
  return { href: u.href, host: u.host, rule: u.protocol === 'https:' ? 'https' : 'http' };
}

// ───────────────────── redirectors (the unattached `open -a` path) ─────────────────────

const OPEN_ENDPOINTS = compilePatterns(OPEN_ENDPOINT_DOMAINS);
/** "https:", "http:/x", "https:\\x" after decoding — an address inside another address. */
const EMBEDDED_URL_RE = /^https?:/i;
const PATH_URL_RE = /https?:[/\\]/i;

/** Percent-decode up to 3 times (double-encoded "%253A" too); stops at the first undecodable step. */
function decodeRepeatedly(s: string): string[] {
  const out = [s];
  let cur = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur.replace(/\+/g, ' '));
    } catch {
      break;
    }
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

export interface RedirectSignal {
  /** Why this URL may forward somewhere else (for the human's prompt and the audit). */
  reason: string;
  /** The embedded address, when one was found. */
  target?: string;
}

/**
 * Signs that `href` may forward the browser to ANOTHER site. The `open -a` path has no landing check
 * (Stephen never sees where the page ends up), so the blocked and sensitive lists only judged the first
 * hop. Returns every signal found ([] = none):
 *   - the URL is on the open-endpoint / redirector list (OPEN_ENDPOINT_DOMAINS: google.com/url, bit.ly, …);
 *   - a query (or fragment) parameter value decodes to an http(s): URL;
 *   - the path contains an (encoded) URL.
 */
/** `//host…` — a scheme-relative URL, resolved by browsers and redirect endpoints against https:. */
const SCHEME_RELATIVE_RE = /^\/\/[^/\s]+\.[^/\s]+/;
/** A bare host name with a public-looking TLD, optionally with a path: `chase.com`, `www.chase.com/login`. */
const BARE_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\.?(?::\d{1,5})?(?:[/?#].*)?$/i;

export function redirectSignals(href: string): RedirectSignal[] {
  const parsed = parseUrl(href);
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return [];
  }
  if (!parsed?.isWeb) return [];
  const out: RedirectSignal[] = [];
  const m = findMatch(parsed, OPEN_ENDPOINTS);
  if (m) out.push({ reason: `${m.raw} is a redirector or open endpoint: it can forward to any site` });

  const values = [...u.searchParams.values()];
  if (u.hash.length > 1) values.push(...new URLSearchParams(u.hash.slice(1)).values());
  for (const v of values) {
    // A full URL, a scheme-relative one (//chase.com/…) or a bare host (chase.com, chase.com/login) all
    // work as redirect targets for typical ?u= / ?next= / ?redirect= endpoints (review #3 verification, #5).
    const hit = decodeRepeatedly(v.trim()).find((d) => EMBEDDED_URL_RE.test(d.trim()) || SCHEME_RELATIVE_RE.test(d.trim()) || BARE_HOST_RE.test(d.trim()));
    if (hit) {
      out.push({ reason: 'a query parameter holds another web address', target: hit.trim().slice(0, 500) });
      break;
    }
  }
  const inPath = decodeRepeatedly(u.pathname).find((d) => PATH_URL_RE.test(d));
  if (inPath) {
    const at = inPath.search(PATH_URL_RE);
    out.push({ reason: 'the path contains another web address', target: inPath.slice(at, at + 500) });
  }
  return out;
}
