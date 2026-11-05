/**
 * play_media's resolver: find the best YouTube video for a query WITHOUT a browser, by fetching the public
 * search results page (`https://www.youtube.com/results?search_query=…`) server-side and reading the
 * `ytInitialData` JSON the page embeds. Nothing else is ever fetched: the URL is built here from a fixed
 * origin and path, redirects are refused (a consent or sign-in redirect just means "fall back"), no cookies
 * or credentials are sent, the body is capped and the whole fetch has a short timeout.
 *
 * Everything returned (title, channel, duration) is page-controlled text: callers must wrap it as untrusted.
 * The video id is validated against `^[A-Za-z0-9_-]{11}$`, so the watch URL built from it is safe.
 */
import { readCappedBody } from '../lib/http-body.js';

export const YT_SEARCH_ORIGIN = 'https://www.youtube.com';
export const YT_SEARCH_PATH = '/results';
export const MEDIA_FETCH_TIMEOUT_MS = 4000;
export const MEDIA_MAX_BYTES = 3 * 1024 * 1024;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const MAX_QUERY_CHARS = 200;

/** A normal desktop browser User-Agent: YouTube serves a slimmer page (without ytInitialData) to unknown clients. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export type MediaService = 'youtube' | 'youtube_music';

/** How long play_media watches the player after the page loaded, and how often (tests shorten these). */
export interface MediaTiming {
  pollMs: number;
  playerWaitMs: number;
  resultsWaitMs: number;
}

/** The subset of WHATWG fetch play_media uses (Node's global fetch fits; tests pass a fake). */
export interface MediaFetchInit {
  method: 'GET';
  headers: Record<string, string>;
  redirect: 'manual';
  credentials: 'omit';
  signal: AbortSignal;
}
export interface MediaResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}
export type FetchFn = (url: string, init: MediaFetchInit) => Promise<MediaResponse>;

export interface VideoHit {
  videoId: string;
  title: string;
  channel: string;
  /** "3:14", or '' when the page gave none. */
  duration: string;
  /** 'video' normally; 'live' / 'short' only when nothing else matched. */
  kind: 'video' | 'live' | 'short';
}

/** Why resolving failed (for the audit log and the fallback note; server-authored, never page text). */
export class ResolveError extends Error {
  constructor(
    readonly reason: 'timeout' | 'http' | 'redirect' | 'too-large' | 'no-data' | 'malformed' | 'no-results' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

export function searchUrl(query: string): string {
  const u = new URL(YT_SEARCH_PATH, YT_SEARCH_ORIGIN);
  u.searchParams.set('search_query', query);
  return u.href;
}

/** What opens in the browser when no video could be resolved. */
export function searchPageUrl(query: string, service: MediaService): string {
  if (service === 'youtube_music') {
    const u = new URL('https://music.youtube.com/search');
    u.searchParams.set('q', query);
    return u.href;
  }
  return searchUrl(query);
}

export function watchUrl(videoId: string, service: MediaService): string {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error('invalid video id');
  return `${service === 'youtube_music' ? 'https://music.youtube.com' : 'https://www.youtube.com'}/watch?v=${videoId}`;
}

/** True for exactly the one URL shape play_media may fetch (defence in depth: checked again right before fetch). */
export function isAllowedFetchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.host === 'www.youtube.com' &&
      u.pathname === YT_SEARCH_PATH &&
      !u.username &&
      !u.password &&
      !u.hash &&
      [...u.searchParams.keys()].every((k) => k === 'search_query')
    );
  } catch {
    return false;
  }
}


/** Fetch the search results page: GET, no cookies, no redirects, desktop UA, timeout, size cap. */
export async function fetchResultsPage(query: string, fetchFn: FetchFn, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  const url = searchUrl(query);
  if (!isAllowedFetchUrl(url)) throw new ResolveError('network', 'refused to fetch an unexpected URL');
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new ResolveError('timeout', `YouTube did not answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });
  try {
    const work = (async () => {
      let res: MediaResponse;
      try {
        res = await fetchFn(url, {
          method: 'GET',
          headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
          redirect: 'manual',
          credentials: 'omit',
          signal: ac.signal,
        });
      } catch (e) {
        if (e instanceof ResolveError) throw e;
        throw new ResolveError('network', 'could not reach YouTube');
      }
      if (res.status >= 300 && res.status < 400) throw new ResolveError('redirect', `YouTube redirected the search (HTTP ${res.status}), e.g. to a consent page`);
      if (res.status !== 200) throw new ResolveError('http', `YouTube answered HTTP ${res.status}`);
      const max = opts.maxBytes ?? MEDIA_MAX_BYTES;
      return readCappedBody(res, max, () => new ResolveError('too-large', `the results page is larger than ${max} bytes`));
    })();
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── ytInitialData ─────────────────────────────

const MARKERS = ['var ytInitialData = ', 'window["ytInitialData"] = ', "window['ytInitialData'] = ", 'ytInitialData = '];

/** The JSON object literal starting at `start` (a '{'), by brace matching that respects strings. */
function objectAt(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Extract and parse `ytInitialData` from the results page HTML. Throws ResolveError('no-data' | 'malformed'). */
export function extractInitialData(html: string): unknown {
  for (const m of MARKERS) {
    const at = html.indexOf(m);
    if (at < 0) continue;
    let i = at + m.length;
    while (i < html.length && /\s/.test(html[i]!)) i++;
    if (html[i] === "'") {
      // Some pages carry it as a JS string literal ('{\x22…'): not worth decoding — treat as no data.
      throw new ResolveError('no-data', 'the results page has no readable ytInitialData');
    }
    if (html[i] !== '{') continue;
    const obj = objectAt(html, i);
    if (!obj) throw new ResolveError('malformed', 'ytInitialData is cut off');
    try {
      return JSON.parse(obj) as unknown;
    } catch {
      throw new ResolveError('malformed', 'ytInitialData is not valid JSON');
    }
  }
  throw new ResolveError('no-data', 'the results page has no ytInitialData');
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function text(v: unknown): string {
  if (!isObj(v)) return '';
  if (typeof v.simpleText === 'string') return v.simpleText;
  if (Array.isArray(v.runs)) return v.runs.map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : '')).join('');
  return '';
}

function badgeStyles(vr: Json): string[] {
  const out: string[] = [];
  for (const key of ['badges', 'ownerBadges', 'thumbnailOverlays']) {
    const list = vr[key];
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!isObj(b)) continue;
      for (const inner of Object.values(b)) {
        if (isObj(inner) && typeof inner.style === 'string') out.push(inner.style);
        if (isObj(inner) && typeof inner.label === 'string') out.push(inner.label);
      }
    }
  }
  return out;
}

/** A videoRenderer → hit, or null when it is not a usable video (ad, invalid id…). */
function hitOf(vr: Json): VideoHit | null {
  const videoId = typeof vr.videoId === 'string' ? vr.videoId : '';
  if (!VIDEO_ID_RE.test(videoId)) return null;
  const styles = badgeStyles(vr);
  if (styles.some((s) => /^(?:BADGE_STYLE_TYPE_AD|Ad|Sponsored)$/i.test(s)) || 'adPlacementRenderer' in vr || 'promotedVideoRenderer' in vr) return null;
  const nav = isObj(vr.navigationEndpoint) ? vr.navigationEndpoint : {};
  const url = isObj(nav.commandMetadata) && isObj(nav.commandMetadata.webCommandMetadata) ? String(nav.commandMetadata.webCommandMetadata.url ?? '') : '';
  const short = 'reelWatchEndpoint' in nav || url.startsWith('/shorts/') || styles.includes('SHORTS');
  const live = styles.some((s) => /LIVE/i.test(s)) || (!vr.lengthText && Array.isArray(vr.badges) && styles.some((s) => /live/i.test(s)));
  const channel = text(vr.ownerText) || text(vr.longBylineText) || text(vr.shortBylineText);
  return {
    videoId,
    title: text(vr.title),
    channel,
    duration: text(vr.lengthText),
    kind: short ? 'short' : live || !vr.lengthText ? 'live' : 'video',
  };
}

/** Every videoRenderer in document order, with whether it sat directly in a results list (not inside a shelf). */
function collect(node: unknown, out: { vr: Json; topLevel: boolean }[], inShelf: boolean, depth: number): void {
  if (depth > 40) return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out, inShelf, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    // Ads never count, whatever they contain.
    if (/^(?:adSlotRenderer|promotedVideoRenderer|promotedSparklesWebRenderer|searchPyvRenderer|adPlacementRenderer|movieRenderer)$/.test(k)) continue;
    if (k === 'videoRenderer' && isObj(v)) {
      out.push({ vr: v, topLevel: !inShelf });
      continue;
    }
    // Playlists, mixes, channels and shorts shelves are skipped as results, but their nested videos are
    // remembered as "inside a shelf" (used only if nothing better exists).
    const shelf = inShelf || /^(?:shelfRenderer|reelShelfRenderer|richShelfRenderer|horizontalCardListRenderer|playlistRenderer|radioRenderer|channelRenderer|universalWatchCardRenderer)$/.test(k);
    collect(v, out, shelf, depth + 1);
  }
}

/** The best video in parsed ytInitialData: first top-level normal video; else any normal video; else a live/short. */
export function pickVideo(data: unknown): VideoHit {
  if (!isObj(data)) throw new ResolveError('malformed', 'ytInitialData is not an object');
  const found: { vr: Json; topLevel: boolean }[] = [];
  collect(data.contents ?? data, found, false, 0);
  const hits = found.map((f) => ({ hit: hitOf(f.vr), topLevel: f.topLevel })).filter((h): h is { hit: VideoHit; topLevel: boolean } => h.hit !== null);
  const best =
    hits.find((h) => h.topLevel && h.hit.kind === 'video') ??
    hits.find((h) => h.hit.kind === 'video') ??
    hits.find((h) => h.hit.kind === 'live') ??
    hits.find((h) => h.hit.kind === 'short');
  if (!best) throw new ResolveError('no-results', 'the search returned no playable video');
  return best.hit;
}

/** Fetch + parse + pick. Throws ResolveError. */
export async function resolveYouTube(query: string, fetchFn: FetchFn, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<VideoHit> {
  const html = await fetchResultsPage(query, fetchFn, opts);
  return pickVideo(extractInitialData(html));
}

/** Node's global fetch, narrowed to FetchFn. */
export const nodeFetch: FetchFn = (url, init) => fetch(url, init) as unknown as Promise<MediaResponse>;
