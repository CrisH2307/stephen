import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectOptions } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpawnedProcess } from '../../src/drivers/util.js';
import {
  ZEN_ATTACH_ONLY_LABEL,
  ZEN_NOT_CLAUDE_READY_MESSAGE,
  ZEN_NOT_RUNNING_MESSAGE,
  ZEN_RUNNING_MESSAGE,
  ZenDriver,
  type ZenDriverDeps,
  bidiSessionEndpoint,
  buildUserJsBlock,
  buildZenArgs,
  ensureUserJsBlock,
  isSessionLimitError,
  isZenAttachOnly,
  sanitizeExtraPrefs,
  upsertUserJsBlock,
  zenLaunchOf,
} from '../../src/drivers/zen.js';
import { HubError } from '../../src/errors.js';
import { FakeBrowser, type TestConfig, makeTestConfig } from './helpers.js';

let tc: TestConfig;
afterEach(() => tc?.cleanup());

const PREF = 'user_pref("remote.prefs.recommended", false);';

describe('buildZenArgs / bidiSessionEndpoint', () => {
  it('builds the launch args with extra args last', () => {
    expect(buildZenArgs('/p/zen', ['--headless'])).toEqual([
      '--profile',
      '/p/zen',
      '--new-instance',
      '--remote-debugging-port',
      '0',
      '--headless',
    ]);
  });
  it('appends /session exactly once', () => {
    expect(bidiSessionEndpoint('ws://127.0.0.1:9222')).toBe('ws://127.0.0.1:9222/session');
    expect(bidiSessionEndpoint('ws://127.0.0.1:9222/')).toBe('ws://127.0.0.1:9222/session');
    expect(bidiSessionEndpoint('ws://127.0.0.1:9222/session')).toBe('ws://127.0.0.1:9222/session');
  });
});

describe('user.js block', () => {
  it('adds the block to an empty file and is idempotent', () => {
    const once = upsertUserJsBlock('');
    expect(once).toContain(PREF);
    expect(once.startsWith('// >>> stephen')).toBe(true);
    expect(upsertUserJsBlock(once)).toBe(once);
  });

  it('preserves existing content and appends after it', () => {
    const existing = 'user_pref("browser.startup.page", 3);\n// my comment';
    const out = upsertUserJsBlock(existing);
    expect(out.startsWith(`${existing}\n// >>> stephen`)).toBe(true);
    expect(upsertUserJsBlock(out)).toBe(out);
  });

  it('replaces an outdated block in place, keeping lines before and after', () => {
    const old = 'a();\n// >>> stephen old header\nuser_pref("x", 1);\n// <<< stephen\nb();\n';
    const out = upsertUserJsBlock(old);
    expect(out).toMatch(/^a\(\);\n\/\/ >>> stephen/);
    expect(out).toContain(PREF);
    expect(out).not.toContain('user_pref("x", 1)');
    expect(out.endsWith('// <<< stephen\nb();\n')).toBe(true);
    expect(out.match(/>>> stephen/g)).toHaveLength(1);
  });

  it('replaces the block browser-hub (the pre-rename name) wrote, in place — never a second block', () => {
    const old = 'a();\n// >>> browser-hub (managed by browser-hub; keeps automation prefs out of your real profile)\nuser_pref("x", 1);\n// <<< browser-hub\nb();\n';
    const out = upsertUserJsBlock(old);
    expect(out).toBe(`a();\n${upsertUserJsBlock('')}b();\n`);
    expect(out).not.toContain('browser-hub');
    expect(out.match(/>>> /g)).toHaveLength(1);
    expect(upsertUserJsBlock(out)).toBe(out);
    // both an old and a new block (should not happen): one block remains, where the first one was
    const both = `${old}c();\n${upsertUserJsBlock('')}d();\n`;
    const merged = upsertUserJsBlock(both);
    expect(merged).toBe(`a();\n${upsertUserJsBlock('')}b();\nc();\nd();\n`);
    // a block-like comment with another name is not ours and is kept
    const foreign = '// >>> stephenson\nuser_pref("y", 2);\n// <<< stephenson\n';
    expect(upsertUserJsBlock(foreign)).toBe(`${foreign}${upsertUserJsBlock('')}`);
  });

  it('ensureUserJsBlock writes once, then reports no change', async () => {
    tc = makeTestConfig();
    const dir = join(tc.home, 'profile');
    mkdirSync(dir);
    writeFileSync(join(dir, 'user.js'), 'user_pref("keep.me", true);\n');
    expect(await ensureUserJsBlock(dir)).toBe(true);
    expect(await ensureUserJsBlock(dir)).toBe(false);
    const text = readFileSync(join(dir, 'user.js'), 'utf8');
    expect(text.startsWith('user_pref("keep.me", true);\n')).toBe(true);
    expect(text.split(PREF)).toHaveLength(2);
  });
});

describe('isSessionLimitError', () => {
  it('matches Gecko session-limit errors', () => {
    expect(isSessionLimitError(new Error('session not created Maximum number of active sessions'))).toBe(true);
    expect(isSessionLimitError(new Error('Protocol error (session.new): session not created'))).toBe(true);
    expect(isSessionLimitError(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe(false);
  });
});

// ───────────── ZenDriver with fakes ─────────────

class FakeChild extends EventEmitter {
  readonly stderr = null;
  killed = false;
  constructor(readonly pid: number | undefined) {
    super();
  }
  unref(): void {}
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Harness {
  driver: ZenDriver;
  spawns: { cmd: string; args: readonly string[]; opts: SpawnOptions }[];
  connects: ConnectOptions[];
  browsers: FakeBrowser[];
  children: FakeChild[];
}

type HarnessOpts = Partial<ZenDriverDeps> & {
  /** Line the fake Zen prints to its log; null = prints nothing. */
  line?: string | null;
  /** Fake child exits immediately with this code. */
  exitCode?: number;
  connectError?: Error;
};

function harness(opts: HarnessOpts = {}): Harness {
  const h: Harness = { driver: undefined as unknown as ZenDriver, spawns: [], connects: [], browsers: [], children: [] };
  const { line = 'WebDriver BiDi listening on ws://127.0.0.1:4444', exitCode, connectError, ...deps } = opts;
  h.driver = new ZenDriver(tc.cfg, {
    isExecutable: async () => true,
    otherUserCount: async () => 0, // B5: a single-user Mac unless a test says otherwise
    isProcessRunning: async () => false,
    isPidAlive: () => false,
    listenTimeoutMs: 300,
    pollIntervalMs: 10,
    spawn: (cmd, args, spawnOpts) => {
      h.spawns.push({ cmd, args, opts: spawnOpts });
      const child = new FakeChild(5000 + h.spawns.length);
      h.children.push(child);
      const stdio = spawnOpts.stdio as unknown[];
      if (line !== null) writeSync(stdio[2] as number, `1730000000\tRemoteAgent\tINFO\t${line}\n`);
      // nextTick: the exit lands while #launch still awaits log.close(), the race behind #109.
      // A driver that watches the child only after that await misses it and times out.
      if (exitCode !== undefined) process.nextTick(() => child.emit('exit', exitCode, null));
      return child as unknown as SpawnedProcess;
    },
    connect: async (o) => {
      h.connects.push(o);
      if (connectError) throw connectError;
      const b = new FakeBrowser();
      h.browsers.push(b);
      return b.asBrowser();
    },
    ...deps,
  });
  return h;
}

async function expectHubError(p: Promise<unknown>, code: string, re: RegExp): Promise<HubError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HubError);
  expect((e as HubError).code).toBe(code);
  expect((e as HubError).message).toMatch(re);
  return e as HubError;
}

describe('ZenDriver agent mode', () => {
  it('launches detached with the agent profile, connects over BiDi to /session, writes state', async () => {
    tc = makeTestConfig({ zen: { extraArgs: ['--headless'] } });
    const h = harness();
    const browser = await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.cmd).toBe(tc.cfg.zen.executablePath);
    expect(h.spawns[0]!.args).toEqual(buildZenArgs(tc.cfg.zen.agentProfileDir, ['--headless']));
    expect(h.spawns[0]!.opts.detached).toBe(true);
    expect(existsSync(tc.cfg.zen.agentProfileDir)).toBe(true);
    expect(h.connects[0]).toMatchObject({
      browserWSEndpoint: 'ws://127.0.0.1:4444/session',
      protocol: 'webDriverBiDi',
      defaultViewport: null,
    });
    const state = JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8'));
    expect(state).toEqual({ pid: 5001, wsUrl: 'ws://127.0.0.1:4444/session', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent', ownerPid: process.pid });
    expect(h.driver.current()).toBe(browser);
    expect(h.driver.status()).toMatchObject({ name: 'zen', connected: true, mode: 'agent', protocol: 'webDriverBiDi' });
    // review #2 finding 9: the agent profile gets the managed block too (automation prefs off)
    const userJs = readFileSync(join(tc.cfg.zen.agentProfileDir, 'user.js'), 'utf8');
    expect(userJs).toContain(PREF);
    expect(userJs).toContain('user_pref("zen.welcome-screen.seen", true);');
  });

  it('agent user.js: recommended prefs off, first-run prefs, extraPrefs last; nothing that weakens security by default', async () => {
    tc = makeTestConfig({
      zen: { extraPrefs: { 'fission.webContentIsolationStrategy': 0, 'zen.welcome-screen.seen': false, 'some.string': 'a "b"' } },
    });
    const dir = tc.cfg.zen.agentProfileDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'user.js'), 'user_pref("selftest.keep", 1);\n');
    const h = harness();
    await h.driver.connect('agent');
    const userJs = readFileSync(join(dir, 'user.js'), 'utf8');
    expect(userJs.startsWith('user_pref("selftest.keep", 1);\n// >>> stephen')).toBe(true);
    expect(userJs).toContain(PREF);
    expect(userJs).toContain('user_pref("fission.webContentIsolationStrategy", 0);');
    expect(userJs).toContain('user_pref("some.string", "a \\"b\\"");');
    // extraPrefs override Stephen's own defaults
    expect(userJs).toContain('user_pref("zen.welcome-screen.seen", false);');
    expect(userJs).not.toContain('user_pref("zen.welcome-screen.seen", true);');
    expect(userJs.match(/>>> stephen/g)).toHaveLength(1);
    // never turns off Safe Browsing / updates / blocklist itself
    expect(userJs).not.toMatch(/safebrowsing|app\.update|services\.settings|signon/);
  });

  it('the default agent block does not set fission.webContentIsolationStrategy (finding 16)', () => {
    const block = buildUserJsBlock('agent');
    expect(block).not.toContain('fission');
    expect(block).toContain(PREF);
  });

  it('extraPrefs never reach the real profile, cannot re-enable recommended prefs, and bad entries are dropped', () => {
    const extra = { 'fission.webContentIsolationStrategy': 0, 'remote.prefs.recommended': true, 'bad name");x(': 1, 'a.b': 1.5, 'c.d': 'x\ny' };
    const real = buildUserJsBlock('real', extra);
    expect(real).toBe(`// >>> stephen (managed by Stephen; keeps automation prefs out of your real profile)\n${PREF}\n// <<< stephen\n`);
    expect(sanitizeExtraPrefs(extra)).toEqual([['fission.webContentIsolationStrategy', 0]]);
    const agent = buildUserJsBlock('agent', extra);
    expect(agent).not.toContain('user_pref("remote.prefs.recommended", true)');
    expect(agent).not.toContain('bad name');
  });

  it('is idempotent and shares concurrent connects', async () => {
    tc = makeTestConfig();
    const h = harness();
    const [a, b] = await Promise.all([h.driver.connect('agent'), h.driver.connect('agent')]);
    expect(a).toBe(b);
    expect(await h.driver.connect('agent')).toBe(a);
    expect(h.spawns).toHaveLength(1);
  });

  it('reattaches from a live state file without spawning', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    const wsUrl = 'ws://127.0.0.1:7777/session';
    writeFileSync(join(tc.cfg.stateDir, 'zen.json'), JSON.stringify({ pid: 4242, wsUrl, profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent' }));
    const h = harness({ isPidAlive: (pid) => pid === 4242 });
    await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(0);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual([wsUrl]);
    expect(h.driver.status().detail).toMatch(/Reattached/);
  });

  it('relaunches (and clears state) when the state pid is dead', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    writeFileSync(
      join(tc.cfg.stateDir, 'zen.json'),
      JSON.stringify({ pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent' }),
    );
    const h = harness({ isPidAlive: () => false });
    await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(1);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:4444/session']);
    expect(JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8')).pid).toBe(5001);
  });

  it('ignores state for another mode and falls back to launch when reattach is refused', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    writeFileSync(
      join(tc.cfg.stateDir, 'zen.json'),
      JSON.stringify({ pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent' }),
    );
    let first = true;
    const h = harness({
      isPidAlive: () => true,
      connect: async (o) => {
        h.connects.push(o);
        if (first) {
          first = false;
          throw new Error('connect ECONNREFUSED 127.0.0.1:7777');
        }
        return new FakeBrowser().asBrowser();
      },
    });
    await h.driver.connect('agent');
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:7777/session', 'ws://127.0.0.1:4444/session']);
    expect(h.spawns).toHaveLength(1);
  });

  it('maps a session-limit error on reattach to NEEDS_USER', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    writeFileSync(
      join(tc.cfg.stateDir, 'zen.json'),
      JSON.stringify({ pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent' }),
    );
    const h = harness({ isPidAlive: () => true, connectError: new Error('session not created Maximum number of active sessions') });
    await expectHubError(h.driver.connect('agent'), 'NEEDS_USER', /previous automation session.*Quit the Stephen agent Zen window/);
    expect(h.spawns).toHaveLength(0);
  });

  it('maps a session-limit error after launch to NEEDS_USER', async () => {
    tc = makeTestConfig();
    const h = harness({ connectError: new Error('Protocol error (session.new): session not created Maximum number of active sessions') });
    await expectHubError(h.driver.connect('agent'), 'NEEDS_USER', /previous automation session/);
  });

  it('reports a missing binary with the config key to set', async () => {
    tc = makeTestConfig();
    const h = harness({ isExecutable: async () => false });
    await expectHubError(h.driver.connect('agent'), 'NOT_CONNECTED', /Zen was not found at .*zen\.executablePath/);
    expect(h.spawns).toHaveLength(0);
  });

  // Updated in review #1 (D1): this used to assert that the slow Zen was SIGTERMed — unsafe for the real
  // profile and needless for agent mode. Now nothing is killed and the next connect resumes waiting.
  it('never kills a Zen that is slow to report listening; the next connect resumes waiting for it', async () => {
    tc = makeTestConfig();
    let alive = true;
    const h = harness({ line: null, isPidAlive: (pid) => pid === 5001 && alive });
    const e = await expectHubError(h.driver.connect('agent'), 'NOT_CONNECTED', /still starting|has not enabled remote control within/);
    expect(e.message).toMatch(/left it running/);
    expect(h.connects).toHaveLength(0);
    const state = JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8'));
    expect(state).toMatchObject({ pid: 5001, wsUrl: '', starting: true, mode: 'agent' });

    // Zen finally finishes starting and prints the line; a retry connects to it without spawning another.
    writeFileSync(state.logPath, 'WebDriver BiDi listening on ws://127.0.0.1:4545\n');
    await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(1);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:4545/session']);
    expect(JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8'))).toMatchObject({ pid: 5001, wsUrl: 'ws://127.0.0.1:4545/session', ownerPid: process.pid });
    expect(JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8')).starting).toBeUndefined();
    alive = false;
  });

  it('never kills a slow-starting Zen on the REAL profile either', async () => {
    tc = makeTestConfig();
    const dir = join(tc.home, 'real-profile');
    mkdirSync(dir, { recursive: true });
    const h = harness({ line: null, resolveRealProfile: async () => dir });
    await expectHubError(h.driver.connect('real'), 'NOT_CONNECTED', /left it running/);
    expect(h.spawns).toHaveLength(1);
    // (no kill function exists any more: the driver has no way to SIGTERM Zen)
  });

  it('a starting Zen that died meanwhile is forgotten and relaunched', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    writeFileSync(
      join(tc.cfg.stateDir, 'zen.json'),
      JSON.stringify({ pid: 4242, wsUrl: '', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent', starting: true, logPath: join(tc.cfg.stateDir, 'x.log') }),
    );
    const h = harness({ isPidAlive: () => false });
    await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(1);
  });

  it('reports an early exit', async () => {
    tc = makeTestConfig();
    const h = harness({ line: 'something else', exitCode: 1 });
    await expectHubError(h.driver.connect('agent'), 'NOT_CONNECTED', /exited right after launch \(exit code 1\)/);
  });

  it('disconnect() detaches via browser.disconnect (never close) and leaves state for reattach', async () => {
    tc = makeTestConfig();
    const h = harness();
    await h.driver.connect('agent');
    await h.driver.disconnect();
    await h.driver.disconnect(); // safe twice
    expect(h.browsers[0]!.disconnectCalls).toBe(1);
    expect(h.browsers[0]!.closeCalls).toBe(0);
    expect(h.driver.current()).toBeNull();
    expect(h.driver.status()).toMatchObject({ connected: false, mode: null });
    expect(existsSync(join(tc.cfg.stateDir, 'zen.json'))).toBe(true);
  });

  it('reflects a dropped connection in status()', async () => {
    tc = makeTestConfig();
    const h = harness();
    await h.driver.connect('agent');
    h.browsers[0]!.drop();
    expect(h.driver.current()).toBeNull();
    expect(h.driver.status()).toMatchObject({ connected: false });
    expect(h.driver.status().detail).toMatch(/connection lost/);
  });
});

describe('ZenDriver real mode', () => {
  function realProfile(): string {
    const dir = join(tc.home, 'real-profile');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('refuses while Zen is running and touches nothing', async () => {
    tc = makeTestConfig();
    const dir = realProfile();
    const h = harness({ isProcessRunning: async (n) => n === 'zen', resolveRealProfile: async () => dir });
    const e = await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /Quit Zen \(⌘Q\) and retry/);
    expect(e.message).toContain(ZEN_RUNNING_MESSAGE);
    expect(h.spawns).toHaveLength(0);
    expect(existsSync(join(dir, 'user.js'))).toBe(false);
  });

  it('writes the user.js block and launches on the real profile (never zen.extraPrefs)', async () => {
    tc = makeTestConfig({ zen: { extraPrefs: { 'fission.webContentIsolationStrategy': 0 } } });
    const dir = realProfile();
    writeFileSync(join(dir, 'user.js'), 'user_pref("mine", 1);\n');
    const h = harness({ resolveRealProfile: async () => dir });
    await h.driver.connect('real');
    expect(h.spawns[0]!.args).toEqual(buildZenArgs(dir, []));
    const userJs = readFileSync(join(dir, 'user.js'), 'utf8');
    expect(userJs.startsWith('user_pref("mine", 1);\n')).toBe(true);
    expect(userJs).toContain(PREF);
    expect(userJs).not.toContain('welcome'); // only the recommended-prefs switch in the real profile
    expect(userJs).not.toContain('fission');
    expect(JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8'))).toMatchObject({ mode: 'real', profileDir: dir });
  });

  it('explains how to set zen.profilePath when no profile is found', async () => {
    tc = makeTestConfig();
    const h = harness({ resolveRealProfile: async () => null });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /about:profiles.*zen\.profilePath/);
  });

  it('rejects a configured profile path that does not exist', async () => {
    tc = makeTestConfig();
    const h = harness({ resolveRealProfile: async () => join(tc.home, 'missing') });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /does not exist/);
  });

  it('switching modes disconnects the previous session first', async () => {
    tc = makeTestConfig();
    const dir = realProfile();
    const h = harness({ resolveRealProfile: async () => dir });
    await h.driver.connect('agent');
    await h.driver.connect('real');
    expect(h.browsers[0]!.disconnectCalls).toBe(1);
    expect(h.driver.status().mode).toBe('real');
  });
});

// ───────────── attach-only (zen.launch: 'never', the default) ─────────────

describe('ZenDriver attach-only (launch: never)', () => {
  function realProfile(): string {
    const dir = join(tc.home, 'real-profile');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function writeState(state: Record<string, unknown>): void {
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    writeFileSync(join(tc.cfg.stateDir, 'zen.json'), JSON.stringify(state));
  }
  const readState = () => JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8'));
  const WS = 'ws://127.0.0.1:7777/session';

  it('attaches to the Stephen-ready Zen from the state file (zen-launch wrote it), never spawns, records ownership', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    writeState({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real' });
    const h = harness({ resolveRealProfile: async () => dir, isPidAlive: (pid) => pid === 4242, isProcessRunning: async () => true });
    const browser = await h.driver.connect('real');
    expect(h.spawns).toHaveLength(0);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual([WS]);
    expect(h.driver.current()).toBe(browser);
    expect(h.driver.status()).toMatchObject({ connected: true, mode: 'real' });
    expect(h.driver.status().detail).toMatch(/Attached to your open Zen \(pid 4242/);
    expect(readState()).toEqual({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real', ownerPid: process.pid });
    expect(existsSync(join(dir, 'user.js'))).toBe(false); // attaching never touches the profile

    // disconnect ends the session, leaves Zen and the state for the next attach, drops ownership
    await h.driver.disconnect();
    expect(h.browsers[0]!.disconnectCalls).toBe(1);
    expect(h.browsers[0]!.closeCalls).toBe(0);
    expect(readState()).toEqual({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real' });
  });

  it('Zen running but not Stephen-ready (no state): NEEDS_USER "open it with Zen for Stephen", nothing spawned or touched', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const h = harness({ resolveRealProfile: async () => dir, isProcessRunning: async (n) => n === 'zen' });
    const e = await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /wasn't started with Stephen access/);
    expect(e.message).toContain(ZEN_NOT_CLAUDE_READY_MESSAGE);
    expect(e.message).toMatch(/retrying will not help/);
    expect(h.spawns).toHaveLength(0);
    expect(h.connects).toHaveLength(0);
    expect(existsSync(join(dir, 'user.js'))).toBe(false);
    expect(h.driver.status().detail).toMatch(/without Stephen access/);
  });

  it('Zen not running: NEEDS_USER "open Zen with the Zen for Stephen app", nothing spawned', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const h = harness({ resolveRealProfile: async () => dir, isProcessRunning: async () => false });
    const e = await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /Zen isn't open/);
    expect(e.message).toContain(ZEN_NOT_RUNNING_MESSAGE);
    expect(e.message).toContain("'Zen for Stephen' app");
    expect(e.message).toContain('install-zen-launcher');
    expect(h.spawns).toHaveLength(0);
    expect(existsSync(join(tc.cfg.stateDir, 'zen-real.log'))).toBe(false);
  });

  it('a dead pid in the state file is forgotten — then the not-running error, still no spawn', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    writeState({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real' });
    const h = harness({ resolveRealProfile: async () => dir, isPidAlive: () => false });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /Zen isn't open/);
    expect(h.spawns).toHaveLength(0);
    expect(h.connects).toHaveLength(0);
    expect(existsSync(join(tc.cfg.stateDir, 'zen.json'))).toBe(false);
  });

  it('state pid alive but its endpoint refuses (Zen reopened normally): not-ready error, no spawn', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    writeState({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real' });
    const h = harness({
      resolveRealProfile: async () => dir,
      isPidAlive: () => true,
      isProcessRunning: async () => true,
      connectError: new Error('connect ECONNREFUSED 127.0.0.1:7777'),
    });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /wasn't started with Stephen access/);
    expect(h.connects).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
  });

  it('ignores state for another profile, and names the agent Zen when that is what runs', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    writeState({ pid: 4242, wsUrl: WS, profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent' });
    const h = harness({ resolveRealProfile: async () => dir, isPidAlive: () => true, isProcessRunning: async () => true });
    const e = await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /wasn't started with Stephen access/);
    expect(e.message).toMatch(/agent Zen counts too/);
    expect(h.connects).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
  });

  it('session limit while attaching: another live Stephen → "someone else", stale → reopen with Zen for Stephen', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const limit = new Error('session not created Maximum number of active sessions');
    writeState({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real', ownerPid: 999 });
    const other = harness({ resolveRealProfile: async () => dir, isPidAlive: () => true, connectError: limit });
    await expectHubError(other.driver.connect('real'), 'NEEDS_USER', /another Claude Code session.*your Zen \(Stephen pid 999\)/);
    writeState({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real' });
    const stale = harness({ resolveRealProfile: async () => dir, isPidAlive: () => true, connectError: limit });
    await expectHubError(stale.driver.connect('real'), 'NEEDS_USER', /previous automation session.*reopen it with the 'Zen for Stephen' app/);
    expect(other.spawns.length + stale.spawns.length).toBe(0);
  });

  it('a Zen still starting (zen-launch timed out) is waited for and connected, never relaunched', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const logPath = join(tc.cfg.stateDir, 'zen-real.log');
    writeState({ pid: 4242, wsUrl: '', profileDir: dir, mode: 'real', starting: true, logPath });
    writeFileSync(logPath, 'WebDriver BiDi listening on ws://127.0.0.1:4646\n');
    const h = harness({ resolveRealProfile: async () => dir, isPidAlive: (pid) => pid === 4242 });
    await h.driver.connect('real');
    expect(h.spawns).toHaveLength(0);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:4646/session']);
    expect(readState()).toMatchObject({ pid: 4242, wsUrl: 'ws://127.0.0.1:4646/session', ownerPid: process.pid });
  });

  it('agent mode with launch "never" does not start the agent Zen either', async () => {
    tc = makeTestConfig({ zen: { mode: 'agent', launch: 'never' } });
    const h = harness({ isProcessRunning: async () => false });
    await expectHubError(h.driver.connect('agent'), 'NEEDS_USER', /"zen\.launch" is "never".*"launch": "auto"/);
    expect(h.spawns).toHaveLength(0);
  });

  it('status says attach-only before connecting; a lost connection says to reopen with the app', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    writeState({ pid: 4242, wsUrl: WS, profileDir: dir, mode: 'real' });
    const h = harness({ resolveRealProfile: async () => dir, isPidAlive: () => true });
    expect(h.driver.status().detail).toContain(ZEN_ATTACH_ONLY_LABEL);
    await h.driver.connect('real');
    h.browsers[0]!.drop();
    expect(h.driver.status().detail).toMatch(/Reopen Zen with the 'Zen for Stephen' app/);
  });

  it('launch "auto" (or a config without zen.launch) keeps the old real-mode behaviour: launches once Zen is quit', async () => {
    for (const zen of [{ mode: 'real' as const, launch: 'auto' as const }, { mode: 'real' as const }]) {
      tc?.cleanup();
      tc = makeTestConfig({ zen });
      const dir = realProfile();
      const h = harness({ resolveRealProfile: async () => dir });
      await h.driver.connect('real');
      expect(h.spawns).toHaveLength(1);
    }
    expect(isZenAttachOnly(makeTestConfig().cfg)).toBe(false); // ResolvedConfig without the key = 'auto'
    expect(zenLaunchOf({ ...tc.cfg, zen: { ...tc.cfg.zen, launch: 'never' } as typeof tc.cfg.zen })).toBe('never');
  });
});

describe('ZenDriver.inspect / launchForClaude (zen-launch)', () => {
  function realProfile(): string {
    const dir = join(tc.home, 'real-profile');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const statePath = () => join(tc.cfg.stateDir, 'zen.json');

  it('inspect: ready only for a live pid in real mode on this profile whose endpoint answers; read-only', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const probes: string[] = [];
    let answers = true;
    let alive = true;
    const h = harness({
      resolveRealProfile: async () => dir,
      isPidAlive: () => alive,
      probeEndpoint: async (u) => {
        probes.push(u);
        return answers;
      },
    });
    expect(await h.driver.inspect('real')).toEqual({ kind: 'none', state: null, profileDir: dir });
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    const st = { pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: dir, mode: 'real' };
    writeFileSync(statePath(), JSON.stringify(st));
    expect((await h.driver.inspect('real')).kind).toBe('ready');
    answers = false;
    expect((await h.driver.inspect('real')).kind).toBe('none');
    answers = true;
    alive = false;
    expect((await h.driver.inspect('real')).kind).toBe('none');
    alive = true;
    writeFileSync(statePath(), JSON.stringify({ ...st, profileDir: join(tc.home, 'other') }));
    expect((await h.driver.inspect('real')).kind).toBe('none');
    writeFileSync(statePath(), JSON.stringify({ ...st, wsUrl: '', starting: true }));
    expect((await h.driver.inspect('real')).kind).toBe('starting');
    expect(probes).toEqual(['ws://127.0.0.1:7777/session', 'ws://127.0.0.1:7777/session']);
    expect(h.connects).toHaveLength(0); // never opens a BiDi session
    expect(existsSync(statePath())).toBe(true);
  });

  it.each([[2], [null]])('B5: with other user accounts (%s), no Zen is started and the reason names only a count', async (others) => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const h = harness({ resolveRealProfile: async () => dir, otherUserCount: async () => others });
    await expect(h.driver.launchForClaude()).rejects.toMatchObject({ code: 'NEEDS_USER', message: expect.stringMatching(others === null ? /couldn't check/ : /2 other user accounts.*Chrome/) });
    expect(h.spawns).toHaveLength(0);
    expect(existsSync(statePath())).toBe(false);
  });

  it('B5: launch "auto" on a shared Mac does not start Zen either', async () => {
    tc = makeTestConfig({ zen: { extraArgs: [] } });
    const h = harness({ otherUserCount: async () => 1 });
    await expect(h.driver.connect('agent')).rejects.toMatchObject({ code: 'NEEDS_USER' });
    expect(h.spawns).toHaveLength(0);
  });

  it('launchForClaude: launches the real profile detached, writes state WITHOUT an owner, opens no session', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never', extraArgs: ['--x'] } });
    const dir = realProfile();
    const h = harness({ resolveRealProfile: async () => dir });
    const info = await h.driver.launchForClaude();
    expect(info).toEqual({ pid: 5001, wsUrl: 'ws://127.0.0.1:4444/session', profileDir: dir, logPath: join(tc.cfg.stateDir, 'zen-real.log'), resumed: false });
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.args).toEqual(buildZenArgs(dir, ['--x']));
    expect(h.spawns[0]!.opts.detached).toBe(true);
    expect(h.connects).toHaveLength(0);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ pid: 5001, wsUrl: 'ws://127.0.0.1:4444/session', profileDir: dir, mode: 'real' });
    expect(readFileSync(join(dir, 'user.js'), 'utf8')).toContain(PREF);
    expect(h.driver.current()).toBeNull();

    // serve then attaches to exactly that Zen without spawning
    const serve = harness({ resolveRealProfile: async () => dir, isPidAlive: (pid) => pid === 5001 });
    await serve.driver.connect('real');
    expect(serve.spawns).toHaveLength(0);
    expect(serve.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:4444/session']);
  });

  it('launchForClaude resumes a launch that is still starting instead of starting a second Zen', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    mkdirSync(tc.cfg.stateDir, { recursive: true });
    const logPath = join(tc.cfg.stateDir, 'zen-real.log');
    writeFileSync(statePath(), JSON.stringify({ pid: 4242, wsUrl: '', profileDir: dir, mode: 'real', starting: true, logPath }));
    writeFileSync(logPath, 'WebDriver BiDi listening on ws://127.0.0.1:4747\n');
    const h = harness({ resolveRealProfile: async () => dir, isPidAlive: (pid) => pid === 4242 });
    const info = await h.driver.launchForClaude();
    expect(info).toMatchObject({ pid: 4242, wsUrl: 'ws://127.0.0.1:4747/session', resumed: true });
    expect(h.spawns).toHaveLength(0);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ pid: 4242, wsUrl: 'ws://127.0.0.1:4747/session', profileDir: dir, mode: 'real' });
  });

  it('launchForClaude reports a Zen that exits at once (profile in use) as NEEDS_USER and kills nothing', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const dir = realProfile();
    const h = harness({ resolveRealProfile: async () => dir, line: 'Zen is already running, but is not responding', exitCode: 0 });
    await expectHubError(h.driver.launchForClaude(), 'NEEDS_USER', /another Zen is probably using profile/);
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.killed).toBe(false);
    expect(existsSync(statePath())).toBe(false);
  });
});
