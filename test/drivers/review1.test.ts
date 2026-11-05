/** Review #1 driver fixes: D2 (Zen session owner), D3 (0700 dirs; ensurePrivateDir itself: test/lib/fs.test.ts), D4 (Chrome Allow wait, many tabs). */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectOptions } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ChromeDriver } from '../../src/drivers/chrome.js';
import { BrowserManager } from '../../src/drivers/manager.js';
import { securePrivateDirs, type SpawnedProcess } from '../../src/drivers/util.js';
import { ZenDriver, type ZenDriverDeps } from '../../src/drivers/zen.js';
import { HubError } from '../../src/errors.js';
import type { BrowserDriver, BrowserName, BrowserStatus, ProfileMode } from '../../src/types.js';
import { FakeBrowser, type TestConfig, makeTestConfig } from './helpers.js';

let tc: TestConfig;
afterEach(() => tc?.cleanup());

const mode = (p: string) => statSync(p).mode & 0o777;

async function hubError(p: Promise<unknown>): Promise<HubError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HubError);
  return e as HubError;
}

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

function zen(deps: Partial<ZenDriverDeps>): { driver: ZenDriver; connects: ConnectOptions[]; spawns: number } {
  const out = { driver: undefined as unknown as ZenDriver, connects: [] as ConnectOptions[], spawns: 0 };
  out.driver = new ZenDriver(tc.cfg, {
    isExecutable: async () => true,
    isProcessRunning: async () => false,
    isPidAlive: () => false,
    listenTimeoutMs: 300,
    pollIntervalMs: 10,
    spawn: (_cmd, _args, opts) => {
      out.spawns++;
      writeSync((opts.stdio as number[])[2]!, 'WebDriver BiDi listening on ws://127.0.0.1:4444\n');
      return new FakeChild(5000 + out.spawns) as unknown as SpawnedProcess;
    },
    connect: async (o) => {
      out.connects.push(o);
      return new FakeBrowser().asBrowser();
    },
    ...deps,
  });
  return out;
}

function writeZenState(state: Record<string, unknown>): void {
  mkdirSync(tc.cfg.stateDir, { recursive: true });
  writeFileSync(join(tc.cfg.stateDir, 'zen.json'), JSON.stringify(state));
}

const SESSION_LIMIT = new Error('session not created: Maximum number of active sessions');

describe('D2 two Claude Code sessions vs one agent Zen', () => {
  it('records this server as the session owner, and clears it on disconnect', async () => {
    tc = makeTestConfig();
    const z = zen({ ownerPid: 111 });
    await z.driver.connect('agent');
    const statePath = join(tc.cfg.stateDir, 'zen.json');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).ownerPid).toBe(111);
    await z.driver.disconnect();
    const after = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(after.ownerPid).toBeUndefined();
    expect(after.wsUrl).toBe('ws://127.0.0.1:4444/session'); // still reattachable
  });

  it('another LIVE Stephen owning the session → clear error, no "quit Zen"', async () => {
    tc = makeTestConfig();
    writeZenState({ pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent', ownerPid: 999 });
    const z = zen({
      ownerPid: 111,
      isPidAlive: (pid) => pid === 4242 || pid === 999,
      connect: async () => {
        throw SESSION_LIMIT;
      },
    });
    const e = await hubError(z.driver.connect('agent'));
    expect(e.code).toBe('NEEDS_USER');
    expect(e.message).toMatch(/another Claude Code session is using Zen's agent profile/);
    expect(e.message).toMatch(/use Chrome/);
    expect(e.message).toMatch(/Do not quit Zen/);
    expect(z.spawns).toBe(0);
    // The other session's ownership is untouched.
    expect(JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8')).ownerPid).toBe(999);
  });

  it('a DEAD owner means a stale session → the old "quit the agent Zen" advice', async () => {
    tc = makeTestConfig();
    writeZenState({ pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent', ownerPid: 999 });
    const z = zen({
      ownerPid: 111,
      isPidAlive: (pid) => pid === 4242,
      connect: async () => {
        throw SESSION_LIMIT;
      },
    });
    const e = await hubError(z.driver.connect('agent'));
    expect(e.message).toMatch(/previous automation session.*Quit the Stephen agent Zen window/);
  });
});

describe('D3 private directories', () => {
  it('securePrivateDirs locks down home, state, output and agent profiles', async () => {
    tc = makeTestConfig();
    chmodSync(tc.home, 0o755);
    mkdirSync(tc.cfg.stateDir, { mode: 0o755 });
    chmodSync(tc.cfg.stateDir, 0o755);
    await securePrivateDirs(tc.cfg);
    for (const d of [tc.home, tc.cfg.stateDir, tc.cfg.output.saveDir, tc.cfg.chrome.agentProfileDir, tc.cfg.zen.agentProfileDir, join(tc.home, 'profiles')]) {
      expect(mode(d), d).toBe(0o700);
    }
  });

  it('Zen and Chrome agent launches create their dirs 0700', async () => {
    tc = makeTestConfig();
    await zen({}).driver.connect('agent');
    expect(mode(tc.cfg.zen.agentProfileDir)).toBe(0o700);
    expect(mode(tc.cfg.stateDir)).toBe(0o700);
    expect(mode(join(tc.home, 'profiles'))).toBe(0o700);

    const chrome = new ChromeDriver(tc.cfg, {
      isExecutable: async () => true,
      launchTimeoutMs: 300,
      pollIntervalMs: 10,
      spawn: (_c, args) => {
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        setTimeout(() => writeFileSync(join(dir, 'DevToolsActivePort'), '5555\n/devtools/browser/x\n'), 10);
        return new FakeChild(6001) as unknown as SpawnedProcess;
      },
      connect: async () => new FakeBrowser().asBrowser(),
    });
    await chrome.connect('agent');
    expect(mode(tc.cfg.chrome.agentProfileDir)).toBe(0o700);
  });
});

describe('D4 Chrome real mode and big sessions', () => {
  it('waits for Allow, shows it in status, and the timeout error says what is going on', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.chrome.userDataDir, { recursive: true });
    writeFileSync(join(tc.cfg.chrome.userDataDir, 'DevToolsActivePort'), '9333\n/devtools/browser/real\n');
    let driver!: ChromeDriver;
    let statusWhileWaiting = '';
    driver = new ChromeDriver(tc.cfg, {
      realConnectTimeoutMs: 60,
      connect: () => {
        statusWhileWaiting = driver.status().detail;
        return new Promise(() => undefined); // the user never clicks Allow
      },
    });
    const e = await hubError(driver.connect('real'));
    expect(statusWhileWaiting).toMatch(/Waiting .* click "Allow"/);
    expect(e.code).toBe('NEEDS_USER');
    expect(e.message).toMatch(/remote debugging is enabled on port 9333, but nobody clicked "Allow"/);
    expect(e.message).toMatch(/behind other windows/);
  });

  it('defaults to a 60 s Allow wait', async () => {
    tc = makeTestConfig();
    mkdirSync(tc.cfg.chrome.userDataDir, { recursive: true });
    writeFileSync(join(tc.cfg.chrome.userDataDir, 'DevToolsActivePort'), '9333\n/devtools/browser/real\n');
    const driver = new ChromeDriver(tc.cfg, { connect: () => new Promise(() => undefined) });
    void driver.connect('real').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(driver.status().detail).toMatch(/up to 60 s/);
  });

  it('listTabs degrades to the known tabs when browser.pages() times out', async () => {
    tc = makeTestConfig();
    const browser = new FakeBrowser();
    for (let i = 0; i < 120; i++) browser.addPage(`https://site${i}.example/`, `Tab ${i}`);
    const driver: BrowserDriver = {
      name: 'chrome',
      protocol: 'cdp',
      connect: async (_m: ProfileMode) => browser.asBrowser(),
      current: () => (browser.connected ? browser.asBrowser() : null),
      status: (): BrowserStatus => ({ name: 'chrome', connected: true, mode: 'agent', protocol: 'cdp', version: null, detail: '' }),
      disconnect: async () => undefined,
    };
    const other = { ...driver, name: 'zen' as BrowserName, current: () => null };
    const m = new BrowserManager(tc.cfg, { chrome: driver, zen: other as BrowserDriver }, { pagesTimeoutMs: 50 });
    const first = await m.listTabs('chrome');
    expect(first).toHaveLength(120);
    browser.pages = () => new Promise(() => undefined); // now pages() hangs
    const t0 = Date.now();
    const again = await m.listTabs('chrome');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(again.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(again[119]!.title).toBe('Tab 119');
  });

  it('listTabs still fails clearly when pages() times out and nothing is known', async () => {
    tc = makeTestConfig();
    const browser = new FakeBrowser();
    browser.pages = () => new Promise(() => undefined);
    const driver: BrowserDriver = {
      name: 'chrome',
      protocol: 'cdp',
      connect: async () => browser.asBrowser(),
      current: () => browser.asBrowser(),
      status: (): BrowserStatus => ({ name: 'chrome', connected: true, mode: 'agent', protocol: 'cdp', version: null, detail: '' }),
      disconnect: async () => undefined,
    };
    const m = new BrowserManager(tc.cfg, { chrome: driver, zen: { ...driver, name: 'zen', current: () => null } as BrowserDriver }, { pagesTimeoutMs: 30 });
    await expect(m.listTabs('chrome')).rejects.toThrow(/timed out/);
  });
});
