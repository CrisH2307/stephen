/**
 * `stephen selftest` for real: the BUILT CLI against Chromium from @sparticuz/chromium.
 *  - Chrome: `selftest --browser chrome --json` with chrome.executablePath pointed at Chromium.
 *  - Zen: a fake `zen` executable (test/helpers/fake-zen.ts) that launches Chromium and prints Gecko's
 *    "WebDriver BiDi listening on ws://…" line, so the real ZenDriver launch + BiDi connect path runs.
 *  - A "zen" that never prints that line: the failure hint, and cleanup of only what selftest started.
 * The user config asks for REAL profiles in both browsers; the selftest must never touch them.
 */
import { execFile, execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { isPidAlive } from '../../src/drivers/util.js';
import { defaultSelftestDeps, runSelftest, type SelftestReport } from '../../src/selftest/index.js';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';
import { writeFakeZen } from '../helpers/fake-zen.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist/cli.js');

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 180_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** True if any process has `needle` in its command line. */
function running(needle: string): boolean {
  try {
    execFileSync('pgrep', ['-f', needle], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function killAll(needle: string): void {
  try {
    execFileSync('pkill', ['-KILL', '-f', needle], { stdio: 'ignore' });
  } catch {
    /* none */
  }
}

describe('Stephen selftest (real Chromium)', () => {
  let home: string;
  let configText: string;
  let realChromeDir: string;
  let realZenProfile: string;

  beforeAll(async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    home = mkdtempSync(join(tmpdir(), 'bh-selftest-'));
    const chromium = await chromiumPath();
    const fakeZen = await writeFakeZen(home, chromium);
    // "Real" profiles that must never be used: a Chrome DevToolsActivePort to nowhere, a Zen profile dir.
    realChromeDir = join(home, 'real-chrome');
    realZenProfile = join(home, 'real-zen');
    mkdirSync(realChromeDir);
    mkdirSync(realZenProfile);
    writeFileSync(join(realChromeDir, 'DevToolsActivePort'), '1\n/devtools/browser/never\n');
    configText = JSON.stringify({
      defaultBrowser: 'zen',
      chrome: { mode: 'real', userDataDir: realChromeDir, executablePath: chromium, extraArgs: chromiumArgs() },
      zen: { mode: 'real', profilePath: realZenProfile, executablePath: fakeZen, extraArgs: chromiumArgs() },
      safety: { confirm: 'auto' },
    });
    writeFileSync(join(home, 'config.json'), configText);
  });

  afterAll(() => {
    if (!home) return;
    killAll(home);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const expectCleanHome = () => {
    expect(existsSync(join(home, 'selftest'))).toBe(false); // temp profile deleted
    expect(existsSync(join(home, 'audit.log'))).toBe(false); // the user's audit log was never written
    expect(existsSync(join(home, 'state'))).toBe(false);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(configText);
    expect(readdirSync(realZenProfile)).toEqual([]); // real Zen profile untouched (no user.js)
    expect(running(join(home, 'selftest'))).toBe(false); // nothing left running
  };

  const passedAll = (report: SelftestReport, browser: string) => {
    const b = report.browsers.find((x) => x.browser === browser)!;
    const notPassed = b.checks.filter((c) => c.status !== 'pass');
    expect(notPassed, JSON.stringify(notPassed, null, 2)).toEqual([]);
    expect(b.checks.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    return b;
  };

  it('selftest --browser chrome --json: all 16 checks pass over CDP in a temp agent profile', async () => {
    const r = await runCli(['selftest', '--browser', 'chrome', '--json'], { STEPHEN_HOME: home });
    const report = JSON.parse(r.stdout) as SelftestReport;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(report).toMatchObject({ ok: true, exitCode: 0, node: process.versions.node });
    const chrome = passedAll(report, 'chrome');
    expect(chrome).toMatchObject({ status: 'pass', protocol: 'cdp' });
    expect(chrome.version).toMatch(/Chrome\/\d+/);
    expect(chrome.profileDir!.startsWith(join(home, 'selftest', 'chrome-'))).toBe(true);
    expect(chrome.profileDir!.endsWith('/profile')).toBe(true);
    expect(chrome.checks[15]!.detail).toMatch(/browser quit on request.*temp profile deleted/);
    expectCleanHome();
  }, 180_000);

  it('selftest --browser zen: the real Zen launch path (BiDi line on stderr → /session) passes all checks', async () => {
    const r = await runCli(['selftest', '--browser', 'zen'], { STEPHEN_HOME: home });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Zen \(WebDriver BiDi\) — .*\/zen$/m);
    expect(r.stdout).toMatch(/^ {2}16 {2}disconnect & clean up +PASS .*BiDi session ended/m);
    expect(r.stdout).toMatch(/^Result: PASS — zen 16\/16 passed$/m);
    expectCleanHome();
  }, 180_000);

  it('a Zen that never reports its BiDi endpoint: actionable FAIL, stops only what it started', async () => {
    const home3 = mkdtempSync(join(tmpdir(), 'bh-selftest-hung-'));
    const hung = join(home3, 'zen');
    writeFileSync(hung, '#!/bin/sh\necho "fake zen: starting up"\nsleep 300\n');
    chmodSync(hung, 0o755);
    // A process the selftest did NOT start, that looks just like what it launches.
    const bystander: ChildProcess = spawn('/bin/sh', [hung, '--profile', join(home3, 'bystander')], { stdio: 'ignore', detached: true });
    try {
      const deps = {
        ...defaultSelftestDeps({ zenListenTimeoutMs: 2000 }),
        loadConfig: () => loadConfig({ zen: { executablePath: hung } }, { HOME: home3, STEPHEN_HOME: home3 }),
        configPath: () => join(home3, 'config.json'),
      };
      const report = await runSelftest({ browser: 'zen', keepOpen: false, json: true }, deps);
      expect(report.exitCode).toBe(1);
      const [first, ...rest] = report.browsers[0]!.checks;
      expect(first).toMatchObject({ id: 1, status: 'fail' });
      expect(first!.detail).toMatch(/has not enabled remote control within 2 s/);
      expect(first!.hint).toMatch(/never printed "WebDriver BiDi listening on ws:\/\/…"/);
      expect(first!.hint).toMatch(/Zen said: fake zen: starting up/);
      expect(rest.slice(0, 14).every((c) => c.status === 'skip')).toBe(true);
      expect(rest[14]).toMatchObject({ id: 16, status: 'pass' });
      expect(rest[14]!.detail).toMatch(/stopped with SIGTERM.*temp profile deleted/);
      expect(existsSync(join(home3, 'selftest'))).toBe(false);
      expect(running(join(home3, 'selftest'))).toBe(false);
      expect(isPidAlive(bystander.pid!)).toBe(true); // never kills what it did not start
    } finally {
      try {
        process.kill(-bystander.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
      rmSync(home3, { recursive: true, force: true });
    }
  }, 60_000);
});
