/**
 * The only way account tools talk to the network: a GET-only JSON/text client pinned to ONE origin.
 *  - The origin is fixed when the client is made (Canvas base URL, api.notion.com, …); every request is a path on
 *    it. A path that resolves to another origin is refused, so Claude-chosen filters can never steer a request
 *    elsewhere (the tools never take URLs from Claude anyway).
 *  - GET; POST only for read-only query APIs (JSON) and OAuth token endpoints (form).
 *  - https only (plain http only for loopback, and only when `allowLoopbackHttp` is set: tests).
 *  - No redirects (`redirect: 'manual'`; a 3xx is an error), timeout per request, response size cap.
 *  - Pagination by RFC 8288 `Link: <…>; rel="next"` (Canvas), same origin only, at most `maxPages`.
 *  - The bearer token goes in the Authorization header only; error messages never contain it or the response body.
 */
import { readCappedBody } from '../lib/http-body.js';

export class AccountHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AccountHttpError';
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** e.g. "https://learn.ontariotechu.ca" — only scheme + host (+ port) are kept. */
  origin: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra fixed headers (e.g. Notion-Version). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  fetch?: FetchFn;
  /** Tests: allow http://127.0.0.1 / localhost. */
  allowLoopbackHttp?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_PAGES = 5;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Validate an origin string; returns the normalized origin or throws. */
export function checkOrigin(raw: string, allowLoopbackHttp = false): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AccountHttpError(`not a valid address: ${raw.slice(0, 100)}`);
  }
  if (u.username || u.password) throw new AccountHttpError('the address must not contain a user name or password');
  if (u.protocol === 'http:' && !(allowLoopbackHttp && LOOPBACK.has(u.hostname))) throw new AccountHttpError('only https:// addresses are allowed');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AccountHttpError('only https:// addresses are allowed');
  return u.origin;
}

/** The `rel="next"` URL of a Link header, or null. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (m && /\brel="?next"?/i.test(m[2]!)) return m[1]!;
  }
  return null;
}

export class ApiClient {
  readonly origin: string;
  private readonly o: ApiClientOptions;
  constructor(o: ApiClientOptions) {
    this.o = o;
    this.origin = checkOrigin(o.origin, o.allowLoopbackHttp);
  }

  /** Absolute URL for a path on the pinned origin; throws if it would leave the origin. */
  url(pathAndQuery: string): string {
    const u = new URL(pathAndQuery, this.origin);
    if (u.origin !== this.origin) throw new AccountHttpError('request left the account origin — refused');
    return u.href;
  }

  private async fetchOnce(href: string, init: { method?: 'GET' | 'POST'; body?: string; form?: boolean } = {}): Promise<{ text: string; res: Response }> {
    const u = new URL(href);
    if (u.origin !== this.origin) throw new AccountHttpError('request left the account origin — refused');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(u.href, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          accept: 'application/json, text/calendar;q=0.9, */*;q=0.1',
          ...(init.body !== undefined ? { 'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
          ...(this.o.headers ?? {}),
          ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (e) {
      clearTimeout(timer);
      // Fixed words only: the raw message can hold a header value, i.e. the token (review 6, R6-6).
      throw new AccountHttpError(`${u.host}: ${networkReason(e)}`);
    }
    try {
      if (res.status >= 300 && res.status < 400) throw new AccountHttpError(`${u.host} answered with a redirect (${res.status}) — refused`, res.status);
      if (res.status === 401 || res.status === 403) throw new AccountHttpError(`${u.host} refused the token (${res.status}) — check it is still valid`, res.status);
      if (res.status === 429) throw new AccountHttpError(`${u.host} says too many requests — try again in a minute`, 429);
      if (!res.ok) throw new AccountHttpError(`${u.host} answered ${res.status}`, res.status);
      const text = await readCappedBody(res, this.o.maxBytes ?? DEFAULT_MAX_BYTES, () => new AccountHttpError(`${u.host} sent too much data`));
      return { text, res };
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET text (e.g. an iCal feed). */
  async getText(pathAndQuery: string): Promise<string> {
    return (await this.fetchOnce(this.url(pathAndQuery))).text;
  }

  /** GET JSON. */
  async getJson<T = unknown>(pathAndQuery: string): Promise<T> {
    return parseJson<T>((await this.fetchOnce(this.url(pathAndQuery))).text, this.origin);
  }

  /** POST JSON (read-only APIs that use POST for queries, e.g. Notion search). */
  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    return parseJson<T>((await this.fetchOnce(this.url(path), { method: 'POST', body: JSON.stringify(body) })).text, this.origin);
  }

  /** POST a form (OAuth token endpoints), JSON back. The form values (codes, tokens) never appear in an error. */
  async postForm<T = unknown>(path: string, form: Record<string, string>): Promise<T> {
    return parseJson<T>((await this.fetchOnce(this.url(path), { method: 'POST', body: new URLSearchParams(form).toString(), form: true })).text, this.origin);
  }

  /** GET a JSON array, following `Link: rel="next"` on the same origin, up to maxPages. */
  async getAllPages<T = unknown>(pathAndQuery: string): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let href: string | null = this.url(pathAndQuery);
    const max = this.o.maxPages ?? DEFAULT_MAX_PAGES;
    for (let page = 0; href && page < max; page++) {
      const { text, res } = await this.fetchOnce(href);
      const data = parseJson<unknown>(text, this.origin);
      if (!Array.isArray(data)) throw new AccountHttpError(`${new URL(href).host} did not return a list`);
      items.push(...(data as T[]));
      const next = nextLink(res.headers.get('link'));
      href = next && new URL(next, this.origin).origin === this.origin ? new URL(next, this.origin).href : null;
    }
    return { items, truncated: href !== null };
  }
}

/** A network error in plain words, never its raw message. */
export function networkReason(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err?.name === 'AbortError') return 'did not answer in time';
  const code = err?.cause?.code ?? err?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the address could not be found (no internet, or a typo)';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'the connection was refused or dropped';
  if (/CERT|SSL|TLS/i.test(code)) return 'the secure connection failed (certificate problem)';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'did not answer in time';
  return 'could not be reached';
}

function parseJson<T>(text: string, origin: string): T {
  try {
    // Canvas may prefix JSON with "while(1);" (CSRF guard) when not asked for plain JSON.
    return JSON.parse(text.replace(/^while\(1\);/, '')) as T;
  } catch {
    throw new AccountHttpError(`${new URL(origin).host} did not return JSON`);
  }
}

