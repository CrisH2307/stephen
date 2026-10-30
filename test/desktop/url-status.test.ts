import { describe, expect, it } from 'vitest';
import { parseIoreg, parseStatusJson, queryStatus, STATUS_JXA } from '../../src/desktop/system.js';
import { parseOpenUrl, UrlDenied } from '../../src/desktop/url.js';
import { FakeMac, ioregXml } from './fakes.js';

describe('open_url scheme rules', () => {
  it('https opens; a bare host gets https://', () => {
    expect(parseOpenUrl('https://www.youtube.com')).toEqual({ href: 'https://www.youtube.com/', host: 'www.youtube.com', rule: 'https' });
    expect(parseOpenUrl('youtube.com')).toMatchObject({ href: 'https://youtube.com/', rule: 'https' });
    expect(parseOpenUrl('//example.com/x')).toMatchObject({ href: 'https://example.com/x', rule: 'https' });
    expect(parseOpenUrl('HTTPS://Example.COM/A')).toMatchObject({ href: 'https://example.com/A', rule: 'https' });
    expect(parseOpenUrl('example.com:8443/x')).toMatchObject({ href: 'https://example.com:8443/x', rule: 'https' });
    expect(parseOpenUrl('localhost:3000')).toMatchObject({ href: 'https://localhost:3000/', rule: 'https' });
  });

  it('http asks (classified, not refused)', () => {
    expect(parseOpenUrl('http://neverssl.com')).toMatchObject({ href: 'http://neverssl.com/', rule: 'http' });
  });

  it('spaces and quotes are percent-encoded into one URL', () => {
    expect(parseOpenUrl('https://example.com/a b"c\'d?q=x y').href).toBe("https://example.com/a%20b%22c'd?q=x%20y");
  });

  const denied = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/uuid',
    'about:blank',
    'about:config',
    'chrome://settings',
    'mailto:someone@example.com',
    'tel:5551234',
    'tel:+15551234567',
    'sms:+15551234567',
    'facetime:someone@example.com',
    'facetime-audio://x',
    'zoommtg://zoom.us/join?confno=1',
    'vscode://file/etc/passwd',
    'x-apple.systempreferences:com.apple.preference.security',
    'ssh://host',
    'ftp://example.com',
    'spotify:track:123',
    'slack://open',
    'view-source:https://example.com',
  ];
  it.each(denied)('%s is refused', (u) => {
    let err: unknown;
    try {
      parseOpenUrl(u);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UrlDenied);
    expect((err as UrlDenied).code).toBe('DENIED');
  });

  it('refuses credentials in the URL and invisible characters; rejects non-URLs', () => {
    expect(() => parseOpenUrl('https://www.google.com@evil.example/')).toThrow(UrlDenied);
    expect(() => parseOpenUrl('https://user:pw@example.com/')).toThrow(UrlDenied);
    expect(() => parseOpenUrl('https://exa‮mple.com')).toThrow(UrlDenied);
    expect(() => parseOpenUrl('https://example.com/\nx')).toThrow(UrlDenied);
    expect(() => parseOpenUrl('   ')).toThrow(/url is empty/);
    expect(() => parseOpenUrl('https://')).toThrow(/not a valid URL/);
  });
});

describe('desktop status parsing', () => {
  it('parses the JXA JSON', () => {
    const s = parseStatusJson(
      JSON.stringify({
        frontmost: { name: 'Zen', bundleId: 'app.zen-browser.zen' },
        apps: [
          { name: 'Finder', bundleId: 'com.apple.finder' },
          { name: 'Zen', bundleId: 'app.zen-browser.zen' },
          { name: null, bundleId: null },
        ],
        displays: 2,
        locked: false,
        secureInput: true,
      }),
    );
    expect(s).toEqual({
      frontmost: { name: 'Zen', bundleId: 'app.zen-browser.zen' },
      apps: [
        { name: 'Finder', bundleId: 'com.apple.finder' },
        { name: 'Zen', bundleId: 'app.zen-browser.zen' },
      ],
      displays: 2,
      locked: false,
      secureInput: true,
    });
  });

  it('unknown or malformed parts become null, never an exception', () => {
    expect(parseStatusJson('not json')).toEqual({ frontmost: null, apps: [], displays: null, locked: null, secureInput: null });
    expect(parseStatusJson('[1,2]')).toMatchObject({ apps: [], locked: null });
    const s = parseStatusJson(JSON.stringify({ frontmost: 'x', apps: 'y', displays: -1, locked: 'yes', secureInput: 1 }));
    expect(s).toEqual({ frontmost: null, apps: [], displays: null, locked: null, secureInput: null });
  });

  it('cleans app names (control/bidi characters, length) and drops malformed bundle ids', () => {
    const long = 'A'.repeat(300);
    const s = parseStatusJson(
      JSON.stringify({ apps: [{ name: 'Evil‮\nApp', bundleId: 'com.x; rm -rf' }, { name: long, bundleId: 'com.ok.app' }] }),
    );
    expect(s.apps[0]).toEqual({ name: 'Evil App', bundleId: null });
    expect(s.apps[1]!.name.length).toBe(100);
  });

  it('parses ioreg IOConsoleUsers (the console session only)', () => {
    expect(parseIoreg(ioregXml({}))).toEqual({ locked: false, secureInput: false });
    expect(parseIoreg(ioregXml({ locked: true }))).toEqual({ locked: true, secureInput: false });
    expect(parseIoreg(ioregXml({ securePid: 412 }))).toEqual({ locked: false, secureInput: true });
    expect(parseIoreg(ioregXml({ locked: true, onConsole: false }))).toEqual({ locked: null, secureInput: null });
    expect(parseIoreg('<plist/>')).toEqual({ locked: null, secureInput: null });
  });

  it('runs a fixed JXA script with osascript; ioreg only when the JXA could not tell', async () => {
    const m = new FakeMac();
    const s = await queryStatus(m.deps());
    expect(s).toMatchObject({ locked: false, secureInput: false, lockSource: 'jxa', displays: 1 });
    expect(m.calls).toEqual([{ file: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', STATUS_JXA] }]);
    expect(STATUS_JXA).toContain("ObjC.import('CoreGraphics')");
    expect(STATUS_JXA).toContain("ObjC.import('Carbon')");
    expect(STATUS_JXA).toContain('CGSSessionScreenIsLocked');
    expect(STATUS_JXA).toContain('IsSecureEventInputEnabled');
    expect(STATUS_JXA).not.toMatch(/windowTitle|kCGWindowName|title/i); // never window titles

    m.calls = [];
    m.status = { ...m.status, locked: null, secureInput: null };
    m.ioreg = ioregXml({ locked: true, securePid: 9 });
    expect(await queryStatus(m.deps())).toMatchObject({ locked: true, secureInput: true, lockSource: 'ioreg' });
    expect(m.calls.map((c) => c.file)).toEqual(['/usr/bin/osascript', '/usr/sbin/ioreg']);
    expect(m.calls[1]!.args).toEqual(['-n', 'Root', '-d1', '-a']);

    m.osascriptFails = true;
    m.ioreg = null;
    expect(await queryStatus(m.deps())).toMatchObject({ locked: null, secureInput: null, lockSource: 'unknown', apps: [] });
  });
});
