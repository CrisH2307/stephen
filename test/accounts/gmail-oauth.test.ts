/**
 * `stephen connect gmail <label>` / `stephen disconnect gmail <label>` (src/connect/gmail-oauth.ts): PKCE, the
 * one-shot loopback server (127.0.0.1 only, path and state checks, timeout), the code exchange against a fake token
 * server (error hygiene, scope check), the Keychain write through `security -i` stdin (never argv), the config update.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GMAIL_SCOPE } from '../../src/accounts/gmail.js';
import { CONNECT_TIMEOUT_MS, GOOGLE_AUTH_URL, consentUrl, pkceChallenge, pkcePair, runConnectCli, startLoopback, type ConnectEnv } from '../../src/connect/gmail-oauth.js';
import { FakeSecurity } from '../voice/tts/helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-gmail-oauth-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const CLIENT_ID = 'fake-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-FAKEclientSECRETfake';
const REFRESH = '1//0gREFRESHsecretREFRESHsecretREFRESH';
const ACCESS = 'ya29.ACCESSsecretACCESSsecretACCESS';
const CODE = '4/0AcodeSECRETcodeSECRETcode';

// ───────────────────────────── fake Google (token + revoke + Gmail profile) ─────────────────────────────

interface Seen {
  path: string;
  form: URLSearchParams | null;
  auth: string | undefined;
}
let server: Server;
let base = '';
let seen: Seen[] = [];
let tokenReply: (res: ServerResponse) => void = (res) => json(res, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: GMAIL_SCOPE, token_type: 'Bearer' });
beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ path, form: raw ? new URLSearchParams(raw) : null, auth: req.headers.authorization });
      if (path === '/token') return tokenReply(res);
      if (path === '/revoke') return json(res, {});
      if (path === '/gmail/v1/users/me/profile') return json(res, { emailAddress: 'cris@gmail.com', messagesTotal: 10 });
      json(res, {}, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A "browser": follows the consent URL straight to the loopback redirect, as Google would after consent. */
const browser = (o: { code?: string; state?: (s: string) => string; extra?: string } = {}) => {
  const opened: URL[] = [];
  return {
    opened,
    open: async (u: string) => {
      const url = new URL(u);
      opened.push(url);
      const p = url.searchParams;
      const state = o.state ? o.state(p.get('state')!) : p.get('state')!;
      void fetch(`${p.get('redirect_uri')}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(o.code ?? CODE)}&scope=${encodeURIComponent(GMAIL_SCOPE)}${o.extra ?? ''}`).catch(() => undefined);
    },
  };
};

const configFile = (body: unknown = { accounts: { gmail: { clientId: CLIENT_ID, accounts: ['school'] } }, voice: { tts: 'say' } }) => {
  const f = join(tmp, `config-${Math.random()}.json`);
  writeFileSync(f, JSON.stringify(body), { mode: 0o600 });
  return f;
};
const envFile = (body = `GOOGLE_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}\n`) => {
  const f = join(tmp, `env-${Math.random()}`);
  writeFileSync(f, body, { mode: 0o600 });
  return f;
};

function run(argv: string[], o: { sec?: FakeSecurity; cfg?: string; env?: string | null; open?: (u: string) => Promise<void>; platform?: NodeJS.Platform; accounts?: unknown; timeoutMs?: number } = {}) {
  seen = [];
  const out: string[] = [];
  const err: string[] = [];
  const sec = o.sec ?? new FakeSecurity();
  const cfg = o.cfg ?? configFile();
  const e: ConnectEnv = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    secrets: { platform: o.platform ?? 'darwin', exec: sec.exec, user: 'tester', envFile: o.env === undefined ? envFile() : o.env },
    accounts: o.accounts !== undefined ? o.accounts : (JSON.parse(readFileSync(cfg, 'utf8')) as { accounts?: unknown }).accounts,
    configPath: cfg,
    openBrowser: o.open ?? browser().open,
    allowLoopbackHttp: true,
    tokenOrigin: base,
    gmailOrigin: base,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  };
  return runConnectCli(argv[0] === 'disconnect' ? 'disconnect' : 'connect', argv.slice(1), e).then((code) => ({ code, out, err, sec, cfg, all: [...out, ...err].join('\n') }));
}
const labelsIn = (cfg: string) => (JSON.parse(readFileSync(cfg, 'utf8')) as { accounts: { gmail: { accounts: string[] } } }).accounts.gmail.accounts;

// ───────────────────────────── PKCE and the consent URL ─────────────────────────────

describe('PKCE (RFC 7636, S256)', () => {
  it('the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('a fresh 43-character base64url verifier from 32 random bytes, and its challenge', () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(pkcePair(() => Buffer.alloc(32, 1)).verifier).toBe(Buffer.alloc(32, 1).toString('base64url'));
  });

  it('consent URL: Google\'s auth endpoint, exactly gmail.readonly, S256, state, offline + consent', () => {
    const u = new URL(consentUrl({ clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:5555/', challenge: 'CH', state: 'ST' }));
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:5555/',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      state: 'ST',
      access_type: 'offline',
      prompt: 'consent',
    });
  });
});

// ───────────────────────────── the loopback server ─────────────────────────────

describe('loopback server', () => {
  it('binds 127.0.0.1 only on a random port; the redirect URI is http://127.0.0.1:<port>/', async () => {
    const l = await startLoopback('state-1', 5_000);
    expect(l.address.address).toBe('127.0.0.1');
    expect(l.address.port).toBeGreaterThan(0);
    expect(l.redirectUri).toBe(`http://127.0.0.1:${l.address.port}/`);
    l.close();
    expect(await l.result).toEqual({ kind: 'timeout' });
  });

  it('wrong path (404), wrong or missing state (400), POST (405) are refused and it keeps waiting; the right state wins once, then it closes', async () => {
    const l = await startLoopback('the-state', 5_000);
    const at = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${l.address.port}${p}`, init);
    expect((await at('/callback?state=the-state&code=x')).status).toBe(404);
    expect((await at('/favicon.ico')).status).toBe(404);
    expect((await at('/?state=other&code=x')).status).toBe(400);
    expect((await at('/?state=the-stat&code=x')).status).toBe(400);
    expect((await at('/?code=x')).status).toBe(400);
    expect((await at('/?state=the-state&code=x', { method: 'POST' })).status).toBe(405);
    const ok = await at('/?state=the-state&code=4%2F0Agood&scope=x');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const page = await ok.text();
    expect(page).not.toContain('4/0Agood');
    expect(await l.result).toEqual({ kind: 'code', code: '4/0Agood' });
    await expect(at('/?state=the-state&code=again')).rejects.toThrow();
  });

  it('the user declines: error=access_denied with the right state', async () => {
    const l = await startLoopback('s2', 5_000);
    await fetch(`http://127.0.0.1:${l.address.port}/?state=s2&error=access_denied`);
    expect(await l.result).toEqual({ kind: 'denied', reason: 'access_denied' });
  });

  it('times out (default 3 minutes) and closes', async () => {
    expect(CONNECT_TIMEOUT_MS).toBe(180_000);
    const l = await startLoopback('s3', 50);
    expect(await l.result).toEqual({ kind: 'timeout' });
    await expect(fetch(`http://127.0.0.1:${l.address.port}/?state=s3&code=x`)).rejects.toThrow();
  });
});

// ───────────────────────────── stephen connect gmail ─────────────────────────────

describe('stephen connect gmail <label>', () => {
  it('end to end: consent URL, code exchange with the verifier, Keychain via security -i stdin, label added to config', async () => {
    const b = browser();
    const r = await run(['connect', 'gmail', 'personal'], { open: b.open });
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const consent = b.opened[0]!.searchParams;
    expect(consent.get('scope')).toBe(GMAIL_SCOPE);
    expect(consent.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const tok = seen.find((s) => s.path === '/token')!;
    const form = Object.fromEntries(tok.form!);
    expect(form).toEqual({ grant_type: 'authorization_code', code: CODE, code_verifier: expect.any(String), client_id: CLIENT_ID, redirect_uri: consent.get('redirect_uri'), client_secret: CLIENT_SECRET });
    expect(pkceChallenge(form.code_verifier!)).toBe(consent.get('code_challenge'));
    expect(seen.find((s) => s.path === '/gmail/v1/users/me/profile')!.auth).toBe(`Bearer ${ACCESS}`);

    expect(r.sec.items.get('stephen-gmail-personal|tester')).toBe(REFRESH);
    const add = r.sec.calls.find((c) => c.args[0] === '-i')!;
    expect(add.input).toBe(`add-generic-password -U -s stephen-gmail-personal -a tester -l "Stephen Gmail refresh token (personal)" -w ${REFRESH}\n`);
    for (const c of r.sec.calls) expect(c.args.join(' ')).not.toContain(REFRESH);
    expect(labelsIn(r.cfg)).toEqual(['school', 'personal']);
    const saved = JSON.parse(readFileSync(r.cfg, 'utf8')) as { voice: unknown; accounts: { gmail: { clientId: string } } };
    expect(saved.voice).toEqual({ tts: 'say' }); // the rest of config.json is kept
    expect(saved.accounts.gmail.clientId).toBe(CLIENT_ID);
    expect(readFileSync(r.cfg, 'utf8')).not.toMatch(/REFRESH|ACCESS|SECRET/);

    expect(r.out.join('\n')).toMatch(/Signed in as cris@gmail\.com[\s\S]*Connected Gmail "personal" \(read-only\)/);
    expect(r.all).not.toMatch(/REFRESHsecret|ACCESSsecret|codeSECRET|FAKEclientSECRET/);
    expect(r.all).not.toContain(form.code_verifier!);
  });

  it('connecting the same label again replaces the Keychain item (-U) and keeps one config entry', async () => {
    const sec = new FakeSecurity();
    sec.items.set('stephen-gmail-school|tester', 'old-token-old-token');
    const r = await run(['connect', 'gmail', 'school'], { sec });
    expect(r.code).toBe(0);
    expect(sec.items.get('stephen-gmail-school|tester')).toBe(REFRESH);
    expect(labelsIn(r.cfg)).toEqual(['school']);
  });

  it('no client secret stored: PKCE only, no client_secret field', async () => {
    const r = await run(['connect', 'gmail', 'personal'], { env: null });
    expect(r.code).toBe(0);
    expect(seen.find((s) => s.path === '/token')!.form!.has('client_secret')).toBe(false);
  });

  it('a callback with the wrong state is ignored: nothing is exchanged, and it times out', async () => {
    const r = await run(['connect', 'gmail', 'personal'], { open: browser({ state: (s) => `${s}x` }).open, timeoutMs: 300 });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/No sign-in arrived.*Nothing was stored/);
    expect(seen).toEqual([]);
    expect(r.sec.items.size).toBe(0);
    expect(labelsIn(r.cfg)).toEqual(['school']);
  });

  it('token endpoint error: a plain message without Google\'s body, the code, the verifier or any token; nothing stored', async () => {
    for (const status of [400, 401, 500]) {
      tokenReply = (res) => json(res, { error: 'invalid_grant', error_description: `code ${CODE} refresh ${REFRESH} secret ${CLIENT_SECRET}` }, status);
      const r = await run(['connect', 'gmail', 'personal']);
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toMatch(status === 400 ? /refused the sign-in code \(400\)/ : status === 401 ? /refused the OAuth client \(401\)/ : /answered 500/);
      expect(r.all).not.toMatch(/codeSECRET|REFRESHsecret|FAKEclientSECRET|invalid_grant|error_description/);
      expect(r.sec.calls.filter((c) => c.args[0] === '-i')).toEqual([]);
      expect(labelsIn(r.cfg)).toEqual(['school']);
    }
    tokenReply = (res) => {
      res.writeHead(302, { location: 'https://evil.example/' });
      res.end();
    };
    expect((await run(['connect', 'gmail', 'personal'])).err.join('\n')).toMatch(/redirect \(302\)/);
    tokenReply = (res) => json(res, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: GMAIL_SCOPE });
  });

  it('a token with other scopes, without gmail.readonly, or without a refresh token is not stored', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ scope: `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.send` }, /more than read-only/],
      [{ scope: 'https://www.googleapis.com/auth/userinfo.email' }, /not read-only Gmail access/],
      [{ scope: GMAIL_SCOPE, refresh_token: undefined }, /did not return a refresh token/],
      [{ scope: GMAIL_SCOPE, refresh_token: 'bad token with "quotes"' }, /did not return a refresh token/],
      // A leading dash could read as an option on the `security -i` command line.
      [{ scope: GMAIL_SCOPE, refresh_token: '-wEVILevilEVIL' }, /did not return a refresh token/],
    ];
    for (const [over, msg] of cases) {
      tokenReply = (res) => json(res, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, ...over });
      const r = await run(['connect', 'gmail', 'personal']);
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toMatch(msg);
      expect(r.sec.items.size).toBe(0);
      expect(labelsIn(r.cfg)).toEqual(['school']);
    }
    tokenReply = (res) => json(res, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: GMAIL_SCOPE });
  });

  it('the user declines: nothing stored', async () => {
    const r = await run(['connect', 'gmail', 'personal'], {
      open: async (u) => {
        const p = new URL(u).searchParams;
        void fetch(`${p.get('redirect_uri')}?state=${encodeURIComponent(p.get('state')!)}&error=access_denied`).catch(() => undefined);
      },
    });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/did not give Stephen access \(access_denied\)/);
    expect(seen).toEqual([]);
  });

  it('refused before any server or browser: bad label, not macOS, no client id, wrong usage', async () => {
    let opened = 0;
    const open = async () => {
      opened += 1;
    };
    expect((await run(['connect', 'gmail', 'Personal'], { open })).code).toBe(2);
    expect((await run(['connect', 'gmail', 'a'.repeat(21)], { open })).code).toBe(2);
    expect((await run(['connect', 'gmail', '../x'], { open })).code).toBe(2);
    const linux = await run(['connect', 'gmail', 'personal'], { open, platform: 'linux' });
    expect(linux.code).toBe(1);
    expect(linux.err[0]).toMatch(/macOS Keychain/);
    const noId = await run(['connect', 'gmail', 'personal'], { open, accounts: {} });
    expect(noId.code).toBe(1);
    expect(noId.err[0]).toMatch(/No Google OAuth client id yet.*accounts.*gmail.*clientId/);
    expect((await run(['connect', 'canvas', 'x'], { open })).code).toBe(2);
    expect((await run(['connect', 'gmail'], { open })).code).toBe(2);
    expect(opened).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('stephen disconnect gmail <label>', () => {
  it('revokes at Google, deletes the Keychain item, removes the label', async () => {
    const sec = new FakeSecurity();
    sec.items.set('stephen-gmail-school|tester', REFRESH);
    const r = await run(['disconnect', 'gmail', 'school'], { sec });
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(['/revoke']);
    expect(Object.fromEntries(seen[0]!.form!)).toEqual({ token: REFRESH });
    expect(sec.calls.at(-1)!.args).toEqual(['delete-generic-password', '-s', 'stephen-gmail-school', '-a', 'tester']);
    expect(sec.items.size).toBe(0);
    expect(labelsIn(r.cfg)).toEqual([]);
    expect(r.all).not.toContain(REFRESH);
  });

  it('nothing in the Keychain: no revoke call, the label still leaves config', async () => {
    const r = await run(['disconnect', 'gmail', 'school']);
    expect(r.code).toBe(0);
    expect(seen).toEqual([]);
    expect(r.out.join('\n')).toMatch(/was not in the Keychain/);
    expect(labelsIn(r.cfg)).toEqual([]);
  });

  it('creates no config file on a bad label', async () => {
    const cfg = join(tmp, 'none.json');
    expect((await run(['disconnect', 'gmail', 'BAD'], { cfg, accounts: {} })).code).toBe(2);
    expect(existsSync(cfg)).toBe(false);
  });
});
