import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectOptions } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ChromeDriver, type ChromeDriverDeps, buildChromeAgentArgs } from '../../src/drivers/chrome.js';
import type { SpawnedProcess } from '../../src/drivers/util.js';
import { HubError } from '../../src/errors.js';
import { FakeBrowser, type TestConfig, makeTestConfig } from './helpers.js';

let tc: TestConfig;
afterEach(() => tc?.cleanup());

class FakeChild extends EventEmitter {
  readonly stderr = null;
  constructor(readonly pid: number) {
    super();
  }
  unref(): void {}
  kill(): boolean {
    return true;
  }
}

interface Harness {
  driver: ChromeDriver;
  spawns: { cmd: string; args: readonly string[]; opts: SpawnOptions }[];
  connects: ConnectOptions[];
  kills: number[];
  browsers: FakeBrowser[];
}

type HarnessOpts = Partial<ChromeDriverDeps> & {
  /** Fake Chrome writes DevToolsActivePort into its --user-data-dir (default true). */
  writesPort?: boolean;
  exitCode?: number;
  connectImpl?: (o: ConnectOptions) => Promise<FakeBrowser>;
};

function harness(opts: HarnessOpts = {}): Harness {
  const { writesPort = true, exitCode, connectImpl, ...deps } = opts;
  const h: Harness = { driver: undefined as unknown as ChromeDriver, spawns: [], connects: [], kills: [], browsers: [] };
  h.driver = new ChromeDriver(tc.cfg, {
    isExecutable: async () => true,
    launchTimeoutMs: 300,
    pollIntervalMs: 10,
    kill: (pid) => h.kills.push(pid),
    spawn: (cmd, args, spawnOpts) => {
      h.spawns.push({ cmd, args, opts: spawnOpts });
      const child = new FakeChild(6000 + h.spawns.length);
      const dirArg = args.find((a) => a.startsWith('--user-data-dir='))!;
      const dir = dirArg.slice('--user-data-dir='.length);
      if (writesPort) setTimeout(() => writeFileSync(join(dir, 'DevToolsActivePort'), `5555\n/devtools/browser/fresh\n`), 20);
      if (exitCode !== undefined) setTimeout(() => child.emit('exit', exitCode, null), 5);
      return child as unknown as SpawnedProcess;
    },
    connect: async (o) => {
      h.connects.push(o);
      const b = connectImpl ? await connectImpl(o) : new FakeBrowser();
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

function writePortFile(dir: string, port: number, path = '/devtools/browser/old'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n${path}\n`);
}

describe('buildChromeAgentArgs', () => {
  it('passes extra args verbatim (incl. quoted headless) but never --remote-allow-origins', () => {
    const args = buildChromeAgentArgs('/p/chrome', ["--headless='shell'", '--single-process', '--remote-allow-origins=*']);
    expect(args).toEqual([
      '--user-data-dir=/p/chrome',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      "--headless='shell'",
      '--single-process',
      'about:blank',
    ]);
  });
});

describe('ChromeDriver real mode', () => {
  it('explains the chrome://inspect steps when DevToolsActivePort is missing', async () => {
    tc = makeTestConfig();
    const h = harness();
    const e = await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /chrome:\/\/inspect\/#remote-debugging/);
    expect(e.message).toMatch(/144/);
    expect(e.message).toMatch(/Allow remote debugging for this browser instance/);
    expect(e.message).toMatch(/click "Allow"/);
    expect(h.connects).toHaveLength(0);
  });

  it('connects to the endpoint from DevToolsActivePort with defaultViewport null', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.userDataDir, 9333, '/devtools/browser/real-1');
    const h = harness();
    await h.driver.connect('real');
    expect(h.connects[0]).toEqual({ browserWSEndpoint: 'ws://127.0.0.1:9333/devtools/browser/real-1', defaultViewport: null });
    expect(h.driver.status()).toMatchObject({ connected: true, mode: 'real', protocol: 'cdp' });
    // one long-lived connection
    await h.driver.connect('real');
    expect(h.connects).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
  });

  it('maps a refused (stale) endpoint to NEEDS_USER', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.userDataDir, 9333);
    const h = harness({
      connectImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9333');
      },
    });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /not running or remote debugging was turned off.*chrome:\/\/inspect/);
  });

  it('times out waiting for Allow, and detaches a connection that completes late', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.userDataDir, 9333);
    const late = new FakeBrowser();
    let release!: () => void;
    const h = harness({
      realConnectTimeoutMs: 50,
      connectImpl: () =>
        new Promise<FakeBrowser>((resolve) => {
          release = () => resolve(late);
        }),
    });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /did not allow the connection.*click "Allow"/);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(late.disconnectCalls).toBe(1);
    expect(late.closeCalls).toBe(0);
    expect(h.driver.current()).toBeNull();
  });

  it('maps other rejections (e.g. user clicked Deny) to NEEDS_USER', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.userDataDir, 9333);
    const h = harness({
      connectImpl: async () => {
        throw new Error('Unexpected server response: 403');
      },
    });
    await expectHubError(h.driver.connect('real'), 'NEEDS_USER', /rejected the debugging connection.*Deny/);
  });
});

describe('ChromeDriver agent mode', () => {
  it('spawns detached with the agent profile and connects via the fresh DevToolsActivePort', async () => {
    tc = makeTestConfig({ chrome: { extraArgs: ['--headless=new'] } });
    const h = harness();
    await h.driver.connect('agent');
    expect(existsSync(tc.cfg.chrome.agentProfileDir)).toBe(true);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.cmd).toBe(tc.cfg.chrome.executablePath);
    expect(h.spawns[0]!.args).toEqual(buildChromeAgentArgs(tc.cfg.chrome.agentProfileDir, ['--headless=new']));
    expect(h.spawns[0]!.opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:5555/devtools/browser/fresh']);
  });

  it('reattaches to a live agent Chrome without spawning', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.agentProfileDir, 7001, '/devtools/browser/live');
    const h = harness();
    await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(0);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual(['ws://127.0.0.1:7001/devtools/browser/live']);
    expect(h.driver.status().detail).toMatch(/Reattached/);
  });

  it('deletes a stale DevToolsActivePort and relaunches', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.agentProfileDir, 7001, '/devtools/browser/stale');
    const h = harness({
      connectImpl: async (o) => {
        if (o.browserWSEndpoint?.includes('stale')) throw new Error('connect ECONNREFUSED');
        return new FakeBrowser();
      },
    });
    await h.driver.connect('agent');
    expect(h.spawns).toHaveLength(1);
    expect(h.connects.map((c) => c.browserWSEndpoint)).toEqual([
      'ws://127.0.0.1:7001/devtools/browser/stale',
      'ws://127.0.0.1:5555/devtools/browser/fresh',
    ]);
  });

  it('reports a missing Chrome binary with the config key', async () => {
    tc = makeTestConfig();
    const h = harness({ isExecutable: async () => false });
    await expectHubError(h.driver.connect('agent'), 'NOT_CONNECTED', /Chrome was not found at .*chrome\.executablePath/);
  });

  it('kills a Chrome it spawned that never opens its port', async () => {
    tc = makeTestConfig();
    const h = harness({ writesPort: false });
    await expectHubError(h.driver.connect('agent'), 'NOT_CONNECTED', /did not open its debugging port/);
    expect(h.kills).toEqual([6001]);
  });

  it('reports an immediate exit (profile in use) without waiting for the timeout', async () => {
    tc = makeTestConfig();
    const h = harness({ writesPort: false, exitCode: 0, launchTimeoutMs: 10_000 });
    const t0 = Date.now();
    await expectHubError(h.driver.connect('agent'), 'NOT_CONNECTED', /exited right after launch.*already using the profile/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('disconnect() never closes, and switching modes disconnects first', async () => {
    tc = makeTestConfig();
    writePortFile(tc.cfg.chrome.userDataDir, 9333);
    const h = harness();
    await h.driver.connect('agent');
    await h.driver.connect('real');
    expect(h.browsers[0]!.disconnectCalls).toBe(1);
    expect(h.driver.status().mode).toBe('real');
    await h.driver.disconnect();
    await h.driver.disconnect();
    expect(h.browsers.map((b) => b.closeCalls)).toEqual([0, 0]);
    expect(h.driver.status().connected).toBe(false);
  });

  it('status reflects a dropped connection', async () => {
    tc = makeTestConfig();
    const h = harness();
    await h.driver.connect('agent');
    h.browsers[0]!.drop();
    expect(h.driver.status()).toMatchObject({ connected: false, mode: null });
    expect(h.driver.status().detail).toMatch(/connection lost/);
  });
});
