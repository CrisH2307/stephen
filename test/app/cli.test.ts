/** `stephen app` (src/app/cli.ts): listener first, then the helper, then `open -a … --open-window`. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { askHelper, askListener, openWindowArgv, runAppCli, type AppCliDeps, type Attempt } from '../../src/app/cli.js';
import { AppServer, appSocketPath } from '../../src/app/server.js';
import { helperSocketPath } from '../../src/helper/paths.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-appcli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOME = '/Users/cris/.stephen';
const APP = '/Users/cris/Applications/Stephen Helper.app';

function deps(o: { files?: string[]; listener?: Attempt; helper?: Attempt; open?: Attempt; platform?: NodeJS.Platform } = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const files = new Set(o.files ?? []);
  const d: AppCliDeps = {
    home: () => HOME,
    platform: o.platform ?? 'darwin',
    appPath: APP,
    exists: (p) => files.has(p),
    askListener: async (p) => (calls.push(`listener ${p}`), o.listener ?? { ok: false, reason: 'unset' }),
    askHelper: async (p) => (calls.push(`helper ${p}`), o.helper ?? { ok: false, reason: 'unset' }),
    open: async (argv) => (calls.push(`open ${JSON.stringify(argv)}`), o.open ?? { ok: true }),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { d, calls, out, err };
}

describe('runAppCli', () => {
  it('asks the running listener first', async () => {
    const t = deps({ files: [appSocketPath(HOME), helperSocketPath(HOME), APP], listener: { ok: true } });
    expect(await runAppCli([], t.d)).toBe(0);
    expect(t.calls).toEqual([`listener ${appSocketPath(HOME)}`]);
    expect(t.out).toEqual(['Opened the Stephen window (asked the running `stephen listen`).']);
  });

  it('listener refuses (no helper link): falls back to the helper socket', async () => {
    const t = deps({ files: [appSocketPath(HOME), helperSocketPath(HOME)], listener: { ok: false, reason: "Stephen Helper isn't connected" }, helper: { ok: true } });
    expect(await runAppCli([], t.d)).toBe(0);
    expect(t.calls).toEqual([`listener ${appSocketPath(HOME)}`, `helper ${helperSocketPath(HOME)}`]);
    expect(t.out.at(-1)).toMatch(/^Opened the Stephen window \(Stephen Helper\)/);
  });

  it('nothing answers: starts the helper with open -a … --args --home <home> --open-window (argv only)', async () => {
    const t = deps({ files: [appSocketPath(HOME), APP], listener: { ok: false, reason: 'connect ECONNREFUSED' } });
    expect(await runAppCli([], t.d)).toBe(0);
    expect(t.calls.at(-1)).toBe(`open ${JSON.stringify(['-a', APP, '--args', '--home', HOME, '--open-window'])}`);
    expect(t.out).toEqual(['Note: stephen listen: connect ECONNREFUSED', 'Started Stephen Helper with its window open. Chat needs `stephen listen` running.']);
  });

  it('no sockets at all: skips straight to open', async () => {
    const t = deps({ files: [APP] });
    expect(await runAppCli([], t.d)).toBe(0);
    expect(t.calls).toEqual([`open ${JSON.stringify(openWindowArgv(APP, HOME))}`]);
  });

  it('helper not installed, open failing, not macOS, bad options', async () => {
    const missing = deps();
    expect(await runAppCli([], missing.d)).toBe(1);
    expect(missing.err[0]).toMatch(/not installed .*stephen install-helper/);

    const failing = deps({ files: [APP], open: { ok: false, reason: 'LSOpenURLsWithRole() failed' } });
    expect(await runAppCli([], failing.d)).toBe(1);
    expect(failing.err).toEqual(['Could not start Stephen Helper: LSOpenURLsWithRole() failed']);

    const linux = deps({ platform: 'linux', files: [APP] });
    expect(await runAppCli([], linux.d)).toBe(1);
    expect(linux.calls).toEqual([]);

    const bad = deps();
    expect(await runAppCli(['--now'], bad.d)).toBe(2);
    const help = deps();
    expect(await runAppCli(['--help'], help.d)).toBe(0);
    expect(help.out[0]).toMatch(/^stephen app: open the Stephen window/);
  });
});

describe('askListener (real app.sock)', () => {
  it('ok from a listener with a helper link; its error message otherwise; a missing socket fails', async () => {
    const home = mkdtempSync(join(tmp, 'l-'));
    let helperUp = true;
    const server = new AppServer({
      home,
      queue: { busy: () => false, start: () => null, stop: () => undefined },
      listening: () => true,
      model: 'sonnet',
      memory: null,
      endConversation: () => undefined,
      history: null,
      audit: null,
      settings: () => ({ config: {}, configPath: '' }),
      speakReplies: false,
      openWindow: () => (helperUp ? null : "Stephen Helper isn't connected to stephen listen"),
    });
    await server.start();
    try {
      server.setState('listening'); // a push arriving first must not be taken for the answer
      expect(await askListener(appSocketPath(home))).toEqual({ ok: true });
      helperUp = false;
      expect(await askListener(appSocketPath(home))).toEqual({ ok: false, reason: "Stephen Helper isn't connected to stephen listen" });
    } finally {
      await server.close();
    }
    expect((await askListener(appSocketPath(home))).ok).toBe(false);
  });
});

describe('askHelper (fake helper.sock)', () => {
  async function fakeHelper(hello: boolean) {
    const dir = mkdtempSync(join(tmp, 'hs-'));
    const path = join(dir, 'helper.sock');
    const got: string[] = [];
    const conns: Socket[] = [];
    const srv = createServer((s) => {
      conns.push(s);
      s.setEncoding('utf8');
      s.on('data', (d: string) => got.push(...d.split('\n').filter(Boolean)));
      if (hello) s.write(`${JSON.stringify({ type: 'hello', version: '1', inputMonitoring: true })}\n`);
    });
    await new Promise<void>((r) => srv.listen(path, () => r()));
    const close = () => {
      for (const c of conns) c.destroy();
      return new Promise<void>((r) => srv.close(() => r()));
    };
    return { path, got, close };
  }

  it('waits for hello, sends open_window, disconnects', async () => {
    const h = await fakeHelper(true);
    try {
      expect(await askHelper(h.path)).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 20));
      expect(h.got.map((l) => JSON.parse(l))).toEqual([{ type: 'open_window' }]);
    } finally {
      await h.close();
    }
  });

  it('no hello: gives up without sending', async () => {
    const h = await fakeHelper(false);
    try {
      expect(await askHelper(h.path, 150)).toEqual({ ok: false, reason: 'no hello from Stephen Helper' });
      expect(h.got).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
