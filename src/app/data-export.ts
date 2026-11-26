/**
 * R20: `stephen data export <folder>` and `stephen data import <folder>`: settings, memory, timers and (with
 * --history) conversation history, to move them between Macs or versions.
 *
 * Privacy: the export is personal data. The folder is new and 0700, every file 0600. Keychain items and `.env` are
 * never read here, and a config.json with a secret-looking key is refused, not copied. Memory suggestions, logs,
 * telemetry, incidents, jobs and recordings are not included.
 * Safety: import only runs while Stephen is stopped, never follows a link (O_NOFOLLOW, lstat), parses every file with
 * the store's own parser and refuses the whole import if any file or item does not read cleanly, so nothing changes.
 * It writes the parsed values with the stores' atomic 0600 writer, never a byte copy.
 */
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { parseHistoryEntry } from '../history/store.js';
import { ensurePrivateDir, readPrivateRegularFile, writePrivateFileAtomicSync, writePrivateJsonFileSync } from '../lib/fs.js';
import { MEMORY_FILE, parseMemoryFile } from '../memory/store.js';
import { parseTimerItems, TIMERS_FILE } from '../timers/store.js';

export const EXPORT_FORMAT = 1;
const MANIFEST = 'manifest.json';
const CONFIG = 'config.json';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export const WHAT_IS_INSIDE =
  'Your Stephen settings (config.json), what you asked Stephen to remember (memory.json), your timers and reminders ' +
  '(timers.json), and, if you chose it, your conversation history (history/). No passwords, keys or tokens: those stay ' +
  'in the macOS Keychain. Keep this folder private, like your diary.';

export interface MoveDeps {
  /** The Stephen home folder (cfg.home). */
  home: string;
  /** Where Stephen reads config.json (configFilePath()). */
  configPath: string;
  version: string;
  now: () => Date;
  /** Secret-looking key names in the config file at that path (cli.ts configUnknownKeys filtered). */
  configSecretKeys: (configPath: string) => Promise<string[]>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** One file in the move: its name in the export folder and its parsed, re-serialized text. */
interface Part {
  name: string;
  text: string;
  what: string;
}

type Read = { parts: Part[] } | { error: string };

/** 'link' for a symlink, 'missing', or 'ok'. lstat: a link is never followed. */
function kindOf(path: string): 'link' | 'missing' | 'ok' {
  try {
    return lstatSync(path).isSymbolicLink() ? 'link' : 'ok';
  } catch {
    return 'missing';
  }
}

/** Read a JSON file that must be a plain regular file (never a link). null: missing. */
function readJson(path: string): { value: unknown } | { error: string } | null {
  const k = kindOf(path);
  if (k === 'missing') return null;
  if (k === 'link') return { error: 'is a link' };
  const text = readPrivateRegularFile(path, MAX_FILE_BYTES);
  if (text === null) return { error: 'is not a plain file, or is too large' };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: 'is not valid JSON' };
  }
}

/**
 * Read config, memory, timers and history from `src` (a Stephen home, or an export folder) strictly: each file with
 * its store's parser, and any item the parser would drop refuses the whole read. Pure apart from reads.
 */
async function readParts(src: { config: string; dir: string }, history: boolean, forExport: boolean, d: MoveDeps): Promise<Read> {
  const parts: Part[] = [];
  const bad = (name: string, why: string): Read => ({ error: `${name} ${why}` });

  const cfg = readJson(src.config);
  if (cfg && 'error' in cfg) return bad(CONFIG, cfg.error);
  if (cfg) {
    if (!cfg.value || typeof cfg.value !== 'object' || Array.isArray(cfg.value)) return bad(CONFIG, 'is not a settings object');
    // "home" names a folder on this Mac: the export leaves it out (and says so); an import never takes it.
    if ('home' in cfg.value) {
      if (!forExport) return bad(CONFIG, 'sets "home" (a folder on the other Mac); remove that line first');
      const { home: _home, ...rest } = cfg.value as Record<string, unknown>;
      cfg.value = rest;
      parts.push({ name: '', text: '', what: 'settings: your "home" folder setting was left out (it names a folder on this Mac)' });
    }
    try {
      loadConfig(undefined, { ...process.env, STEPHEN_CONFIG: src.config });
    } catch (e) {
      return bad(CONFIG, `does not load: ${(e as Error).message}`);
    }
    const secrets = await d.configSecretKeys(src.config);
    if (secrets.length) return bad(CONFIG, 'has a key whose name looks like a secret (name not shown). Secrets belong in the Keychain: remove it first');
    parts.push({ name: CONFIG, text: `${JSON.stringify(cfg.value, null, 2)}\n`, what: 'settings' });
  }

  const mem = readJson(join(src.dir, MEMORY_FILE));
  if (mem && 'error' in mem) return bad(MEMORY_FILE, mem.error);
  if (mem) {
    const parsed = parseMemoryFile(mem.value);
    const raw = (mem.value as { items?: unknown[] } | null)?.items;
    if (!parsed || !Array.isArray(raw) || parsed.items.length !== raw.length) return bad(MEMORY_FILE, 'has items Stephen cannot read');
    parts.push({ name: MEMORY_FILE, text: `${JSON.stringify(parsed)}\n`, what: `${parsed.items.length} memory item${parsed.items.length === 1 ? '' : 's'}` });
  }

  const tim = readJson(join(src.dir, TIMERS_FILE));
  if (tim && 'error' in tim) return bad(TIMERS_FILE, tim.error);
  if (tim) {
    const items = parseTimerItems(tim.value);
    const raw = (tim.value as { items?: unknown[] } | null)?.items;
    if (!Array.isArray(raw) || items.length !== raw.length) return bad(TIMERS_FILE, 'has items Stephen cannot read');
    parts.push({ name: TIMERS_FILE, text: `${JSON.stringify({ version: 1, items })}\n`, what: `${items.length} timer${items.length === 1 ? '' : 's'} and reminders` });
  }

  if (history) {
    const dir = join(src.dir, 'history');
    if (kindOf(dir) === 'link') return bad('history/', 'is a link');
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => !n.startsWith('.'));
    } catch {
      // no history folder
    }
    let entries = 0;
    for (const n of names.sort()) {
      if (!DAY_FILE_RE.test(n)) return bad(`history/${n}`, 'is not a history day file');
      const text = kindOf(join(dir, n)) === 'link' ? null : readPrivateRegularFile(join(dir, n), MAX_FILE_BYTES);
      if (text === null) return bad(`history/${n}`, 'is a link, not a plain file, or too large');
      const lines: string[] = [];
      for (const line of text.split('\n').filter((l) => l.trim())) {
        let entry;
        try {
          entry = parseHistoryEntry(JSON.parse(line));
        } catch {
          entry = null;
        }
        if (!entry) return bad(`history/${n}`, 'has a line Stephen cannot read');
        lines.push(JSON.stringify(entry));
      }
      entries += lines.length;
      parts.push({ name: `history/${n}`, text: lines.length ? `${lines.join('\n')}\n` : '', what: '' });
    }
    if (names.length) parts.push({ name: '', text: '', what: `${entries} conversation history entr${entries === 1 ? 'y' : 'ies'}` });
  }
  return { parts };
}

const summary = (parts: Part[]) => parts.filter((p) => p.what).map((p) => p.what);

/**
 * Every setting path that an import would add, remove or change, by name only (values can hold addresses). All of
 * them are listed, not a guess at which ones matter for safety: a missed one would be worse than a long list.
 */
export function changedSettings(before: unknown, after: unknown, path = ''): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => {
      const p = path ? `${path}.${k}` : k;
      if (!(k in after)) return [`${p} (removed)`];
      if (!(k in before)) return [`${p} (new)`];
      return changedSettings(before[k], after[k], p);
    });
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [`${path || 'settings'} (changed)`];
}

export async function exportData(dest: string, o: { history: boolean }, d: MoveDeps): Promise<number> {
  try {
    lstatSync(dest);
    d.err(`${dest} already exists. Pick a new folder name: Stephen never writes into an existing folder.`);
    return 1;
  } catch {
    // good: it does not exist
  }
  const read = await readParts({ config: d.configPath, dir: d.home }, o.history, true, d);
  if ('error' in read) {
    d.err(`Nothing exported: ${read.error}.`);
    return 1;
  }
  try {
    mkdirSync(dest, { mode: 0o700 });
    for (const p of read.parts.filter((x) => x.name)) {
      if (p.name.startsWith('history/')) mkdirSync(join(dest, 'history'), { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(join(dest, p.name), p.text);
    }
    writePrivateJsonFileSync(join(dest, MANIFEST), {
      format: EXPORT_FORMAT,
      stephenVersion: d.version,
      createdAt: d.now().toISOString(),
      whatIsInside: WHAT_IS_INSIDE,
      contents: summary(read.parts),
    });
  } catch (e) {
    d.err(`Export failed: ${(e as Error).message}. The folder ${dest} may be incomplete; delete it.`);
    return 1;
  }
  d.out(`Exported to ${dest} (only you can open it):`);
  for (const line of summary(read.parts)) d.out(`  ${line}`);
  if (!summary(read.parts).length) d.out('  nothing yet (no settings, memory or timers saved)');
  d.out(WHAT_IS_INSIDE);
  return 0;
}

export interface ImportDeps extends MoveDeps {
  listenerAnswers: () => Promise<boolean>;
  /** Ask one question; null when there is no terminal (then --yes is needed). */
  ask: ((question: string) => Promise<string>) | null;
}

export async function importData(src: string, o: { yes: boolean; config: boolean }, d: ImportDeps): Promise<number> {
  if (kindOf(src) !== 'ok' || !lstatSync(src).isDirectory()) {
    d.err(`${src} is not a plain folder (missing, a link, or a file). Nothing was changed.`);
    return 1;
  }
  if (await d.listenerAnswers()) {
    d.err('Stephen is running. Quit it first (menu bar icon, Quit), then import again. Nothing was changed.');
    return 1;
  }
  const manifest = readJson(join(src, MANIFEST));
  if (!manifest || 'error' in manifest) {
    d.err(`${src} is not a Stephen export (no readable ${MANIFEST}). Nothing was changed.`);
    return 1;
  }
  const format = (manifest.value as { format?: unknown } | null)?.format;
  if (format !== EXPORT_FORMAT) {
    d.err(`This export has format ${String(format)}; this Stephen reads format ${EXPORT_FORMAT}. Nothing was changed.`);
    return 1;
  }
  const read = await readParts({ config: join(src, CONFIG), dir: src }, true, false, d);
  if ('error' in read) {
    d.err(`Nothing imported: ${read.error}. Nothing was changed.`);
    return 1;
  }
  // Settings can loosen safety (allowed sites, trust, account addresses, the jobs folder, the daily limit), so they
  // come in only with --config, and every setting that changes is named before the question.
  const cfgPart = read.parts.find((p) => p.name === CONFIG);
  const parts = read.parts.filter((p) => p.name !== CONFIG || o.config);
  const lines = summary(parts).filter((l) => o.config || !l.startsWith('settings'));
  if (cfgPart && !o.config) d.out('The settings in this export are not imported (add --config to import them too).');
  if (!lines.length) {
    d.out('Nothing else to import.');
    return 0;
  }
  d.out('This replaces, on this Mac:');
  for (const l of lines) d.out(`  ${l}`);
  if (cfgPart && o.config) {
    const now = readJson(d.configPath);
    const changes = changedSettings(now && 'value' in now ? now.value : {}, JSON.parse(cfgPart.text));
    d.out(changes.length ? 'Settings that change (check each one: some can loosen safety):' : 'Your settings stay the same.');
    for (const c of changes) d.out(`  ${c}`);
  }
  if (!o.yes) {
    if (!d.ask) {
      d.err('No terminal to ask in: run it again with --yes to confirm.');
      return 1;
    }
    if (!/^y(es)?$/i.test((await d.ask('Import? (y/N) ')).trim())) {
      d.out('Not imported. Nothing was changed.');
      return 0;
    }
  }
  try {
    await ensurePrivateDir(d.home);
    for (const p of parts.filter((x) => x.name)) {
      if (p.name === CONFIG) writePrivateFileAtomicSync(d.configPath, p.text);
      else {
        if (p.name.startsWith('history/')) await ensurePrivateDir(join(d.home, 'history'), d.home);
        writePrivateFileAtomicSync(join(d.home, p.name), p.text);
      }
    }
  } catch (e) {
    d.err(`Import stopped part way: ${(e as Error).message}. Run it again to finish.`);
    return 1;
  }
  d.out('Imported. Start Stephen again to use it.');
  return 0;
}

export const DATA_MOVE_USAGE = 'Usage: stephen data export <new folder> [--history]\n       stephen data import <folder> [--config] [--yes]';

/** `stephen data export|import ...`. cli.ts passes what only it may load (the config key check, the version). */
export async function runDataMove(argv: string[], w: { configSecretKeys: MoveDeps['configSecretKeys']; version: string }): Promise<number> {
  const [verb, folder, ...flags] = argv;
  const allowed = verb === 'export' ? ['--history'] : ['--yes', '--config'];
  if ((verb !== 'export' && verb !== 'import') || !folder || folder.startsWith('-') || flags.some((f) => !allowed.includes(f))) {
    console.error(DATA_MOVE_USAGE);
    return 2;
  }
  const { configFilePath } = await import('../config.js');
  const { socketAnswers } = await import('./data-cli.js');
  const { createInterface } = await import('node:readline/promises');
  const { resolve } = await import('node:path');
  const cfg = loadConfig();
  const base: MoveDeps = {
    home: cfg.home,
    configPath: configFilePath(),
    version: w.version,
    now: () => new Date(),
    configSecretKeys: w.configSecretKeys,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
  if (verb === 'export') return exportData(resolve(folder), { history: flags.includes('--history') }, base);
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    return await importData(resolve(folder), { yes: flags.includes('--yes'), config: flags.includes('--config') }, {
      ...base,
      listenerAnswers: () => socketAnswers(join(cfg.home, 'run', 'app.sock')),
      ask: rl ? (q) => rl.question(q) : null,
    });
  } finally {
    rl?.close();
  }
}
