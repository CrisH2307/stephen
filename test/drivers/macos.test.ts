import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ZEN_BUNDLE_ID,
  appBundleOf,
  appleScriptString,
  getBrowserVersion,
  isProcessRunning,
  osascriptQuitArgv,
  parseBidiListening,
  plistString,
  readAppBundleInfo,
  parseProfilesIni,
  readDevToolsActivePort,
  resolveZenRealProfile,
} from '../../src/drivers/macos.js';
import { probeWsEndpoint } from '../../src/drivers/util.js';
import { type TestConfig, makeTestConfig } from './helpers.js';

let tc: TestConfig;
afterEach(() => tc?.cleanup());

describe('readDevToolsActivePort', () => {
  it('parses port + path into a loopback ws endpoint', async () => {
    tc = makeTestConfig();
    writeFileSync(join(tc.home, 'DevToolsActivePort'), '9222\n/devtools/browser/abc-123\n');
    expect(await readDevToolsActivePort(tc.home)).toEqual({
      port: 9222,
      path: '/devtools/browser/abc-123',
      wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
    });
  });

  it('tolerates CRLF and surrounding blank lines', async () => {
    tc = makeTestConfig();
    writeFileSync(join(tc.home, 'DevToolsActivePort'), '\r\n 41234 \r\n/devtools/browser/x\r\n\r\n');
    expect((await readDevToolsActivePort(tc.home))?.wsEndpoint).toBe('ws://127.0.0.1:41234/devtools/browser/x');
  });

  it('returns null when missing', async () => {
    tc = makeTestConfig();
    expect(await readDevToolsActivePort(join(tc.home, 'nope'))).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['port only', '9222\n'],
    ['non-numeric port', 'abc\n/devtools/browser/x\n'],
    ['port 0', '0\n/devtools/browser/x\n'],
    ['port too large', '70000\n/devtools/browser/x\n'],
    ['relative path', '9222\ndevtools/browser/x\n'],
    ['path with spaces', '9222\n/devtools/browser/x y\n'],
  ])('returns null when malformed (%s)', async (_label, content) => {
    tc = makeTestConfig();
    writeFileSync(join(tc.home, 'DevToolsActivePort'), content);
    expect(await readDevToolsActivePort(tc.home)).toBeNull();
  });
});

describe('parseProfilesIni', () => {
  const base = '/Users/me/Library/Application Support/zen';

  it('resolves relative and absolute profile paths, Default=1 and install defaults', () => {
    const ini = [
      '[General]',
      'StartWithLastProfile=1',
      'Version=2',
      '',
      '[Profile1]',
      'Name=Default (release)',
      'IsRelative=1',
      'Path=Profiles/abc.Default (release)',
      'Default=1',
      '',
      '[Profile0]',
      'Name=Work',
      'IsRelative=0',
      'Path=/Volumes/data/zen-work',
      '',
      '[Install6ED35B3CA1B5D9A]',
      'Default=Profiles/abc.Default (release)',
      'Locked=1',
    ].join('\r\n');
    const parsed = parseProfilesIni(ini, base);
    expect(parsed.profiles).toEqual([
      { name: 'Default (release)', path: join(base, 'Profiles', 'abc.Default (release)'), isDefault: true },
      { name: 'Work', path: '/Volumes/data/zen-work', isDefault: false },
    ]);
    expect(parsed.installDefaults).toEqual([join(base, 'Profiles', 'abc.Default (release)')]);
  });

  it('keeps absolute install defaults absolute and ignores comments/garbage', () => {
    const ini = '﻿; comment\n# another\n[Install1]\nDefault=/abs/profile\n[Profile0]\nPath=Profiles/x\nnot a kv line\n';
    const parsed = parseProfilesIni(ini, base);
    expect(parsed.installDefaults).toEqual(['/abs/profile']);
    expect(parsed.profiles).toEqual([{ name: 'Profiles/x', path: join(base, 'Profiles', 'x'), isDefault: false }]);
  });

  it('returns empty lists for empty input', () => {
    expect(parseProfilesIni('', base)).toEqual({ profiles: [], installDefaults: [] });
  });
});

describe('resolveZenRealProfile', () => {
  function setup(ini: string, dirs: string[]): void {
    const sup = tc.cfg.zen.zenAppSupportDir;
    mkdirSync(sup, { recursive: true });
    writeFileSync(join(sup, 'profiles.ini'), ini);
    for (const d of dirs) mkdirSync(join(sup, d), { recursive: true });
  }

  it('prefers cfg.zen.profilePath', async () => {
    tc = makeTestConfig({ zen: { profilePath: '/explicit/profile' } });
    expect(await resolveZenRealProfile(tc.cfg)).toBe('/explicit/profile');
  });

  it('prefers the [Install] default over Default=1', async () => {
    tc = makeTestConfig();
    setup(
      '[Profile0]\nName=old\nIsRelative=1\nPath=Profiles/old\nDefault=1\n\n[Profile1]\nName=new\nIsRelative=1\nPath=Profiles/new\n\n[InstallABC]\nDefault=Profiles/new\n',
      ['Profiles/old', 'Profiles/new'],
    );
    expect(await resolveZenRealProfile(tc.cfg)).toBe(join(tc.cfg.zen.zenAppSupportDir, 'Profiles', 'new'));
  });

  it('falls back to Default=1 when the install default does not exist', async () => {
    tc = makeTestConfig();
    setup('[Profile0]\nIsRelative=1\nPath=Profiles/old\nDefault=1\n[InstallABC]\nDefault=Profiles/gone\n', ['Profiles/old']);
    expect(await resolveZenRealProfile(tc.cfg)).toBe(join(tc.cfg.zen.zenAppSupportDir, 'Profiles', 'old'));
  });

  it('uses the only profile when nothing is marked default', async () => {
    tc = makeTestConfig();
    setup('[Profile0]\nIsRelative=1\nPath=Profiles/only\n', ['Profiles/only']);
    expect(await resolveZenRealProfile(tc.cfg)).toBe(join(tc.cfg.zen.zenAppSupportDir, 'Profiles', 'only'));
  });

  it('returns null with several undecided profiles, or no profiles.ini', async () => {
    tc = makeTestConfig();
    expect(await resolveZenRealProfile(tc.cfg)).toBeNull();
    setup('[Profile0]\nIsRelative=1\nPath=Profiles/a\n[Profile1]\nIsRelative=1\nPath=Profiles/b\n', ['Profiles/a', 'Profiles/b']);
    expect(await resolveZenRealProfile(tc.cfg)).toBeNull();
  });
});

describe('parseBidiListening', () => {
  it('extracts the ws url', () => {
    expect(parseBidiListening('WebDriver BiDi listening on ws://127.0.0.1:46249')).toBe('ws://127.0.0.1:46249');
    expect(parseBidiListening('1730000000000\tRemoteAgent\tINFO\tWebDriver BiDi listening on ws://127.0.0.1:9222\r')).toBe(
      'ws://127.0.0.1:9222',
    );
  });
  it('ignores other lines', () => {
    expect(parseBidiListening('DevTools listening on ws://127.0.0.1:9222/devtools/browser/x')).toBeNull();
    expect(parseBidiListening('')).toBeNull();
  });
});

describe('process helpers', () => {
  it('isProcessRunning is false for a name that cannot exist', async () => {
    expect(await isProcessRunning('bh-no-such-process-xyz')).toBe(false);
  });

  it('isProcessRunning finds a running process by exact name', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await isProcessRunning('sleep')).toBe(true);
      expect(await isProcessRunning('slee')).toBe(false); // -x: exact match only
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('getBrowserVersion returns trimmed --version output, null on failure', async () => {
    expect(await getBrowserVersion(process.execPath)).toBe(process.version);
    expect(await getBrowserVersion('/definitely/not/a/binary')).toBeNull();
  });
});

describe('Zen.app bundle helpers', () => {
  it('appBundleOf finds the .app around the binary', () => {
    expect(appBundleOf('/Applications/Zen.app/Contents/MacOS/zen')).toBe('/Applications/Zen.app');
    expect(appBundleOf('/Users/me/Applications/Zen Twilight.app/Contents/MacOS/zen')).toBe('/Users/me/Applications/Zen Twilight.app');
    expect(appBundleOf('/opt/zen/zen')).toBeNull();
  });

  it('plistString reads XML plist strings (entities decoded)', () => {
    const xml = '<dict><key>CFBundleIdentifier</key>\n\t<string>app.zen-browser.zen</string><key>CFBundleName</key><string>A &amp; B</string></dict>';
    expect(plistString(xml, 'CFBundleIdentifier')).toBe('app.zen-browser.zen');
    expect(plistString(xml, 'CFBundleName')).toBe('A & B');
    expect(plistString(xml, 'Missing')).toBeNull();
  });

  it('readAppBundleInfo: bundle id + icon from Info.plist; falls back to the first .icns; tolerates binary plists', async () => {
    tc = makeTestConfig();
    const app = join(tc.home, 'Zen.app');
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Resources', 'b.icns'), 'x');
    writeFileSync(join(app, 'Contents', 'Resources', 'zen.icns'), 'x');
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<key>CFBundleIdentifier</key><string>app.zen</string><key>CFBundleIconFile</key><string>zen</string>');
    expect(await readAppBundleInfo(app)).toEqual({ bundleId: 'app.zen', iconPath: join(app, 'Contents', 'Resources', 'zen.icns') });
    writeFileSync(join(app, 'Contents', 'Info.plist'), 'bplist00\u0000binary');
    expect(await readAppBundleInfo(app)).toEqual({ bundleId: null, iconPath: join(app, 'Contents', 'Resources', 'b.icns') });
    expect(await readAppBundleInfo(join(tc.home, 'missing.app'))).toEqual({ bundleId: null, iconPath: null });
  });

  it('appleScriptString escapes quotes and backslashes and refuses control characters', () => {
    expect(appleScriptString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(() => appleScriptString('a\nb')).toThrow(/control character/);
    expect(osascriptQuitArgv(DEFAULT_ZEN_BUNDLE_ID)).toEqual(['-e', 'tell application id "app.zen-browser.zen" to quit']);
    // a hostile bundle id stays inside the string literal
    expect(osascriptQuitArgv('x" to quit')).toEqual(['-e', 'tell application id "x\\" to quit" to quit']);
    expect(() => osascriptQuitArgv('x\ntell app "Finder" to quit')).toThrow(/control character/);
  });
});

describe('probeWsEndpoint', () => {
  it('true when something listens on the loopback port, false otherwise; never opens a WebSocket', async () => {
    const net = await import('node:net');
    const seen: string[] = [];
    const server = net.createServer((sock) => {
      sock.once('data', (d) => seen.push(d.toString()));
      sock.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    expect(await probeWsEndpoint(`ws://127.0.0.1:${port}/session`)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probeWsEndpoint(`ws://127.0.0.1:${port}/session`)).toBe(false);
    expect(await probeWsEndpoint('ws://example.com:80/session')).toBe(false); // loopback only
    expect(await probeWsEndpoint('not a url')).toBe(false);
    expect(seen).toEqual([]);
  });
});
