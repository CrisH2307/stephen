/** Phase 1.8 track C: `volume` and `media_control` (fixed JXA scripts, validated args, locked-screen refusal, audit). */
import { describe, expect, it } from 'vitest';
import { parsePlayers, parseVolume, pickPlayer, PLAYERS_JXA, volumeArg, VOLUME_JXA, type PlayersStatus } from '../../src/desktop/sound.js';
import { ioregXml, setupDesktop, standardMac, textOf } from './fakes.js';

const intent = 'the user asked';
const osa = (h: Awaited<ReturnType<typeof setupDesktop>>, script: string) => h.mac.calls.filter((c) => c.file === '/usr/bin/osascript' && c.args[3] === script);

describe('sound helpers', () => {
  it('volumeArg: set needs a level; up/down default to a step of 10', () => {
    expect(volumeArg('set', 30)).toBe(30);
    expect(() => volumeArg('set', undefined)).toThrow(/needs a level/);
    expect(volumeArg('up', undefined)).toBe(10);
    expect(volumeArg('down', 25)).toBe(25);
    expect(volumeArg('mute', 80)).toBe(0);
  });

  it('parseVolume / parsePlayers never throw and drop junk', () => {
    expect(parseVolume('{"volume": 42.4, "muted": false}')).toEqual({ volume: 42, muted: false });
    expect(parseVolume('{"volume": 500}')).toEqual({ volume: null, muted: null });
    expect(parseVolume('nope')).toEqual({ volume: null, muted: null });
    expect(parsePlayers('{"Spotify":{"running":true,"state":"Playing"},"Music":{"running":false}}')).toEqual({ Spotify: { running: true, state: 'playing' }, Music: { running: false } });
    expect(parsePlayers('{"Spotify":{"running":true,"state":"<script>"}}').Spotify).toEqual({ running: true, state: 'unknown' });
    expect(parsePlayers('garbage')).toEqual({ Spotify: { running: false }, Music: { running: false } });
  });

  it('pickPlayer: named one if running; else the playing one; pause never picks a paused player', () => {
    const st = (s: PlayersStatus['Spotify'], m: PlayersStatus['Music']): PlayersStatus => ({ Spotify: s, Music: m });
    const off = { running: false };
    expect(pickPlayer(st({ running: true, state: 'paused' }, { running: true, state: 'playing' }), 'next')).toBe('Music');
    expect(pickPlayer(st({ running: true, state: 'paused' }, off), 'pause')).toBeNull();
    expect(pickPlayer(st({ running: true, state: 'paused' }, off), 'play')).toBe('Spotify');
    expect(pickPlayer(st(off, { running: true, state: 'stopped' }), 'toggle')).toBe('Music');
    expect(pickPlayer(st(off, off), 'play')).toBeNull();
    expect(pickPlayer(st(off, { running: true, state: 'playing' }), 'pause', 'Spotify')).toBeNull();
  });

  it('the scripts take their input only from argv (no interpolation) and never launch an app', () => {
    for (const s of [VOLUME_JXA, PLAYERS_JXA]) {
      expect(s.startsWith('function run(argv) {')).toBe(true);
      expect(s).not.toMatch(/\$\{|activate\(\)|launch\(\)|doShellScript/);
    }
    expect(PLAYERS_JXA).toMatch(/if \(!p\.running\(\)\) throw new Error\('not running'\)/);
  });
});

describe('volume tool', () => {
  it('set / up / down / mute — fixed script, validated number as argv, audited', async () => {
    const h = await setupDesktop();
    expect(textOf(await h.call('volume', { action: 'set', level: 30, intent }))).toBe('Volume is now at 30%.');
    expect(textOf(await h.call('volume', { action: 'up', intent }))).toBe('Volume is now at 40%.');
    expect(textOf(await h.call('volume', { action: 'down', level: 25, intent }))).toBe('Volume is now at 15%.');
    expect(textOf(await h.call('volume', { action: 'mute', intent }))).toBe('Volume is now muted.');
    expect(osa(h, VOLUME_JXA).map((c) => c.args.slice(0, 3).concat(c.args.slice(4)))).toEqual([
      ['-l', 'JavaScript', '-e', 'set', '30'],
      ['-l', 'JavaScript', '-e', 'up', '10'],
      ['-l', 'JavaScript', '-e', 'down', '25'],
      ['-l', 'JavaScript', '-e', 'mute', '0'],
    ]);
    // one gate decision (rate limit) + one result entry per change
    const ok = h.audit.entries.filter((e) => e.tool === 'volume' && e.outcome === 'ok' && (e.args as { result?: unknown } | undefined)?.result);
    expect(ok).toHaveLength(4);
    expect(h.audit.entries.filter((e) => e.tool === 'volume')).toHaveLength(8);
    expect(ok[0]!.args).toMatchObject({ action: 'set', level: 30, result: { volume: 30, muted: false } });
  });

  it('rejects bad input before touching the Mac', async () => {
    const h = await setupDesktop();
    expect((await h.call('volume', { action: 'set', level: 101, intent })).isError).toBe(true);
    expect((await h.call('volume', { action: 'loud', intent })).isError).toBe(true);
    expect((await h.call('volume', { action: 'set', level: 2.5, intent })).isError).toBe(true);
    const r = await h.call('volume', { action: 'set', intent });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/needs a level/);
    expect(osa(h, VOLUME_JXA)).toEqual([]);
  });

  it('refused on a locked Mac (nothing changed)', async () => {
    const mac = standardMac();
    mac.status.locked = true;
    const h = await setupDesktop({ mac });
    const r = await h.call('volume', { action: 'up', intent });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/locked/);
    expect(osa(h, VOLUME_JXA)).toEqual([]);
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'volume', outcome: 'denied' });
  });

  it('counts toward the shared rate limit', async () => {
    const h = await setupDesktop({ overrides: { safety: { maxActionsPerMinute: 2 } } });
    await h.call('volume', { action: 'up', intent });
    await h.call('volume', { action: 'up', intent });
    const r = await h.call('volume', { action: 'up', intent });
    expect(r.isError).toBe(true);
    expect(osa(h, VOLUME_JXA)).toHaveLength(2);
  });

  it('not on macOS: explains instead of running anything', async () => {
    const mac = standardMac();
    mac.platform = 'linux';
    const h = await setupDesktop({ mac });
    const r = await h.call('volume', { action: 'up', intent });
    expect(textOf(r)).toMatch(/need macOS/);
    expect(h.mac.calls).toEqual([]);
  });
});

describe('media_control tool', () => {
  it('next → the player that is playing', async () => {
    const h = await setupDesktop();
    h.mac.players = { Spotify: { running: true, state: 'paused' }, Music: { running: true, state: 'playing' } };
    const r = await h.call('media_control', { action: 'next', intent });
    expect(textOf(r)).toBe('Apple Music: next done (now playing).');
    const acts = osa(h, PLAYERS_JXA).map((c) => c.args.slice(4));
    expect(acts).toEqual([['status'], ['next', 'Music']]);
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'media_control', outcome: 'ok', args: { action: 'next', player: 'Music' } });
  });

  it('pause with nothing playing (and no browser attached): does nothing and says why', async () => {
    const h = await setupDesktop();
    h.mac.players = { Spotify: { running: true, state: 'paused' }, Music: { running: false } };
    const r = await h.call('media_control', { action: 'pause', intent });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/^Nothing done: No YouTube Music tab found: Stephen isn't connected to Zen.*, and nothing is playing in Spotify or Music\. To start new music, use play_media\.$/);
    expect(osa(h, PLAYERS_JXA).map((c) => c.args[4])).toEqual(['status']);
  });

  it('never launches a player: a named one that is not running is reported, not opened', async () => {
    const h = await setupDesktop();
    const r = await h.call('media_control', { action: 'play', player: 'Spotify', intent });
    expect(textOf(r)).toMatch(/^Nothing done: Spotify isn't running/);
    expect(h.mac.opens()).toEqual([]);
    expect(osa(h, PLAYERS_JXA).map((c) => c.args[4])).toEqual(['status']);
  });

  it('toggle on Spotify', async () => {
    const h = await setupDesktop();
    h.mac.players.Spotify = { running: true, state: 'playing' };
    expect(textOf(await h.call('media_control', { action: 'toggle', intent }))).toBe('Spotify: play/pause done (now paused).');
  });

  it('Automation permission denied → says where to allow it', async () => {
    const h = await setupDesktop();
    h.mac.players.Spotify = { running: true, state: 'playing' };
    h.mac.playersFail = 'execution error: Not authorized to send Apple events to Spotify. (-1743)';
    const r = await h.call('media_control', { action: 'pause', intent });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Privacy & Security → Automation/);
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'media_control', outcome: 'error' });
  });

  it('refused on a locked Mac before even asking the players', async () => {
    const mac = standardMac();
    mac.status.locked = true;
    mac.ioreg = ioregXml({ locked: true });
    const h = await setupDesktop({ mac });
    const r = await h.call('media_control', { action: 'pause', intent });
    expect(r.isError).toBe(true);
    expect(osa(h, PLAYERS_JXA)).toEqual([]);
  });

  it('only Spotify and Music are accepted as players', async () => {
    const h = await setupDesktop();
    expect((await h.call('media_control', { action: 'play', player: 'Terminal', intent })).isError).toBe(true);
    expect(osa(h, PLAYERS_JXA)).toEqual([]);
  });
});
