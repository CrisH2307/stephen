/**
 * `stephen data` (B6): what Stephen keeps on this Mac, how big it is, how long it stays and how to delete it.
 * The list mirrors docs/DATA-STORES.md (test/app/data-list.test.ts keeps the two in step). It reads sizes only,
 * never file contents, and deletes nothing; R10 ("delete all my data") reuses STORES and filesOf.
 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseAccountsConfig } from '../accounts/config.js';
import { defaultEnvFiles, SECRET_SPECS } from '../accounts/secrets.js';
import { expandPath, LEGACY_HOME_DIRNAME, loadConfig, STEPHEN_HOME_DIRNAME } from '../config.js';
import { claudeTranscriptDir, purgeTranscripts } from '../voice/transcripts.js';
import { KEYCHAIN_SERVICE as VOICE_KEY_SERVICE } from '../voice/tts/keys.js';

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
    console.error('Usage: stephen data\n       stephen data delete --all');
    return 2;
  }
  for (const line of dataLines({ home: loadConfig().home, jobsRoot: expandPath(jobsRoot, homedir()) })) out(line);
  return 0;
}

// ── `stephen data delete --all` (R10) ──

/** Every Keychain item Stephen writes, except the per-label Gmail tokens (those go through `stephen disconnect`). */
export const KEYCHAIN_SERVICES: readonly string[] = [...Object.values(SECRET_SPECS).map((x) => x.keychain), VOICE_KEY_SERVICE];

export interface DeleteDeps {
  places: DataPlaces;
  /** The person's home folder: never deleted, nor anything above it. */
  userHome: string;
  /** Ask one question and return the answer; null when there is no terminal to ask in. */
  ask: ((question: string) => Promise<string>) | null;
  /** Does `stephen listen` answer on app.sock? */
  listenerAnswers: () => Promise<boolean>;
  gmailLabels: string[];
  /** The existing `stephen disconnect gmail <label>` (revokes at Google, deletes the Keychain item). */
  disconnectGmail: (label: string) => Promise<number>;
  deleteKeychain: (service: string) => Promise<'deleted' | 'missing' | string>;
  /** Claude Code's transcript folder for the voice work folder (src/voice/transcripts.ts). */
  transcriptDir: string;
  /** `.env` files Stephen may read (src/accounts/secrets.ts): never deleted, only named if one is still there. */
  envFiles: string[];
  out: (line: string) => void;
  err: (line: string) => void;
}

/** A folder that must never be deleted as a whole: the disk root, the person's home, or anything above it. */
export function unsafeToDelete(path: string, userHome: string): boolean {
  const p = resolve(path);
  const u = resolve(userHome);
  return p === '/' || p === u || u.startsWith(`${p}/`);
}

/** Stephen's subfolders that may be left empty after its stores go (custom home only). */
const STORE_DIRS = ['history', 'voice', 'telemetry', 'incidents', 'jobs', 'logs', 'run', 'replay'];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Only ~/.stephen or the old ~/.browser-hub are Stephen's alone, so only they are deleted as a whole. */
export function isDefaultHome(home: string, userHome: string): boolean {
  const h = real(home);
  return [STEPHEN_HOME_DIRNAME, LEGACY_HOME_DIRNAME].some((name) => h === real(join(userHome, name)));
}

const yes = (answer: string) => /^\s*y(es)?\s*$/i.test(answer);
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Delete a path without following links: a link is removed itself, never its target (rmSync does not follow). */
function removePath(path: string): void {
  if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { recursive: true, force: true });
}

/** Delete `dir` and everything in it, except `keep` (and the folders on the way to it). Links are never followed. */
function removeAllExcept(dir: string, keep: string | null): void {
  if (keep === dir) return;
  if (!keep || !keep.startsWith(`${dir}/`) || lstatSync(dir).isSymbolicLink()) return removePath(dir);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === keep) continue;
    if (keep.startsWith(`${p}/`) && lstatSync(p).isDirectory()) removeAllExcept(p, keep);
    else removePath(p);
  }
}

/** `stephen data delete --all`: everything Stephen keeps, after one clear question; the job folder only after a second. */
export async function deleteAllData(d: DeleteDeps): Promise<number> {
  const home = resolve(d.places.home);
  const jobsRoot = resolve(d.places.jobsRoot);
  const show = (p: string) => tilde(p, d.userHome);
  if (unsafeToDelete(home, d.userHome)) {
    d.err(`Refused: the Stephen folder is set to ${show(home)}, which is not a folder Stephen can delete as a whole.`);
    return 1;
  }
  if (await d.listenerAnswers()) {
    d.err('Quit Stephen first.');
    return 1;
  }
  if (!d.ask) {
    d.err('Run this in Terminal: it asks you before it deletes anything.');
    return 1;
  }
  for (const line of dataLines(d.places, d.userHome)) d.out(line);
  d.out('');
  if (!yes(await d.ask('Delete all of this? [y/N] '))) {
    d.out('Nothing was deleted.');
    return 0;
  }
  let jobs = false;
  if (exists(jobsRoot)) {
    if (unsafeToDelete(jobsRoot, d.userHome)) d.out(`Kept ${show(jobsRoot)}: Stephen never deletes that folder as a whole.`);
    else jobs = yes(await d.ask(`Also delete ${show(jobsRoot)}? It holds your job output files. [y/N] `));
  }

  let failed = false;
  for (const label of d.gmailLabels) if ((await d.disconnectGmail(label)) !== 0) failed = true;
  for (const service of KEYCHAIN_SERVICES) {
    const r = await d.deleteKeychain(service);
    if (r === 'deleted') d.out(`Deleted the Keychain item ${service}.`);
    else if (r !== 'missing') {
      d.err(`Could not delete the Keychain item ${service}: ${r}`);
      failed = true;
    }
  }
  const n = purgeTranscripts(d.transcriptDir, null);
  if (n) d.out(`Deleted ${n} Claude Code transcript${n === 1 ? '' : 's'}.`);

  const notDeleted: string[] = [];
  const keepJobs = !jobs && exists(jobsRoot);
  const inJobs = (p: string) => keepJobs && (p === jobsRoot || p.startsWith(`${jobsRoot}/`) || jobsRoot.startsWith(`${p}/`));
  if (!exists(home)) {
    // nothing to delete in the Stephen folder
  } else if (keepJobs && jobsRoot === home) {
    notDeleted.push(`${show(home)}: it is also your job folder, and you chose to keep that.`);
  } else if (isDefaultHome(home, d.userHome)) {
    // The default folder is Stephen's alone: it all goes, except a job folder inside it on a "no".
    removeAllExcept(home, keepJobs ? jobsRoot : null);
    d.out(`Deleted ${show(home)}${keepJobs && jobsRoot.startsWith(`${home}/`) ? ` (kept ${show(jobsRoot)} inside it)` : ''}.`);
  } else {
    // A folder set in config.json may hold the person's own files: only Stephen's known stores go.
    let gone = 0;
    for (const s of STORES) {
      for (const f of filesOf(s, d.places)) {
        if (!f.startsWith(`${home}/`) || inJobs(f)) continue;
        removePath(f);
        gone++;
      }
    }
    for (const dir of STORE_DIRS) {
      try {
        rmdirSync(join(home, dir)); // only when empty
      } catch {
        // not empty or not there: kept
      }
    }
    d.out(`Deleted ${gone} Stephen item${gone === 1 ? '' : 's'} in ${show(home)}.`);
    notDeleted.push(`Other files in ${show(home)}: that folder is set in config.json, so only Stephen's own files went.`);
  }
  if (jobs && exists(jobsRoot)) {
    removePath(jobsRoot);
    d.out(`Deleted ${show(jobsRoot)}.`);
  } else if (keepJobs && jobsRoot !== home) notDeleted.push(`${show(jobsRoot)}: your job output files.`);
  for (const f of d.envFiles) {
    if (exists(f)) notDeleted.push(`${show(f)}: an old settings file that may still hold account keys. Delete it yourself if you no longer need it.`);
  }
  if (notDeleted.length) {
    d.out('Not deleted:');
    for (const l of notDeleted) d.out(`  ${l}`);
  }
  if (failed) d.err('Some items could not be deleted (see above). Remove them in Keychain Access.');
  return failed ? 1 : 0;
}

/** True when something accepts a connection on the socket (stephen listen serves app.sock). */
export function socketAnswers(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection(path);
    const finish = (v: boolean) => {
      clearTimeout(t);
      s.destroy();
      done(v);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/** The owner-only writers live in src/connect, which only src/cli.ts may load (boundary test): it passes them in. */
export interface OwnerWriters {
  keychainDelete: (service: string, deps: { user: string }) => Promise<'deleted' | 'missing' | string>;
  disconnectGmail: (label: string) => Promise<number>;
}

export async function runDataDelete(argv: string[], jobsRoot: string, w: OwnerWriters): Promise<number> {
  if (argv.length !== 1 || argv[0] !== '--all') {
    console.error('Usage: stephen data delete --all');
    return 2;
  }
  const cfg = loadConfig();
  let gmailLabels: string[] = [];
  try {
    gmailLabels = parseAccountsConfig(cfg.accounts ?? {}).gmail.accounts;
  } catch {
    // a broken accounts section: the Keychain items below still go; Gmail labels can be removed in Keychain Access
  }
  const user = userInfo().username;
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    return await deleteAllData({
      places: { home: cfg.home, jobsRoot: expandPath(jobsRoot, homedir()) },
      userHome: homedir(),
      ask: rl ? (q) => rl.question(q) : null,
      listenerAnswers: () => socketAnswers(join(cfg.home, 'run', 'app.sock')),
      gmailLabels,
      disconnectGmail: w.disconnectGmail,
      deleteKeychain: (s) => w.keychainDelete(s, { user }),
      transcriptDir: claudeTranscriptDir(join(cfg.home, 'voice', 'workdir')),
      envFiles: defaultEnvFiles(),
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    });
  } finally {
    rl?.close();
  }
}
