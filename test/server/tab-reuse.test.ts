/**
 * Tab reuse (src/server/tab-reuse.ts): siteKey, findReusableTab, and tab_open through MCP.
 * open_url / play_media go through the same openPage — see test/desktop/reuse.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { UserConfig } from '../../src/config.js';
import { findReusableTab, siteKey, siteLabel } from '../../src/server/tab-reuse.js';
import type { BrowserName, TabInfo } from '../../src/types.js';
import { FakePage, setup, textOf } from './fakes.js';

const intent = 'the user asked to check their email';

describe('siteKey', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'youtube.com'],
    ['https://youtube.com/', 'youtube.com'],
    ['https://m.youtube.com/watch?v=abc', 'youtube.com'],
    ['https://music.youtube.com/watch?v=abc', 'music.youtube.com'],
    ['https://www.google.com/maps/dir/?api=1&destination=Toronto', 'google.com/maps'],
    ['https://www.google.com/maps/place/CN+Tower', 'google.com/maps'],
    ['https://maps.google.com/?q=Toronto', 'google.com/maps'],
    ['https://www.google.com/search?q=weather', 'google.com/search'],
    ['https://www.google.com/', 'google.com'],
    ['https://www.google.co.uk/maps/dir/', 'google.co.uk/maps'],
    ['https://docs.google.com/document/d/1/edit', 'docs.google.com/document'],
    ['https://docs.google.com/spreadsheets/d/1/edit', 'docs.google.com/spreadsheets'],
    ['https://mail.google.com/mail/u/0/#inbox', 'mail.google.com'],
    ['https://mail.google.com/', 'mail.google.com'],
    ['https://www.notion.so/myteam/Roadmap-0123456789abcdef', 'notion.so'],
    ['https://www.notion.so/otherteam', 'notion.so'],
    ['https://notion.so/', 'notion.so'],
    ['https://myteam.notion.site/Public-page-1', 'myteam.notion.site'],
    ['https://ontariotechu.instructure.com/courses/123/assignments', 'ontariotechu.instructure.com'],
    ['https://canvas.school.edu/courses/1', 'canvas.school.edu'],
  ])('%s → %s', (url, key) => {
    expect(siteKey(url)).toBe(key);
  });

  it('separates Google apps that share a host (maps vs search)', () => {
    expect(siteKey('https://www.google.com/maps/dir/A/B')).not.toBe(siteKey('https://www.google.com/search?q=maps'));
    expect(siteKey('https://www.google.com/MAPS/dir/')).toBe('google.com/maps');
  });

  it('is case-insensitive for the host, keeps non-default ports, ignores default ones', () => {
    expect(siteKey('HTTPS://WWW.YouTube.COM/watch?v=x')).toBe('youtube.com');
    expect(siteKey('https://Mail.Google.com./')).toBe('mail.google.com');
    expect(siteKey('http://localhost:3000/a')).toBe('localhost:3000');
    expect(siteKey('http://localhost:3000/a')).not.toBe(siteKey('http://localhost:8080/a'));
    expect(siteKey('https://example.com:443/x')).toBe('example.com');
    expect(siteKey('https://www.google.com:8443/maps')).toBe('google.com:8443/maps');
  });

  it('normalizes IDN hosts (unicode and punycode are one site)', () => {
    expect(siteKey('https://bücher.example/x')).toBe('xn--bcher-kva.example');
    expect(siteKey('https://xn--bcher-kva.example/y')).toBe(siteKey('https://www.bücher.example/'));
  });

  it('notion.site is not notion.so', () => {
    expect(siteKey('https://team.notion.site/x')).not.toBe(siteKey('https://www.notion.so/team/x'));
  });

  it('only http(s) pages have a site', () => {
    for (const u of ['about:blank', 'chrome://settings', 'file:///Users/x/a.html', 'mailto:a@b.c', 'not a url', '']) {
      expect(siteKey(u)).toBeNull();
    }
  });

  it('labels the well-known sites', () => {
    expect(siteLabel('google.com/maps')).toBe('Google Maps');
    expect(siteLabel('mail.google.com')).toBe('Gmail');
    expect(siteLabel('school.instructure.com')).toBe('Canvas');
    expect(siteLabel('example.com')).toBe('example.com');
  });
});

describe('findReusableTab', () => {
  const tabs = (list: Array<Partial<TabInfo> & { id: string; url: string }>) => ({
    listTabs: async (browser?: BrowserName): Promise<TabInfo[]> =>
      list.map((t) => ({ browser: t.id.startsWith('c') ? 'chrome' : 'zen', title: '', current: false, ...t }) as TabInfo).filter((t) => !browser || t.browser === browser),
  });
  const MAPS = 'https://www.google.com/maps/dir/?api=1&destination=Toronto';

  it('an exact match (fragment ignored) wins and is focused, even over a current same-site tab', async () => {
    const m = tabs([
      { id: 'z1', url: 'https://mail.google.com/mail/u/0/', current: true },
      { id: 'z2', url: 'https://mail.google.com/mail/u/0/#inbox' },
    ]);
    expect(await findReusableTab(m, 'zen', 'https://mail.google.com/mail/u/0/#sent')).toMatchObject({ tab: { id: 'z1' }, mode: 'focus' });
    expect(await findReusableTab(m, 'zen', 'https://mail.google.com/mail/u/1/')).toMatchObject({ tab: { id: 'z1' }, mode: 'navigate' });
  });

  it('same site → navigate, preferring the current tab, then the most recently used', async () => {
    const m = tabs([
      { id: 'z1', url: 'https://www.google.com/maps/place/A', lastUsed: 2 },
      { id: 'z2', url: 'https://www.google.com/search?q=x', current: true },
      { id: 'z3', url: 'https://www.google.com/maps/place/B', lastUsed: 5 },
      { id: 'z4', url: 'https://www.google.com/maps/place/C' },
    ]);
    expect(await findReusableTab(m, 'zen', MAPS)).toMatchObject({ tab: { id: 'z3' }, mode: 'navigate' });
    const cur = tabs([
      { id: 'z1', url: 'https://www.google.com/maps/place/A', lastUsed: 9 },
      { id: 'z2', url: 'https://maps.google.com/?q=x', current: true },
    ]);
    expect(await findReusableTab(cur, 'zen', MAPS)).toMatchObject({ tab: { id: 'z2' }, mode: 'navigate' });
  });

  it('no tab on the site → null; other browser tabs never count', async () => {
    const m = tabs([
      { id: 'z1', url: 'https://www.google.com/search?q=x' },
      { id: 'c1', url: MAPS },
    ]);
    expect(await findReusableTab(m, 'zen', MAPS)).toBeNull();
    expect(await findReusableTab(m, 'chrome', MAPS)).toMatchObject({ tab: { id: 'c1' }, mode: 'focus' });
  });

  it('skips a tab with a pending dialog and non-web tabs', async () => {
    const m = tabs([
      { id: 'z1', url: 'https://mail.google.com/mail/u/0/', current: true },
      { id: 'z2', url: 'https://mail.google.com/mail/u/0/#inbox' },
      { id: 'z3', url: 'about:blank' },
    ]);
    const hasDialog = (t: string) => t === 'z1';
    expect(await findReusableTab(m, 'zen', 'https://mail.google.com/', { hasDialog })).toMatchObject({ tab: { id: 'z2' }, mode: 'navigate' });
    expect(await findReusableTab(tabs([{ id: 'z1', url: 'https://a.example/' }]), 'zen', 'https://a.example/', { hasDialog: () => true })).toBeNull();
    for (const url of ['about:blank', 'chrome://newtab/', 'file:///tmp/a.html']) {
      expect(await findReusableTab(tabs([{ id: 'z1', url }]), 'zen', url)).toBeNull();
    }
  });

  it('reuse "exact" only focuses the same page; "never" never reuses', async () => {
    const m = tabs([{ id: 'z1', url: 'https://www.google.com/maps/place/A' }]);
    expect(await findReusableTab(m, 'zen', MAPS, { reuse: 'exact' })).toBeNull();
    expect(await findReusableTab(m, 'zen', 'https://www.google.com/maps/place/A#x', { reuse: 'exact' })).toMatchObject({ mode: 'focus' });
    expect(await findReusableTab(m, 'zen', 'https://www.google.com/maps/place/A', { reuse: 'never' })).toBeNull();
  });

  it('a browser that cannot list its tabs just gets none', async () => {
    const broken = { listTabs: async (): Promise<TabInfo[]> => Promise.reject(new Error('gone')) };
    expect(await findReusableTab(broken, 'zen', MAPS)).toBeNull();
  });
});

describe('tab_open reuses tabs (MCP)', () => {
  const GMAIL_TAB = 'https://mail.google.com/mail/u/0/#inbox';

  it('"check my email": loads Gmail in the existing Gmail tab instead of a new one', async () => {
    const h = await setup();
    const gm = h.manager.addPage('z2', new FakePage(GMAIL_TAB, 'Inbox'));
    const r = await h.call('tab_open', { url: 'https://mail.google.com/', intent });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/^Loaded https:\/\/mail\.google\.com\/ in your existing Gmail tab \(z2\) instead of opening a new tab/);
    expect(gm.gotoCalls.map((c) => c[0])).toEqual(['https://mail.google.com/']);
    expect(h.manager.opened.size).toBe(0);
    // Gate decision for the target URL exactly as before (tab_open, new tab), then the load audited as navigate.
    expect(h.gate.checks.at(-1)).toMatchObject({ kind: 'tab_open', tab: 'new', targetUrl: 'https://mail.google.com/' });
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'tab_open', tab: 'z2', kind: 'navigate', outcome: 'ok', args: { url: 'https://mail.google.com/', reused: 'navigate' } });
  });

  it('the exact page already open: switches to it without reloading', async () => {
    const h = await setup();
    const gm = h.manager.addPage('z2', new FakePage(GMAIL_TAB, 'Inbox'));
    const r = await h.call('tab_open', { url: 'https://mail.google.com/mail/u/0/', intent });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/^Switched to the tab that already had this page \(z2\)/);
    expect(gm.gotoCalls).toEqual([]);
    expect(h.manager.current.get('zen')).toBe('z2');
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'tab_open', tab: 'z2', kind: 'tab_open', outcome: 'ok', args: { reused: 'focus' } });
  });

  it('new_tab: true forces a new tab', async () => {
    const h = await setup();
    const gm = h.manager.addPage('z2', new FakePage(GMAIL_TAB, 'Inbox'));
    const r = await h.call('tab_open', { url: 'https://mail.google.com/', new_tab: true, intent });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/^Opened z3 in zen and loaded https:\/\/mail\.google\.com\//);
    expect(gm.gotoCalls).toEqual([]);
    expect(h.manager.opened.has('z3')).toBe(true);
  });

  it('desktop.reuseTabs "never" (the shared setting) always opens a new tab', async () => {
    const h = await setup({ overrides: { desktop: { reuseTabs: 'never' } } as UserConfig });
    h.manager.addPage('z2', new FakePage(GMAIL_TAB, 'Inbox'));
    const r = await h.call('tab_open', { url: 'https://mail.google.com/mail/u/0/#inbox', intent });
    expect(textOf(r)).toMatch(/^Opened z3 in zen/);
  });

  it('never reuses a tab with a pending dialog', async () => {
    const h = await setup();
    const gm = h.manager.addPage('z2', new FakePage(GMAIL_TAB, 'Inbox'));
    await h.call('tab_focus', { tab: 'z2' }); // attaches the dialog tracker
    gm.emitDialog('confirm', 'Discard draft?');
    const r = await h.call('tab_open', { url: 'https://mail.google.com/', intent });
    expect(textOf(r)).toMatch(/^Opened z3 in zen/);
    expect(gm.gotoCalls).toEqual([]);
  });

  it('a gate denial for the target stops before any tab is touched', async () => {
    const h = await setup();
    const gm = h.manager.addPage('z2', new FakePage(GMAIL_TAB, 'Inbox'));
    h.gate.decide = () => ({ allowed: false, decision: { verdict: 'deny', risk: 'high', rules: ['blocked-url'], reason: 'blocked' }, confirmation: 'not-needed', message: 'Blocked by policy.' });
    const r = await h.call('tab_open', { url: 'https://mail.google.com/', intent });
    expect(r.isError).toBe(true);
    expect(gm.gotoCalls).toEqual([]);
    expect(h.manager.current.get('zen')).not.toBe('z2');
  });

  it('a blank tab_open is always a new tab', async () => {
    const h = await setup();
    const r = await h.call('tab_open', { intent });
    expect(textOf(r)).toMatch(/^Opened new blank tab z2 in zen/);
  });
});
