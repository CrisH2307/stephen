/**
 * `stephen data` (B6): what Stephen keeps on this Mac, how big it is, how long it stays and how to delete it.
 * The list mirrors docs/DATA-STORES.md (test/app/data-list.test.ts keeps the two in step). It reads sizes only,
 * never file contents, and deletes nothing; R10 ("delete all my data") reuses STORES and filesOf.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expandPath, loadConfig } from '../config.js';

export interface DataPlaces {
  /** The Stephen home folder (`~/.stephen` unless config says otherwise). */
  home: string;
  /** `jobs.root`, where job output folders are made. */
  jobsRoot: string;
}

export interface Store {
  /** The "What" column of docs/DATA-STORES.md. */
  what: string;
  /**
   * Files or folders on disk. A `*` in the last part matches by name in that folder, like the shell: it does not
   * match names that start with a dot. Empty: not a plain file.
   */
  paths: (p: DataPlaces) => string[];
  /** Shown instead of the paths when there is no plain file to measure. */
  where?: string;
  kept: string;
  remove: string;
}

const h = (...parts: string[]) => (p: DataPlaces) => [join(p.home, ...parts)];

export const STORES: readonly Store[] = [
  { what: 'Memory', paths: h('memory.json'), kept: 'until you forget it, at most 30 items', remove: 'say "forget ...", use the Memory page, or run stephen memory' },
  { what: 'Memory suggestions', paths: h('memory-proposals.json'), kept: 'until you keep or skip them, at most 20', remove: 'Skip on the Memory page' },
  { what: 'Timers and reminders', paths: h('timers.json'), kept: 'until done or cancelled', remove: 'say "cancel all timers"' },
  { what: 'Conversations (history)', paths: h('history/'), kept: '7 days by default (0 to 30)', remove: 'stephen history clear' },
  // ponytail: not measured, the folder name depends on the voice work folder (src/voice/transcripts.ts).
  { what: 'Claude Code transcripts', paths: () => [], where: "Claude Code's own folder (~/.claude/projects/)", kept: 'deleted when the conversation ends', remove: 'stephen history clear' },
  { what: 'Follow-up record', paths: h('voice', 'conversation.json'), kept: 'until the conversation ends', remove: 'ends with the conversation' },
  { what: 'Conversation trust state', paths: h('voice', 'conversation-state.json'), kept: 'until the next command starts a new conversation', remove: 'ends with the conversation' },
  { what: 'F5 recordings and their labels (opt-in)', paths: h('replay/'), kept: '30 days, at most 100 clips', remove: 'stephen replay delete --all' },
  { what: 'Latency records', paths: h('telemetry', 'latency-*.jsonl'), kept: '30 days', remove: 'deleted after 30 days, or delete the folder' },
  { what: 'Incidents', paths: h('incidents/'), kept: '30 days', remove: 'deleted after 30 days, or delete the folder' },
  { what: 'Safety audit log', paths: h('audit.log*'), kept: 'up to 4 files of 5 MB', remove: 'delete the files' },
  { what: 'Tool log', paths: h('voice', 'tool-log.jsonl'), kept: 'emptied before each command', remove: 'delete the file' },
  { what: 'Job state and logs', paths: h('jobs', '*'), kept: '30 days after the job ends', remove: 'deleted after 30 days' },
  { what: 'Announced jobs', paths: h('jobs', '.announced.json'), kept: 'kept (job ids only)', remove: 'delete the file' },
  { what: 'Job output folders', paths: (p) => [`${p.jobsRoot}/`], kept: 'until you delete them', remove: 'delete the folder in Finder' },
  { what: 'Helper log', paths: h('logs', 'helper.log*'), kept: 'about 1 MB, one old copy', remove: 'delete the files' },
  { what: 'Listener log and pid', paths: (p) => [join(p.home, 'logs', 'listen.log*'), join(p.home, 'run', 'listen.pid')], kept: 'about 2 MB, one old copy', remove: 'delete the files' },
  { what: 'Settings', paths: h('config.json'), kept: 'kept', remove: 'edit or delete the file' },
  { what: 'Account secrets', paths: () => [], where: 'macOS Keychain (names start with stephen-)', kept: 'until removed', remove: 'stephen disconnect gmail <label>, stephen voice-key delete, or Keychain Access' },
  { what: 'Account secrets in a `.env` file (older setups)', paths: () => [], where: '.env in the Stephen folder', kept: 'until you delete it', remove: 'delete the lines or the file' },
];

/**
 * Bytes in a file, or in every file under a folder; 0 when missing. lstat, never stat: a link counts as itself and
 * is never followed, so a link to a big folder or a link loop cannot make `stephen data` walk forever.
 */
function bytesOf(path: string): number {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, name) => n + bytesOf(join(path, name)), 0);
  } catch {
    return 0;
  }
}

/** The files and folders of a store that exist now (globs expanded). Read-only; R10 deletes these. */
export function filesOf(s: Store, p: DataPlaces): string[] {
  const found: string[] = [];
  for (const raw of s.paths(p)) {
    const path = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const name = basename(path);
    let matches = [path];
    if (name.includes('*')) {
      const re = new RegExp(`^${name.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      try {
        matches = readdirSync(dirname(path))
          .filter((f) => re.test(f) && (name.startsWith('.') || !f.startsWith('.')))
          .map((f) => join(dirname(path), f));
      } catch {
        matches = [];
      }
    }
    for (const m of matches) {
      try {
        lstatSync(m);
        found.push(m);
      } catch {
        // not created yet
      }
    }
  }
  return found;
}

/** Total size of a store, or null when none of its files exist yet. */
export function storeSize(s: Store, p: DataPlaces): number | null {
  const files = filesOf(s, p);
  return files.length ? files.reduce((n, f) => n + bytesOf(f), 0) : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const tilde = (path: string, userHome: string) => (path === userHome || path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path);

/** The lines `stephen data` prints. */
export function dataLines(p: DataPlaces, userHome: string = homedir()): string[] {
  const lines = ['What Stephen keeps on this Mac (nothing here is sent to us):', ''];
  for (const s of STORES) {
    const size = s.paths(p).length ? storeSize(s, p) : undefined;
    lines.push(s.what.replace(/`/g, ''));
    lines.push(`  where:  ${s.where ?? s.paths(p).map((x) => tilde(x, userHome)).join(', ')}`);
    if (size !== undefined) lines.push(`  size:   ${size === null ? 'not created yet' : formatBytes(size)}`);
    lines.push(`  kept:   ${s.kept}`);
    lines.push(`  delete: ${s.remove}`);
  }
  lines.push('', 'More detail: docs/DATA-STORES.md');
  return lines;
}

/** `jobsRoot` (config `jobs.root`) comes from src/cli.ts, which may load src/jobs on demand; src/app may not. */
export function runDataCli(argv: string[], jobsRoot: string, out: (line: string) => void = console.log): number {
  if (argv.length) {
    console.error('Usage: stephen data');
    return 2;
  }
  for (const line of dataLines({ home: loadConfig().home, jobsRoot: expandPath(jobsRoot, homedir()) })) out(line);
  return 0;
}
