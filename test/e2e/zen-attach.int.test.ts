/**
 * Attach-only Zen end to end, with the BUILT CLI and a fake "zen" (test/helpers/fake-zen.ts: Chromium
 * behind Gecko's "WebDriver BiDi listening on ws://…" line):
 *  1. `serve` with the default config (zen real + launch never) and no Zen: a NEEDS_USER error, nothing spawned;
 *  2. `zen-launch` starts "Zen" on the real profile and exits, leaving it running and the state written;
 *  3. the user opens a tab themselves;
 *  4. the SAME server (no restart) now attaches: tabs_list shows the user's tab, a click works,
 *     and no second browser process appears;
 *  5. the server exits: the browser keeps running with the user's tab, the session ownership is released;
 *  6. a Zen opened normally (no state): `zen-launch` exits 2, and `serve` explains how to reopen it.
 */
import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDevToolsActivePort } from '../../src/drivers/macos.js';
import { isPidAlive } from '../../src/drivers/util.js';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';
import { writeFakeZen } from '../helpers/fake-zen.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist/cli.js');

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const text = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const PAGE = `<!doctype html><html><head><title>Say So</title></head><body>
<h1>Say So</h1><button id="play" onclick="document.title='Playing: Say So'">Play</button></body></html>`;

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

/** pids of processes whose command line contains `needle` (excluding pgrep itself). */
function pids(needle: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', needle]).toString().trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Main Chromium processes on `profile` (child processes carry --type=…). */
function browserPids(profile: string): number[] {
  return execFileSync('ps', ['-eo', 'pid=,args='])
    .toString()
    .split('\n')
    .filter((l) => l.includes(`--user-data-dir=${profile}`) && !l.includes('--type='))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('attach-only Zen: zen-launch + serve (fake zen on real Chromium)', () => {
  let home: string;
  let fakeZen: string;
  let profile: string;
  let http: Server;
  let url: string;
  const env = () => ({ BROWSER_HUB_HOME: home });
  const statePath = () => join(home, 'state', 'zen.json');

  async function startServe(): Promise<{ client: Client; call: (n: string, a?: Record<string, unknown>) => Promise<ToolResult>; transport: StdioClientTransport }> {
    const client = new Client({ name: 'zen-attach-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve'],
      env: { ...process.env, ...env() } as Record<string, string>,
      stderr: 'ignore',
    });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
    return { client, call, transport };
  }

  beforeAll(async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    home = mkdtempSync(join(tmpdir(), 'bh-zen-attach-'));
    fakeZen = await writeFakeZen(home, await chromiumPath());
    profile = join(home, 'real-zen');
    mkdirSync(profile);
    // The DEFAULT zen settings (no mode, no launch) → real profile, attach-only.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ defaultBrowser: 'zen', zen: { executablePath: fakeZen, profilePath: profile, extraArgs: chromiumArgs() }, safety: { confirm: 'deny' } }),
    );
    http = createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
    // No other "zen" may be running for the not-running case to be meaningful.
    expect(pids(fakeZen)).toEqual([]);
  }, 180_000);

  afterAll(async () => {
    http?.close();
    if (!home) return;
    // Clean up only what this test started (the fake zen and its Chromium live under `home`).
    try {
      execFileSync('pkill', ['-KILL', '-f', home], { stdio: 'ignore' });
    } catch {
      /* none left */
    }
    await waitFor(() => pids(home).length === 0, 10_000, 'test processes to exit').catch(() => undefined);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('never launches Zen itself; zen-launch makes the user\'s Zen Claude-ready; serve attaches to it and leaves it running', async () => {
    const srv = await startServe();
    try {
      // 1) Default config, no Zen: status says attach-only, and a Zen tool explains what to do — nothing spawned.
      expect(text(await srv.call('browser_status'))).toContain('Zen: attach-only (uses your open Zen; never launches one)');
      const none = await srv.call('tabs_list', { browser: 'zen' });
      expect(none.isError).toBe(true);
      expect(text(none)).toMatch(/NEEDS_USER: Zen isn't open\. Open Zen with the 'Zen for Claude' app/);
      const agent = await srv.call('browser_connect', { browser: 'zen', mode: 'agent' });
      expect(text(agent)).toMatch(/DENIED.*attach-only/s);
      expect(pids(fakeZen)).toEqual([]);
      expect(browserPids(profile)).toEqual([]);

      // 2) zen-launch: starts it, records it, exits; Zen keeps running.
      const launched = await runCli(['zen-launch', '--json'], env());
      expect(launched.code, launched.stdout + launched.stderr).toBe(0);
      const result = JSON.parse(launched.stdout) as { status: string; pid: number; wsUrl: string; profileDir: string };
      expect(result).toMatchObject({ status: 'launched', profileDir: profile });
      expect(result.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/session$/);
      expect(isPidAlive(result.pid)).toBe(true);
      expect(pids(fakeZen)).toEqual([result.pid]);
      const state = JSON.parse(readFileSync(statePath(), 'utf8'));
      expect(state).toEqual({ pid: result.pid, wsUrl: result.wsUrl, profileDir: profile, mode: 'real' }); // no owner: no session open
      expect(readFileSync(join(profile, 'user.js'), 'utf8')).toContain('user_pref("remote.prefs.recommended", false);');
      await waitFor(async () => (await readDevToolsActivePort(profile)) !== null, 30_000, 'Chromium to start');
      const browserPid = browserPids(profile);
      expect(browserPid).toHaveLength(1);

      // Running it again just reports the ready Zen (exit 0) — no second browser.
      const again = await runCli(['zen-launch'], env());
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain(`✓ Zen is already running with Claude access (pid ${result.pid}).`);

      // 3) The user opens a tab themselves (their own connection, then gone).
      const port = (await readDevToolsActivePort(profile))!;
      const user = await puppeteer.connect({ browserWSEndpoint: port.wsEndpoint, defaultViewport: null });
      const userPage = await user.newPage();
      await userPage.goto(url);
      await user.disconnect();

      // 4) The same server now attaches (nothing restarted) and works in the user's tab.
      const tabs = text(await srv.call('tabs_list', { browser: 'zen' }));
      const m = /- (z\d+) "Say So" http:\/\/127\.0\.0\.1:\d+\//.exec(tabs);
      expect(m, tabs).not.toBeNull();
      const tab = m![1]!;
      const snap = text(await srv.call('snapshot', { tab }));
      const ref = /button "Play" \[ref=([^\]]+)\]/.exec(snap)?.[1];
      expect(ref, snap).toBeTruthy();
      const click = await srv.call('click', { target: ref, intent: 'play the song' });
      expect(click.isError, text(click)).toBeFalsy();
      await waitFor(async () => /"Playing: Say So"/.test(text(await srv.call('tabs_list', { browser: 'zen' }))), 10_000, 'the click to take effect');
      const status = text(await srv.call('browser_status'));
      expect(status).toMatch(/- zen: connected · real profile/);
      expect(status).toMatch(/Attached to your open Zen \(pid \d+/);
      // Exactly the one browser zen-launch started: no second Zen, no second Chromium.
      expect(pids(fakeZen)).toEqual([result.pid]);
      expect(browserPids(profile)).toEqual(browserPid);
      expect(JSON.parse(readFileSync(statePath(), 'utf8')).ownerPid).toEqual(expect.any(Number));
    } finally {
      await srv.client.close();
    }

    // 5) Server gone: the session ownership is released and the browser (with the user's tab) still runs.
    await waitFor(() => JSON.parse(readFileSync(statePath(), 'utf8')).ownerPid === undefined, 15_000, 'ownership release');
    const st = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(isPidAlive(st.pid)).toBe(true);
    const port = (await readDevToolsActivePort(profile))!;
    const check = await puppeteer.connect({ browserWSEndpoint: port.wsEndpoint, defaultViewport: null });
    try {
      const titles = await Promise.all((await check.pages()).map((p) => p.title()));
      expect(titles).toContain('Playing: Say So');
    } finally {
      await check.disconnect();
    }

    // A fresh server reattaches to the same Zen (still no spawn).
    const srv2 = await startServe();
    try {
      expect(text(await srv2.call('tabs_list', { browser: 'zen' }))).toContain('"Playing: Say So"');
      expect(pids(fakeZen)).toEqual([st.pid]);
    } finally {
      await srv2.client.close();
    }
  }, 240_000);

  it('a Zen opened normally (no Claude access): zen-launch exits 2, serve says to reopen it with the app; nothing is quit or spawned', async () => {
    // Stop the Claude-ready one from the previous test (test cleanup only — browser-hub itself never kills Zen).
    try {
      execFileSync('pkill', ['-TERM', '-f', fakeZen], { stdio: 'ignore' });
    } catch {
      /* not running */
    }
    await waitFor(() => pids(home).length === 0, 20_000, 'the previous fake zen to exit');

    // The user opens "Zen" normally: same profile, no state file entry.
    const normal = spawn(fakeZen, ['--profile', profile, ...chromiumArgs()], { detached: true, stdio: 'ignore' });
    normal.unref();
    await waitFor(() => pids(fakeZen).length === 1, 10_000, 'the normal zen to start');

    const r = await runCli(['zen-launch'], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^! Zen is open without Claude access\. .*--quit-running/);
    expect(r.stdout).toBe('');
    const json = await runCli(['zen-launch', '--json'], env());
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ exitCode: 2, status: 'zen-running' });

    const srv = await startServe();
    try {
      const res = await srv.call('tab_open', { browser: 'zen', intent: 'open the song' });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/NEEDS_USER: Zen is open, but it wasn't started with Claude access\. Quit Zen \(⌘Q\) and reopen it with the 'Zen for Claude' app/);
    } finally {
      await srv.client.close();
    }
    // still exactly the user's Zen, untouched
    expect(pids(fakeZen)).toEqual([normal.pid]);
    expect(isPidAlive(normal.pid!)).toBe(true);
    expect(existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')).pid : null).not.toBe(normal.pid);
  }, 180_000);

  it('install-zen-launcher --dry-run prints the AppleScript with the real node and cli paths', async () => {
    const r = await runCli(['install-zen-launcher', '--dry-run'], { ...env(), HOME: join(home, 'user home') });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`App:     ${join(home, 'user home', 'Applications', 'Zen for Claude.app')}`);
    expect(r.stdout).toContain(`set nodePath to ${JSON.stringify(process.execPath)}`);
    expect(r.stdout).toContain(`set cliPath to ${JSON.stringify(CLI)}`);
    expect(existsSync(join(home, 'user home'))).toBe(false);
  });
});
