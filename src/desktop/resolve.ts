/**
 * Turn what the model asked for ("spotify", "Google Chrome", "chrome", "com.spotify.client") into a real
 * .app on disk and its bundle id (read from Contents/Info.plist — plutil when available, else the XML).
 */
import { join } from 'node:path';
import { plistString } from '../drivers/macos.js';
import { HubError } from '../errors.js';
import { normalizeAppName, type ResolvedApp } from './apps.js';
import { BIN, type DesktopDeps } from './system.js';

/** Searched in this order (one level, plus one level of plain sub-folders of the two Applications dirs). */
export function appSearchDirs(homeDir: string): string[] {
  return [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/Applications/Utilities',
    join(homeDir, 'Applications'),
  ];
}

/** Spoken/short names → display names to try (in order). Only a convenience; policy is on the bundle id. */
const ALIASES: Readonly<Record<string, string[]>> = {
  chrome: ['Google Chrome'],
  'google chrome': ['Google Chrome'],
  zen: ['Zen', 'Zen Browser'],
  'zen browser': ['Zen Browser', 'Zen'],
  vscode: ['Visual Studio Code'],
  'vs code': ['Visual Studio Code'],
  code: ['Visual Studio Code'],
  settings: ['System Settings'],
  'system preferences': ['System Settings', 'System Preferences'],
  itunes: ['Music'],
  'apple music': ['Music'],
  'apple tv': ['TV'],
  'apple podcasts': ['Podcasts'],
  imessage: ['Messages'],
  teams: ['Microsoft Teams', 'Microsoft Teams (work or school)', 'Microsoft Teams classic'],
  word: ['Microsoft Word'],
  excel: ['Microsoft Excel'],
  powerpoint: ['Microsoft PowerPoint'],
  outlook: ['Microsoft Outlook'],
  zoom: ['zoom.us'],
  '1password': ['1Password', '1Password 7'],
  passwords: ['Passwords'],
  keychain: ['Keychain Access'],
  terminal: ['Terminal'],
  iterm: ['iTerm'],
};

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9_-]+)+$/;

/** True if `s` looks like a reverse-DNS bundle id rather than a name. */
export function looksLikeBundleId(s: string): boolean {
  return BUNDLE_ID_RE.test(s.trim()) && !/\.app$/i.test(s.trim());
}

export interface AppCandidate {
  name: string;
  path: string;
  /** Index of the search dir it came from (lower = preferred on ties). */
  dirRank: number;
}

/** Every .app in the search dirs (deduplicated by path). */
export async function listApps(deps: DesktopDeps): Promise<AppCandidate[]> {
  const dirs = appSearchDirs(deps.homeDir);
  const out: AppCandidate[] = [];
  const seen = new Set<string>();
  const add = (dir: string, name: string, rank: number) => {
    const path = join(dir, name);
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ name: name.replace(/\.app$/i, ''), path, dirRank: rank });
  };
  for (const [rank, dir] of dirs.entries()) {
    const entries = await deps.fs.list(dir);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (/\.app$/i.test(e.name)) add(dir, e.name, rank);
    }
    // Vendor folders such as /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app (one level only).
    if (dir === '/Applications' || dir === join(deps.homeDir, 'Applications')) {
      for (const e of entries) {
        if (!e.isDir || e.name.startsWith('.') || /\.app$/i.test(e.name) || e.name === 'Utilities') continue;
        const sub = join(dir, e.name);
        for (const s of await deps.fs.list(sub)) {
          if (/\.app$/i.test(s.name) && !s.name.startsWith('.')) add(sub, s.name, rank);
        }
      }
    }
  }
  return out;
}

/** CFBundleIdentifier of an .app: `plutil -extract` (authoritative: top-level key), else the XML Info.plist. */
export async function readBundleId(deps: DesktopDeps, appPath: string): Promise<string | null> {
  const id = await readPlistKey(deps, appPath, 'CFBundleIdentifier');
  return id && BUNDLE_ID_RE.test(id) ? id : null;
}

/** A top-level string key of an .app's Info.plist: `plutil -extract <key> raw` (authoritative), else the XML. */
export async function readPlistKey(deps: DesktopDeps, appPath: string, key: string): Promise<string | null> {
  const plist = join(appPath, 'Contents', 'Info.plist');
  try {
    const r = await deps.execFile(BIN.plutil, ['-extract', key, 'raw', '-o', '-', plist], { timeoutMs: 5000 });
    const v = r.stdout.trim();
    if (v) return v;
  } catch {
    /* fall back to the XML */
  }
  const buf = await deps.fs.read(plist);
  if (!buf || buf.subarray(0, 8).toString('latin1').startsWith('bplist')) return null;
  return plistString(buf.toString('utf8'), key)?.trim() || null;
}

/**
 * The bundle's own names (CFBundleName, CFBundleDisplayName), cleaned and capped. These — not the .app's
 * file name — are what a NAME entry in desktop.allowedApps must match. App-controlled text.
 */
export async function readBundleNames(deps: DesktopDeps, appPath: string): Promise<string[]> {
  const out: string[] = [];
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const v = await readPlistKey(deps, appPath, key);
    // eslint-disable-next-line no-control-regex
    const c = v?.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Bundle id from an XML Info.plist without spawning anything (null for binary plists). Used to scan many apps. */
async function quickBundleId(deps: DesktopDeps, appPath: string): Promise<string | null> {
  const buf = await deps.fs.read(join(appPath, 'Contents', 'Info.plist'));
  if (!buf) return null;
  const head = buf.subarray(0, 8).toString('latin1');
  if (head.startsWith('bplist')) return null;
  const id = plistString(buf.toString('utf8'), 'CFBundleIdentifier');
  return id && BUNDLE_ID_RE.test(id) ? id : null;
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * How well `name` matches the query (lower is better; null = no match):
 *   0 exact (ignoring case, punctuation and ".app"), 1 alias, 2 whole-word match ("chrome" → "Google Chrome",
 *   "zen" → "Zen Browser"), 3 prefix / substring without spaces, 4 one or two typos.
 */
export function matchScore(query: string, name: string): number | null {
  const q = normalizeAppName(query);
  const n = normalizeAppName(name);
  if (!q || !n) return null;
  const qc = q.replace(/ /g, '');
  const nc = n.replace(/ /g, '');
  if (q === n || qc === nc) return 0;
  const aliases = ALIASES[q];
  if (aliases?.some((a) => normalizeAppName(a) === n)) return 1;
  if (` ${n} `.includes(` ${q} `)) return 2;
  if (qc.length >= 3 && nc.startsWith(qc)) return 3;
  if (qc.length >= 4 && nc.includes(qc)) return 3;
  if (qc.length >= 5 && levenshtein(qc, nc, qc.length >= 8 ? 2 : 1) <= (qc.length >= 8 ? 2 : 1)) return 4;
  return null;
}

async function resolved(deps: DesktopDeps, c: AppCandidate, bundleId: string): Promise<ResolvedApp> {
  return { name: c.name, path: c.path, realPath: await deps.fs.realpath(c.path), bundleId, bundleNames: await readBundleNames(deps, c.path) };
}

/**
 * Resolve an app name or bundle id to a real .app. Throws HubError('INVALID_ARG') with an actionable message
 * when nothing matches or the match has no readable bundle id.
 */
export async function resolveApp(deps: DesktopDeps, input: string): Promise<ResolvedApp> {
  const query = input.trim();
  const apps = await listApps(deps);
  if (looksLikeBundleId(query)) {
    const want = query.toLowerCase();
    const ids = await Promise.all(apps.map(async (c) => ({ c, id: await quickBundleId(deps, c.path) })));
    // Binary plists (no quick id) are checked with plutil only if no XML plist matched.
    const quick = ids.filter((x) => x.id?.toLowerCase() === want);
    const pool = quick.length ? quick.map((x) => x.c) : ids.filter((x) => x.id === null).map((x) => x.c);
    for (const c of pool) {
      const id = await readBundleId(deps, c.path);
      if (id && id.toLowerCase() === want) return resolved(deps, c, id);
    }
    // Not found by id: maybe it is a name with dots ("zoom.us") — fall through to name matching.
  }
  let best: { c: AppCandidate; score: number } | null = null;
  for (const c of apps) {
    const s = matchScore(query, c.name);
    if (s === null) continue;
    if (
      !best ||
      s < best.score ||
      (s === best.score &&
        (c.name.length < best.c.name.length ||
          (c.name.length === best.c.name.length && (c.dirRank < best.c.dirRank || (c.dirRank === best.c.dirRank && c.name < best.c.name)))))
    ) {
      best = { c, score: s };
    }
  }
  if (!best) {
    throw new HubError(
      'INVALID_ARG',
      `No app matching "${query.slice(0, 80)}" is installed (looked in ${appSearchDirs(deps.homeDir).join(', ')}). ` +
        'Check the name with the user. For a website, use open_url instead.',
    );
  }
  const id = await readBundleId(deps, best.c.path);
  if (!id) {
    throw new HubError(
      'INVALID_ARG',
      // No file name or path here: both are app-controlled text, and this message goes to the model unwrapped.
      `The app matching "${query.slice(0, 80)}" has no readable bundle id, so Stephen cannot check it against its safety lists and will not open it. Ask the user to open it themselves.`,
    );
  }
  return resolved(deps, best.c, id);
}
