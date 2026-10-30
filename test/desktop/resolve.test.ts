import { describe, expect, it } from 'vitest';
import { looksLikeBundleId, matchScore, readBundleId, resolveApp } from '../../src/desktop/resolve.js';
import { FakeMac, HOME, infoPlist, standardMac } from './fakes.js';

describe('resolveApp', () => {
  it('matches display names case-insensitively, with or without ".app"', async () => {
    const m = standardMac();
    for (const q of ['Spotify', 'spotify', ' SPOTIFY ', 'Spotify.app']) {
      expect(await resolveApp(m.deps(), q), q).toMatchObject({ name: 'Spotify', path: '/Applications/Spotify.app', bundleId: 'com.spotify.client' });
    }
    expect((await resolveApp(m.deps(), 'system settings')).bundleId).toBe('com.apple.systempreferences');
    expect((await resolveApp(m.deps(), 'activitymonitor')).path).toBe('/System/Applications/Utilities/Activity Monitor.app');
  });

  it('light fuzziness: chrome → Google Chrome, zen → Zen Browser, typos', async () => {
    const m = standardMac();
    m.addApp('/Applications', 'Chrome Remote Desktop Host Uninstaller', 'com.google.chromeremotedesktop.uninstaller');
    expect((await resolveApp(m.deps(), 'chrome')).name).toBe('Google Chrome');
    // "Zen Browser" and "Zen for Stephen" both contain the word: the shorter (the browser) wins.
    expect((await resolveApp(m.deps(), 'zen')).name).toBe('Zen Browser');
    expect((await resolveApp(m.deps(), 'spotfy')).name).toBe('Spotify');
    expect((await resolveApp(m.deps(), 'visual studio')).name).toBe('Visual Studio Code');
    expect((await resolveApp(m.deps(), 'vscode')).name).toBe('Visual Studio Code');
  });

  it('prefers an exact "Zen" over "Zen Browser"', async () => {
    const m = standardMac();
    m.addApp('/Applications', 'Zen', 'app.zen-browser.zen');
    expect((await resolveApp(m.deps(), 'zen')).path).toBe('/Applications/Zen.app');
  });

  it('accepts a bundle id (case-insensitive), including apps with a binary Info.plist', async () => {
    const m = standardMac();
    m.addApp('/Applications', 'Binary App', 'com.example.binary', { binary: true });
    expect(await resolveApp(m.deps(), 'com.spotify.client')).toMatchObject({ name: 'Spotify', bundleId: 'com.spotify.client' });
    expect(await resolveApp(m.deps(), 'COM.SPOTIFY.CLIENT')).toMatchObject({ name: 'Spotify' });
    expect(await resolveApp(m.deps(), 'com.example.binary')).toMatchObject({ name: 'Binary App', bundleId: 'com.example.binary' });
  });

  it('a dotted name that is not a known bundle id falls back to name matching ("zoom.us")', async () => {
    const m = standardMac();
    m.addApp('/Applications', 'zoom.us', 'us.zoom.xos');
    expect(looksLikeBundleId('zoom.us')).toBe(true);
    expect(await resolveApp(m.deps(), 'zoom.us')).toMatchObject({ bundleId: 'us.zoom.xos' });
    expect(await resolveApp(m.deps(), 'zoom')).toMatchObject({ bundleId: 'us.zoom.xos' });
  });

  it('finds apps in ~/Applications and one level of vendor folders', async () => {
    const m = standardMac();
    const vendor = m.addFolder('/Applications', 'Adobe Photoshop 2026');
    m.addApp(vendor, 'Adobe Photoshop 2026', 'com.adobe.Photoshop');
    m.addApp(`${HOME}/Applications`, 'Obsidian', 'md.obsidian');
    expect((await resolveApp(m.deps(), 'photoshop')).path).toBe('/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app');
    expect((await resolveApp(m.deps(), 'obsidian')).path).toBe(`${HOME}/Applications/Obsidian.app`);
  });

  it('reads the bundle id with plutil (top-level key), falling back to the XML', async () => {
    const m = new FakeMac();
    // A nested dict mentions an allowed id first; plutil reads the real top-level key, and that is what counts.
    const path = m.addApp('/Applications', 'Spotify', 'com.apple.Terminal', {
      plist: infoPlist('com.apple.Terminal', '<key>Nested</key><dict><key>CFBundleIdentifier</key><string>com.spotify.client</string></dict>'),
    });
    m.plutilIds.set(`${path}/Contents/Info.plist`, 'com.apple.Terminal');
    expect(await readBundleId(m.deps(), path)).toBe('com.apple.Terminal');
    expect((await resolveApp(m.deps(), 'spotify')).bundleId).toBe('com.apple.Terminal');
    m.plutilWorks = false;
    const plain = m.addApp('/Applications', 'Plain', 'com.example.plain');
    expect(await readBundleId(m.deps(), plain)).toBe('com.example.plain');
    const bin = m.addApp('/Applications', 'Bin', 'com.example.bin', { binary: true });
    expect(await readBundleId(m.deps(), bin)).toBeNull(); // binary plist without plutil: unknown
    const calls = m.calls.filter((c) => c.file === '/usr/bin/plutil');
    expect(calls[0]!.args).toEqual(['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${path}/Contents/Info.plist`]);
  });

  it('refuses an app without a readable bundle id, and explains when nothing matches', async () => {
    const m = new FakeMac();
    m.plutilWorks = false;
    m.addApp('/Applications', 'Mystery', 'com.example.mystery', { binary: true });
    await expect(resolveApp(m.deps(), 'mystery')).rejects.toThrow(/has no readable bundle id/);
    await expect(resolveApp(m.deps(), 'youtube')).rejects.toThrow(/No app matching "youtube" is installed.*use open_url/);
  });

  it('matchScore tiers', () => {
    expect(matchScore('spotify', 'Spotify')).toBe(0);
    expect(matchScore('googlechrome', 'Google Chrome')).toBe(0);
    expect(matchScore('chrome', 'Google Chrome')).toBe(1);
    expect(matchScore('browser', 'Zen Browser')).toBe(2);
    expect(matchScore('spot', 'Spotify')).toBe(3);
    expect(matchScore('spotfy', 'Spotify')).toBe(4);
    expect(matchScore('xy', 'Spotify')).toBeNull();
    expect(matchScore('', 'Spotify')).toBeNull();
  });
});
