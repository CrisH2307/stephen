/**
 * Which apps Stephen may open (docs/STEPHEN.md "Safety rules", docs/DESKTOP.md).
 *
 * Everything is decided on the app's BUNDLE ID, read from the real .app's Info.plist — renaming
 * Terminal.app to "Spotify.app" does not change its id, so it stays blocked. Order of precedence:
 *   1. built-in hard block (ids, id prefixes, a few names, apps inside Stephen's repo/home) → deny, NOT overridable
 *   2. desktop.blockedApps (names or ids)                                                 → deny
 *   3. built-in allow-list (ids only) + desktop.allowedApps (names or ids)                → open
 *      (the built-in list and NAME entries only for apps in a standard Applications dir; a name entry must
 *      also match the bundle's own CFBundleName / CFBundleDisplayName, not just its file name)
 *   4. anything else                                                                     → ask the human
 *
 * Messages refer to the app by BUNDLE ID only: display names come from the file system (app-controlled
 * text), so callers put them inside the untrusted wrapper.
 */
import type { DesktopConfig } from './config.js';

export interface BlockEntry {
  /** Exact bundle ids (compared case-insensitively). */
  ids?: string[];
  /** Bundle-id prefixes, for vendors that ship several ids (compared case-insensitively). */
  prefixes?: string[];
}

/**
 * Built-in hard block, by category. Opening any of these could hand out shell access, change security
 * settings, reveal secrets, give someone remote control, or let Claude drive itself.
 */
export const HARD_BLOCK: Readonly<Record<string, BlockEntry>> = {
  terminal: {
    ids: [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'com.mitchellh.ghostty',
      'net.kovidgoyal.kitty',
      'org.alacritty',
      'io.alacritty',
      'com.github.wez.wezterm',
      'co.zeit.hyper',
      'org.tabby',
      'com.raphaelamorim.rio',
      'com.termius-dmg.mac', // Termius (direct download)
      'com.termius.mac', // Termius (App Store)
      'dev.commandline.waveterm', // Wave
    ],
    prefixes: ['dev.warp.'], // dev.warp.Warp-Stable, -Preview, -Beta
  },
  'script or automation tool': {
    ids: [
      'com.apple.ScriptEditor2',
      'com.apple.Automator',
      'com.apple.shortcuts',
      'com.apple.shortcuts.mac-helper',
      'org.hammerspoon.Hammerspoon', // runs Lua with Accessibility rights
      'com.raycast.macos', // Raycast: script commands, extensions, AI
      'com.hegenberg.BetterTouchTool', // triggers run shell scripts / AppleScript
      'org.python.PythonLauncher', // opens .py files by running them
      'org.python.IDLE',
      'org.sveinbjorn.Platypus', // turns scripts into apps
    ],
    prefixes: [
      // Applets saved from Script Editor (incl. "Zen for Stephen" / "Zen for Claude") and Automator apps run scripts.
      'com.apple.ScriptEditor.id.',
      'com.apple.automator.',
      'com.latenightsw.ScriptDebugger', // ScriptDebugger7, ScriptDebugger8…
      'com.stairways.keyboardmaestro.', // .editor, .engine
      'com.runningwithcrayons.Alfred', // Alfred, Alfred-Preferences, Alfred-3…
      'com.red-sweater.fastscripts', // FastScripts / FastScripts3
    ],
  },
  'virtual machine or container app': {
    ids: [
      'com.docker.docker',
      'dev.kdrag0n.MacVirt', // OrbStack
      'com.utmapp.UTM',
      'com.vmware.fusion',
    ],
    prefixes: ['com.parallels.', 'org.virtualbox.app.'],
  },
  'AI agent app': {
    // ChatGPT (com.openai.chat), Codex (com.openai.codex) and future OpenAI apps: they can run code and drive the Mac.
    prefixes: ['com.openai.'],
  },
  'developer tool': {
    ids: [
      'com.github.GitHubClient', // GitHub Desktop
      'com.torusknot.SourceTreeNotMAS', // Sourcetree
      'com.DanPristupov.Fork',
      'com.axosoft.gitkraken',
      'co.gitup.mac',
      'com.postmanlabs.mac', // Postman
      'com.insomnia.app', // Insomnia
      'org.wireshark.Wireshark',
    ],
    prefixes: ['com.fournova.Tower', 'com.sublimemerge'], // Tower 2/3, Sublime Merge
  },
  'IDE or code editor': {
    ids: [
      'com.microsoft.VSCode',
      'com.microsoft.VSCodeInsiders',
      'com.vscodium',
      'com.todesktop.230313mzl4w4u92', // Cursor
      'com.exafunction.windsurf',
      'com.panic.Nova',
      'com.barebones.bbedit',
    ],
    // com.jetbrains.* covers every JetBrains IDE and the Toolbox; com.google.android.studio is Android Studio.
    prefixes: ['com.apple.dt.', 'dev.zed.', 'com.jetbrains.', 'com.sublimetext.', 'com.google.android.studio'],
  },
  'system settings': {
    ids: ['com.apple.systempreferences', 'com.apple.Settings'],
  },
  'password manager or keychain': {
    ids: [
      'com.apple.keychainaccess',
      'com.apple.Passwords',
      'com.bitwarden.desktop',
      'org.keepassxc.keepassxc',
      'in.sinew.Enpass-Desktop',
      'me.proton.pass.electron',
      'com.markmcguill.strongbox.mac',
    ],
    prefixes: ['com.1password.', 'com.agilebits.', 'com.dashlane.', 'com.lastpass.'],
  },
  'system tool': {
    ids: [
      'com.apple.ActivityMonitor',
      'com.apple.DiskUtility',
      'com.apple.installer',
      'com.apple.MigrateAssistant',
      'com.apple.DirectoryUtility',
      'com.apple.bootcampassistant',
      'com.apple.Console', // system and app logs (secrets, tokens)
      'com.apple.Ticket-Viewer', // Kerberos tickets
      'com.apple.archiveutility', // unpacks whatever archive it is handed
    ],
  },
  'remote-control app': {
    ids: ['com.philandro.anydesk', 'com.apple.ScreenSharing', 'com.microsoft.rdc.macos', 'com.carriez.rustdesk', 'tv.parsec.www'],
    prefixes: ['com.teamviewer.', 'com.edovia.screens', 'com.splashtop.'],
  },
  'Claude or Stephen itself': {
    ids: ['com.anthropic.claudefordesktop'],
    prefixes: ['com.anthropic.'],
  },
};

/** Display names that are always blocked (Stephen's own launchers and helpers), compared after normalization. */
export const HARD_BLOCK_NAMES: readonly string[] = ['Zen for Stephen', 'Zen for Claude', 'Stephen', 'browser-hub'];

/** Built-in allow-list: opens without asking. Matched by bundle id only (a name could be faked). */
export const DEFAULT_ALLOW: Readonly<Record<string, string[]>> = {
  browsers: [
    'app.zen-browser.zen',
    'com.google.Chrome',
    'com.apple.Safari',
    'org.mozilla.firefox',
    'com.brave.Browser',
    'company.thebrowser.Browser', // Arc
    'com.microsoft.edgemac',
    'com.operasoftware.Opera',
    'com.vivaldi.Vivaldi',
  ],
  media: ['com.apple.Music', 'com.spotify.client', 'com.apple.podcasts', 'com.apple.TV', 'com.apple.Photos', 'com.apple.Preview'],
  productivity: [
    'com.apple.Notes',
    'com.apple.reminders',
    'com.apple.iCal', // Calendar
    'com.apple.mail',
    'com.apple.MobileSMS', // Messages
    'com.apple.Maps',
    'com.apple.weather',
    'com.apple.clock',
    'com.apple.calculator',
  ],
  'chat and work': [
    'com.tinyspeck.slackmacgap', // Slack
    'com.hnc.Discord',
    'notion.id',
    'com.figma.Desktop',
    'us.zoom.xos',
    'com.microsoft.teams2',
    'com.microsoft.teams',
    'md.obsidian',
    'com.linear',
  ],
};

const lc = (s: string) => s.toLowerCase();
const HARD_IDS = new Map<string, string>();
const HARD_PREFIXES: [string, string][] = [];
for (const [category, e] of Object.entries(HARD_BLOCK)) {
  for (const id of e.ids ?? []) HARD_IDS.set(lc(id), category);
  for (const p of e.prefixes ?? []) HARD_PREFIXES.push([lc(p), category]);
}
const ALLOW_IDS = new Set(Object.values(DEFAULT_ALLOW).flat().map(lc));

/** Normalized display name for comparisons: NFKC, lowercase, ".app" dropped, punctuation → spaces, collapsed. */
export function normalizeAppName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.app$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const HARD_NAMES = new Set(HARD_BLOCK_NAMES.map(normalizeAppName));

/** Hard-block category of a bundle id, or null. */
export function hardBlockCategory(bundleId: string): string | null {
  const id = lc(bundleId);
  const exact = HARD_IDS.get(id);
  if (exact) return exact;
  for (const [p, category] of HARD_PREFIXES) if (id.startsWith(p)) return category;
  return null;
}

export function isDefaultAllowed(bundleId: string): boolean {
  return ALLOW_IDS.has(lc(bundleId));
}

/** A real, resolved app. */
export interface ResolvedApp {
  /** Display name (the .app's file name without ".app"). App-controlled text: never put it in a message unwrapped. */
  name: string;
  /** Absolute path of the .app as found. */
  path: string;
  /** Symlinks resolved. This is the exact bundle the policy checked and the one that is launched. */
  realPath: string;
  bundleId: string;
  /** The bundle's own CFBundleName / CFBundleDisplayName (when readable). App-controlled text. */
  bundleNames?: string[];
}

export type AppVerdict =
  | { verdict: 'deny'; rule: 'hard-block' | 'config-block'; reason: string }
  | { verdict: 'allow'; rule: 'default-allow' | 'config-allow' }
  | { verdict: 'confirm'; rule: 'unlisted' | 'non-standard-location' };

/**
 * The standard Applications folders (admin- or system-owned). Apps elsewhere (~/Applications, anything a
 * user-level process could write) are never opened without asking, whatever bundle id they claim.
 */
export const STANDARD_APP_DIRS: readonly string[] = ['/Applications', '/System/Applications'];

/** True if both the found path and the real (symlink-resolved) path are inside a standard Applications folder. */
export function inStandardAppDir(app: Pick<ResolvedApp, 'path' | 'realPath'>): boolean {
  const ok = (p: string) => STANDARD_APP_DIRS.some((d) => p.startsWith(`${d}/`)) && !p.split('/').includes('..');
  return ok(app.path) && ok(app.realPath);
}

/** Does a block-list entry (a display name or a bundle id) name this app? Matches the id, the file name or the bundle's own names. */
export function entryMatches(entry: string, app: Pick<ResolvedApp, 'name' | 'bundleId' | 'bundleNames'>): boolean {
  const e = entry.trim();
  if (!e) return false;
  if (lc(e) === lc(app.bundleId)) return true;
  const n = normalizeAppName(e);
  return [app.name, ...(app.bundleNames ?? [])].some((x) => normalizeAppName(x) === n);
}

/**
 * Does an allow-list entry name this app? A bundle id matches the id. A NAME must match the bundle's own
 * CFBundleName / CFBundleDisplayName (not just its file name) AND the app must be in a standard Applications folder.
 */
export function allowEntryMatches(entry: string, app: Pick<ResolvedApp, 'path' | 'realPath' | 'bundleId' | 'bundleNames'>): boolean {
  const e = entry.trim();
  if (!e) return false;
  if (lc(e) === lc(app.bundleId)) return true;
  if (!inStandardAppDir(app)) return false;
  const n = normalizeAppName(e);
  return !!n && (app.bundleNames ?? []).some((x) => normalizeAppName(x) === n);
}

/** True if `p` is `dir` or inside it. */
function inside(p: string, dir: string): boolean {
  if (!dir) return false;
  const d = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return p === d || p.startsWith(`${d}/`);
}

/** "a terminal", "an IDE or code editor", "an AI agent app". */
export function withArticle(category: string): string {
  return `${/^[aeiouAEIOU]/.test(category) ? 'an' : 'a'} ${category}`;
}

export interface PolicyContext {
  cfg: DesktopConfig;
  /** Real paths of Stephen's own repo/package dir and home (~/.stephen): apps inside them are Stephen's own helpers. */
  ownDirs: string[];
}

/**
 * The open_app policy. Pure. Denial reasons name the app by its bundle id only (a computed fact); the
 * display name is app-controlled text and is left to the caller to wrap.
 */
export function appVerdict(app: ResolvedApp, ctx: PolicyContext): AppVerdict {
  const id = app.bundleId;
  const category = hardBlockCategory(id);
  if (category) {
    return {
      verdict: 'deny',
      rule: 'hard-block',
      reason: `${id} is ${withArticle(category)}, which Stephen never opens — not even when it is listed in desktop.allowedApps.`,
    };
  }
  if ([app.name, ...(app.bundleNames ?? [])].some((n) => HARD_NAMES.has(normalizeAppName(n)))) {
    return { verdict: 'deny', rule: 'hard-block', reason: `${id} is one of Stephen's or Claude's own apps, which Stephen never opens.` };
  }
  if (ctx.ownDirs.some((d) => inside(app.realPath, d) || inside(app.path, d))) {
    return { verdict: 'deny', rule: 'hard-block', reason: `${id} lives inside Stephen's own folders, so Stephen never opens it.` };
  }
  if (ctx.cfg.blockedApps.some((e) => entryMatches(e, app))) {
    return { verdict: 'deny', rule: 'config-block', reason: `${id} is on the user's block list (desktop.blockedApps).` };
  }
  if (ctx.cfg.allowedApps.some((e) => allowEntryMatches(e, app))) return { verdict: 'allow', rule: 'config-allow' };
  if (isDefaultAllowed(id)) {
    // The built-in list trusts a bundle id; only an app in a standard Applications folder may claim one unasked.
    return inStandardAppDir(app) ? { verdict: 'allow', rule: 'default-allow' } : { verdict: 'confirm', rule: 'non-standard-location' };
  }
  return { verdict: 'confirm', rule: 'unlisted' };
}
