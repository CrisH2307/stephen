import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountsStatus } from '../../src/app/accounts-status.js';
import { AppServer } from '../../src/app/server.js';
import type { ExecFn } from '../../src/voice/tts/keys.js';
import { TestClient } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-accts-'));
const CANVAS = 'canvas-secret-token-0123456789';
const NOTION = 'ntn_notion_secret_value_9876543210';
const ICS = 'https://calendar.google.com/calendar/ical/secret-abc/basic.ics';

function envFile(text: string): string {
  const f = join(tmp, `env-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, text, { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

const noKeychain: ExecFn = async () => ({ code: 44, stdout: '', stderr: '' });
const byId = (s: Awaited<ReturnType<typeof accountsStatus>>) => Object.fromEntries(s.accounts.map((a) => [a.id, a]));

describe('accountsStatus', () => {
  it('reports .env hits with the source label and never the value', async () => {
    const s = await accountsStatus({}, { platform: 'linux', envFile: envFile(`CANVAS_API=${CANVAS}\nNOTION_API=${NOTION}\n`) });
    const a = byId(s);
    expect(a.canvas).toMatchObject({ state: 'connected', source: '.env' });
    expect(a.notion).toMatchObject({ state: 'connected', source: '.env' });
    expect(a.calendar).toMatchObject({ state: 'not_set', source: null });
    expect(a.weather).toMatchObject({ state: 'connected', source: null, detail: 'Toronto, ON' });
    const json = JSON.stringify(s);
    for (const secret of [CANVAS, NOTION]) expect(json).not.toContain(secret);
    for (const row of s.accounts) expect(row.hint.length).toBeGreaterThan(10);
  });

  it('reports the Keychain as the source when it answers first', async () => {
    const exec: ExecFn = async (_f, args) =>
      args.includes('stephen-calendar-ics') ? { code: 0, stdout: `${ICS}\n`, stderr: '' } : { code: 44, stdout: '', stderr: '' };
    const s = await accountsStatus({}, { platform: 'darwin', exec, user: 'cris', envFile: null });
    expect(byId(s).calendar).toMatchObject({ state: 'connected', source: 'keychain' });
    expect(byId(s).canvas).toMatchObject({ state: 'not_set', source: null });
    expect(JSON.stringify(s)).not.toContain('secret-abc');
  });

  it('turned-off services say off, even with a secret present; weather shows the configured place', async () => {
    const s = await accountsStatus(
      { canvas: { enabled: false }, weather: { label: 'Oshawa, ON', latitude: 43.9, longitude: -78.9 } },
      { platform: 'linux', envFile: envFile(`CANVAS_API=${CANVAS}\n`) },
    );
    expect(byId(s).canvas).toMatchObject({ state: 'off', source: null });
    expect(byId(s).weather.detail).toBe('Oshawa, ON');
    expect(JSON.stringify(s)).not.toContain(CANVAS);
    const all = await accountsStatus({ enabled: false }, { platform: 'linux', envFile: null });
    expect(all.accounts.map((a) => a.state)).toEqual(['off', 'off', 'off', 'off']);
  });

  it('tolerates a missing config, a broken config and a missing .env', async () => {
    for (const raw of [undefined, null, [], 'x', {}]) {
      const s = await accountsStatus(raw, { platform: 'linux', exec: noKeychain, envFile: join(tmp, 'nope.env') });
      expect(s.accounts.map((a) => a.id)).toEqual(['canvas', 'calendar', 'notion', 'weather']);
      expect(s.note).toBeUndefined();
    }
    const bad = await accountsStatus({ timeZone: 'Mars/Base' }, { platform: 'linux', envFile: null });
    expect(bad.note).toMatch(/timeZone/);
    expect(bad.accounts).toHaveLength(4);
  });

  it('lists Gmail labels from accounts.gmail.accounts, connected only when the Keychain has a token', async () => {
    const REFRESH = '1//0gRefreshTokenValueThatMustNotLeak123';
    const exec: ExecFn = async (_f, args) =>
      args.includes('stephen-gmail-school') ? { code: 0, stdout: `${REFRESH}\n`, stderr: '' } : { code: 44, stdout: '', stderr: '' };
    const s = await accountsStatus({ gmail: { accounts: ['school', 'personal'] } }, { platform: 'darwin', exec, user: 'cris', envFile: null });
    expect(s.note).toBeUndefined();
    const gmail = s.accounts.filter((a) => a.name === 'Gmail');
    expect(gmail.map((g) => [g.detail, g.state, g.source])).toEqual([['school', 'connected', 'keychain'], ['personal', 'not_set', null]]);
    expect(JSON.stringify(s)).not.toContain(REFRESH);
    expect((await accountsStatus({ gmail: {} }, { platform: 'linux', envFile: null })).accounts).toHaveLength(4);
    const off = await accountsStatus({ gmail: { enabled: false, accounts: ['school'] } }, { platform: 'darwin', exec, user: 'cris', envFile: null });
    expect(off.accounts.find((a) => a.name === 'Gmail')).toMatchObject({ state: 'off', source: null });
  });

  it('R7-9: checks presence only: security never gets -w, no value is read or returned', async () => {
    const calls: string[][] = [];
    // A fake `security` that would hand out values to anyone who asked with -w.
    const exec: ExecFn = async (_f, args) => {
      calls.push(args);
      const hit = args.includes('stephen-canvas') || args.includes('stephen-gmail-school');
      return hit ? { code: 0, stdout: args.includes('-w') ? 'LEAKED-SECRET-VALUE\n' : 'keychain: "login.keychain-db"\nattributes:\n', stderr: '' } : { code: 44, stdout: '', stderr: '' };
    };
    const s = await accountsStatus({ gmail: { accounts: ['school', 'personal'] } }, { platform: 'darwin', exec, user: 'cris', envFile: envFile(`NOTION_API=${NOTION}\n`) });
    expect(calls.length).toBeGreaterThan(4);
    for (const a of calls) {
      expect(a).not.toContain('-w');
      expect(a[0]).toBe('find-generic-password');
    }
    const a = byId(s);
    expect(a.canvas).toMatchObject({ state: 'connected', source: 'keychain' });
    expect(a.notion).toMatchObject({ state: 'connected', source: '.env' });
    expect(a['gmail:1']).toMatchObject({ state: 'connected', source: 'keychain', detail: 'school' });
    expect(a['gmail:2']).toMatchObject({ state: 'not_set', detail: 'personal' });
    const json = JSON.stringify(s);
    expect(json).not.toContain('LEAKED');
    expect(json).not.toContain(NOTION);
    // An empty .env key is not "connected".
    expect(byId(await accountsStatus({}, { platform: 'linux', envFile: envFile('NOTION_API=\n') })).notion.state).toBe('not_set');
  });

  it('an unreadable (group-readable) .env counts as not set', async () => {
    const f = join(tmp, 'loose.env');
    writeFileSync(f, `NOTION_API=${NOTION}\n`);
    chmodSync(f, 0o644);
    const s = await accountsStatus({}, { platform: 'linux', envFile: f });
    expect(byId(s).notion).toMatchObject({ state: 'not_set', source: null });
  });
});

describe('accounts.status over app.sock', () => {
  const servers: AppServer[] = [];
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) await s.close();
  });

  async function serve(accounts?: () => Promise<{ accounts: never[]; note?: string }>) {
    const home = mkdtempSync(join(tmp, 'home-'));
    const server = new AppServer({
      home,
      queue: { busy: () => false, start: () => null, stop: () => undefined },
      listening: () => true,
      model: 'sonnet',
      memory: null,
      endConversation: () => undefined,
      history: null,
      audit: null,
      settings: () => ({ config: {}, configPath: '/x/config.json' }),
      ...(accounts ? { accounts } : {}),
      speakReplies: false,
      openWindow: () => null,
    });
    await server.start();
    servers.push(server);
    const c = await TestClient.connect(server.socketPath);
    clients.push(c);
    return { server, c };
  }

  it('answers with the rows and no secrets', async () => {
    const { c } = await serve();
    // (no accounts option: not available)
    expect(await c.request({ id: 'x', type: 'accounts.status' })).toEqual({ id: 'x', type: 'error', message: 'accounts status is not available' });
  });

  it('answers type "accounts" built from lookupSecret', async () => {
    const home = mkdtempSync(join(tmp, 'home2-'));
    const file = envFile(`NOTION_API=${NOTION}\n`);
    const server = new AppServer({
      home,
      queue: { busy: () => false, start: () => null, stop: () => undefined },
      listening: () => true,
      model: 'sonnet',
      memory: null,
      endConversation: () => undefined,
      history: null,
      audit: null,
      settings: () => ({ config: {}, configPath: '/x/config.json' }),
      accounts: () => accountsStatus({}, { platform: 'linux', envFile: file }),
      speakReplies: false,
      openWindow: () => null,
    });
    await server.start();
    servers.push(server);
    const c = await TestClient.connect(server.socketPath);
    clients.push(c);
    const r = await c.request({ id: 'y', type: 'accounts.status' });
    expect(r.type).toBe('accounts');
    expect((r.accounts as { id: string; state: string; source: string | null }[]).find((a) => a.id === 'notion')).toMatchObject({ state: 'connected', source: '.env' });
    expect(JSON.stringify(r)).not.toContain(NOTION);
  });

  it('a failing lookup answers with an error line', async () => {
    const { c } = await serve(async () => {
      throw new Error('boom /secret/path');
    });
    expect(await c.request({ id: 'z', type: 'accounts.status' })).toEqual({ id: 'z', type: 'error', message: 'could not read the accounts status' });
  });
});
