/**
 * Unit tests for `browser-hub selftest` orchestration — no browser: fake sessions, checks and fixtures.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HubConfig, loadConfig } from '../../src/config.js';
import { isZenAttachOnly } from '../../src/drivers/zen.js';
import {
  CHROME_SELFTEST_ARGS,
  assertSelftestConfig,
  buildSelftestConfig,
  connectHint,
  parseSelftestArgs,
  runSelftest,
  summarize,
  type BrowserReport,
  type SelftestDeps,
} from '../../src/selftest/index.js';
import { CHECK_NAMES, type CheckEnv, type CheckResult } from '../../src/selftest/checks.js';
import type { FixtureServer } from '../../src/selftest/fixtures.js';
import type { SelftestSession } from '../../src/selftest/session.js';
import type { BrowserName, ResolvedConfig } from '../../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A user config that asks for REAL profiles everywhere — the selftest must ignore that. */
function userConfig(): ResolvedConfig {
  const home = mkdtempSync(join(tmpdir(), 'bh-st-unit-'));
  dirs.push(home);
  return loadConfig(
    {
      chrome: { mode: 'real', executablePath: '/opt/chrome', extraArgs: ['--user-flag'] },
      zen: { mode: 'real', executablePath: '/opt/zen', profilePath: '/Users/me/zen-profile', extraArgs: ['--zen-flag'] },
      safety: { confirm: 'auto', sensitiveDomains: ['127.0.0.1'] },
    },
    { HOME: home, BROWSER_HUB_HOME: home },
  );
}

const passAll = (): CheckResult[] =>
  CHECK_NAMES.slice(0, 15).map((name, i) => ({ id: i + 1, name, status: 'pass' as const, ms: 10, detail: 'ok' }));

const fakeFixtures = (): FixtureServer & { closed: boolean } => {
  const f = {
    a: 'http://127.0.0.1:1',
    b: 'http://localhost:2',
    closed: false,
    submissions: () => [],
    hits: () => [],
    waitForHit: async () => false,
    close: async () => {
      f.closed = true;
    },
  };
  return f;
};

interface Harness {
  deps: SelftestDeps;
  log: string[];
  out: string[];
  configs: ResolvedConfig[];
  fixtures: ReturnType<typeof fakeFixtures>;
}

function harness(opts: {
  found?: Partial<Record<BrowserName, boolean>>;
  checks?: (env: CheckEnv) => Promise<CheckResult[]>;
  session?: Partial<SelftestSession>;
  openSession?: SelftestDeps['openSession'];
  removeRunDir?: SelftestDeps['removeRunDir'];
} = {}): Harness {
  const log: string[] = [];
  const out: string[] = [];
  const configs: ResolvedConfig[] = [];
  const user = userConfig();
  const fixtures = fakeFixtures();
  const found = { chrome: true, zen: true, ...opts.found };
  const deps: SelftestDeps = {
    loadConfig: () => user,
    locate: async (b, cfg) =>
      found[b] ? { found: true, path: cfg[b].executablePath } : { found: false, searched: [cfg[b].executablePath, `/Applications/Other/${b}`] },
    startFixtures: async () => fixtures,
    createRunDir: async (cfg, b) => {
      log.push(`mkdir ${b}`);
      return join(cfg.home, 'selftest', `${b}-abc123`);
    },
    removeRunDir: opts.removeRunDir ?? (async (dir) => void log.push(`rm ${dir.split('/').pop()}`)),
    openSession:
      opts.openSession ??
      (async (cfg, b) => {
        configs.push(cfg);
        log.push(`open ${b}`);
        return {
          call: async () => ({ content: [] }),
          version: async () => `Fake${b}/1.0`,
          spawnedPids: () => [4242],
          diagnostics: async () => 'last log line',
          disconnect: async () => void log.push('disconnect'),
          verifyDisconnected: async () => {
            log.push('verify');
            return 'verified';
          },
          closeBrowser: async () => {
            log.push('close');
            return 'browser closed';
          },
          release: async () => {
            log.push('release');
            return 'left running (pid 4242)';
          },
          ...opts.session,
        };
      }),
    runChecks: async (env) => {
      log.push(`checks ${env.browser}`);
      const r = await (opts.checks ?? (async () => passAll()))(env);
      for (const c of r) env.onResult?.(c);
      return r;
    },
    out: (l) => out.push(l),
    configPath: () => '/Users/me/.browser-hub/config.json',
  };
  return { deps, log, out, configs, fixtures };
}

const base = { keepOpen: false, json: false };

describe('parseSelftestArgs', () => {
  it('parses flags and rejects bad input', () => {
    expect(parseSelftestArgs([])).toEqual({ browser: 'all', keepOpen: false, json: false });
    expect(parseSelftestArgs(['--browser', 'zen', '--keep-open', '--json'])).toEqual({ browser: 'zen', keepOpen: true, json: true });
    expect(parseSelftestArgs(['--browser=chrome'])).toEqual({ browser: 'chrome', keepOpen: false, json: false });
    expect(parseSelftestArgs(['--browser', 'safari'])).toHaveProperty('error');
    expect(parseSelftestArgs(['--browser'])).toHaveProperty('error');
    expect(parseSelftestArgs(['--real'])).toHaveProperty('error');
  });
});

describe('buildSelftestConfig (never real mode)', () => {
  it('forces agent mode and keeps everything stateful inside the temp dir', () => {
    const user = userConfig();
    const runDir = join(user.home, 'selftest', 'zen-xyz');
    for (const b of ['chrome', 'zen'] as const) {
      const cfg = buildSelftestConfig(user, b, runDir, `/found/${b}`);
      expect(cfg.chrome.mode).toBe('agent');
      expect(cfg.zen.mode).toBe('agent');
      expect(cfg.zen.profilePath).toBeNull();
      expect(cfg[b].executablePath).toBe(`/found/${b}`);
      expect(cfg[b].agentProfileDir).toBe(join(runDir, 'profile'));
      expect(cfg.home).toBe(runDir);
      expect(cfg.auditLogPath).toBe(join(runDir, 'audit.log'));
      expect(cfg.auditLogPath).not.toBe(user.auditLogPath);
      expect(cfg.stateDir.startsWith(runDir)).toBe(true);
      expect(cfg.output.saveDir.startsWith(runDir)).toBe(true);
      // Real-profile locations point at a dir that does not exist inside the temp dir.
      expect(cfg.chrome.userDataDir.startsWith(runDir)).toBe(true);
      expect(cfg.zen.zenAppSupportDir.startsWith(runDir)).toBe(true);
      // Safety: default lists (deterministic), never asks a human.
      expect(cfg.safety.confirm).toBe('deny');
      expect(cfg.safety.sensitiveDomains).toEqual([]);
      // The user's launch flags are kept.
      expect(cfg.chrome.extraArgs).toEqual(['--user-flag', ...CHROME_SELFTEST_ARGS]);
      expect(cfg.zen.extraArgs).toEqual(['--zen-flag']);
      expect(() => assertSelftestConfig(cfg, runDir)).not.toThrow();
    }
  });

  it('assertSelftestConfig refuses anything that could reach a real profile or the user audit log', () => {
    const user = userConfig();
    const runDir = join(user.home, 'selftest', 'chrome-1');
    const good = buildSelftestConfig(user, 'chrome', runDir, '/c');
    expect(() => assertSelftestConfig({ ...good, chrome: { ...good.chrome, mode: 'real' } }, runDir)).toThrow(/agent mode/);
    expect(() => assertSelftestConfig({ ...good, zen: { ...good.zen, profilePath: '/x' } }, runDir)).toThrow(/profilePath/);
    expect(() => assertSelftestConfig({ ...good, auditLogPath: user.auditLogPath }, runDir)).toThrow(/auditLogPath/);
    expect(() => assertSelftestConfig({ ...good, safety: { ...good.safety, confirm: 'auto' } }, runDir)).toThrow(/deny/);
  });

  it('the attach-only Zen default does not reach the selftest: it always launches its own temporary agent Zen', () => {
    const user = userConfig();
    expect([user.zen.mode, (user as HubConfig).zen.launch]).toEqual(['real', 'never']);
    const runDir = join(user.home, 'selftest', 'zen-1');
    const cfg = buildSelftestConfig(user, 'zen', runDir, '/z');
    expect([cfg.zen.mode, cfg.zen.launch]).toEqual(['agent', 'auto']);
    expect(isZenAttachOnly(cfg)).toBe(false);
    const never: HubConfig = { ...cfg, zen: { ...cfg.zen, launch: 'never' } };
    expect(() => assertSelftestConfig(never, runDir)).toThrow(/zen\.launch/);
  });
});

describe('runSelftest orchestration', () => {
  it('runs every found browser in agent mode, prints a table, cleans up and exits 0', async () => {
    const h = harness();
    const report = await runSelftest({ ...base, browser: 'all' }, h.deps);
    expect(report.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.browsers.map((b) => [b.browser, b.status, b.checks.length])).toEqual([
      ['chrome', 'pass', 16],
      ['zen', 'pass', 16],
    ]);
    expect(report.browsers[1]!.version).toBe('Fakezen/1.0');
    expect(report.browsers[1]!.protocol).toBe('webDriverBiDi');
    // Never real: every session got agent-only configs even though the user config says real.
    expect(h.configs).toHaveLength(2);
    for (const c of h.configs) {
      expect([c.chrome.mode, c.zen.mode]).toEqual(['agent', 'agent']);
      expect(c.safety.confirm).toBe('deny');
    }
    expect(h.log).toEqual([
      'mkdir chrome', 'open chrome', 'checks chrome', 'disconnect', 'verify', 'close', 'rm chrome-abc123',
      'mkdir zen', 'open zen', 'checks zen', 'disconnect', 'verify', 'close', 'rm zen-abc123',
    ]);
    expect(h.fixtures.closed).toBe(true);
    const text = h.out.join('\n');
    expect(text).toMatch(/^Chrome \(CDP\) — \/opt\/chrome$/m);
    expect(text).toMatch(/^Zen \(WebDriver BiDi\) — \/opt\/zen$/m);
    expect(text).toMatch(/your configured real profile is never used/);
    expect(text).toMatch(/^ {3}1 {2}connect & open tab +PASS +10 ms {2}ok$/m);
    expect(text).toMatch(/^ {2}16 {2}disconnect & clean up +PASS +\d+ ms {2}verified; browser closed; temp profile deleted$/m);
    expect(text).toMatch(/browser version: Fakechrome\/1\.0/);
    expect(text.split('\n').at(-1)).toBe('Result: PASS — chrome 16/16 passed · zen 16/16 passed');
  });

  it('skips a browser whose binary is missing (with where it looked) and still exits 0', async () => {
    const h = harness({ found: { zen: false } });
    const report = await runSelftest({ ...base, browser: 'all' }, h.deps);
    expect(report.exitCode).toBe(0);
    const zen = report.browsers.find((b) => b.browser === 'zen')!;
    expect(zen.status).toBe('skip');
    expect(zen.checks).toEqual([]);
    expect(zen.hint).toContain('/opt/zen, /Applications/Other/zen');
    expect(zen.hint).toContain('"zen.executablePath"');
    expect(h.log.some((l) => l.includes('zen'))).toBe(false); // nothing created or launched for it
    expect(h.out.join('\n')).toMatch(/SKIP: Zen not found/);
    expect(report.summary).toBe('Result: PASS — chrome 16/16 passed · zen skipped (Zen not found)');
  });

  it('fails when the requested browser is missing, and when nothing at all could be tested', async () => {
    const one = await runSelftest({ ...base, browser: 'zen' }, harness({ found: { zen: false } }).deps);
    expect(one.exitCode).toBe(1);
    expect(one.browsers[0]!.status).toBe('fail');
    const none = await runSelftest({ ...base, browser: 'all' }, harness({ found: { zen: false, chrome: false } }).deps);
    expect(none.exitCode).toBe(1);
    expect(none.summary).toMatch(/no browser could be tested/);
  });

  it('a failed check fails the run, with the fix shown under the row', async () => {
    const h = harness({
      checks: async () =>
        passAll().map((c) => (c.id === 10 ? { ...c, status: 'fail' as const, detail: 'the server received 1 submission(s)', hint: 'Do not use it.' } : c)),
    });
    const report = await runSelftest({ ...base, browser: 'chrome' }, h.deps);
    expect(report.exitCode).toBe(1);
    expect(report.browsers[0]!.status).toBe('fail');
    const text = h.out.join('\n');
    expect(text).toMatch(/^ {2}10 {2}"Send" refused, nothing submitted +FAIL +10 ms {2}the server received 1 submission\(s\)\n {8}fix: Do not use it\.$/m);
    expect(report.summary).toBe('Result: FAIL — chrome FAILED (15/16 passed; failed: 10)');
    expect(h.log).toContain('close'); // still cleaned up
  });

  it('cleans up when the checks crash: browser closed, temp dir removed, missing checks reported', async () => {
    const h = harness({
      checks: async () => {
        throw new Error('boom');
      },
    });
    const report = await runSelftest({ ...base, browser: 'chrome' }, h.deps);
    expect(report.exitCode).toBe(1);
    const checks = report.browsers[0]!.checks;
    expect(checks).toHaveLength(16);
    expect(checks[0]).toMatchObject({ id: 1, status: 'fail', detail: 'selftest error: boom' });
    expect(checks.slice(1, 15).every((c) => c.status === 'skip')).toBe(true);
    expect(checks[15]).toMatchObject({ id: 16, status: 'pass' });
    // Check 1 did not pass, so there is no connection to verify — but everything is still torn down.
    expect(h.log).toEqual(['mkdir chrome', 'open chrome', 'checks chrome', 'disconnect', 'close', 'rm chrome-abc123']);
  });

  it('removes the temp dir even if the session could not be opened', async () => {
    const h = harness({
      openSession: async () => {
        throw new Error('no MCP');
      },
    });
    const report = await runSelftest({ ...base, browser: 'zen' }, h.deps);
    expect(report.exitCode).toBe(1);
    expect(h.log).toEqual(['mkdir zen', 'rm zen-abc123']);
  });

  it('adds the browser log to a failed connect, and skips post-disconnect verification', async () => {
    const h = harness({
      checks: async () => [
        { id: 1, name: CHECK_NAMES[0]!, status: 'fail', ms: 60000, detail: 'browser_connect failed', hint: 'Zen never printed the BiDi line.' },
      ],
    });
    const report = await runSelftest({ ...base, browser: 'zen' }, h.deps);
    const first = report.browsers[0]!.checks[0]!;
    expect(first.hint).toBe('Zen never printed the BiDi line. Zen said: last log line');
    expect(h.log).not.toContain('verify');
    expect(h.log).toContain('close');
  });

  it('reports a cleanup failure as a failed check 16 and still deletes the temp dir', async () => {
    const h = harness({
      session: {
        closeBrowser: async () => {
          throw new Error('could not stop the browser it started (pid 4242)');
        },
      },
    });
    const report = await runSelftest({ ...base, browser: 'chrome' }, h.deps);
    expect(report.exitCode).toBe(1);
    const last = report.browsers[0]!.checks[15]!;
    expect(last.status).toBe('fail');
    expect(last.detail).toMatch(/closing the browser: could not stop/);
    expect(last.hint).toMatch(/quit it/);
    expect(h.log).toContain('rm chrome-abc123');
  });

  it('--keep-open leaves the browser and profile, but still ends the session', async () => {
    const h = harness();
    const report = await runSelftest({ ...base, keepOpen: true, browser: 'chrome' }, h.deps);
    expect(report.exitCode).toBe(0);
    expect(h.log).toEqual(['mkdir chrome', 'open chrome', 'checks chrome', 'disconnect', 'verify', 'release']);
    expect(report.browsers[0]!.checks[15]!.detail).toMatch(/left running \(pid 4242\); profile kept at .*chrome-abc123/);
  });

  it('--json prints nothing itself (the CLI prints the report)', async () => {
    const h = harness();
    const report = await runSelftest({ ...base, json: true, browser: 'all' }, h.deps);
    expect(h.out).toEqual([]);
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed.browsers[0]!.checks[0]).toMatchObject({ id: 1, name: 'connect & open tab', status: 'pass', ms: 10 });
    expect(parsed).toMatchObject({ ok: true, exitCode: 0, node: process.versions.node });
  });
});

describe('summarize', () => {
  const b = (browser: BrowserName, status: BrowserReport['status']): BrowserReport => ({
    browser,
    status,
    protocol: 'cdp',
    executablePath: null,
    version: null,
    profileDir: null,
    checks: status === 'skip' ? [] : passAll(),
  });
  it('exit 0 only if something ran and nothing failed', () => {
    expect(summarize([b('chrome', 'pass'), b('zen', 'skip')]).exitCode).toBe(0);
    expect(summarize([b('chrome', 'pass'), b('zen', 'fail')]).exitCode).toBe(1);
    expect(summarize([b('chrome', 'skip'), b('zen', 'skip')]).exitCode).toBe(1);
  });
});

describe('connectHint', () => {
  const cfg = '/u/.browser-hub/config.json';
  it('maps driver errors to actionable fixes', () => {
    expect(connectHint('zen', 'NOT_CONNECTED: Zen was not found at /Applications/Zen.app/…', cfg)).toMatch(/"zen\.executablePath".*config\.json/);
    expect(connectHint('zen', 'NOT_CONNECTED: Zen (pid 9) was started but has not enabled remote control within 60 s', cfg)).toMatch(
      /WebDriver BiDi listening on.*first launch after a Zen update/,
    );
    expect(connectHint('zen', 'NOT_CONNECTED: Zen exited right after launch (exit code 1)', cfg)).toMatch(/quit right after starting/);
    expect(connectHint('chrome', 'NOT_CONNECTED: Launched Chrome (x) but it did not open its debugging port within 15 s', cfg)).toMatch(
      /chrome\.extraArgs/,
    );
    expect(connectHint('chrome', 'something odd', cfg)).toMatch(/browser-hub doctor/);
  });
});
