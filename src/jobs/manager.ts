/**
 * Jobs from the listener's and the CLI's side (docs/ADR-004): plan a job (no side effects), start it after the
 * owner approved the dialog (folder or worktree, meta files, queued state, the detached supervisor), list, stop.
 * Only `stephen listen` (the job router) and `stephen jobs` load this; nothing Claude can reach does (boundary test).
 *
 * Folder rules (rule 4): the job folder is `<root>/<id>`, made fresh with mkdir (never reused), 0700, under a root that
 * is a real folder (not a symlink), checked again by realpath after it is made. The id is `<date>-<slug>` with the
 * slug `[a-z0-9-]{1,40}`, so no `..`, `/` or leading `-` can reach a path, a branch name or argv.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expandPath } from '../config.js';
import { REPO_ROOT } from '../lib/repo.js';
import { ensurePrivateDir, isInside, writePrivateFileAtomicSync, writePrivateJsonFileSync } from '../lib/fs.js';
import { wallParts } from '../lib/zone.js';
import type { IAuditLog } from '../types.js';
import type { JobsConfig } from './config.js';
import type { SpawnFn, SupervisorSpec } from './runner.js';
import {
  branchFor,
  buildJobEnv,
  cleanTask,
  EDIT_REQUEST_MAX,
  EDIT_REQUEST_TOO_LONG,
  editedTask,
  isJobId,
  jobFiles,
  jobIdFor,
  jobPersona,
  jobSettings,
  jobSlug,
  reposNamed,
  SLUG_MAX,
  slugOf,
  wantsWeb,
  type JobSpec,
} from './spec.js';
import { isFinal, jobVersions, jobsDir, listJobStates, listJobStatesAsync, metaDirOf, readJobState, supervisorRuns, writeJobState, type JobState, type ReconcileOptions } from './state.js';

export type GitFn = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultGit: GitFn = (args) =>
  new Promise((res) => {
    execFile('git', args as string[], { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      res({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The repo root of this Stephen install (its .env is in every job's denyRead). */
export function stephenRepoRoot(): string {
  return REPO_ROOT;
}

export interface JobManagerOptions {
  /** Stephen's home (`~/.stephen`). */
  home: string;
  config: JobsConfig;
  /** The model and effort picked in Settings > Model; a null model falls back to jobs.model. */
  modelPrefs?: () => { model: string | null; effort: string | null };
  /** The owner's zone: the date in an id and the daily cap. */
  timeZone: string;
  /** `claude` (voice.claudePath). */
  claudePath: string;
  /** Stephen's audit log (start, stop; the supervisor writes the end). */
  auditLogPath?: string | null;
  audit?: IAuditLog | null;
  /** The environment the job's scratch env is built from (only PATH, HOME, LANG, TMPDIR, USER are read). */
  env?: NodeJS.ProcessEnv;
  /** For `~` in jobs.root and jobs.repos (default: the user's home). */
  userHome?: string;
  /** node and dist/cli.js for `stephen jobs _run` (default: this process and this install). */
  nodePath?: string;
  cliPath?: string;
  stephenRepo?: string;
  now?: () => number;
  /** True once today's daily cost limit is used (voice DailyLimit.allowed). A new job is refused; a running one is not stopped. */
  dailyLimitUsed?: () => boolean;
  /** Starts the supervisor (tests). */
  spawn?: SpawnFn;
  git?: GitFn;
  alive?: (pid: number) => boolean;
  /** Test-only: run the job without the OS sandbox (the opt-in real test on a box without one). Never set by Stephen. */
  testOnlyNoSandbox?: boolean;
}

/** What the dialog shows and start() makes. Nothing exists on disk yet. */
export interface JobPlan {
  id: string;
  task: string;
  folder: string;
  cwd: string;
  web: boolean;
  model: string;
  effort?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  wallClockMs: number;
  repo?: { name: string; path: string; branch: string };
  /** Files in `<root>/inbox/` that start() moves into the job's input/ (plain jobs only), shown in the dialog. */
  inputs?: string[];
  /**
   * ADR-010: an edited job. The dialog shows all of it: the old job, the version, and either the old folder that is
   * copied (with its counts) or, for a code job, the old branch the new worktree branch is cut from.
   */
  edit?: { of: string; version: number; base: string; copyFrom?: string; files?: number; bytes?: number; fromBranch?: string };
}

/** A new job at 100% of today's cost limit. Running jobs are not stopped. */
export const JOB_LIMIT_USED = "Today's limit is used. The job did not start.";
/** ADR-010: Edit request is off while a job is queued or running (threat E9). */
export const EDIT_STOP_FIRST = 'Stop the job first to change its request.';
/** ADR-010 copy caps for an edited job's folder (threat E10). */
export const COPY_MAX_BYTES = 500 * 1024 * 1024;
export const COPY_MAX_FILES = 10_000;
export const COPY_TOO_BIG = 'The old job folder is too big to copy. Start a new job instead.';
export const COPY_GONE = "The old job folder isn't there any more (or isn't a plain folder in your jobs folder). Start a new job instead.";
/** R7: a job start that fails on disk or in git says one plain sentence. The raw detail goes to the log only. */
export const JOB_FOLDER_FAILED = "I couldn't make the job folder. The job did not start.";
export const JOB_WORKTREE_FAILED = "I couldn't make a git worktree for the job. The job did not start.";
export const JOB_COPY_FAILED = "I couldn't copy the old job folder. The job did not start.";
export const JOB_FILES_FAILED = "I couldn't write the job's files. The job did not start.";
export const JOB_RUNNER_FAILED = "I couldn't start the job runner. The job did not start.";
/** The raw reason behind a plain refusal, for the listener log (stderr). Never shown to the user. */
function logRaw(what: string, detail: string): void {
  console.error(`jobs: ${what}: ${detail}`);
}

/**
 * Walk the old job folder `src` without following any symlink: regular files and folders only (symlinks, sockets and
 * the rest are skipped). Over COPY_MAX_FILES entries (files and folders) or COPY_MAX_BYTES → COPY_TOO_BIG. With `dst`
 * (a fresh empty folder), each file is copied there: opened O_NOFOLLOW (a file swapped for a link since the walk is
 * skipped), written O_CREAT|O_EXCL|O_NOFOLLOW 0600, bytes counted as copied. `src` is only ever read.
 *
 * [DEV REVIEW] Folders: Node cannot read a folder's entries through an O_DIRECTORY|O_NOFOLLOW fd (no fdopendir), so
 * each folder, `src` included, must be a plain folder whose realpath is exactly its own path (no symlink anywhere on
 * the way) before it is read, after it is read, and after each of its files is opened. A folder swapped for a symlink
 * at any level → COPY_GONE, and the caller removes what was copied (fail closed). `src` must be a realpath.
 * `beforeRead` is a test hook (the gap between the check and the read).
 */
export function copyJobFolder(src: string, dst: string | null, beforeRead?: (dir: string) => void): { files: number; bytes: number } | { error: string } {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let swapped = false;
  const plain = (dir: string): boolean => {
    if (plainFolder(dir)) return true;
    swapped = true;
    return false;
  };
  const copyFile = (from: string, to: string): boolean => {
    let fd: number;
    try {
      fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return true; // a link or gone since the walk: skipped
    }
    try {
      if (!plain(dirname(from))) return false; // the folder was swapped while the file was opened
      if (!fstatSync(fd).isFile()) return true;
      const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) {
          bytes += n;
          if (bytes > COPY_MAX_BYTES) return false;
          writeSync(out, buf, 0, n);
        }
      } finally {
        closeSync(out);
      }
      return true;
    } finally {
      closeSync(fd);
    }
  };
  const walk = (from: string, to: string | null): boolean => {
    if (!plain(from)) return false;
    beforeRead?.(from);
    const names = readdirSync(from).sort();
    if (!plain(from)) return false; // swapped while it was read: the names may be another folder's
    for (const n of names) {
      const a = join(from, n);
      const st = lstatSync(a, { throwIfNoEntry: false });
      if (!st || !(st.isDirectory() || st.isFile())) continue;
      if (++entries > COPY_MAX_FILES) return false;
      if (st.isDirectory()) {
        if (to) mkdirSync(join(to, n), { mode: 0o700 });
        if (!walk(a, to && join(to, n))) return false;
        continue;
      }
      files++;
      if (!to) {
        bytes += st.size;
        if (bytes > COPY_MAX_BYTES) return false;
      } else if (!copyFile(a, join(to, n))) return false;
    }
    return true;
  };
  return walk(src, dst) ? { files, bytes } : { error: swapped ? COPY_GONE : COPY_TOO_BIG };
}

/** A real folder (not a symlink) whose realpath is exactly `dir`: no symlink anywhere on its path. */
function plainFolder(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && realpathSync(dir) === dir;
  } catch {
    return false;
  }
}

/** ADR-010: the old job folder may be copied: a plain folder directly in the job root (checked at plan and at start). */
function oldFolderOk(folder: string, realRoot: string): boolean {
  return !!folder && plainFolder(folder) && dirname(folder) === realRoot;
}

/** The owner's drop folder for job inputs (owner, 2026-11-05): `<jobs root>/inbox/`. */
export const INBOX_DIR = 'inbox';
export const MAX_INBOX_FILES = 20;
export const MAX_INBOX_BYTES = 100 * 1024 * 1024;

/**
 * Regular files directly in the inbox (no folders, no symlinks, no dot files), sorted. Over the caps → an error
 * for the owner. A missing inbox is just empty.
 */
export function inboxFiles(inbox: string): string[] | { error: string } {
  let names: string[];
  try {
    if (lstatSync(inbox).isSymbolicLink()) return { error: `${inbox} is a symlink; make it a plain folder.` };
    names = readdirSync(inbox);
  } catch {
    return [];
  }
  const files: string[] = [];
  let bytes = 0;
  for (const n of names.sort()) {
    if (n.startsWith('.')) continue;
    const st = lstatSync(join(inbox, n));
    if (!st.isFile()) continue; // symlinks, folders and the rest stay where they are
    files.push(n);
    bytes += st.size;
  }
  if (files.length > MAX_INBOX_FILES) return { error: `The job inbox has ${files.length} files; at most ${MAX_INBOX_FILES} per job.` };
  if (bytes > MAX_INBOX_BYTES) return { error: `The job inbox holds more than ${MAX_INBOX_BYTES / 1024 / 1024} MB; move some files out first.` };
  return files;
}

export class JobManager {
  constructor(private readonly o: JobManagerOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get userHome(): string {
    return this.o.userHome ?? this.o.env?.HOME ?? homedir();
  }

  /** The job root, expanded (not checked). */
  root(): string {
    return expandPath(this.o.config.root, this.userHome);
  }

  private reconcileOptions(): ReconcileOptions {
    return {
      now: () => this.now(),
      ...(this.o.alive ? { alive: this.o.alive } : {}),
      onFailed: (s) => this.auditEnd(s, s.error, 'reconcile'),
    };
  }

  list(): JobState[] {
    return listJobStates(this.o.home, this.reconcileOptions());
  }

  /** list() without blocking the event loop on `ps` (the listener's job watcher, #202 B2). */
  listAsync(): Promise<JobState[]> {
    return listJobStatesAsync(this.o.home, this.reconcileOptions());
  }

  get(id: string): JobState | null {
    return this.list().find((j) => j.id === id) ?? null;
  }

  running(): JobState[] {
    return this.list().filter((j) => !isFinal(j.status));
  }

  /** "2026-11-05" in the owner's zone. */
  private today(): string {
    const w = wallParts(this.now(), this.o.timeZone);
    return `${w.y}-${String(w.mo + 1).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
  }

  /** Why another job can't start now ('' = it can): today's cost limit, the running cap and the daily cap (rule 5). */
  capError(): string {
    if (this.o.dailyLimitUsed?.()) return JOB_LIMIT_USED;
    const all = this.list();
    const running = all.filter((j) => !isFinal(j.status)).length;
    if (running >= this.o.config.maxRunning) return `${running} jobs are already running, the most at once. Stop one or wait for it to finish.`;
    const today = this.today();
    if (all.filter((j) => j.id.startsWith(today)).length >= this.o.config.dailyStarts) return `That's ${this.o.config.dailyStarts} jobs today already, the daily limit.`;
    return '';
  }

  /** The root, checked: a real folder (or missing), not `/`, not the home folder, not inside or around Stephen's home. */
  private rootError(root: string): string {
    const r = resolve(root);
    if (r === '/' || r === resolve(this.userHome)) return `jobs.root can't be ${r}: give jobs their own folder (default ~/Stephen Jobs).`;
    if (isInside(r, this.o.home) || isInside(this.o.home, r)) return "jobs.root can't be inside Stephen's home or contain it.";
    const st = lstatSync(r, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return `${r} must be a real folder (not a file or a symlink).`;
    return '';
  }

  /**
   * Plan a job for this task: id, folder, web, repo, budgets. Creates nothing. An error is said to the owner as is.
   */
  async plan(rawTask: string, opts: { inbox?: boolean } = {}): Promise<JobPlan | { error: string }> {
    if (!this.o.config.enabled) return { error: 'Jobs are turned off in your Stephen settings (jobs.enabled).' };
    const task = cleanTask(rawTask);
    if (task.split(' ').filter(Boolean).length < 2) return { error: 'Say what the job should do, like "start a job to write my lab report draft".' };
    const cap = this.capError();
    if (cap) return { error: cap };
    const root = this.root();
    const rootErr = this.rootError(root);
    if (rootErr) return { error: rootErr };
    const names = reposNamed(task, Object.keys(this.o.config.repos));
    if (names.length > 1) return { error: `That names more than one of your repos (${names.join(', ')}). Say just one.` };
    let repo: { name: string; path: string } | undefined;
    if (names.length === 1) {
      const name = names[0]!;
      const path = expandPath(this.o.config.repos[name]!, this.userHome);
      const top = await (this.o.git ?? defaultGit)(['-C', path, 'rev-parse', '--show-toplevel']);
      if (top.code !== 0) return { error: `Your repo "${name}" (${path}) isn't a git repository I can use.` };
      repo = { name, path: realpathSync(top.stdout.trim()) };
    }
    // The folder as makeFolder will see it: the realpath of the root (or of its parent, while it doesn't exist yet).
    const realRoot = existsSync(root) ? realpathSync(root) : join(existsSync(dirname(root)) ? realpathSync(dirname(root)) : dirname(root), basename(root));
    const slug = jobSlug(task);
    const day = this.today();
    for (let n = 1; n <= 50; n++) {
      const id = jobIdFor(day, slug, n);
      const folder = join(realRoot, id);
      if (existsSync(folder) || existsSync(metaDirOf(this.o.home, id))) continue;
      const branch = branchFor(slugOf(id));
      if (repo) {
        const b = await (this.o.git ?? defaultGit)(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (b.code === 0) continue; // that branch exists: next suffix
      }
      // No inbox files for a repo job, or when the caller can't show them (a phone job, REVIEW-8 R8-2).
      const inbox = repo || opts.inbox === false ? [] : inboxFiles(join(realRoot, INBOX_DIR));
      if (!Array.isArray(inbox)) return { error: inbox.error };
      const picked = this.o.modelPrefs?.();
      return {
        id,
        task,
        folder,
        cwd: repo ? join(folder, 'repo') : folder,
        ...(inbox.length ? { inputs: inbox } : {}),
        web: wantsWeb(task),
        model: picked?.model ?? this.o.config.model,
        ...(picked?.effort ? { effort: picked.effort } : {}),
        maxTurns: this.o.config.maxTurns,
        maxBudgetUsd: this.o.config.maxBudgetUsd,
        wallClockMs: this.o.config.wallClockMin * 60_000,
        ...(repo ? { repo: { ...repo, branch } } : {}),
      };
    }
    return { error: 'Too many jobs with that name today.' };
  }

  /**
   * ADR-010 Edit request, [DEV REVIEW]: plan a NEW job from a stopped, finished or failed one. Creates nothing; the
   * caller shows the job dialog (startPrompt) and starts only after the owner approves it, like any job. Nothing of
   * the old job is reused unless the plan carries it and the dialog shows it: web, budgets and model come fresh from
   * the edited request and the settings; the old folder is copied (never reused, never written); a code job gets a new
   * worktree branch cut from the old job's branch (the old worktree is never used). The id is today's date and the
   * old slug with `-v<version>`, so the caps count it like any start.
   */
  async planEdit(oldId: string, rawRequest: string): Promise<JobPlan | { error: string }> {
    if (!this.o.config.enabled) return { error: 'Jobs are turned off in your Stephen settings (jobs.enabled).' };
    const old = this.get(oldId);
    if (!old) return { error: `There's no job ${oldId}.` };
    if (!isFinal(old.status)) return { error: EDIT_STOP_FIRST };
    const request = cleanTask(rawRequest);
    if (request.split(' ').filter(Boolean).length < 2) return { error: 'Say what the job should do, like "write my lab report draft".' };
    if ([...request].length > EDIT_REQUEST_MAX) return { error: EDIT_REQUEST_TOO_LONG };
    const cap = this.capError();
    if (cap) return { error: cap };
    const root = this.root();
    const rootErr = this.rootError(root);
    if (rootErr) return { error: rootErr };
    const realRoot = existsSync(root) ? realpathSync(root) : '';
    if (!realRoot) return { error: COPY_GONE };
    const git = this.o.git ?? defaultGit;
    let repo: { name: string; path: string } | undefined;
    let edit: NonNullable<JobPlan['edit']>;
    if (old.repo) {
      const configured = this.o.config.repos[old.repo.name];
      if (!configured) return { error: `Your repo "${old.repo.name}" is no longer in your Stephen settings. Start a new job instead.` };
      const path = expandPath(configured, this.userHome);
      const top = await git(['-C', path, 'rev-parse', '--show-toplevel']);
      if (top.code !== 0) return { error: `Your repo "${old.repo.name}" (${path}) isn't a git repository I can use.` };
      repo = { name: old.repo.name, path: realpathSync(top.stdout.trim()) };
      const from = old.repo.branch;
      const has = /^stephen\/job-[a-z0-9][a-z0-9-]*$/.test(from) ? await git(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${from}`]) : { code: 1 };
      if (has.code !== 0) return { error: `The old job's branch ${from} is gone. Start a new job instead.` };
      edit = { of: old.id, version: 0, base: '', fromBranch: from };
    } else {
      // The old folder must still be a plain folder in the job root (it came from Stephen's own state file).
      if (!oldFolderOk(old.folder, realRoot)) return { error: COPY_GONE };
      const scan = copyJobFolder(old.folder, null);
      if ('error' in scan) return scan;
      edit = { of: old.id, version: 0, base: '', copyFrom: old.folder, ...scan };
    }
    // The old job's name without its `-v<N>`, with room for a version of up to four digits.
    const base = (old.editOf ? slugOf(old.id).replace(/-v\d+$/, '') : slugOf(old.id)).slice(0, SLUG_MAX - 6).replace(/-+$/, '') || 'job';
    const t = await this.editTarget(old.id, base, realRoot, repo?.path, 2);
    if (t) {
      const { id, folder, branch } = t;
      edit = { ...edit, version: t.version, base };
      const picked = this.o.modelPrefs?.();
      return {
        id,
        task: editedTask(old.task, request),
        folder,
        cwd: repo ? join(folder, 'repo') : folder,
        web: wantsWeb(request),
        model: picked?.model ?? this.o.config.model,
        ...(picked?.effort ? { effort: picked.effort } : {}),
        maxTurns: this.o.config.maxTurns,
        maxBudgetUsd: this.o.config.maxBudgetUsd,
        wallClockMs: this.o.config.wallClockMin * 60_000,
        ...(repo ? { repo: { ...repo, branch } } : {}),
        edit,
      };
    }
    return { error: 'Too many jobs with that name today.' };
  }

  /**
   * ADR-010: the id of an edited job: today, the old name, `-v<version>`, where the version is the highest in the job's
   * family (the jobs linked by editOf) + 1, at least `min`, and the next one while that folder, meta folder or branch
   * exists. Two edits of version 1 get versions 2 and 3. Only a lookup: the start claims the id (exclusive mkdir).
   */
  private async editTarget(of: string, base: string, realRoot: string, repoPath: string | undefined, min: number): Promise<{ id: string; folder: string; branch: string; version: number } | null> {
    const top = jobVersions(this.list()).get(of)?.versions ?? 1;
    const day = this.today();
    for (let v = Math.max(min, top + 1), n = 0; n < 50; v++, n++) {
      const id = jobIdFor(day, `${base}-v${v}`);
      const folder = join(realRoot, id);
      if (existsSync(folder) || existsSync(metaDirOf(this.o.home, id))) continue;
      const branch = branchFor(slugOf(id));
      if (repoPath && (await (this.o.git ?? defaultGit)(['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) continue;
      return { id, folder, branch, version: v };
    }
    return null;
  }

  /** Make the job folder `<root>/<id>`: fresh, 0700, a real folder whose realpath is exactly where we meant. */
  private makeFolder(plan: JobPlan): string {
    const root = this.root();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const err = this.rootError(root);
    if (err) throw new Error(err);
    const realRoot = realpathSync(root);
    if (!isJobId(plan.id)) throw new Error('bad job id');
    const folder = join(realRoot, plan.id);
    if (dirname(folder) !== realRoot || folder !== plan.folder) throw new Error('the job folder moved since the dialog');
    mkdirSync(folder, { mode: 0o700 }); // EEXIST: one job, one folder
    const st = lstatSync(folder);
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync(folder) !== folder) throw new Error(`${folder} is not a plain folder`);
    chmodSync(folder, 0o700);
    return folder;
  }

  /**
   * Start an approved plan: folder (or worktree), meta folder with settings.json, persona.md and spec.json (0600),
   * the queued state, then the detached supervisor. Starts run one at a time, and the caps (plus the caller's
   * `extraCap`, e.g. the phone's daily limit) are checked inside that turn, after the previous start wrote its state
   * (REVIEW-8 R8-3). An approved start that is refused anyway is audited with the reason (R8-4).
   */
  async start(plan: JobPlan, source: string, extraCap?: () => string): Promise<JobState | { refused: string }> {
    const run = this.starting.then(() => this.startNow(plan, source, extraCap));
    this.starting = run.then(
      () => undefined,
      () => undefined,
    );
    const r = await run;
    if ('refused' in r) {
      void this.o.audit
        ?.append({ tool: 'job_start', outcome: 'error', confirmation: 'approved', error: r.refused, args: { id: plan.id, task: plan.task, web: plan.web, source } })
        .catch(() => undefined);
    }
    return r;
  }

  private starting: Promise<void> = Promise.resolve();

  private async startNow(plan: JobPlan, source: string, extraCap?: () => string): Promise<JobState | { refused: string }> {
    const cap = this.capError() || extraCap?.() || '';
    if (cap) return { refused: cap };
    const home = this.o.home;
    let folder = '';
    let metaDir = '';
    try {
      await ensurePrivateDir(jobsDir(home), home);
      // [DEV REVIEW] ADR-010: the exclusive mkdir claims the id. An edited job whose id a sibling edit took first (two
      // dialogs open at once) moves to the next free version; nothing of the sibling's folder is touched.
      for (let tries = 0; ; tries++) {
        try {
          folder = this.makeFolder(plan);
          break;
        } catch (e) {
          if (!plan.edit || (e as NodeJS.ErrnoException).code !== 'EEXIST' || tries >= 20) throw e;
          const next = await this.editTarget(plan.edit.of, plan.edit.base, dirname(plan.folder), plan.repo?.path, plan.edit.version + 1);
          if (!next) throw e;
          plan = {
            ...plan,
            id: next.id,
            folder: next.folder,
            cwd: plan.repo ? join(next.folder, 'repo') : next.folder,
            ...(plan.repo ? { repo: { ...plan.repo, branch: next.branch } } : {}),
            edit: { ...plan.edit, version: next.version },
          };
        }
      }
      metaDir = metaDirOf(home, plan.id);
      mkdirSync(metaDir, { mode: 0o700 }); // fresh too
      if (lstatSync(metaDir).isSymbolicLink()) throw new Error(`${metaDir} is a symlink`);
    } catch (e) {
      logRaw('job folder', (e as Error).message);
      return { refused: JOB_FOLDER_FAILED };
    }
    if (plan.repo) {
      // ADR-010: an edited code job's new branch is cut from the old job's branch; the old worktree is never used.
      const from = plan.edit?.fromBranch ? [`refs/heads/${plan.edit.fromBranch}`] : [];
      const r = await (this.o.git ?? defaultGit)(['-C', plan.repo.path, 'worktree', 'add', join(folder, 'repo'), '-b', plan.repo.branch, ...from]);
      if (r.code !== 0) {
        // [DEV REVIEW] Nothing half-made stays behind: the claimed job folder and meta folder go, as for a failed copy.
        rmSync(folder, { recursive: true, force: true });
        rmSync(metaDir, { recursive: true, force: true });
        logRaw(`git worktree of ${plan.repo.name}`, r.stderr.trim().split('\n').at(-1)?.slice(0, 160) || 'git failed');
        return { refused: JOB_WORKTREE_FAILED };
      }
    } else if (plan.edit) {
      // ADR-010 [DEV REVIEW]: a copy of the old job's folder (shown in the dialog), checked against the caps again as it
      // copies. Over them, or anything failing: the new folders go and nothing is started. The old folder is only read.
      let copied: ReturnType<typeof copyJobFolder>;
      try {
        // planEdit's folder check again, right before the copy: the folder may have been swapped while the dialog was open.
        const from = plan.edit.copyFrom ?? '';
        copied = oldFolderOk(from, dirname(folder)) ? copyJobFolder(from, folder) : { error: COPY_GONE };
      } catch (e) {
        logRaw('copy old job folder', (e as Error).message);
        copied = { error: JOB_COPY_FAILED };
      }
      if ('error' in copied) {
        rmSync(folder, { recursive: true, force: true });
        rmSync(metaDir, { recursive: true, force: true });
        return { refused: copied.error };
      }
    } else {
      const input = join(folder, 'input');
      mkdirSync(input, { mode: 0o700 });
      // Move (not copy) what the dialog listed: the inbox is empty again for the next job. Re-checked here: a file
      // that became a symlink or disappeared since the dialog is skipped.
      const inbox = join(dirname(folder), INBOX_DIR);
      for (const n of plan.inputs ?? []) {
        try {
          if (lstatSync(join(inbox, n)).isFile()) renameSync(join(inbox, n), join(input, n));
        } catch {
          /* gone or changed since the dialog: skipped */
        }
      }
    }
    try {
      mkdirSync(join(dirname(folder), INBOX_DIR), { mode: 0o700 }); // there for the next job
    } catch {
      /* exists */
    }
    const spec: JobSpec = {
      id: plan.id,
      task: plan.task,
      folder,
      cwd: plan.cwd,
      metaDir,
      model: plan.model,
      ...(plan.effort ? { effort: plan.effort } : {}),
      maxTurns: plan.maxTurns,
      maxBudgetUsd: plan.maxBudgetUsd,
      wallClockMs: plan.wallClockMs,
      web: plan.web,
      sessionId: randomUUID(),
      ...(plan.repo ? { repo: plan.repo } : {}),
      // R9 L2: the folder or branch was copied from an earlier job; the prompt says so.
      ...(plan.edit ? { earlier: true } : {}),
    };
    const f = jobFiles(metaDir);
    const now = this.now();
    const state: JobState = {
      version: 1,
      id: plan.id,
      task: plan.task,
      status: 'queued',
      folder,
      cwd: plan.cwd,
      source,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      deadlineAt: null,
      pid: null,
      claudePid: null,
      sessionId: spec.sessionId,
      model: plan.model,
      web: plan.web,
      maxTurns: plan.maxTurns,
      maxBudgetUsd: plan.maxBudgetUsd,
      wallClockMs: plan.wallClockMs,
      repo: plan.repo ? { name: plan.repo.name, branch: plan.repo.branch } : null,
      turns: 0,
      toolCalls: 0,
      costUsd: null,
      denials: 0,
      summary: '',
      error: '',
      ...(plan.edit ? { editOf: plan.edit.of, editVersion: plan.edit.version } : {}),
    };
    const sup: SupervisorSpec = { version: 1, home, claudePath: this.o.claudePath, auditLogPath: this.o.auditLogPath ?? null, spec };
    try {
      const settings = jobSettings({ stephenHome: home, stephenRepo: this.o.stephenRepo ?? stephenRepoRoot(), ...(this.o.testOnlyNoSandbox ? { testOnlyNoSandbox: true } : {}) });
      writePrivateFileAtomicSync(f.settings, JSON.stringify(settings, null, 2) + '\n');
      writePrivateFileAtomicSync(f.persona, jobPersona(spec) + '\n');
      writePrivateJsonFileSync(f.spec, sup);
      writeJobState(home, state);
    } catch (e) {
      logRaw('job files', (e as Error).message);
      return { refused: JOB_FILES_FAILED };
    }
    void this.o.audit
      ?.append({
        tool: 'job_start',
        outcome: 'ok',
        confirmation: 'approved',
        args: { id: plan.id, task: plan.task, folder, web: plan.web, model: plan.model, maxTurns: plan.maxTurns, maxBudgetUsd: plan.maxBudgetUsd, wallClockMin: plan.wallClockMs / 60_000, source, ...(plan.repo ? { repo: plan.repo.name, branch: plan.repo.branch } : {}), ...(plan.edit ? { editOf: plan.edit.of, version: plan.edit.version } : {}) },
      })
      .catch(() => undefined);
    // The supervisor gets the same scratch environment as the job (it passes it on), its own process group (a
    // listener restart or Ctrl-C doesn't reach it), and no terminal.
    const spawnFn: SpawnFn = this.o.spawn ?? ((c, a, opts) => spawn(c, a as string[], opts));
    try {
      const child = spawnFn(this.o.nodePath ?? process.execPath, [this.o.cliPath ?? join(stephenRepoRoot(), 'dist', 'cli.js'), 'jobs', '_run', metaDir], {
        cwd: metaDir,
        env: buildJobEnv(this.o.env ?? process.env),
        stdio: 'ignore',
        detached: true,
        shell: false,
      });
      child.on('error', (e) => this.runnerFailed(plan.id, e.message));
      child.unref();
    } catch (e) {
      this.runnerFailed(plan.id, (e as Error).message);
      return readJobState(home, plan.id) ?? state;
    }
    return state;
  }

  /** The owner said no (or no dialog could be shown): nothing was made; only the audit log knows. */
  declined(plan: JobPlan, outcome: 'declined' | 'unavailable', source: string): void {
    void this.o.audit
      ?.append({ tool: 'job_start', outcome: 'denied', confirmation: outcome, args: { id: plan.id, task: plan.task, web: plan.web, source } })
      .catch(() => undefined);
  }

  /** R7: the job's error is one plain sentence; the raw spawn error goes to the log only. */
  private runnerFailed(id: string, detail: string): void {
    logRaw('job runner', detail);
    this.failQueued(id, JOB_RUNNER_FAILED);
  }

  private failQueued(id: string, error: string): void {
    const s = readJobState(this.o.home, id);
    if (!s || s.status !== 'queued') return;
    try {
      writeJobState(this.o.home, { ...s, status: 'failed', endedAt: this.now(), error });
    } catch {
      /* reconcile marks it failed later */
    }
    this.auditEnd(s, error, 'start');
  }

  /** A job the listener (not its supervisor) declared failed: the supervisor never writes its own job_end then. */
  private auditEnd(s: JobState, error: string, by: string): void {
    void this.o.audit?.append({ tool: 'job_end', outcome: 'error', error, args: { id: s.id, status: 'failed', by } }).catch(() => undefined);
  }

  /**
   * Stop a job: SIGTERM to its supervisor, which stops Claude Code's group (SIGKILL after 10 s) and writes `stopped`.
   * A queued job is marked stopped (its supervisor checks before and right after it starts Claude Code). Waits up
   * to `waitMs` for the final state.
   */
  async stop(id: string, by: string, waitMs = 15_000): Promise<JobState | { refused: string }> {
    const s = this.get(id);
    if (!s) return { refused: `There's no job ${id}.` };
    if (isFinal(s.status)) return s;
    // Audited after the stop, with what actually happened (R8-4).
    const audited = (r: JobState): JobState => {
      const stopped = isFinal(r.status);
      void this.o.audit
        ?.append({ tool: 'job_stop', outcome: stopped ? 'ok' : 'error', ...(stopped ? {} : { error: 'still running after the wait' }), args: { id, by, status: r.status } })
        .catch(() => undefined);
      return r;
    };
    if (s.pid === null) {
      writeJobState(this.o.home, { ...s, status: 'stopped', endedAt: this.now(), error: 'Stopped by the owner before it started.' });
      return audited(readJobState(this.o.home, id) ?? s);
    }
    // Only a pid that is still this job's supervisor gets the signal (R8-5: never an unrelated reused pid).
    if (supervisorRuns(s, s.pid, this.o.alive)) {
      try {
        process.kill(s.pid, 'SIGTERM');
      } catch {
        /* gone: reconcile below */
      }
    }
    const until = Date.now() + waitMs;
    for (;;) {
      const now = readJobState(this.o.home, id);
      if (now && isFinal(now.status)) return audited(now);
      if (Date.now() > until || !supervisorRuns(s, s.pid, this.o.alive)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return audited(this.get(id) ?? s);
  }
}

/** "2026-11-05-write-my-lab-report" from a folder path or id the owner typed (basename only). */
export function jobIdArg(arg: string): string | null {
  const b = basename(arg.trim().replace(/\/+$/, ''));
  return isJobId(b) ? b : null;
}
