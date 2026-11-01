/**
 * media_control on YouTube Music / YouTube tabs (PLAN-1.9 12.5): tab choice (YouTube Music > YouTube > Spotify/Music),
 * the clicks and keys sent, the REAL safety gate on every read/press/click, honest results, attach rules unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer-core';
import { findMediaTabs, MEDIA_KEYS, mediaSiteOf } from '../../src/desktop/media-tab.js';
import { PLAYERS_JXA } from '../../src/desktop/sound.js';
import type { TabInfo } from '../../src/types.js';
import { element, FakePage } from '../server/fakes.js';
import { setupDesktop, textOf } from './fakes.js';

const intent = 'the user asked to pause the music';
const YTM = 'https://music.youtube.com/watch?v=BxuY9FET9Y4&list=RDAMVM';
const YT = 'https://www.youtube.com/watch?v=BxuY9FET9Y4';

type Setup = Awaited<ReturnType<typeof setupDesktop>>;
type Btn = { name: string; role?: string };

/**
 * A fake player bar on every page: find('pause'/'play') answers from `state`; clicking the Play/Pause button or
 * pressing the toggle key flips it. `extra` adds more buttons per query (shelf arrows, "Play all"…).
 */
function player(h: Setup, start: 'playing' | 'paused' | 'none', opts: { toggleKey?: string; extra?: Record<string, Btn[]>; next?: boolean } = {}) {
  const p = { state: start };
  const names = new Map<string, string>();
  const toggleKey = opts.toggleKey ?? MEDIA_KEYS.youtube_music.toggle;
  h.engine.find.mockImplementation(async (_page: Page, tab: string, query: string) => {
    const out: { ref: string; role: string; name: string; context: string }[] = [];
    if (query === 'pause' && p.state === 'playing') out.push({ ref: `${tab}:e7`, role: 'button', name: 'Pause', context: '' });
    if (query === 'play' && p.state === 'paused') out.push({ ref: `${tab}:e7`, role: 'button', name: 'Play', context: '' });
    if (query === 'next' && opts.next) out.push({ ref: `${tab}:e8`, role: 'button', name: 'Next', context: '' });
    for (const [i, b] of (opts.extra?.[query] ?? []).entries()) out.push({ ref: `${tab}:x${i}`, role: b.role ?? 'button', name: b.name, context: '' });
    for (const m of out) names.set(m.ref, m.name);
    return out;
  });
  // describe() reports what find() saw, so the gate classifies the real button (a "Pause" click, not "Send").
  h.engine.describe.mockImplementation(async (_p: Page, ref: string) => element(ref, { name: names.get(ref) ?? 'Pause', text: '' }));
  const flip = () => {
    if (p.state !== 'none') p.state = p.state === 'playing' ? 'paused' : 'playing';
  };
  h.engine.pressKey.mockImplementation(async (_p: Page, key: string) => {
    if (key === toggleKey) flip();
  });
  h.engine.click.mockImplementation(async (_p: Page, ref: string) => {
    if (ref.endsWith(':e7')) flip();
  });
  return p;
}

/** Zen attached with these tabs (ids z1, z2, …). */
async function withTabs(urls: string[], over: Parameters<typeof setupDesktop>[0] = {}): Promise<Setup> {
  const h = await setupDesktop(over);
  urls.forEach((u, i) => h.manager.addPage(`z${i + 1}`, new FakePage(u)));
  return h;
}

const osa = (h: Setup) => h.mac.calls.filter((c) => c.file === '/usr/bin/osascript' && c.args[3] === PLAYERS_JXA).map((c) => c.args[4]);
const keys = (h: Setup) => h.engine.pressKey.mock.calls.map((c) => c[1]);
const clicks = (h: Setup) => h.engine.click.mock.calls.map((c) => c[1]);

describe('finding the media tab', () => {
  const tab = (id: string, url: string, over: Partial<TabInfo> = {}): TabInfo => ({ id, browser: id.startsWith('c') ? 'chrome' : 'zen', title: '', url, current: false, ...over });

  it('mediaSiteOf: any music.youtube.com page; only watch pages on youtube.com; https only', () => {
    expect(mediaSiteOf('https://music.youtube.com/')).toBe('youtube_music');
    expect(mediaSiteOf(YTM)).toBe('youtube_music');
    expect(mediaSiteOf(YT)).toBe('youtube');
    expect(mediaSiteOf('https://m.youtube.com/watch?v=x')).toBe('youtube');
    expect(mediaSiteOf('https://www.youtube.com/')).toBeNull();
    expect(mediaSiteOf('http://music.youtube.com/')).toBeNull();
    expect(mediaSiteOf('https://music.youtube.com.evil.example/')).toBeNull();
    expect(mediaSiteOf('about:blank')).toBeNull();
  });

  it('YouTube Music before YouTube, the current tab first, tabs with a dialog skipped', async () => {
    const tabs = [tab('z1', YT, { current: true }), tab('z2', 'https://music.youtube.com/'), tab('z3', YTM, { lastUsed: 5 }), tab('z4', 'https://music.youtube.com/explore')];
    const m = { listTabs: async () => tabs };
    expect((await findMediaTabs(m, ['zen'])).map((t) => [t.tab.id, t.site])).toEqual([
      ['z3', 'youtube_music'],
      ['z4', 'youtube_music'],
      ['z2', 'youtube_music'],
      ['z1', 'youtube'],
    ]);
    expect((await findMediaTabs(m, ['zen'], (id) => id === 'z3')).map((t) => t.tab.id)).toEqual(['z4', 'z2', 'z1']);
    expect(await findMediaTabs({ listTabs: async () => Promise.reject(new Error('gone')) }, ['zen'])).toEqual([]);
  });
});

describe('media_control on a YouTube Music tab', () => {
  it('pause: clicks the player\'s Pause button through the gate, says so, never asks Spotify/Music', async () => {
    const h = await withTabs(['https://www.google.com/', YTM]);
    h.mac.players.Spotify = { running: true, state: 'playing' };
    const p = player(h, 'playing');
    const check = vi.spyOn(h.gate, 'check');
    const r = await h.call('media_control', { action: 'pause', intent });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toBe('Paused YouTube Music (tab z2).');
    expect(p.state).toBe('paused');
    expect(clicks(h)).toEqual(['z2:e7']);
    expect(keys(h)).toEqual([]);
    expect(osa(h)).toEqual([]);
    expect(h.audit.entries.find((e) => e.tool === 'media_control' && e.kind === 'click' && e.urlAfter !== undefined)).toMatchObject({ tab: 'z2', outcome: 'ok', args: { action: 'pause', site: 'youtube_music' } });
    // the player was read through the gate, then the click was gated too
    expect(check.mock.calls.map(([req]) => [req.tool, req.kind, req.tab])).toEqual([
      ['media_control', 'read', 'z2'],
      ['media_control', 'click', 'z2'],
      ['media_control', 'read', 'z2'],
    ]);
  });

  it('next / previous: presses j / k (YouTube Music shortcuts) through the gate', async () => {
    const h = await withTabs([YTM]);
    player(h, 'playing');
    expect(textOf(await h.call('media_control', { action: 'next', intent }))).toBe('Skipped to the next track on YouTube Music (tab z1).');
    expect(textOf(await h.call('media_control', { action: 'previous', intent }))).toBe('Went back to the previous track on YouTube Music (tab z1).');
    expect(keys(h)).toEqual(['j', 'k']);
    const presses = h.audit.entries.filter((e) => e.tool === 'media_control' && e.kind === 'press' && e.urlAfter !== undefined); // the result entries
    expect(presses.map((e) => [e.outcome, (e.args as { key?: string }).key])).toEqual([
      ['ok', 'j'],
      ['ok', 'k'],
    ]);
  });

  it('play when it is already playing: nothing pressed, says so', async () => {
    const h = await withTabs([YTM]);
    player(h, 'playing');
    const r = await h.call('media_control', { action: 'play', intent });
    expect(textOf(r)).toBe('YouTube Music is already playing (tab z1); nothing pressed.');
    expect(keys(h)).toEqual([]);
    expect(clicks(h)).toEqual([]);
  });

  it('toggle with a paused player clicks Play ("Play all" and similar never count)', async () => {
    const h = await withTabs([YTM]);
    const p = player(h, 'paused', { extra: { play: [{ name: 'Play all' }, { name: 'Play', role: 'link' }] } });
    expect(textOf(await h.call('media_control', { action: 'toggle', intent }))).toBe('Playing YouTube Music (tab z1).');
    expect(p.state).toBe('playing');
    expect(clicks(h)).toEqual(['z1:e7']);
  });

  it('no player button visible: Space, but only when nothing has focus (Space would activate a focused control)', async () => {
    const h = await withTabs([YTM]);
    player(h, 'none');
    let r = await h.call('media_control', { action: 'toggle', intent });
    expect(textOf(r)).toMatch(/^Pressed play\/pause on YouTube Music \(Stephen couldn't see/);
    expect(keys(h)).toEqual(['Space']);

    h.engine.describeFocused.mockImplementation(async () => element('z1:e2', { name: 'Like', isEditable: false }));
    r = await h.call('media_control', { action: 'toggle', intent });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Nothing pressed on YouTube Music \(tab z1\): an element on the page has keyboard focus/);
    expect(keys(h)).toEqual(['Space']);
  });

  it('focus in the search box: next clicks the one Next button instead of typing j; ambiguous buttons → honest refusal', async () => {
    const h = await withTabs([YTM]);
    h.engine.describeFocused.mockImplementation(async () => element('z1:e1', { role: 'combobox', name: 'Search', tag: 'input', isEditable: true }));
    player(h, 'playing', { next: true });
    expect(textOf(await h.call('media_control', { action: 'next', intent }))).toBe('Skipped to the next track on YouTube Music (tab z1).');
    expect(keys(h)).toEqual([]);
    expect(clicks(h)).toEqual(['z1:e8']);

    const h2 = await withTabs([YTM]);
    h2.engine.describeFocused.mockImplementation(async () => element('z1:e1', { role: 'combobox', name: 'Search', tag: 'input', isEditable: true }));
    player(h2, 'playing', { next: true, extra: { next: [{ name: 'Next' }] } }); // a shelf arrow also called "Next"
    const r = await h2.call('media_control', { action: 'next', intent });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/keyboard focus is in a text field/);
    expect(keys(h2)).toEqual([]);
    expect(clicks(h2)).toEqual([]);
  });

  it('pause on a paused YouTube Music tab: falls through to a playing Spotify, else says it is already paused', async () => {
    const h = await withTabs([YTM]);
    player(h, 'paused');
    h.mac.players.Spotify = { running: true, state: 'playing' };
    expect(textOf(await h.call('media_control', { action: 'pause', intent }))).toBe('Spotify: pause done (now paused).');
    expect(clicks(h)).toEqual([]);

    const h2 = await withTabs([YTM]);
    player(h2, 'paused');
    const r = await h2.call('media_control', { action: 'pause', intent });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('Nothing done: YouTube Music is already paused (tab z1), and nothing is playing in Spotify or Music.');
  });

  it('goes through the shared rate limit (the press is a gated action)', async () => {
    const h = await withTabs([YTM], { overrides: { safety: { maxActionsPerMinute: 1 } } });
    player(h, 'playing');
    expect((await h.call('media_control', { action: 'next', intent })).isError).toBeFalsy();
    const r = await h.call('media_control', { action: 'next', intent });
    expect(r.isError).toBe(true);
    expect(keys(h)).toEqual(['j']);
  });
});

describe('media_control: which target', () => {
  it('YouTube Music wins over a YouTube tab (even the current one)', async () => {
    const h = await withTabs([YT, YTM]);
    h.manager.current.set('zen', 'z1');
    player(h, 'playing');
    expect(textOf(await h.call('media_control', { action: 'next', intent }))).toContain('YouTube Music (tab z2)');
    expect(keys(h)).toEqual(['j']);
  });

  it('a YouTube watch tab second: Shift+N for next, Shift+P for previous, Pause (k) button for pause', async () => {
    const h = await withTabs(['https://www.youtube.com/', YT]);
    h.engine.find.mockImplementation(async (_p: Page, tab: string, q: string) => (q === 'pause' ? [{ ref: `${tab}:e7`, role: 'button', name: 'Pause (k)', context: '' }] : []));
    expect(textOf(await h.call('media_control', { action: 'next', intent }))).toBe('Skipped to the next track on YouTube (tab z2).');
    expect(textOf(await h.call('media_control', { action: 'previous', intent }))).toBe('Went back to the previous track on YouTube (tab z2).');
    expect(keys(h)).toEqual(['Shift+N', 'Shift+P']);
    await h.call('media_control', { action: 'pause', intent });
    expect(clicks(h)).toEqual(['z2:e7']);
  });

  it('a YouTube tab with no visible button: toggle presses k', async () => {
    const h = await withTabs([YT]);
    player(h, 'none', { toggleKey: 'k' });
    await h.call('media_control', { action: 'toggle', intent });
    expect(keys(h)).toEqual(['k']);
  });

  it('no media tab: falls back to Spotify/Music; nothing there either → honest message', async () => {
    const h = await withTabs(['https://www.google.com/']);
    h.mac.players.Music = { running: true, state: 'playing' };
    expect(textOf(await h.call('media_control', { action: 'next', intent }))).toBe('Apple Music: next done (now playing).');

    const h2 = await withTabs(['https://www.google.com/']);
    const r = await h2.call('media_control', { action: 'play', intent });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("Nothing done: No YouTube Music tab is open (and no YouTube video), and Spotify and Music aren't running. To start new music, use play_media.");
    expect(keys(h2)).toEqual([]);
    expect(h2.mac.opens()).toEqual([]);
  });

  it('not attached to the browser: says it cannot see the tabs, then tries Spotify/Music', async () => {
    const h = await setupDesktop();
    const r = await h.call('media_control', { action: 'pause', intent });
    expect(textOf(r)).toBe(
      'Nothing done: No YouTube Music tab found: Stephen isn\'t connected to Zen, so it can\'t see its tabs (opening Zen with "Zen for Stephen" fixes that), and nothing is playing in Spotify or Music. To start new music, use play_media.',
    );
    expect(osa(h)).toEqual(['status']);
  });

  it('attaches on demand to a running "Zen for Stephen" (attach-only), like play_media', async () => {
    const h = await setupDesktop();
    h.manager.addPage('z3', new FakePage(YTM));
    h.manager.connected.zen = false; // fresh server
    h.manager.unreachable.delete('zen');
    player(h, 'playing');
    expect(textOf(await h.call('media_control', { action: 'pause', intent }))).toBe('Paused YouTube Music (tab z3).');
    expect(h.manager.connectCalls).toEqual([['zen', undefined]]);
  });

  it('never attaches on demand in agent mode or to Chrome; an already-connected Chrome tab is used', async () => {
    const a = await setupDesktop({ overrides: { zen: { mode: 'agent' } } });
    a.manager.unreachable.delete('zen');
    await a.call('media_control', { action: 'pause', intent });
    expect(a.manager.connectCalls).toEqual([]);

    const c = await setupDesktop({ overrides: { defaultBrowser: 'chrome' } });
    await c.call('media_control', { action: 'pause', intent });
    expect(c.manager.connectCalls.filter(([b]) => b === 'chrome')).toEqual([]);

    const cc = await setupDesktop({ overrides: { defaultBrowser: 'chrome' } });
    cc.manager.addPage('c2', new FakePage(YTM)); // Chrome already connected
    player(cc, 'playing');
    expect(textOf(await cc.call('media_control', { action: 'pause', intent }))).toBe('Paused YouTube Music (tab c2).');
  });

  it('a named player (the user said "Spotify") skips the tabs', async () => {
    const h = await withTabs([YTM]);
    player(h, 'playing');
    h.mac.players.Spotify = { running: true, state: 'playing' };
    expect(textOf(await h.call('media_control', { action: 'pause', player: 'Spotify', intent }))).toBe('Spotify: pause done (now paused).');
    expect(clicks(h)).toEqual([]);
    expect(h.engine.find).not.toHaveBeenCalled();
  });

  it('the tool description puts YouTube Music first', async () => {
    const h = await setupDesktop();
    const t = (await h.client.listTools()).tools.find((x) => x.name === 'media_control')!;
    expect(t.description).toMatch(/YouTube Music tab in Zen or Chrome, else a YouTube video tab/);
  });
});
