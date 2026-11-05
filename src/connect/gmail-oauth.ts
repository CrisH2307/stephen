/**
 * `stephen connect gmail <label>` and `stephen disconnect gmail <label>`: the owner signs in to a Gmail account once,
 * in Terminal. Only src/cli.ts loads this file (on demand); nothing the model can reach imports it (boundary test in
 * test/memory/boundary.test.ts), so no tool can start a sign-in, store a token or change the account list.
 *
 * OAuth 2.0 for a desktop app (RFC 8252) with PKCE (RFC 7636, S256):
 *   1. verifier = 32 random bytes (base64url), challenge = SHA-256(verifier); state = 16 random bytes.
 *   2. A one-shot HTTP server on 127.0.0.1 (never 0.0.0.0), random port, path "/" only. It answers wrong paths with
 *      404 and a wrong or missing state with 400 and keeps waiting; it closes after the first callback with the right
 *      state, or after the timeout (3 minutes).
 *   3. The browser opens Google's consent page (`open <url>`, argv, no shell; elsewhere the URL is printed):
 *      scope exactly gmail.readonly, access_type=offline + prompt=consent (so Google returns a refresh token).
 *   4. The code is exchanged at https://oauth2.googleapis.com/token (pinned origin, no redirects, timeout, byte cap)
 *      with the verifier; the client secret is sent only when the owner stored one.
 *   5. The granted scopes must be exactly gmail.readonly, else nothing is stored.
 *   6. The signed-in address is read (Gmail users/me/profile) and the owner confirms it in Terminal:
 *      `Save <address> as "<label>"? [y/N]` (default no; no terminal → refused unless --yes). Another local user who
 *      raced the loopback with their own Google sign-in shows up here as the wrong address (review 7, R7-7).
 *   7. The refresh token goes to the Keychain item `stephen-gmail-<label>` via `security -i` on stdin (never argv,
 *      config, logs or the environment), and the label is added to accounts.gmail.accounts in config.json.
 * The access token from the exchange is used once (to read the address) and then dropped.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { userInfo } from 'node:os';
import { configFilePath, loadConfig } from '../config.js';
import { section, updateAccountsConfig } from './accounts-cli.js';
import { parseAccountsConfig } from '../accounts/config.js';
import { GMAIL_SCOPE, GmailClient, googleTokenCall, grantedScopes, type GoogleTokenResponse } from '../accounts/gmail.js';
import { AccountHttpError, type FetchFn } from '../accounts/http.js';
import { GMAIL_LABEL_RE, GOOGLE_TOKEN_RE, gmailKeychainService, lookupGmailToken, lookupSecret, type SecretDeps } from '../accounts/secrets.js';
import { defaultExec } from '../lib/keychain.js';
import { keychainDelete, keychainStore } from './keychain-write.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CONNECT_TIMEOUT_MS = 3 * 60_000;

export const CONNECT_USAGE = `stephen connect gmail <label> [--yes]  Sign in to one Gmail account, read-only (label: 1 to 32 of a-z, 0-9, _ and -; e.g. personal).
                                       Asks you to confirm the signed-in address; --yes skips that (needed without a terminal)
stephen disconnect gmail <label>  Revoke and forget it (Keychain item stephen-gmail-<label> and the config entry)`;

// ───────────── PKCE and the consent URL ─────────────

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A fresh verifier (43 base64url characters = 32 random bytes) and its challenge. */
export function pkcePair(rand: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = rand(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function consentUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

// ───────────── the one-shot loopback server ─────────────

export type CallbackResult = { kind: 'code'; code: string } | { kind: 'denied'; reason: string } | { kind: 'timeout' };

export interface Loopback {
  redirectUri: string;
  address: AddressInfo;
  /** Settles once: the first callback with the right state, or the timeout. The server is closed by then. */
  result: Promise<CallbackResult>;
  close(): void;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Stephen</title></head><body style="font:16px -apple-system,sans-serif;margin:3em"><h1>${title}</h1><p>${text}</p></body></html>`;

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Listen on 127.0.0.1:<random port> for Google's redirect carrying `state`. */
export async function startLoopback(state: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Loopback> {
  let settle!: (r: CallbackResult) => void;
  const result = new Promise<CallbackResult>((r) => (settle = r));
  let done = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, html: string, then?: () => void) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        connection: 'close',
      });
      res.end(html, then);
    };
    if (done) return send(410, PAGE('Already done', 'Stephen is no longer waiting for a sign-in. You can close this tab.'));
    if (req.method !== 'GET') return send(405, PAGE('Not allowed', 'Only the sign-in redirect is accepted here.'));
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(400, PAGE('Bad request', ''));
    }
    if (url.pathname !== '/') return send(404, PAGE('Not found', ''));
    const got = url.searchParams.get('state') ?? '';
    if (!sameSecret(got, state)) return send(400, PAGE('Not this sign-in', "This sign-in link isn't the one Stephen is waiting for. Go back to Terminal and run the connect command again if needed."));
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code') ?? '';
    let r: CallbackResult;
    if (error !== null || !code) r = { kind: 'denied', reason: error && /^[a-z_]{1,40}$/.test(error) ? error : 'no code' };
    else if (!/^[\x21-\x7e]{1,2048}$/.test(code)) r = { kind: 'denied', reason: 'malformed code' };
    else r = { kind: 'code', code };
    done = true;
    send(200, r.kind === 'code' ? PAGE('Stephen is almost connected', 'You can close this tab and go back to Terminal.') : PAGE('Not connected', 'Stephen was not given access. You can close this tab.'), () => finish(r));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const timer = setTimeout(() => {
    done = true;
    finish({ kind: 'timeout' });
  }, timeoutMs);
  let finished = false;
  function finish(r: CallbackResult) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    settle(r);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${address.port}/`,
    address,
    result,
    close: () => {
      done = true;
      finish({ kind: 'timeout' });
    },
  };
}

// ───────────── the commands ─────────────

export interface ConnectEnv {
  out?: (l: string) => void;
  err?: (l: string) => void;
  /** Keychain (exec, platform, user) and the .env file (client secret). */
  secrets?: SecretDeps;
  /** Tests: the "accounts" config section instead of config.json's. */
  accounts?: unknown;
  /** Tests: the config.json to update. */
  configPath?: string;
  /** Default: macOS `open <url>`; elsewhere nothing (the URL is printed). */
  openBrowser?: (url: string) => Promise<void> | void;
  timeoutMs?: number;
  /** Where the "Save <address>?" answer is read (default: process.stdin). Not a terminal → refused unless --yes. */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Tests only: fake Google servers on loopback. */
  allowLoopbackHttp?: boolean;
  tokenOrigin?: string;
  gmailOrigin?: string;
  fetch?: FetchFn;
}

/** Print `question`, then read one line; null on end of input (EOF counts as "no"). */
function askLine(input: NodeJS.ReadableStream, question: string, out: (l: string) => void): Promise<string | null> {
  out(question);
  const rl = createInterface({ input, terminal: false });
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.once('line', (l) => finish(l));
    rl.once('close', () => finish(null));
  });
}

/** A token-endpoint failure in plain words (never Google's body, the code, the verifier or a token). */
function tokenFailure(e: unknown): string {
  if (e instanceof AccountHttpError && e.status === 400) return 'Google refused the sign-in code (400). Run the connect command again.';
  if (e instanceof AccountHttpError && e.status === 401) return 'Google refused the OAuth client (401): check accounts.gmail.clientId and the client secret (Keychain "stephen-google-oauth" or GOOGLE_OAUTH_CLIENT_SECRET in Stephen\'s .env).';
  if (e instanceof AccountHttpError) return e.message;
  return 'the token request failed';
}

export async function runConnectCli(cmd: 'connect' | 'disconnect', argv: string[], e: ConnectEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  if (argv[0] === '--help' || argv[0] === 'help') {
    out(CONNECT_USAGE);
    return 0;
  }
  const yes = cmd === 'connect' && argv.length === 3 && argv[2] === '--yes';
  if (argv[0] !== 'gmail' || (argv.length !== 2 && !yes)) {
    err(`Usage:\n${CONNECT_USAGE}\n(Canvas, Notion and the calendar use Stephen's .env file instead; see stephen accounts.)`);
    return 2;
  }
  const label = argv[1]!;
  if (!GMAIL_LABEL_RE.test(label)) {
    err("The label is 1 to 32 of a-z, 0-9, _ and - (use the account's name, e.g. khang; if two share a name, say what each is for, e.g. personal_purpose_school and personal_purpose_jobs).");
    return 2;
  }
  const secrets = e.secrets ?? {};
  if ((secrets.platform ?? process.platform) !== 'darwin') {
    err('Gmail sign-ins are kept in the macOS Keychain, so this runs on the Mac only.');
    return 1;
  }
  const user = secrets.user ?? userInfo().username;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    err(`Unsupported user name for the Keychain account: ${JSON.stringify(user)}`);
    return 1;
  }
  const keychain = { exec: secrets.exec ?? defaultExec, user };
  const file = e.configPath ?? configFilePath();
  const http = { ...(e.fetch ? { fetch: e.fetch } : {}), ...(e.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) };
  const tokenOpts = { ...http, ...(e.allowLoopbackHttp && e.tokenOrigin ? { origin: e.tokenOrigin } : {}) };
  const service = gmailKeychainService(label);

  const setLabels = (change: (list: string[]) => string[]) =>
    updateAccountsConfig(file, (accounts) => {
      const g = section(accounts, 'gmail');
      const list = Array.isArray(g.accounts) ? g.accounts.filter((x): x is string => typeof x === 'string') : [];
      return { ...accounts, gmail: { ...g, accounts: change(list) } };
    });

  if (cmd === 'disconnect') {
    const saved = await lookupGmailToken(label, { ...secrets, user });
    if (saved.value) {
      try {
        await googleTokenCall('/revoke', { token: saved.value }, tokenOpts);
        out('Revoked Stephen\'s access at Google.');
      } catch (x) {
        out(`Could not revoke it at Google (${tokenFailure(x)}); remove "Stephen" at https://myaccount.google.com/permissions to be sure.`);
      }
    }
    const d = await keychainDelete(service, keychain);
    if (d !== 'deleted' && d !== 'missing') {
      err(`Could not delete the Keychain item ${service}: ${d}`);
      return 1;
    }
    try {
      setLabels((list) => list.filter((x) => x !== label));
    } catch (x) {
      err(`Could not update ${file}: ${(x as Error).message}`);
      return 1;
    }
    out(d === 'deleted' ? `Disconnected Gmail "${label}" (Keychain item ${service} deleted, removed from ${file}).` : `Gmail "${label}" was not in the Keychain; removed it from ${file}.`);
    // A running `stephen serve` keeps its cached access token (up to an hour) until it restarts (review 7, R7-12).
    out('Restart Stephen (quit and start stephen listen or the app again) so a running Stephen stops using this account now.');
    return 0;
  }

  // ── connect ──
  let clientId: string | undefined;
  try {
    clientId = parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts).gmail.clientId;
  } catch (x) {
    err((x as Error).message);
    return 2;
  }
  if (!clientId) {
    err(`No Google OAuth client id yet. Create a "Desktop app" OAuth client in Google Cloud (see docs/PLAN-2A-READ-MY-STUFF.md), then put its id in ${file} as "accounts": { "gmail": { "clientId": "<id>" } }.`);
    return 1;
  }
  const stdin = e.stdin ?? process.stdin;
  if (!yes && !stdin.isTTY) {
    err('Run this in Terminal: Stephen asks you to confirm the signed-in address before saving it (or add --yes to skip that question).');
    return 2;
  }
  const clientSecret = (await lookupSecret('google-oauth-client-secret', secrets)).value;

  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  const loop = await startLoopback(state, e.timeoutMs ?? CONNECT_TIMEOUT_MS);
  const url = consentUrl({ clientId, redirectUri: loop.redirectUri, challenge, state });
  out(`Opening Google's sign-in for Gmail "${label}" (read-only). Pick the account, then allow "Read your email".`);
  out(`If no browser opens, paste this address into one on this Mac:\n${url}`);
  try {
    const open = e.openBrowser ?? ((u: string) => ((secrets.platform ?? process.platform) === 'darwin' ? defaultExec('open', [u], { timeoutMs: 10_000 }).then(() => undefined) : undefined));
    await open(url);
  } catch {
    /* the URL is printed above */
  }
  const r = await loop.result;
  if (r.kind === 'timeout') {
    err(`No sign-in arrived within ${Math.round((e.timeoutMs ?? CONNECT_TIMEOUT_MS) / 1000)} seconds. Nothing was stored.`);
    return 1;
  }
  if (r.kind === 'denied') {
    err(`Google did not give Stephen access (${r.reason}). Nothing was stored.`);
    return 1;
  }

  let tok: GoogleTokenResponse;
  try {
    tok = await googleTokenCall(
      '/token',
      { grant_type: 'authorization_code', code: r.code, code_verifier: verifier, client_id: clientId, redirect_uri: loop.redirectUri, ...(clientSecret ? { client_secret: clientSecret } : {}) },
      tokenOpts,
    );
  } catch (x) {
    err(`Sign-in failed: ${tokenFailure(x)} Nothing was stored.`);
    return 1;
  }
  const scopes = grantedScopes(tok);
  if (scopes.size !== 1 || !scopes.has(GMAIL_SCOPE)) {
    err(`Google granted ${scopes.has(GMAIL_SCOPE) ? 'more than' : 'not'} read-only Gmail access (${[...scopes].map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(', ') || 'nothing'}). Stephen stores only a gmail.readonly sign-in, so nothing was stored. ${scopes.has(GMAIL_SCOPE) ? 'Remove Stephen at https://myaccount.google.com/permissions and connect again.' : 'Connect again and tick "Read your email".'}`);
    return 1;
  }
  const refresh = typeof tok.refresh_token === 'string' ? tok.refresh_token : '';
  if (!GOOGLE_TOKEN_RE.test(refresh)) {
    err('Google did not return a refresh token. Remove Stephen at https://myaccount.google.com/permissions and connect again. Nothing was stored.');
    return 1;
  }
  // Which mailbox is this? The owner must recognise it before anything is stored (review 7, R7-7).
  let address = '';
  try {
    if (typeof tok.access_token !== 'string' || !GOOGLE_TOKEN_RE.test(tok.access_token)) throw new AccountHttpError('Google did not return an access token');
    const gmail = new GmailClient({ token: tok.access_token, ...http, ...(e.allowLoopbackHttp && e.gmailOrigin ? { origin: e.gmailOrigin } : {}) });
    address = await gmail.profile();
    if (address === 'unknown address') throw new AccountHttpError('Gmail did not say which address signed in');
  } catch (x) {
    err(`Could not read which Gmail address signed in (${x instanceof AccountHttpError ? x.message : 'unknown error'}). Is the Gmail API enabled in your Google Cloud project? Nothing was stored.`);
    return 1;
  }
  if (yes) out(`Signed in as ${address}. Saving it as "${label}" (--yes).`);
  else {
    const answer = await askLine(stdin, `Signed in as ${address}. Save ${address} as "${label}"? [y/N] `, out);
    if (!/^\s*y(es)?\s*$/i.test(answer ?? '')) {
      err(`Not saved. If ${address} is not the account you picked, someone else may have finished this sign-in: run the connect command again.`);
      return 1;
    }
  }
  const bad = await keychainStore(service, `Stephen Gmail refresh token (${label})`, refresh, keychain);
  if (bad) {
    err(bad);
    return 1;
  }
  try {
    setLabels((list) => (list.includes(label) ? list : [...list, label]));
  } catch (x) {
    err(`Stored the sign-in in the Keychain (${service}), but could not update ${file}: ${(x as Error).message}. Add "${label}" to accounts.gmail.accounts by hand.`);
    return 1;
  }
  out(`Connected Gmail "${label}" (read-only). The sign-in is in the Keychain item ${service}; ${file} lists the account. Restart Stephen to use it.`);
  return 0;
}
