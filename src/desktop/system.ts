/**
 * Everything that touches macOS, behind injectable deps so the tests run on Linux:
 * process spawning (execFile with an argv array — never a shell), the file system, the platform.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run `file` with `args` (no shell). Rejects on a non-zero exit, a timeout or a spawn failure. */
export type ExecFileFn = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export interface DirEntry {
  name: string;
  /** A real directory (not a symlink). */
  isDir: boolean;
}

export interface DesktopFs {
  /** Entries of a directory; [] if it does not exist or can't be read. */
  list(dir: string): Promise<DirEntry[]>;
  /** File contents, or null if unreadable. */
  read(path: string): Promise<Buffer | null>;
  /** Symlinks resolved; the input itself if that fails. */
  realpath(path: string): Promise<string>;
  /** True if `path` is a directory (following symlinks). */
  isDir(path: string): Promise<boolean>;
}

export interface DesktopDeps {
  platform: NodeJS.Platform;
  execFile: ExecFileFn;
  fs: DesktopFs;
  /** The user's home directory (for ~/Applications). */
  homeDir: string;
  /** Stephen's own package/repo directory (apps inside it are never opened). */
  repoDir: string;
}

/** Absolute paths: a PATH change can't swap in another binary. */
export const BIN = {
  open: '/usr/bin/open',
  osascript: '/usr/bin/osascript',
  plutil: '/usr/bin/plutil',
  ioreg: '/usr/sbin/ioreg',
  codesign: '/usr/bin/codesign',
} as const;

const CODESIGN_TIMEOUT_MS = 20_000;

/**
 * `codesign --verify --deep --strict <app>`: true when the bundle's code signature is intact (any valid
 * signature, incl. ad-hoc — this catches tampered or unsigned bundles, not WHO signed it; checking the Team ID
 * is phase 2). A failure, a timeout or a missing codesign all count as "not verified".
 */
export async function verifyCodeSignature(deps: DesktopDeps, appPath: string): Promise<{ ok: boolean; detail: string }> {
  if (!appPath.startsWith('/')) return { ok: false, detail: 'not an absolute path' };
  try {
    await deps.execFile(BIN.codesign, ['--verify', '--deep', '--strict', appPath], { timeoutMs: CODESIGN_TIMEOUT_MS });
    return { ok: true, detail: '' };
  } catch (e) {
    return { ok: false, detail: execErrorText(e) || 'codesign failed' };
  }
}

export const nodeExecFileFn: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', shell: false, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export const nodeFs: DesktopFs = {
  async list(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  async read(path) {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  },
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  },
  async isDir(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Stephen's package root: two levels above this file (src/desktop or dist/desktop). */
export function defaultRepoDir(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
}

export function defaultDesktopDeps(): DesktopDeps {
  return { platform: process.platform, execFile: nodeExecFileFn, fs: nodeFs, homeDir: homedir(), repoDir: defaultRepoDir() };
}

/** First line of an exec error's stderr (or message), control characters removed, capped. */
export function execErrorText(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  const raw = typeof stderr === 'string' && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e);
  // eslint-disable-next-line no-control-regex
  const line = (raw.split('\n').find((l) => l.trim()) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// ───────────────────────────── desktop status ─────────────────────────────

/**
 * FIXED JXA script (no interpolation, ever). Prints one JSON object:
 *   frontmost   NSWorkspace.frontmostApplication (name + bundle id)
 *   apps        NSWorkspace.runningApplications with activationPolicy Regular (0) = apps with a Dock icon
 *   displays    NSScreen.screens.count
 *   locked      CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"] (key absent = unlocked; no session = null)
 *   secureInput IsSecureEventInputEnabled() (Carbon/HIToolbox)
 * Each part is in its own try so one failure leaves the others (null = unknown). No window titles.
 * None of this needs a TCC grant (no Accessibility, Screen Recording or Automation).
 */
export const STATUS_JXA = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('Carbon');
function str(v) { try { if (!v || (v.isNil && v.isNil())) return null; var u = ObjC.unwrap(v); return typeof u === 'string' ? u : null; } catch (e) { return null; } }
var out = { frontmost: null, apps: [], displays: null, locked: null, secureInput: null };
try {
  var ws = $.NSWorkspace.sharedWorkspace;
  var f = ws.frontmostApplication;
  if (f && !f.isNil()) out.frontmost = { name: str(f.localizedName), bundleId: str(f.bundleIdentifier) };
  var list = ws.runningApplications;
  var n = list.count;
  for (var i = 0; i < n; i++) {
    var a = list.objectAtIndex(i);
    if (Number(a.activationPolicy) === 0) out.apps.push({ name: str(a.localizedName), bundleId: str(a.bundleIdentifier) });
  }
} catch (e) {}
try { out.displays = Number($.NSScreen.screens.count); } catch (e) {}
try {
  var ref = $.CGSessionCopyCurrentDictionary();
  if (ref) {
    var dict = ObjC.castRefToObject(ref);
    var v = dict.objectForKey('CGSSessionScreenIsLocked');
    out.locked = (v && !v.isNil()) ? !!v.boolValue : false;
  }
} catch (e) {}
try { out.secureInput = !!$.IsSecureEventInputEnabled(); } catch (e) {}
JSON.stringify(out);
`.trim();

export interface RunningApp {
  name: string;
  bundleId: string | null;
}

export interface DesktopStatus {
  frontmost: RunningApp | null;
  /** Regular GUI apps (Dock icon), in launch order. */
  apps: RunningApp[];
  displays: number | null;
  /** null = could not be determined. */
  locked: boolean | null;
  secureInput: boolean | null;
  /** How `locked` / `secureInput` were determined ('jxa' | 'ioreg' | 'unknown'). */
  lockSource: 'jxa' | 'ioreg' | 'unknown';
}

const MAX_NAME = 100;

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1)}…` : s;
}

function cleanId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v) ? v : null;
}

function app(v: unknown): RunningApp | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = cleanName(o.name);
  const bundleId = cleanId(o.bundleId);
  if (!name && !bundleId) return null;
  return { name: name ?? bundleId ?? '?', bundleId };
}

/** Parse the JXA output. Anything malformed becomes null/[] (unknown), never an exception. */
export function parseStatusJson(stdout: string): Omit<DesktopStatus, 'lockSource'> {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(stdout.trim());
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    /* unknown */
  }
  const apps = Array.isArray(o.apps) ? o.apps.map(app).filter((a): a is RunningApp => a !== null) : [];
  const n = o.displays;
  return {
    frontmost: app(o.frontmost),
    apps,
    displays: typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 100 ? n : null,
    locked: typeof o.locked === 'boolean' ? o.locked : null,
    secureInput: typeof o.secureInput === 'boolean' ? o.secureInput : null,
  };
}

/**
 * Parse `ioreg -n Root -d1 -a` (XML plist of the IORegistry root). Its IOConsoleUsers array has one dict per
 * login session; the one with kCGSSessionOnConsoleKey = true is the user at the screen. In it,
 * CGSSessionScreenIsLocked = true while the screen is locked, and kCGSSessionSecureInputPID is present while
 * some process has secure keyboard input on. No console session → both unknown.
 */
export function parseIoreg(xml: string): { locked: boolean | null; secureInput: boolean | null } {
  const start = xml.indexOf('<key>IOConsoleUsers</key>');
  if (start < 0) return { locked: null, secureInput: null };
  const rest = xml.slice(start);
  const arrEnd = rest.indexOf('</array>');
  const arr = arrEnd >= 0 ? rest.slice(0, arrEnd) : rest;
  const sessions = arr.split('<dict>').slice(1);
  const onConsole = sessions.find((s) => /<key>kCGSSessionOnConsoleKey<\/key>\s*<true\s*\/>/.test(s));
  if (!onConsole) return { locked: null, secureInput: null };
  return {
    locked: /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(onConsole),
    secureInput: /<key>kCGSSessionSecureInputPID<\/key>\s*<integer>\s*[1-9]\d*\s*<\/integer>/.test(onConsole),
  };
}

const STATUS_TIMEOUT_MS = 10_000;

/** Query the desktop state: the JXA script, plus ioreg when the JXA could not tell lock / secure-input state. */
export async function queryStatus(deps: DesktopDeps): Promise<DesktopStatus> {
  let base: Omit<DesktopStatus, 'lockSource'> = { frontmost: null, apps: [], displays: null, locked: null, secureInput: null };
  try {
    const r = await deps.execFile(BIN.osascript, ['-l', 'JavaScript', '-e', STATUS_JXA], { timeoutMs: STATUS_TIMEOUT_MS });
    base = parseStatusJson(r.stdout);
  } catch {
    /* fall back below */
  }
  let lockSource: DesktopStatus['lockSource'] = base.locked !== null ? 'jxa' : 'unknown';
  if (base.locked === null || base.secureInput === null) {
    try {
      const r = await deps.execFile(BIN.ioreg, ['-n', 'Root', '-d1', '-a'], { timeoutMs: STATUS_TIMEOUT_MS });
      const io = parseIoreg(r.stdout);
      if (base.locked === null && io.locked !== null) {
        base.locked = io.locked;
        lockSource = 'ioreg';
      }
      if (base.secureInput === null) base.secureInput = io.secureInput;
    } catch {
      /* stays unknown */
    }
  }
  return { ...base, lockSource };
}
