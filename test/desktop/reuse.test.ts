/**
 * Tab reuse for open_url and play_media (the owner's audit log: four direction questions opened four Google
 * Maps tabs). Same openPage / findReusableTab as tab_open (src/server/tab-reuse.ts), REAL safety gate.
 */
import { describe, expect, it } from 'vitest';
import type { Page } from 'puppeteer-core';
import { FakePage } from '../server/fakes.js';
import { setupDesktop, textOf } from './fakes.js';

const intent = 'the user asked for directions';
const WATCH = 'https://www.youtube.com/watch?v=BxuY9FET9Y4';
const dirs = (to: string) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}`;

type Setup = Awaited<ReturnType<typeof setupDesktop>>;

/** Zen for Stephen is running; a fresh server attaches on demand. */
async function attached(over: Parameters<typeof setupDesktop>[0] = {}): Promise<Setup> {
  const h = await setupDesktop(over);
  h.manager.unreachable.delete('zen');
  return h;
}

describe('open_url reuses tabs', () => {
  it('the reported Maps scenario: four direction questions → one tab, navigated each time', async () => {
    const h = await attached();
    const targets = ['CN Tower', 'Union Station', 'Ontario Tech University', 'Pearson Airport'].map(dirs);
    const texts: string[] = [];
    for (const url of targets) {
      const r = await h.call('open_url', { url, intent });
      expect(r.isError, textOf(r)).toBeFalsy();
      texts.push(textOf(r));
    }
    expect([...h.manager.pages.keys()]).toEqual(['z1']);
    expect(h.manager.opened.size).toBe(1);
    expect(h.manager.pages.get('z1')!.gotoCalls.map((c) => c[0])).toEqual(targets);
    expect(texts[0]).toMatch(/^Opened a new Zen tab and loaded/);
    for (const t of texts.slice(1)) {
      expect(t).toMatch(/^Loaded https:\/\/www\.google\.com\/maps\/dir\/\S+ in your existing Google Maps tab \(z1\) instead of opening a new tab/);
      expect(t).toContain('Tab id: z1 (reused)');
    }
    // Every call went through the gate for its target, and every reuse was a gated, audited navigate.
    const navs = h.audit.entries.filter((e) => e.tool === 'open_url' && e.kind === 'navigate' && e.outcome === 'ok');
    expect(navs).toHaveLength(3);
    for (const e of navs) expect(e.args).toMatchObject({ via: 'attached browser (reused tab)', reused: 'navigate' });
    expect(h.mac.opens()).toEqual([]);
  });

  it('a maps.google.com tab the user already had counts as Google Maps; Google Search does not', async () => {
    const h = await attached();
    const search = h.manager.addPage('z1', new FakePage('https://www.google.com/search?q=directions', 'Search'));
    const maps = h.manager.addPage('z2', new FakePage('https://maps.google.com/?q=Toronto', 'Maps'));
    h.manager.connected.zen = false;
    const r = await h.call('open_url', { url: dirs('CN Tower'), intent });
    expect(textOf(r)).toContain('your existing Google Maps tab (z2)');
    expect(search.gotoCalls).toEqual([]);
    expect(maps.gotoCalls).toHaveLength(1);
  });

  it('the exact page already open: switches to it, no reload', async () => {
    const h = await attached();
    const url = 'https://ontariotechu.instructure.com/courses/123';
    const canvas = h.manager.addPage('z1', new FakePage(`${url}#top`, 'Course'));
    h.manager.addPage('z2', new FakePage('https://www.notion.so/team/Notes-1', 'Notes'));
    h.manager.current.set('zen', 'z2');
    h.manager.connected.zen = false;
    const r = await h.call('open_url', { url, intent });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(/^Switched to the tab that already had this page \(z1\)/);
    expect(canvas.gotoCalls).toEqual([]);
    expect(h.manager.current.get('zen')).toBe('z1');
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'open_url', tab: 'z1', kind: 'tab_open', outcome: 'ok', args: { reused: 'focus' } });
  });

  it('Notion: another page of the workspace loads in the Notion tab', async () => {
    const h = await attached();
    const notion = h.manager.addPage('z1', new FakePage('https://www.notion.so/team/Notes-1', 'Notes'));
    h.manager.connected.zen = false;
    const r = await h.call('open_url', { url: 'https://www.notion.so/team/Roadmap-2', intent });
    expect(textOf(r)).toContain('your existing Notion tab (z1)');
    expect(notion.gotoCalls.map((c) => c[0])).toEqual(['https://www.notion.so/team/Roadmap-2']);
  });

  it('desktop.reuseTabs "never": a new tab every time', async () => {
    const h = await attached({ overrides: { desktop: { reuseTabs: 'never' } } });
    await h.call('open_url', { url: dirs('A'), intent });
    await h.call('open_url', { url: dirs('B'), intent });
    expect([...h.manager.pages.keys()]).toEqual(['z1', 'z2']);
  });

  it('desktop.reuseTabs "exact": same site is a new tab, the same page is focused', async () => {
    const h = await attached({ overrides: { desktop: { reuseTabs: 'exact' } } });
    await h.call('open_url', { url: dirs('A'), intent });
    await h.call('open_url', { url: dirs('B'), intent });
    const r = await h.call('open_url', { url: dirs('A'), intent });
    expect([...h.manager.pages.keys()]).toEqual(['z1', 'z2']);
    expect(textOf(r)).toMatch(/^Switched to the tab that already had this page \(z1\)/);
  });

  it('a blocked target is refused by the gate before any tab on that site is touched', async () => {
    const h = await attached({ overrides: { safety: { blockedDomains: ['evil.example'] } } });
    const tab = h.manager.addPage('z1', new FakePage('https://evil.example/old', 'old'));
    h.manager.connected.zen = false;
    const r = await h.call('open_url', { url: 'https://evil.example/new', intent });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/blocked list/);
    expect(tab.gotoCalls).toEqual([]);
  });

  it('new_tab: true keeps several pages of one site side by side ("routes from my home to two stations")', async () => {
    const h = await attached();
    const home = '123 Example St, Oshawa, ON';
    const route = (to: string) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(home)}&destination=${encodeURIComponent(to)}&travelmode=transit`;
    const a = await h.call('open_url', { url: route('Oshawa GO Station'), new_tab: true, intent });
    const b = await h.call('open_url', { url: route('Whitby GO Station'), new_tab: true, intent });
    expect(a.isError, textOf(a)).toBeFalsy();
    expect(b.isError, textOf(b)).toBeFalsy();
    expect([...h.manager.pages.keys()]).toEqual(['z1', 'z2']);
    expect(h.manager.pages.get('z1')!.gotoCalls.map((c) => c[0])).toEqual([route('Oshawa GO Station')]);
    expect(h.manager.pages.get('z2')!.gotoCalls.map((c) => c[0])).toEqual([route('Whitby GO Station')]);
    expect(textOf(b)).toMatch(/^Opened a new Zen tab and loaded/);
    // still gated: both went through the gate as tab_open and were audited
    // each route: one gate decision (tab "new") + one audited open in its own tab
    const opens = h.audit.entries.filter((e) => e.tool === 'open_url' && e.outcome === 'ok');
    expect(opens.map((e) => e.tab)).toEqual(['new', 'z1', 'new', 'z2']);
    expect(opens.every((e) => e.kind === 'tab_open')).toBe(true);
  });

  it('without new_tab the default reuse still applies (a third route replaces the Maps tab it finds)', async () => {
    const h = await attached();
    await h.call('open_url', { url: dirs('A'), new_tab: true, intent });
    await h.call('open_url', { url: dirs('B'), new_tab: true, intent });
    await h.call('open_url', { url: dirs('C'), intent });
    expect([...h.manager.pages.keys()]).toEqual(['z1', 'z2']);
  });

  it('new_tab: true does not get around the gate: a blocked site is still refused', async () => {
    const h = await attached({ overrides: { safety: { blockedDomains: ['evil.example'] } } });
    const r = await h.call('open_url', { url: 'https://evil.example/', new_tab: true, intent });
    expect(r.isError).toBe(true);
    expect([...h.manager.pages.keys()]).toEqual([]);
  });
});

describe('play_media still reuses the YouTube tab and presses play', () => {
  it('paused video in the reused tab → k pressed', async () => {
    const h = await attached();
    const yt = h.manager.addPage('z4', new FakePage('https://m.youtube.com/watch?v=OLDVIDEO123', 'old'));
    h.manager.connected.zen = false;
    const state = { s: 'paused' as 'paused' | 'playing' };
    h.engine.find.mockImplementation(async (_p: Page, tab: string, q: string) => {
      if (q === 'pause') return state.s === 'playing' ? [{ ref: `${tab}:e7`, role: 'button', name: 'Pause (k)', context: '' }] : [];
      if (q === 'play') return state.s === 'paused' ? [{ ref: `${tab}:e7`, role: 'button', name: 'Play (k)', context: '' }] : [];
      return [];
    });
    h.engine.pressKey.mockImplementation(async (_p: Page, key: string) => {
      if (key === 'k') state.s = 'playing';
    });
    const r = await h.call('play_media', { query: 'One Call Away Charlie Puth', intent: 'play a song' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(yt.gotoCalls.map((c) => c[0])).toEqual([WATCH]);
    expect(h.manager.opened.size).toBe(0);
    expect(state.s).toBe('playing');
    expect(textOf(r)).toMatch(/Playing on YouTube in Zen \(it was paused, so Stephen pressed play\) — tab z4 \(your YouTube tab that was already open, no new tab\)/);
  });

  it('YouTube Music is its own site: a YouTube tab is not reused for it', async () => {
    const h = await attached();
    const yt = h.manager.addPage('z1', new FakePage('https://www.youtube.com/', 'YouTube'));
    h.manager.connected.zen = false;
    const r = await h.call('play_media', { query: 'One Call Away Charlie Puth', service: 'youtube_music', intent: 'play a song' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(yt.gotoCalls).toEqual([]);
    expect(h.manager.opened.size).toBe(1);
  });
});
