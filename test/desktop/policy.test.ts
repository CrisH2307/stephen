import { describe, expect, it } from 'vitest';
import {
  appVerdict,
  DEFAULT_ALLOW,
  HARD_BLOCK,
  hardBlockCategory,
  type PolicyContext,
  type ResolvedApp,
} from '../../src/desktop/apps.js';
import { parseDesktopConfig } from '../../src/desktop/config.js';
import { HOME, REPO } from './fakes.js';

const ctx = (over: Partial<PolicyContext['cfg']> = {}): PolicyContext => ({
  cfg: { ...parseDesktopConfig({}), ...over },
  ownDirs: [REPO, `${HOME}/.stephen`],
});

const app = (name: string, bundleId: string, path = `/Applications/${name}.app`, bundleNames = [name]): ResolvedApp => ({ name, bundleId, path, realPath: path, bundleNames });

describe('hard block', () => {
  // One or more real bundle ids per category in docs/STEPHEN.md.
  const cases: [string, string, string][] = [
    ['Terminal', 'com.apple.Terminal', 'terminal'],
    ['iTerm', 'com.googlecode.iterm2', 'terminal'],
    ['Warp', 'dev.warp.Warp-Stable', 'terminal'],
    ['Ghostty', 'com.mitchellh.ghostty', 'terminal'],
    ['kitty', 'net.kovidgoyal.kitty', 'terminal'],
    ['Alacritty', 'org.alacritty', 'terminal'],
    ['WezTerm', 'com.github.wez.wezterm', 'terminal'],
    ['Script Editor', 'com.apple.ScriptEditor2', 'script or automation tool'],
    ['Automator', 'com.apple.Automator', 'script or automation tool'],
    ['Shortcuts', 'com.apple.shortcuts', 'script or automation tool'],
    ['Some Applet', 'com.apple.ScriptEditor.id.some-applet', 'script or automation tool'],
    ['Some Workflow', 'com.apple.automator.my-workflow', 'script or automation tool'],
    ['Xcode', 'com.apple.dt.Xcode', 'IDE or code editor'],
    ['Visual Studio Code', 'com.microsoft.VSCode', 'IDE or code editor'],
    ['Cursor', 'com.todesktop.230313mzl4w4u92', 'IDE or code editor'],
    ['Zed', 'dev.zed.Zed', 'IDE or code editor'],
    ['IntelliJ IDEA', 'com.jetbrains.intellij', 'IDE or code editor'],
    ['System Settings', 'com.apple.systempreferences', 'system settings'],
    ['Keychain Access', 'com.apple.keychainaccess', 'password manager or keychain'],
    ['Passwords', 'com.apple.Passwords', 'password manager or keychain'],
    ['1Password', 'com.1password.1password', 'password manager or keychain'],
    ['1Password 7', 'com.agilebits.onepassword7', 'password manager or keychain'],
    ['Bitwarden', 'com.bitwarden.desktop', 'password manager or keychain'],
    ['KeePassXC', 'org.keepassxc.keepassxc', 'password manager or keychain'],
    ['Dashlane', 'com.dashlane.dashlanephonefinal', 'password manager or keychain'],
    ['LastPass', 'com.lastpass.LastPass', 'password manager or keychain'],
    ['Activity Monitor', 'com.apple.ActivityMonitor', 'system tool'],
    ['Disk Utility', 'com.apple.DiskUtility', 'system tool'],
    ['Installer', 'com.apple.installer', 'system tool'],
    ['Migration Assistant', 'com.apple.MigrateAssistant', 'system tool'],
    ['TeamViewer', 'com.teamviewer.TeamViewer', 'remote-control app'],
    ['AnyDesk', 'com.philandro.anydesk', 'remote-control app'],
    ['Screens 5', 'com.edovia.screens5.mac', 'remote-control app'],
    ['Claude', 'com.anthropic.claudefordesktop', 'Claude or Stephen itself'],
    ['Zen for Stephen', 'com.apple.ScriptEditor.id.zen-for-stephen', 'script or automation tool'],
  ];

  it.each(cases)('%s (%s) is denied as a %s', (name, id, category) => {
    expect(hardBlockCategory(id)).toBe(category);
    expect(hardBlockCategory(id.toUpperCase())).toBe(category); // ids compare case-insensitively
    const v = appVerdict(app(name, id), ctx());
    expect(v).toMatchObject({ verdict: 'deny', rule: 'hard-block' });
  });

  it.each(cases)('%s stays denied even when desktop.allowedApps lists it by name and id', (name, id) => {
    const v = appVerdict(app(name, id), ctx({ allowedApps: [name, id, id.toLowerCase()] }));
    expect(v).toMatchObject({ verdict: 'deny', rule: 'hard-block' });
    expect(v.verdict === 'deny' && v.reason).toContain('not even when it is listed in desktop.allowedApps');
  });

  it('an app renamed to look like an allowed one is judged by its real bundle id', () => {
    for (const [name, id] of [
      ['Spotify', 'com.apple.Terminal'],
      ['Google Chrome', 'com.googlecode.iterm2'],
      ['Music', 'com.1password.1password'],
    ] as const) {
      expect(appVerdict(app(name, id), ctx({ allowedApps: [name] })).verdict, name).toBe('deny');
    }
  });

  it("blocks Stephen's and Claude's own launchers by name, and anything inside Stephen's repo or home", () => {
    expect(appVerdict(app('Zen for Claude', 'com.example.whatever'), ctx()).verdict).toBe('deny');
    expect(appVerdict(app('Zen for Stephen', 'com.example.whatever'), ctx()).verdict).toBe('deny');
    expect(appVerdict(app('Helper', 'com.example.helper', `${REPO}/build/Helper.app`), ctx({ allowedApps: ['Helper'] }))).toMatchObject({
      verdict: 'deny',
      rule: 'hard-block',
    });
    const linked: ResolvedApp = { name: 'Helper', bundleId: 'com.example.helper', path: '/Applications/Helper.app', realPath: `${HOME}/.stephen/Helper.app` };
    expect(appVerdict(linked, ctx({ allowedApps: ['com.example.helper'] })).verdict).toBe('deny');
    // A sibling directory that merely shares the prefix is not "inside".
    expect(appVerdict(app('Other', 'com.example.other', `${REPO}-other/Other.app`), ctx()).verdict).toBe('confirm');
  });

  it('no default-allowed id is hard-blocked (the lists do not overlap)', () => {
    for (const id of Object.values(DEFAULT_ALLOW).flat()) expect(hardBlockCategory(id), id).toBeNull();
    expect(Object.keys(HARD_BLOCK).length).toBeGreaterThanOrEqual(8);
  });
});

describe('allow / block lists', () => {
  it('default allow-list opens by bundle id', () => {
    for (const id of ['com.spotify.client', 'com.apple.Music', 'app.zen-browser.zen', 'com.google.Chrome', 'com.apple.iCal', 'us.zoom.xos', 'com.tinyspeck.slackmacgap']) {
      expect(appVerdict(app('X', id), ctx())).toEqual({ verdict: 'allow', rule: 'default-allow' });
    }
  });

  it('the default allow-list never matches by name', () => {
    expect(appVerdict(app('Spotify', 'com.evil.spotify'), ctx())).toEqual({ verdict: 'confirm', rule: 'unlisted' });
  });

  it('desktop.allowedApps by name or bundle id', () => {
    expect(appVerdict(app('Steam', 'com.valvesoftware.steam'), ctx({ allowedApps: ['steam'] }))).toEqual({ verdict: 'allow', rule: 'config-allow' });
    expect(appVerdict(app('Steam', 'com.valvesoftware.steam'), ctx({ allowedApps: ['COM.valvesoftware.Steam'] }))).toEqual({ verdict: 'allow', rule: 'config-allow' });
    expect(appVerdict(app('Steam', 'com.valvesoftware.steam'), ctx())).toEqual({ verdict: 'confirm', rule: 'unlisted' });
  });

  it('desktop.blockedApps beats both allow-lists', () => {
    expect(appVerdict(app('Music', 'com.apple.Music'), ctx({ blockedApps: ['Music'] }))).toMatchObject({ verdict: 'deny', rule: 'config-block' });
    expect(appVerdict(app('Steam', 'com.valvesoftware.steam'), ctx({ allowedApps: ['Steam'], blockedApps: ['com.valvesoftware.steam'] }))).toMatchObject({
      verdict: 'deny',
      rule: 'config-block',
    });
  });
});

describe('desktop config', () => {
  it('defaults, and null means default', () => {
    expect(parseDesktopConfig(undefined)).toEqual({ enabled: true, allowedApps: [], blockedApps: [] });
    expect(parseDesktopConfig({ enabled: null, allowedApps: null })).toEqual({ enabled: true, allowedApps: [], blockedApps: [] });
    expect(parseDesktopConfig({ enabled: false, allowedApps: [' Steam '], blockedApps: ['com.apple.Music'] })).toEqual({
      enabled: false,
      allowedApps: ['Steam'],
      blockedApps: ['com.apple.Music'],
    });
  });

  it('rejects unknown keys and bad values with clear messages', () => {
    expect(() => parseDesktopConfig({ allowApps: ['x'] })).toThrow(/unknown key "desktop.allowApps" \(allowed: enabled, allowedApps, blockedApps\)/);
    expect(() => parseDesktopConfig({ enabled: 'yes' })).toThrow(/"desktop.enabled": must be true or false/);
    expect(() => parseDesktopConfig({ allowedApps: 'Steam' })).toThrow(/"desktop.allowedApps": must be a list of app names or bundle ids/);
    expect(() => parseDesktopConfig({ blockedApps: [''] })).toThrow(/"desktop.blockedApps.0": entries must be non-empty/);
    expect(() => parseDesktopConfig({ blockedApps: ['a\nb'] })).toThrow(/control characters/);
    expect(() => parseDesktopConfig({ enabled: 1, extra: true })).toThrow(/Invalid "desktop" section in config.json: .*extra.*enabled/s);
  });
});
