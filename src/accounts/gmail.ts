/**
 * Gmail, read-only (phase 2a, subtask 7). Two questions the owner asks by voice:
 *   - "any email from my prof?" / "do I have unread mail?" → gmail_search: sender name + domain, subject, date, snippet
 *   - "what does it say?"                                  → gmail_read: one message that gmail_search listed, as text
 * API: Gmail v1 on https://gmail.googleapis.com (GET only): `users/me/messages?q=…`, `users/me/messages/{id}`.
 * Auth: OAuth 2.0, scope gmail.readonly. The refresh token is in the Keychain (`stephen connect gmail <label>`,
 * src/connect/gmail-oauth.ts, which the model can't reach). An access token is fetched from
 * https://oauth2.googleapis.com/token on demand and kept in memory only (GmailAccess), never written anywhere.
 *
 * The model never writes Gmail query syntax: it gives a few fields and buildGmailQuery turns them into `q`, each value
 * cut down to plain words and quoted, so "x OR from:evil" stays a literal phrase. Message ids come from Google and are
 * shape-checked; gmail_read only accepts ids that gmail_search returned in this process (index.ts).
 */
import { AccountHttpError, ApiClient, type FetchFn } from './http.js';
import { htmlToText, field } from './result.js';
import { whenText } from './canvas.js';
import { GOOGLE_TOKEN_RE } from './secrets.js';

export const GMAIL_ORIGIN = 'https://gmail.googleapis.com';
export const GOOGLE_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const MAX_SEARCH = 10;
export const MAX_FROM_CHARS = 80;
export const MAX_SUBJECT_CHARS = 120;
export const MAX_DAYS = 30;
/** Characters of message text handed to the model (the body is for a spoken summary, not an archive). */
export const MAX_BODY_CHARS = 3000;
/** A Gmail message id: Google's are 16 hex digits; anything else alphanumeric and short is accepted, nothing more. */
export const GMAIL_ID_RE = /^[A-Za-z0-9]{6,64}$/;
/** Always part of `q`: mail the owner received, not their own drafts, sent mail or chats. */
const BASE_QUERY = '-in:sent -in:drafts -in:chats';

// ───────────── query builder (the only place `q` is written) ─────────────

export class GmailQueryError extends Error {}

/**
 * One filter value → plain words: letters, digits, spaces and `. @ _ ' & + -` survive; everything else (quotes,
 * backslashes, colons, braces, parentheses…) becomes a space, so no Gmail operator can be formed and the value
 * can't leave its quotes. Inside quotes Gmail treats OR/AND/-x as words.
 */
export function cleanQueryValue(raw: string, max: number): string {
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .@_'&+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export interface GmailFilters {
  from?: string | undefined;
  subject?: string | undefined;
  newerThanDays?: number | undefined;
  unreadOnly?: boolean | undefined;
}

/** The Gmail `q` string for these filters. A filter given but empty after cleaning is refused (never silently dropped). */
export function buildGmailQuery(f: GmailFilters): string {
  const parts = [BASE_QUERY];
  for (const [op, raw, max] of [['from', f.from, MAX_FROM_CHARS], ['subject', f.subject, MAX_SUBJECT_CHARS]] as const) {
    if (raw === undefined) continue;
    const v = cleanQueryValue(raw, max);
    if (!v) throw new GmailQueryError(`The ${op} filter has no usable words; use plain words like a name or a few subject words.`);
    parts.push(`${op}:"${v}"`);
  }
  if (f.newerThanDays !== undefined) {
    const d = Math.floor(f.newerThanDays);
    if (!Number.isFinite(d) || d < 1 || d > MAX_DAYS) throw new GmailQueryError(`newer_than_days must be 1 to ${MAX_DAYS}.`);
    parts.push(`newer_than:${d}d`);
  }
  if (f.unreadOnly) parts.push('is:unread');
  return parts.join(' ');
}

// ───────────── OAuth token endpoint ─────────────

export interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface GoogleHttpOptions {
  /** Tests: a fake server (with allowLoopbackHttp). */
  origin?: string;
  fetch?: FetchFn;
  allowLoopbackHttp?: boolean;
}

/**
 * POST https://oauth2.googleapis.com/<path> with a form (code exchange, refresh, revoke). Pinned origin, no redirects,
 * timeout, 64 KB cap. Errors carry the host and status only: never the form (code, verifier, tokens) or Google's body.
 */
export async function googleTokenCall(path: '/token' | '/revoke', form: Record<string, string>, o: GoogleHttpOptions = {}): Promise<GoogleTokenResponse> {
  const api = new ApiClient({ origin: o.origin ?? GOOGLE_TOKEN_ORIGIN, timeoutMs: 15_000, maxBytes: 64 * 1024, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
  const r = await api.postForm<GoogleTokenResponse>(path, form);
  return r && typeof r === 'object' ? r : {};
}

/** The scopes a token response granted, as a set. */
export const grantedScopes = (r: GoogleTokenResponse): Set<string> => new Set(String(r.scope ?? '').split(/\s+/).filter(Boolean));

/**
 * One Gmail account's access token: refreshed on demand from the refresh token, kept in memory until a minute before
 * it expires. Never persisted.
 */
export class GmailAccess {
  private cached: { token: string; until: number } | null = null;
  constructor(
    private readonly o: GoogleHttpOptions & { clientId: string; clientSecret: string | null; refreshToken: string; now?: () => number },
  ) {}

  async accessToken(): Promise<string> {
    const now = this.o.now ?? Date.now;
    if (this.cached && now() < this.cached.until) return this.cached.token;
    const r = await googleTokenCall(
      '/token',
      { grant_type: 'refresh_token', refresh_token: this.o.refreshToken, client_id: this.o.clientId, ...(this.o.clientSecret ? { client_secret: this.o.clientSecret } : {}) },
      this.o,
    );
    const token = typeof r.access_token === 'string' ? r.access_token : '';
    if (!GOOGLE_TOKEN_RE.test(token)) throw new AccountHttpError('oauth2.googleapis.com did not return an access token');
    if (r.scope !== undefined && !grantedScopes(r).has(GMAIL_SCOPE)) throw new AccountHttpError('the saved Gmail sign-in no longer has read access', 400);
    const life = Math.min(3600, Math.max(60, Number(r.expires_in) || 3600));
    this.cached = { token, until: now() + (life - 60) * 1000 };
    return token;
  }

  /** Forget the access token (after Gmail refused it). */
  drop(): void {
    this.cached = null;
  }
}

// ───────────── API shapes (only the parts Stephen reads) ─────────────

interface Header {
  name?: string;
  value?: string;
}
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

// ───────────── formatting (pure) ─────────────

const header = (m: GmailMessage, name: string): string => {
  const h = (m.payload?.headers ?? []).find((x) => typeof x?.name === 'string' && x.name.toLowerCase() === name.toLowerCase());
  return typeof h?.value === 'string' ? h.value.slice(0, 2000) : '';
};

/**
 * A From header → display name + the address's real domain only ("Dr Patel <ontariotechu.ca>"); never the full
 * address. The display name is the sender's own text, so it can't carry a domain of its own (review 7, R7-6): after
 * NFKC (so "＠" and "（" are caught), words that hold an "@" or look like a domain ("ontariotechu.ca") are dropped,
 * and so are parentheses and brackets. The angle brackets then hold only the domain from the address.
 */
export function senderText(from: string): string {
  const addr = /<([^<>\s]*)>\s*$/.exec(from)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(from)?.[0] ?? '';
  const at = addr.lastIndexOf('@');
  const domain = at >= 0 ? addr.slice(at + 1).toLowerCase() : '';
  const okDomain = /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : '';
  const name = from
    .replace(/<[^<>]*>\s*$/, '')
    .slice(0, 400)
    .normalize('NFKC')
    .replace(/[()[\]{}<>"]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !w.includes('@') && !/[\p{L}\p{N}-]\.\p{L}{2,}/u.test(w))
    .join(' ');
  const n = field(name, 60);
  if (n && okDomain) return `${n} <${okDomain}>`;
  return n || (okDomain ? `someone at ${okDomain}` : 'unknown sender');
}

function dateText(m: GmailMessage, timeZone?: string): string {
  const ms = Number(m.internalDate);
  if (Number.isFinite(ms) && ms > 0) return whenText(new Date(ms).toISOString(), timeZone);
  const d = header(m, 'Date');
  return d && !Number.isNaN(Date.parse(d)) ? whenText(new Date(Date.parse(d)).toISOString(), timeZone) : 'no date';
}

/** One search result line (the id is Google's, shape-checked; everything else is cleaned third-party text). */
export function formatSearchLine(m: GmailMessage, opts: { timeZone?: string } = {}): string {
  const unread = Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD');
  const snippet = field(m.snippet ?? '', 200);
  return `- id ${m.id} · ${dateText(m, opts.timeZone)} · ${senderText(header(m, 'From'))}${unread ? ' · unread' : ''} · "${field(header(m, 'Subject') || '(no subject)', 160)}"${snippet ? ` — ${snippet}` : ''}`;
}

/** Drop `<style>…</style>`, `<script>…</script>` and `<head>…</head>` with indexOf scans (linear time, review 6 R6-2). */
export function dropBlocks(html: string): string {
  const lower = html.toLowerCase();
  // `<tag` followed by `>`, `/` or white space (so `<head` doesn't match `<header`), from `from` on; -1 if none.
  const find = (tag: string, from: number): number => {
    for (let at = lower.indexOf(tag, from); at >= 0; at = lower.indexOf(tag, at + 1)) {
      if (/[\s/>]/.test(lower[at + tag.length] ?? '>')) return at;
    }
    return -1;
  };
  let out = '';
  let i = 0;
  // Next start of each tag at or after i (-1: none left). Each search moves forward only, so the whole scan is linear.
  const next = new Map(['style', 'script', 'head'].map((t) => [t, find(`<${t}`, 0)]));
  for (;;) {
    let at = -1;
    let name = '';
    for (const [t, pos] of next) {
      const a = pos >= 0 && pos < i ? find(`<${t}`, i) : pos;
      next.set(t, a);
      if (a >= 0 && (at < 0 || a < at)) [at, name] = [a, t];
    }
    if (at < 0) break;
    out += html.slice(i, at);
    const end = find(`</${name}`, at);
    if (end < 0) return out; // unclosed: the rest is that block
    const close = lower.indexOf('>', end);
    i = close < 0 ? html.length : close + 1;
  }
  return out + html.slice(i);
}

/** An element hidden by its own attributes: `hidden`, `aria-hidden="true"`, or an inline style that hides it. */
const HIDDEN_ATTR_RE = /\shidden(?=[\s=/>]|$)|aria-hidden\s*=\s*["']?true|display\s*:\s*none|visibility\s*:\s*hidden|(?:^|[\s;"'])(?:font-size|max-height|height|width|opacity)\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:[;"'!>]|$)/i;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Drop elements the reader can't see (review 7, R7-11): `hidden`, `aria-hidden="true"`, `display:none`,
 * `visibility:hidden`, zero size / font size / opacity in an inline style. Best effort (CSS classes are not looked
 * at). One forward scan over the tags; inside a hidden element only same-name tags are counted for nesting, so it
 * is linear time. An unclosed hidden element drops the rest.
 */
export function dropHidden(html: string): string {
  let out = '';
  let i = 0;
  let hiddenTag = '';
  let depth = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const gt = html.indexOf('>', lt);
    if (gt < 0) break; // no tag left: the rest is text
    const tag = html.slice(lt, gt + 1);
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    const name = m ? m[2]!.toLowerCase() : '';
    const closing = !!m?.[1];
    const selfClosing = VOID_TAGS.has(name) || tag.endsWith('/>');
    if (hiddenTag) {
      if (name === hiddenTag && !selfClosing) depth += closing ? -1 : 1;
      if (depth === 0) hiddenTag = '';
    } else {
      out += html.slice(i, lt);
      if (m && !closing && HIDDEN_ATTR_RE.test(tag.slice(m[0].length))) {
        if (!selfClosing) {
          hiddenTag = name;
          depth = 1;
        }
      } else out += tag;
    }
    i = gt + 1;
  }
  return hiddenTag ? out : out + html.slice(i);
}

const MAX_PARTS = 60;
const MAX_RAW_CHARS = 400_000;

const decode = (data: string): string => Buffer.from(data.slice(0, MAX_RAW_CHARS), 'base64url').toString('utf8');

/** The message text: the first text/plain part (not an attachment), else the first text/html one as text. */
export function messageText(payload: GmailPart | undefined): string {
  let plain: string | null = null;
  let html: string | null = null;
  let seen = 0;
  const walk = (p: GmailPart | undefined, depth: number) => {
    if (!p || depth > 10 || seen++ > MAX_PARTS || (plain !== null && html !== null)) return;
    const data = p.body?.data;
    const attachment = !!p.filename || !!p.body?.attachmentId;
    if (typeof data === 'string' && data && !attachment) {
      const type = (p.mimeType ?? '').toLowerCase();
      if (type === 'text/plain' && plain === null) plain = decode(data);
      else if (type === 'text/html' && html === null) html = decode(data);
    }
    for (const c of Array.isArray(p.parts) ? p.parts : []) walk(c, depth + 1);
  };
  walk(payload, 0);
  if (plain !== null) {
    // Quoted earlier messages ("> …") are dropped: the reply is what's new.
    return (plain as string)
      .split(/\r?\n/)
      .filter((l) => !/^\s*>/.test(l))
      .join('\n');
  }
  if (html !== null) return htmlToText(dropHidden(dropBlocks(html as string)));
  return '';
}

/** One message as lines: who, when, subject, then the cleaned text. */
export function formatMessage(m: GmailMessage, opts: { timeZone?: string } = {}): string[] {
  const body = field(messageText(m.payload), MAX_BODY_CHARS);
  return [
    `From: ${senderText(header(m, 'From'))}`,
    `Date: ${dateText(m, opts.timeZone)}`,
    `Subject: ${field(header(m, 'Subject') || '(no subject)', 200)}`,
    `Text: ${body || field(m.snippet ?? '', 400) || '(no text)'}`,
  ];
}

// ───────────── client ─────────────

export class GmailClient {
  readonly api: ApiClient;
  constructor(o: { token: string; origin?: string; fetch?: FetchFn; allowLoopbackHttp?: boolean }) {
    this.api = new ApiClient({ origin: o.origin ?? GMAIL_ORIGIN, token: o.token, timeoutMs: 15_000, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
  }

  /** Newest first: the ids matching `q` (at most `max`), then each one's headers and snippet. */
  async search(q: string, max: number): Promise<GmailMessage[]> {
    const n = Math.min(MAX_SEARCH, Math.max(1, Math.floor(max)));
    const list = await this.api.getJson<{ messages?: { id?: unknown }[] }>(`/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${n}`);
    const ids = (Array.isArray(list?.messages) ? list.messages : [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && GMAIL_ID_RE.test(id))
      .slice(0, n);
    const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
    const msgs = await Promise.all(ids.map((id) => this.api.getJson<GmailMessage>(`/gmail/v1/users/me/messages/${id}?${meta}`)));
    return msgs.map((m, i) => ({ ...m, id: ids[i] }));
  }

  /** One full message (the id must already be shape-checked and allowed). */
  async message(id: string): Promise<GmailMessage> {
    if (!GMAIL_ID_RE.test(id)) throw new AccountHttpError('not a Gmail message id');
    const m = await this.api.getJson<GmailMessage>(`/gmail/v1/users/me/messages/${id}?format=full`);
    return { ...m, id };
  }

  /** Connection check (`stephen connect`): the account's address. */
  async profile(): Promise<string> {
    const p = await this.api.getJson<{ emailAddress?: string }>('/gmail/v1/users/me/profile');
    return typeof p?.emailAddress === 'string' && /^[^\s<>"]{3,254}$/.test(p.emailAddress) ? p.emailAddress : 'unknown address';
  }
}
