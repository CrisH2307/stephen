import type { Browser } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserManager } from '../../src/drivers/index.js';
import { HubError } from '../../src/errors.js';
import type { BrowserDriver, BrowserName, BrowserStatus, IBrowserManager, ProfileMode } from '../../src/types.js';
import { FakeBrowser, type TestConfig, makeTestConfig } from './helpers.js';

let tc: TestConfig;
afterEach(() => tc?.cleanup());

class FakeDriver implements BrowserDriver {
  readonly protocol;
  browser: FakeBrowser | null = null;
  connectCalls: ProfileMode[] = [];
  disconnectCalls = 0;
  failDisconnect = false;
  delayMs = 0;
  constructor(readonly name: BrowserName) {
    this.protocol = name === 'chrome' ? ('cdp' as const) : ('webDriverBiDi' as const);
  }
  async connect(mode: ProfileMode): Promise<Browser> {
    this.connectCalls.push(mode);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (!this.browser || !this.browser.connected) this.browser = new FakeBrowser();
    return this.browser.asBrowser();
  }
  current(): Browser | null {
    return this.browser?.connected ? this.browser.asBrowser() : null;
  }
  status(): BrowserStatus {
    return { name: this.name, connected: !!this.current(), mode: null, protocol: this.protocol, version: null, detail: 'fake' };
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    if (this.failDisconnect) throw new Error('boom');
    this.browser?.drop();
    this.browser = null;
  }
}

function setup(opts: { closeWaitMs?: number } = {}): { m: IBrowserManager; chrome: FakeDriver; zen: FakeDriver } {
  tc = makeTestConfig();
  tc.cfg.chrome.mode = 'real';
  const chrome = new FakeDriver('chrome');
  const zen = new FakeDriver('zen');
  return { m: createBrowserManager(tc.cfg, { chrome, zen }, opts), chrome, zen };
}

async function expectTabNotFound(p: Promise<unknown>, tab: string): Promise<void> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HubError);
  expect((e as HubError).code).toBe('TAB_NOT_FOUND');
  expect((e as HubError).message).toBe(`Tab ${tab} is closed or unknown. Use tabs_list.`);
}

describe('BrowserManager', () => {
  it('connect() defaults to the configured mode and shares in-flight connects', async () => {
    const { m, chrome, zen } = setup();
    chrome.delayMs = 20;
    const [a, b] = await Promise.all([m.connect('chrome'), m.connect('chrome')]);
    expect(a).toBe(b);
    expect(chrome.connectCalls).toEqual(['real']);
    await m.connect('zen');
    await m.connect('zen', 'real');
    expect(zen.connectCalls).toEqual(['agent', 'real']);
  });

  it('assigns browser-prefixed ids to existing and new tabs, refreshing from pages()', async () => {
    const { m, chrome } = setup();
    await m.connect('chrome');
    chrome.browser!.addPage('https://mail.example.com/', 'Inbox');
    chrome.browser!.addPage('https://docs.example.com/', 'Doc');
    let tabs = await m.listTabs('chrome');
    expect(tabs.map((t) => [t.id, t.title, t.url, t.current])).toEqual([
      ['c1', 'Inbox', 'https://mail.example.com/', false],
      ['c2', 'Doc', 'https://docs.example.com/', false],
    ]);
    const { id, page } = await m.openTab('chrome');
    expect(id).toBe('c3');
    expect(await m.getPage('c3')).toBe(page);
    // user opens a tab by hand
    chrome.browser!.addPage('https://news.example.com/', 'News');
    tabs = await m.listTabs();
    expect(tabs.map((t) => t.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(tabs.find((t) => t.current)?.id).toBe('c3');
    // the same Page always keeps its id
    tabs = await m.listTabs('chrome');
    expect(tabs.map((t) => t.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('excludes non-page targets and extension/devtools pages', async () => {
    const { m, zen } = setup();
    await m.connect('zen');
    zen.browser!.addPage('https://a.example/', 'A');
    zen.browser!.addPage('devtools://devtools/bundled/inspector.html', 'DevTools');
    zen.browser!.addPage('chrome-extension://abc/popup.html', 'Ext');
    zen.browser!.addPage('moz-extension://uuid/options.html', 'Ext2');
    zen.browser!.addPage('https://sw.example/', 'SW', 'service_worker');
    const tabs = await m.listTabs('zen');
    expect(tabs.map((t) => [t.id, t.url])).toEqual([['z1', 'https://a.example/']]);
  });

  it('purges closed tabs and never reuses ids', async () => {
    const { m, chrome } = setup();
    await m.connect('chrome');
    const p1 = chrome.browser!.addPage('https://one.example/');
    chrome.browser!.addPage('https://two.example/');
    await m.listTabs('chrome');
    await m.focusTab('c1');
    p1.userClose(); // user closes c1 (fires page close + targetdestroyed)
    await expectTabNotFound(m.getPage('c1'), 'c1');
    const tabs = await m.listTabs('chrome');
    expect(tabs.map((t) => t.id)).toEqual(['c2']);
    expect(tabs.some((t) => t.current)).toBe(false); // current was c1
    const { id } = await m.openTab('chrome');
    expect(id).toBe('c3');
    await m.closeTab('c3');
    await expectTabNotFound(m.getPage('c3'), 'c3');
    expect((await m.openTab('chrome')).id).toBe('c4');
  });

  it('getPage/focusTab mark current; focusTab brings to front', async () => {
    const { m, chrome } = setup();
    await m.connect('chrome');
    const a = chrome.browser!.addPage('https://a/');
    chrome.browser!.addPage('https://b/');
    await m.listTabs('chrome');
    await m.getPage('c2');
    expect((await m.listTabs('chrome')).find((t) => t.current)?.id).toBe('c2');
    await m.focusTab('c1');
    expect(a.fronted).toBe(1);
    expect((await m.listTabs('chrome')).find((t) => t.current)?.id).toBe('c1');
  });

  it('rejects unknown and malformed tab ids', async () => {
    const { m } = setup();
    await expectTabNotFound(m.getPage('z9'), 'z9');
    await expect(m.getPage('x1')).rejects.toMatchObject({ code: 'TAB_NOT_FOUND' });
    expect(m.browserOf('z3')).toBe('zen');
    expect(m.browserOf('c12')).toBe('chrome');
  });

  it('skips unconnected browsers unless connectIfNeeded', async () => {
    const { m, chrome, zen } = setup();
    expect(await m.listTabs()).toEqual([]);
    expect(chrome.connectCalls).toEqual([]);
    await m.listTabs('zen', true);
    expect(zen.connectCalls).toEqual(['agent']);
    expect(chrome.connectCalls).toEqual([]);
  });

  it('purges a browser’s tabs when it disconnects, ids keep counting', async () => {
    const { m, zen } = setup();
    await m.connect('zen');
    zen.browser!.addPage('https://a/');
    await m.listTabs('zen');
    zen.browser!.drop(); // user quit Zen
    await expectTabNotFound(m.getPage('z1'), 'z1');
    expect(await m.listTabs('zen')).toEqual([]);
    await m.connect('zen');
    zen.browser!.addPage('https://a/');
    expect((await m.listTabs('zen')).map((t) => t.id)).toEqual(['z2']);
  });

  it('openTab connects lazily', async () => {
    const { m, zen } = setup();
    const { id } = await m.openTab('zen');
    expect(id).toBe('z1');
    expect(zen.connectCalls).toEqual(['agent']);
  });

  it('shutdown disconnects all drivers and swallows errors', async () => {
    const { m, chrome, zen } = setup();
    await m.connect('chrome');
    await m.connect('zen');
    zen.failDisconnect = true;
    await expect(m.shutdown()).resolves.toBeUndefined();
    expect(chrome.disconnectCalls).toBe(1);
    expect(zen.disconnectCalls).toBe(1);
    expect(m.status().map((s) => s.name)).toEqual(['chrome', 'zen']);
  });

  it('falls back to an empty title when page.title() hangs', async () => {
    const { m, chrome } = setup();
    await m.connect('chrome');
    const p = chrome.browser!.addPage('https://slow/');
    p.title = () => new Promise<string>(() => undefined);
    const t0 = Date.now();
    const tabs = await m.listTabs('chrome');
    expect(tabs[0]!.title).toBe('');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('review #2 finding 11: tab origin and closing', () => {
  const opened = (m: IBrowserManager, tab: string) => (m as IBrowserManager & { openedByHub(t: string): boolean }).openedByHub(tab);

  it('openedByHub: true only for tabs browser-hub opened (until they close)', async () => {
    const { m, chrome } = setup();
    await m.connect('chrome');
    chrome.browser!.addPage('https://user.example/');
    await m.listTabs('chrome');
    const { id } = await m.openTab('chrome');
    expect(opened(m, 'c1')).toBe(false); // the user's tab
    expect(opened(m, id)).toBe(true);
    expect(opened(m, 'z9')).toBe(false); // unknown
    await m.closeTab(id);
    expect(opened(m, id)).toBe(false);
  });

  it('closeTab runs beforeunload and waits for a delayed close', async () => {
    const { m, chrome } = setup();
    await m.connect('chrome');
    const p = chrome.browser!.addPage('https://a.example/');
    p.closeMode = 'later';
    await m.listTabs('chrome');
    await m.closeTab('c1');
    expect(p.closeOpts).toEqual([{ runBeforeUnload: true }]);
    expect(p.closed).toBe(true);
    await expectTabNotFound(m.getPage('c1'), 'c1');
  });

  it('a tab kept open by its beforeunload dialog stays registered (closeTab returns after the wait)', async () => {
    const { m, chrome } = setup({ closeWaitMs: 50 });
    await m.connect('chrome');
    const p = chrome.browser!.addPage('https://draft.example/');
    p.closeMode = 'stay';
    await m.listTabs('chrome');
    await m.closeTab('c1');
    expect(p.closed).toBe(false);
    expect(await m.getPage('c1')).toBe(p.asPage());
    p.userClose(); // the user/model accepted "Leave page?"
    await expectTabNotFound(m.getPage('c1'), 'c1');
  });
});
