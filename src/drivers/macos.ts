// Owned by worktree wt-drivers. Keep these export signatures (doctor in wt-server uses them).
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { ResolvedConfig } from '../types.js';
import { isExecutable } from './util.js';

export interface DevToolsActivePort {
  port: number;
  /** e.g. '/devtools/browser/<uuid>' */
  path: string;
  /** ws://127.0.0.1:<port><path> */
  wsEndpoint: string;
}

/** Reads `<userDataDir>/DevToolsActivePort` (line 1 port, line 2 path). null if missing/malformed. */
export async function readDevToolsActivePort(userDataDir: string): Promise<DevToolsActivePort | null> {
  let text: string;
  try {
    text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return null;
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const [rawPort, rawPath] = lines;
  if (!rawPort || !rawPath || !/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (port <= 0 || port > 65535) return null;
  if (!rawPath.startsWith('/') || /\s/.test(rawPath)) return null;
  return { port, path: rawPath, wsEndpoint: `ws://127.0.0.1:${port}${rawPath}` };
}

export interface FirefoxProfileEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDefault: boolean;
}

export interface ProfilesIni {
  profiles: FirefoxProfileEntry[];
  /** Absolute paths from [Install…] sections' Default= (preferred over Default=1). */
  installDefaults: string[];
}

function resolveIniPath(p: string, baseDir: string, isRelative: boolean | null): string {
  // profiles.ini always uses '/' in relative paths, even on Windows.
  if (isRelative === false || (isRelative === null && isAbsolute(p))) return normalize(p);
  if (isAbsolute(p)) return normalize(p);
  return normalize(join(baseDir, ...p.split('/')));
}

/** Parse a Firefox/Zen profiles.ini. `baseDir` resolves IsRelative=1 paths. */
export function parseProfilesIni(text: string, baseDir: string): ProfilesIni {
  type Section = { name: string; kv: Map<string, string> };
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = { name: sec[1]!.trim(), kv: new Map() };
      sections.push(cur);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0 || !cur) continue;
    cur.kv.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }

  const profiles: FirefoxProfileEntry[] = [];
  const installDefaults: string[] = [];
  for (const s of sections) {
    if (/^Profile\d+$/i.test(s.name)) {
      const p = s.kv.get('path');
      if (!p) continue;
      const rel = s.kv.get('isrelative');
      const isRelative = rel === undefined ? null : rel === '1';
      profiles.push({
        name: s.kv.get('name') ?? p,
        path: resolveIniPath(p, baseDir, isRelative),
        isDefault: s.kv.get('default') === '1',
      });
    } else if (/^Install/i.test(s.name)) {
      const d = s.kv.get('default');
      // An install's Default= is the profile's Path value: relative unless absolute.
      if (d) installDefaults.push(resolveIniPath(d, baseDir, null));
    }
  }
  return { profiles, installDefaults };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The real Zen profile to use: cfg.zen.profilePath, else profiles.ini install default, else Default=1 profile. null if none. */
export async function resolveZenRealProfile(cfg: ResolvedConfig): Promise<string | null> {
  if (cfg.zen.profilePath) return cfg.zen.profilePath;
  let text: string;
  try {
    text = await readFile(join(cfg.zen.zenAppSupportDir, 'profiles.ini'), 'utf8');
  } catch {
    return null;
  }
  const ini = parseProfilesIni(text, cfg.zen.zenAppSupportDir);
  const candidates: string[] = [...ini.installDefaults, ...ini.profiles.filter((p) => p.isDefault).map((p) => p.path)];
  if (ini.profiles.length === 1) candidates.push(ini.profiles[0]!.path);
  // Only return a profile that exists: launching Zen with a missing --profile dir would
  // silently create a fresh, empty profile (no logins), which is never what 'real' means.
  for (const c of candidates) {
    if (await isDir(c)) return c;
  }
  return null;
}

const ZEN_APP_NAMES = ['Zen', 'Zen Browser', 'Zen Twilight'];

/** First existing Zen binary among known macOS app names, or null. */
export async function findZenExecutable(): Promise<string | null> {
  const roots = ['/Applications', join(homedir(), 'Applications')];
  for (const root of roots) {
    for (const app of ZEN_APP_NAMES) {
      const bin = join(root, `${app}.app`, 'Contents', 'MacOS', 'zen');
      if (await isExecutable(bin)) return bin;
    }
  }
  return null;
}

const BIDI_LISTENING_RE = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/;

/** Extract the ws URL from a Gecko stderr line 'WebDriver BiDi listening on ws://127.0.0.1:PORT'. */
export function parseBidiListening(line: string): string | null {
  const m = BIDI_LISTENING_RE.exec(line);
  return m ? m[1]! : null;
}

/** True if a process with this exact name is running (pgrep -x). Injectable for tests. */
export async function isProcessRunning(processName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', processName], { timeout: 5000 }, (err) => {
      // exit 0 → match; exit 1 → no match; ENOENT (no pgrep) / other → treat as not running.
      resolve(!err);
    });
  });
}

/** `<binary> --version` output trimmed, or null on failure. */
export async function getBrowserVersion(executablePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executablePath, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout).trim();
      resolve(out || null);
    });
  });
}

// ───────────── Zen.app bundle (zen-launch, install-zen-launcher) ─────────────

/** Zen's CFBundleIdentifier, used when Info.plist can't be read. */
export const DEFAULT_ZEN_BUNDLE_ID = 'app.zen-browser.zen';

/** `/Applications/Zen.app/Contents/MacOS/zen` → `/Applications/Zen.app`; null if the binary isn't inside an .app bundle. */
export function appBundleOf(executablePath: string): string | null {
  const parts = normalize(executablePath).split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i]!.endsWith('.app') && parts[i + 1] === 'Contents') return parts.slice(0, i + 1).join('/') || null;
  }
  return null;
}

/** Value of `<key>name</key><string>value</string>` in an XML plist (Info.plist of an app); null if absent. */
export function plistString(xml: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<key>\\s*${esc}\\s*</key>\\s*<string>([^<]*)</string>`).exec(xml);
  if (!m) return null;
  const v = m[1]!
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
  return v || null;
}

export interface AppBundleInfo {
  bundleId: string | null;
  /** Absolute path of the app's .icns (CFBundleIconFile, else the first .icns in Resources); null if none. */
  iconPath: string | null;
}

/** Bundle id and icon of an .app (XML Info.plist only; a binary plist yields nulls and callers use defaults). */
export async function readAppBundleInfo(appPath: string): Promise<AppBundleInfo> {
  let xml = '';
  try {
    xml = await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8');
  } catch {
    // unreadable → defaults
  }
  const bundleId = xml.startsWith('bplist') ? null : plistString(xml, 'CFBundleIdentifier');
  const resources = join(appPath, 'Contents', 'Resources');
  let iconPath: string | null = null;
  const iconFile = xml.startsWith('bplist') ? null : plistString(xml, 'CFBundleIconFile');
  if (iconFile && !iconFile.includes('/')) {
    const candidate = join(resources, iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`);
    if (await isFile(candidate)) iconPath = candidate;
  }
  if (!iconPath) {
    try {
      const icns = (await readdir(resources)).filter((f) => f.endsWith('.icns')).sort();
      if (icns.length) iconPath = join(resources, icns[0]!);
    } catch {
      // no Resources dir
    }
  }
  return { bundleId, iconPath };
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** An AppleScript string literal for `s` (quotes and backslashes escaped). Rejects control characters. */
export function appleScriptString(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`refusing to put a control character into AppleScript: ${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** /usr/bin/osascript argv that asks an app (by bundle id) to quit normally — the same as ⌘Q, never a kill. */
export function osascriptQuitArgv(bundleId: string): string[] {
  return ['-e', `tell application id ${appleScriptString(bundleId)} to quit`];
}
