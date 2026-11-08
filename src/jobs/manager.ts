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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from 'node:fs';
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
  isJobId,
  jobFiles,
  jobIdFor,
  jobPersona,
  jobSettings,
  jobSlug,
  reposNamed,
  slugOf,
  wantsWeb,
  type JobSpec,
} from './spec.js';
import { isFinal, jobsDir, listJobStates, metaDirOf, readJobState, supervisorRuns, writeJobState, type JobState } from './state.js';

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
  maxTurns: number;
  maxBudgetUsd: number;
  wallClockMs: number;
  repo?: { name: string; path: string; branch: string };
  /** Files in `<root>/inbox/` that start() moves into the job's input/ (plain jobs only), shown in the dialog. */
  inputs?: string[];
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

  list(): JobState[] {
    return listJobStates(this.o.home, {
      now: () => this.now(),
      ...(this.o.alive ? { alive: this.o.alive } : {}),
      onFailed: (s) => this.auditEnd(s, s.error, 'reconcile'),
    });
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

  /** Why another job can't start now ('' = it can): the running cap and the daily cap (rule 5). */
  capError(): string {
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
      return {
        id,
        task,
        folder,
        cwd: repo ? join(folder, 'repo') : folder,
        ...(inbox.length ? { inputs: inbox } : {}),
        web: wantsWeb(task),
        model: this.o.config.model,
        maxTurns: this.o.config.maxTurns,
        maxBudgetUsd: this.o.config.maxBudgetUsd,
        wallClockMs: this.o.config.wallClockMin * 60_000,
        ...(repo ? { repo: { ...repo, branch } } : {}),
      };
    }
    return { error: 'Too many jobs with that name today.' };
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
    const metaDir = metaDirOf(home, plan.id);
    let folder: string;
    try {
      await ensurePrivateDir(jobsDir(home), home);
      folder = this.makeFolder(plan);
      mkdirSync(metaDir, { mode: 0o700 }); // fresh too
      if (lstatSync(metaDir).isSymbolicLink()) throw new Error(`${metaDir} is a symlink`);
    } catch (e) {
      return { refused: `I couldn't make the job folder (${(e as Error).message}).` };
    }
    if (plan.repo) {
      const r = await (this.o.git ?? defaultGit)(['-C', plan.repo.path, 'worktree', 'add', join(folder, 'repo'), '-b', plan.repo.branch]);
      if (r.code !== 0) return { refused: `I couldn't make a git worktree of ${plan.repo.name} (${r.stderr.trim().split('\n').at(-1)?.slice(0, 160) ?? 'git failed'}).` };
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
      maxTurns: plan.maxTurns,
      maxBudgetUsd: plan.maxBudgetUsd,
      wallClockMs: plan.wallClockMs,
      web: plan.web,
      sessionId: randomUUID(),
      ...(plan.repo ? { repo: plan.repo } : {}),
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
    };
    const sup: SupervisorSpec = { version: 1, home, claudePath: this.o.claudePath, auditLogPath: this.o.auditLogPath ?? null, spec };
    try {
      const settings = jobSettings({ stephenHome: home, stephenRepo: this.o.stephenRepo ?? stephenRepoRoot(), ...(this.o.testOnlyNoSandbox ? { testOnlyNoSandbox: true } : {}) });
      writePrivateFileAtomicSync(f.settings, JSON.stringify(settings, null, 2) + '\n');
      writePrivateFileAtomicSync(f.persona, jobPersona(spec) + '\n');
      writePrivateJsonFileSync(f.spec, sup);
      writeJobState(home, state);
    } catch (e) {
      return { refused: `I couldn't write the job's files (${(e as Error).message}).` };
    }
    void this.o.audit
      ?.append({
        tool: 'job_start',
        outcome: 'ok',
        confirmation: 'approved',
        args: { id: plan.id, task: plan.task, folder, web: plan.web, model: plan.model, maxTurns: plan.maxTurns, maxBudgetUsd: plan.maxBudgetUsd, wallClockMin: plan.wallClockMs / 60_000, source, ...(plan.repo ? { repo: plan.repo.name, branch: plan.repo.branch } : {}) },
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
      child.on('error', (e) => this.failQueued(plan.id, `Could not start the job runner (${e.message}).`));
      child.unref();
    } catch (e) {
      this.failQueued(plan.id, `Could not start the job runner (${(e as Error).message}).`);
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
