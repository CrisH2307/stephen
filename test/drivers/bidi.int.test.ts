/**
 * The puppeteer WebDriver BiDi code path Zen uses, exercised against real Chromium.
 * c) BrowserManager over BiDi: open/list/get/focus/close tabs, purge on close & disconnect.
 * d) ZenDriver reattach-from-state + disconnect over a real BiDi connection (BiDi-over-CDP to a
 *    detached Chromium standing in for a Zen we launched earlier): the browser keeps running and a
 *    new session can be opened afterwards.
 */
import puppeteer, { type Browser, type ConnectOptions } from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBrowserManager } from '../../src/drivers/index.js';
import { ZenDriver } from '../../src/drivers/zen.js';
import { HubError } from '../../src/errors.js';
import type { BrowserDriver, BrowserStatus, ProfileMode } from '../../src/types.js';
import { launchTestBrowser } from '../helpers/chromium.js';
import { type TestConfig, makeTestConfig } from './helpers.js';
import { isPidAlive, killGroup, spawnDetachedChromium } from './proc.js';

const configs: TestConfig[] = [];
const browsers: Browser[] = [];
const pids: number[] = [];

afterAll(async () => {
  for (const b of browsers) await b.close().catch(() => undefined);
  for (const pid of pids) await killGroup(pid);
  for (const c of configs) c.cleanup();
});

/** Minimal driver named 'zen' that hands out a BiDi-connected Chromium. */
class BidiTestDriver implements BrowserDriver {
  readonly name = 'zen' as const;
  readonly protocol = 'webDriverBiDi' as const;
  browser: Browser | null = null;
  async connect(_mode: ProfileMode): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.browser = await launchTestBrowser('webDriverBiDi');
    browsers.push(this.browser);
    return this.browser;
  }
  current(): Browser | null {
    return this.browser?.connected ? this.browser : null;
  }
  status(): BrowserStatus {
    return { name: 'zen', connected: !!this.current(), mode: 'agent', protocol: 'webDriverBiDi', version: null, detail: 'test' };
  }
  async disconnect(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    await b?.close(); // test-owned browser: closing is fine here
  }
}

const idleChrome: BrowserDriver = {
  name: 'chrome',
  protocol: 'cdp',
  connect: () => Promise.reject(new Error('not used')),
  current: () => null,
  status: () => ({ name: 'chrome', connected: false, mode: null, protocol: 'cdp', version: null, detail: 'unused' }),
  disconnect: async () => undefined,
};

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof HubError ? e.code : `non-hub: ${String(e)}`;
  }
}

describe('BrowserManager over WebDriver BiDi', () => {
  it('opens, lists, focuses and closes tabs; purges closed pages and on disconnect', async () => {
    const tc = makeTestConfig();
    configs.push(tc);
    const zen = new BidiTestDriver();
    const m = createBrowserManager(tc.cfg, { chrome: idleChrome, zen });

    const initial = await m.listTabs(undefined, false);
    expect(initial).toEqual([]); // not connected and not asked to connect

    const first = await m.listTabs('zen', true); // launch's initial tab
    expect(first.every((t) => /^z\d+$/.test(t.id))).toBe(true);
    const preexisting = first.length;

    const a = await m.openTab('zen');
    await a.page.goto('data:text/html,<title>Alpha</title><p>a</p>');
    const b = await m.openTab('zen');
    await b.page.goto('data:text/html,<title>Beta</title><p>b</p>');
    expect(Number(b.id.slice(1))).toBe(Number(a.id.slice(1)) + 1);

    let tabs = await m.listTabs('zen');
    expect(tabs).toHaveLength(preexisting + 2);
    expect(tabs.find((t) => t.id === a.id)).toMatchObject({ title: 'Alpha', current: false });
    expect(tabs.find((t) => t.id === b.id)).toMatchObject({ title: 'Beta', current: true, browser: 'zen' });

    expect(await m.getPage(a.id)).toBe(a.page);
    await m.focusTab(a.id);
    tabs = await m.listTabs('zen');
    expect(tabs.find((t) => t.current)?.id).toBe(a.id);
    // same Page → same id across refreshes
    expect(tabs.map((t) => t.id)).toEqual((await m.listTabs('zen')).map((t) => t.id));

    await m.closeTab(a.id);
    expect(await codeOf(m.getPage(a.id))).toBe('TAB_NOT_FOUND');

    // Closed outside the manager (like the user closing the tab).
    await b.page.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await codeOf(m.getPage(b.id))).toBe('TAB_NOT_FOUND');
    tabs = await m.listTabs('zen');
    expect(tabs.map((t) => t.id)).not.toContain(b.id);
    expect(tabs).toHaveLength(preexisting);

    // A tab opened outside the manager gets a fresh, never-reused id.
    const outside = await zen.browser!.newPage();
    await outside.goto('data:text/html,<title>Outside</title>');
    tabs = await m.listTabs('zen');
    const o = tabs.find((t) => t.title === 'Outside');
    expect(o).toBeDefined();
    expect(Number(o!.id.slice(1))).toBeGreaterThan(Number(b.id.slice(1)));

    // Browser goes away → all its tabs are purged.
    await zen.browser!.close();
    expect(await codeOf(m.getPage(o!.id))).toBe('TAB_NOT_FOUND');
    expect(await m.listTabs('zen')).toEqual([]);
    await m.shutdown();
  });
});

describe('ZenDriver over a real BiDi connection', () => {
  it('reattaches from the state file, and disconnect() ends the session leaving the browser running', async () => {
    const tc = makeTestConfig();
    configs.push(tc);
    const fakeZenDir = join(tc.home, 'fake-zen-userdata');
    mkdirSync(fakeZenDir, { recursive: true });
    const { child, port } = await spawnDetachedChromium(fakeZenDir, 'data:text/html,<title>Zen Tab</title>');
    pids.push(child.pid!);

    mkdirSync(tc.cfg.stateDir, { recursive: true });
    mkdirSync(tc.cfg.zen.agentProfileDir, { recursive: true });
    writeFileSync(
      join(tc.cfg.stateDir, 'zen.json'),
      JSON.stringify({ pid: child.pid, wsUrl: port.wsEndpoint, profileDir: tc.cfg.zen.agentProfileDir, mode: 'agent' }),
    );
    const neverSpawn = (): never => {
      throw new Error('must reattach, not spawn');
    };
    // Record BiDi commands sent on the connection puppeteer uses (BidiBrowser.connection is internal;
    // we only wrap its send() to observe traffic).
    const sent: string[] = [];
    const recordingConnect = async (o: ConnectOptions): Promise<Browser> => {
      const b = await puppeteer.connect(o);
      const conn = (b as unknown as { connection: { send: (method: string, ...rest: unknown[]) => Promise<unknown> } }).connection;
      const orig = conn.send.bind(conn);
      conn.send = (method: string, ...rest: unknown[]) => {
        sent.push(method);
        return orig(method, ...rest);
      };
      return b;
    };
    const driver = new ZenDriver(tc.cfg, { spawn: neverSpawn, connect: recordingConnect, reattachTimeoutMs: 20_000 });
    const m = createBrowserManager(tc.cfg, { chrome: idleChrome, zen: driver });

    await m.connect('zen');
    expect(driver.status()).toMatchObject({ connected: true, mode: 'agent', protocol: 'webDriverBiDi' });
    expect(driver.status().detail).toMatch(/Reattached/);
    const tabs = await m.listTabs('zen');
    expect(tabs.map((t) => t.title)).toContain('Zen Tab');

    await m.shutdown();
    expect(driver.current()).toBeNull();
    expect(sent).toContain('session.end');
    expect(sent).not.toContain('browser.close');
    expect(isPidAlive(child.pid!)).toBe(true);

    // A new session can be opened after disconnect (session.end freed the slot).
    const driver2 = new ZenDriver(tc.cfg, { spawn: neverSpawn, reattachTimeoutMs: 20_000 });
    await driver2.connect('agent');
    expect(driver2.status().connected).toBe(true);
    await driver2.disconnect();
    expect(isPidAlive(child.pid!)).toBe(true);
  });
});
