/**
 * The listener's / CLI's side of jobs: folder rules (rule 4: realpath, no symlinks, fresh folder, 0700, `..`), the
 * running and daily caps (rule 5), restart recovery (a job whose supervisor is gone is marked failed), git worktrees
 * for code jobs, and one end-to-end run through the real `stephen jobs _run` supervisor process (needs the build).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runJobsCli } from '../../src/jobs/cli.js';
import { JOB_FILES_FAILED, JOB_FOLDER_FAILED, JOB_RUNNER_FAILED, JobManager, jobIdArg, stephenRepoRoot } from '../../src/jobs/manager.js';
import { listJobStates, readJobState, reconcile, writeJobState, type JobState } from '../../src/jobs/state.js';
import { isPidAlive } from '../../src/lib/process.js';
import { FAKE_CLAUDE, NOW, TODAY, harness, tempRoot, until } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-manager');
afterAll(cleanup);

const state = (id: string, o: Partial<JobState> = {}): JobState => ({
  version: 1,
  id,
  task: 'write something',
  status: 'running',
  folder: '/x',
  cwd: '/x',
  source: 'voice-ptt',
  createdAt: NOW - 60_000,
  startedAt: NOW - 60_000,
  endedAt: null,
  deadlineAt: NOW + 44 * 60_000,
  pid: process.pid,
  claudePid: null,
  sessionId: '',
  model: 'sonnet',
  web: false,
  maxTurns: 150,
  maxBudgetUsd: 5,
  wallClockMs: 45 * 60_000,
  repo: null,
  turns: 0,
  toolCalls: 0,
  costUsd: null,
  denials: 0,
  summary: '',
  error: '',
  ...o,
});
const seed = (home: string, s: JobState) => {
  mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
  writeJobState(home, s);
};

describe('plan: what the dialog will show (nothing is created)', () => {
  it('id, folder under the root, budgets from config, web off', async () => {
    const h = harness(tmp);
    const p = await h.manager.plan('write my SOFE 3980 lab report draft');
    expect(p).toEqual({
      id: `${TODAY}-write-my-sofe-3980-lab-report-draft`,
      task: 'write my SOFE 3980 lab report draft',
      folder: join(h.root, `${TODAY}-write-my-sofe-3980-lab-report-draft`),
      cwd: join(h.root, `${TODAY}-write-my-sofe-3980-lab-report-draft`),
      web: false,
      model: 'sonnet',
      maxTurns: 150,
      maxBudgetUsd: 5,
      wallClockMs: 45 * 60_000,
    });
    expect(existsSync(h.root)).toBe(false);
    expect(existsSync(join(h.home, 'jobs'))).toBe(false);
  });

  it('the model and effort picked in Settings > Model reach the plan and the saved spec; none picked falls back to jobs.model', async () => {
    const h = harness(tmp, { modelPrefs: () => ({ model: 'haiku', effort: 'low' }) });
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    expect(p).toMatchObject({ model: 'haiku', effort: 'low' });
    await h.manager.start(p, 'voice-ptt');
    expect(JSON.parse(readFileSync(join(h.home, 'jobs', p.id, 'spec.json'), 'utf8'))).toMatchObject({ spec: { model: 'haiku', effort: 'low' } });
    const d = harness(tmp, { modelPrefs: () => ({ model: null, effort: null }) });
    const q = await d.manager.plan('write my lab report draft');
    expect(q).toMatchObject({ model: 'sonnet' });
    expect(q).not.toHaveProperty('effort');
  });

  it('"with web" turns web on; a one-word task is refused', async () => {
    const h = harness(tmp);
    expect(await h.manager.plan('research cheap flights to vancouver with web')).toMatchObject({ web: true });
    expect(await h.manager.plan('stuff')).toEqual({ error: expect.stringMatching(/Say what the job should do/) });
  });

  it('jobs.enabled false refuses', async () => {
    const h = harness(tmp, { jobs: { enabled: false } });
    expect(await h.manager.plan('write my report draft')).toEqual({ error: expect.stringMatching(/turned off/) });
  });
});

describe('folder rules (rule 4)', () => {
  it('start: a fresh 0700 folder with input/, a 0700 meta folder, 0600 files', async () => {
    const h = harness(tmp);
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    const s = await h.manager.start(p, 'voice-ptt');
    expect(s).toMatchObject({ status: 'queued', folder: p.folder, source: 'voice-ptt' });
    expect(statSync(p.folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(p.folder, 'input')).isDirectory()).toBe(true);
    const meta = join(h.home, 'jobs', p.id);
    expect(statSync(meta).mode & 0o777).toBe(0o700);
    expect(readdirSync(meta).sort()).toEqual(['persona.md', 'settings.json', 'spec.json']);
    for (const f of readdirSync(meta)) expect(statSync(join(meta, f)).mode & 0o777, f).toBe(0o600);
    // settings.json is outside the job folder and names Stephen's home in denyRead.
    expect(readdirSync(p.folder)).toEqual(['input']);
  });

  it('the same task twice gets a second folder; an existing folder is never reused', async () => {
    const h = harness(tmp);
    const p1 = await h.manager.plan('write my lab report draft');
    if ('error' in p1) throw new Error(p1.error);
    await h.manager.start(p1, 'voice-ptt');
    const p2 = await h.manager.plan('write my lab report draft');
    expect(p2).toMatchObject({ id: `${TODAY}-write-my-lab-report-draft-2` });
  });

  it('a symlink planted at the job folder between the dialog and the start is refused; nothing is written through it', async () => {
    const h = harness(tmp);
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    const elsewhere = join(h.userHome, 'Documents');
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(h.root, { recursive: true });
    symlinkSync(elsewhere, p.folder);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await h.manager.start(p, 'voice-ptt');
    // R7: one plain sentence; the raw EEXIST reason goes to the log only.
    expect(r).toEqual({ refused: JOB_FOLDER_FAILED });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^jobs: job folder: .*EEXIST/));
    log.mockRestore();
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readJobState(h.home, p.id)).toBeNull();
  });

  it("a failed write of the job's files is one plain sentence; the raw reason goes to the log only (R7)", async () => {
    // A stephenRepo that is not a path makes jobSettings throw a raw TypeError inside the write step.
    const h = harness(tmp, { stephenRepo: 42 as unknown as string });
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await h.manager.start(p, 'voice-ptt');
    expect(r).toEqual({ refused: JOB_FILES_FAILED });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^jobs: job files: .*argument/));
    log.mockRestore();
    expect(h.supervisor.calls).toEqual([]);
  });

  it('a job runner that cannot start (spawn throws) fails the job with one plain sentence; the raw reason goes to the log only (R7)', async () => {
    const h = harness(tmp, {
      spawn: () => {
        throw new Error('spawn EACCES /secret/path/node');
      },
    });
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await h.manager.start(p, 'voice-ptt')).toMatchObject({ status: 'failed', error: JOB_RUNNER_FAILED });
      expect(readJobState(h.home, p.id)).toMatchObject({ status: 'failed', error: JOB_RUNNER_FAILED });
      expect(log).toHaveBeenCalledWith('jobs: job runner: spawn EACCES /secret/path/node');
    } finally {
      log.mockRestore();
    }
  });

  it("a job runner that emits 'error' after the spawn fails the job with one plain sentence; the raw reason goes to the log only (R7)", async () => {
    const child = Object.assign(new EventEmitter(), { unref: () => undefined }) as unknown as ChildProcess;
    const h = harness(tmp, { spawn: () => child });
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await h.manager.start(p, 'voice-ptt')).toMatchObject({ status: 'queued' });
      child.emit('error', new Error('spawn ENOENT /secret/path/node'));
      expect(readJobState(h.home, p.id)).toMatchObject({ status: 'failed', error: JOB_RUNNER_FAILED });
      expect(log).toHaveBeenCalledWith('jobs: job runner: spawn ENOENT /secret/path/node');
    } finally {
      log.mockRestore();
    }
  });

  it('a root that is a symlink is refused (plan and start)', async () => {
    const h = harness(tmp);
    const real = join(h.userHome, 'real-root');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, h.root);
    expect(await h.manager.plan('write my lab report draft')).toEqual({ error: expect.stringMatching(/must be a real folder/) });
  });

  it('a root of /, the home folder, or Stephen\'s home is refused', async () => {
    for (const root of ['/', '~', '~/.stephen', '~/.stephen/jobs-here']) {
      const h = harness(tmp, { jobs: { root } });
      expect(await h.manager.plan('write my lab report draft'), root).toEqual({ error: expect.stringMatching(/jobs.root can't be/) });
    }
  });

  it('`..`, slashes and dashes in the task never leave the root', async () => {
    const h = harness(tmp);
    const p = await h.manager.plan('../../../etc/passwd -rf --now');
    if ('error' in p) throw new Error(p.error);
    expect(p.id).toBe(`${TODAY}-etc-passwd-rf-now`);
    const s = await h.manager.start(p, 'voice-ptt');
    expect(s).toMatchObject({ status: 'queued' });
    expect(readdirSync(h.root).sort()).toEqual([p.id, 'inbox'].sort()); // the job folder and the inbox, nothing outside
    expect(jobIdArg(`../${p.id}`)).toBe(p.id);
    expect(jobIdArg('../../etc')).toBeNull();
  });
});

describe('caps (rule 5)', () => {
  it('at most 2 running jobs', async () => {
    const h = harness(tmp);
    seed(h.home, state(`${TODAY}-one`));
    expect(await h.manager.plan('write my lab report draft')).not.toHaveProperty('error');
    seed(h.home, state(`${TODAY}-two`));
    expect(await h.manager.plan('write my lab report draft')).toEqual({ error: expect.stringMatching(/2 jobs are already running/) });
  });

  it('the daily start cap counts today\'s jobs, finished ones too', async () => {
    const h = harness(tmp, { jobs: { dailyStarts: 3 } });
    for (const n of ['a', 'b', 'c']) seed(h.home, state(`${TODAY}-${n}`, { status: 'done', endedAt: NOW - 1000, pid: null }));
    seed(h.home, state('2026-11-04-yesterday', { status: 'done', endedAt: NOW - 86_400_000, pid: null }));
    expect(await h.manager.plan('write my lab report draft')).toEqual({ error: expect.stringMatching(/3 jobs today already/) });
  });

  it('start() checks the caps again (the dialog took time)', async () => {
    const h = harness(tmp);
    const p = await h.manager.plan('write my lab report draft');
    if ('error' in p) throw new Error(p.error);
    seed(h.home, state(`${TODAY}-one`));
    seed(h.home, state(`${TODAY}-two`));
    expect(await h.manager.start(p, 'voice-ptt')).toEqual({ refused: expect.stringMatching(/already running/) });
    expect(existsSync(p.folder)).toBe(false);
  });
});

describe('restart recovery: the state files are the registry', () => {
  it('a running job whose supervisor is gone → failed; its claude group is killed', async () => {
    const h = harness(tmp);
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => dead.once('exit', r));
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    await until(() => isPidAlive(orphan.pid!), 5000, 'orphan');
    seed(h.home, state(`${TODAY}-crashed`, { pid: dead.pid!, claudePid: orphan.pid! }));
    seed(h.home, state(`${TODAY}-alive`, { pid: process.pid }));
    seed(h.home, state(`${TODAY}-never-started`, { status: 'queued', pid: null, createdAt: NOW - 120_000, startedAt: null }));
    seed(h.home, state(`${TODAY}-just-queued`, { status: 'queued', pid: null, createdAt: NOW - 1000, startedAt: null }));
    const byId = Object.fromEntries(h.manager.list().map((j) => [j.id, j]));
    expect(byId[`${TODAY}-crashed`]).toMatchObject({ status: 'failed', error: expect.stringMatching(/ended without a result/) });
    expect(byId[`${TODAY}-alive`]?.status).toBe('running');
    expect(byId[`${TODAY}-never-started`]).toMatchObject({ status: 'failed', error: expect.stringMatching(/didn't start/) });
    expect(byId[`${TODAY}-just-queued`]?.status).toBe('queued');
    // Written back: a second reader (a restarted listener, `stephen jobs list`) sees failed too.
    expect(readJobState(h.home, `${TODAY}-crashed`)?.status).toBe('failed');
    await until(() => !isPidAlive(orphan.pid!), 5000, 'orphan killed');
  });

  it('a "running" job far past its deadline is failed even if its pid was reused', () => {
    const h = harness(tmp);
    const s = state(`${TODAY}-ancient`, { deadlineAt: NOW - 20 * 60_000 });
    seed(h.home, s);
    expect(reconcile(h.home, s, { now: () => NOW, alive: () => true }).status).toBe('failed');
  });

  it('listJobStates ignores files that are not job states', () => {
    const h = harness(tmp);
    mkdirSync(join(h.home, 'jobs'), { recursive: true });
    writeFileSync(join(h.home, 'jobs', 'notes.json'), '{}', { mode: 0o600 });
    writeFileSync(join(h.home, 'jobs', `${TODAY}-loose.json`), '{"version":1}', { mode: 0o644 });
    expect(listJobStates(h.home)).toEqual([]);
  });
});

describe('code jobs: a git worktree of a configured repo', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

  it('names the repo → worktree on stephen/job-<slug> as the cwd; an existing branch gets the next suffix', async () => {
    const base = join(tmp, 'repo-case');
    const repo = join(base, 'myapp');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# app\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'branch', 'stephen/job-fix-the-tests-in-myapp');
    const h = harness(tmp, { jobs: { repos: { myapp: repo } } });
    const p = await h.manager.plan('fix the tests in myapp');
    if ('error' in p) throw new Error(p.error);
    expect(p.id).toBe(`${TODAY}-fix-the-tests-in-myapp-2`);
    expect(p.repo).toEqual({ name: 'myapp', path: repo, branch: 'stephen/job-fix-the-tests-in-myapp-2' });
    expect(p.cwd).toBe(join(p.folder, 'repo'));
    const s = await h.manager.start(p, 'voice-ptt');
    expect(s).toMatchObject({ status: 'queued', cwd: join(p.folder, 'repo'), repo: { name: 'myapp', branch: 'stephen/job-fix-the-tests-in-myapp-2' } });
    expect(git(join(p.folder, 'repo'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('stephen/job-fix-the-tests-in-myapp-2');
    expect(lstatSync(join(p.folder, 'repo', 'README.md')).isFile()).toBe(true);
  });

  it('a configured path that is not a repo is refused; no repo named → a plain folder', async () => {
    const notRepo = join(tmp, 'not-a-repo');
    mkdirSync(notRepo, { recursive: true });
    const h = harness(tmp, { jobs: { repos: { thing: notRepo } } });
    expect(await h.manager.plan('fix the thing')).toEqual({ error: expect.stringMatching(/isn't a git repository/) });
    expect(await h.manager.plan('write a poem')).not.toHaveProperty('repo');
  });
});

describe('stephen jobs CLI', () => {
  it('list, status, show, stop', async () => {
    const h = harness(tmp);
    seed(h.home, state(`${TODAY}-write-my-report`, { status: 'done', pid: null, endedAt: NOW, turns: 12, costUsd: 0.5, summary: 'Wrote report.md.', folder: '/Users/cris/Stephen Jobs/x', cwd: '/Users/cris/Stephen Jobs/x', sessionId: 'abc' }));
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await runJobsCli(['list'], { manager: h.manager, out, now: () => NOW })).toBe(0);
    expect(lines.join('\n')).toMatch(new RegExp(`${TODAY}-write-my-report  done .*12 turns  \\$0\\.50`));
    lines.length = 0;
    expect(await runJobsCli(['status', `${TODAY}-write-my-report`], { manager: h.manager, out, now: () => NOW })).toBe(0);
    expect(lines.join('\n')).toMatch(/folder: {3}\/Users\/cris\/Stephen Jobs\/x[\s\S]*claude --resume abc/);
    lines.length = 0;
    expect(await runJobsCli(['show', `${TODAY}-write-my-report`], { manager: h.manager, out, now: () => NOW })).toBe(0);
    expect(lines.join('\n')).toMatch(/Folder: \/Users\/cris\/Stephen Jobs\/x[\s\S]*written by the job[\s\S]*Wrote report\.md\./);
    lines.length = 0;
    expect(await runJobsCli(['stop', `${TODAY}-write-my-report`], { manager: h.manager, out, now: () => NOW })).toBe(0);
    expect(lines.join('\n')).toMatch(/already ended \(done\)/);
    const errs: string[] = [];
    expect(await runJobsCli(['show', '../../etc'], { manager: h.manager, out, err: (l) => errs.push(l) })).toBe(2);
    expect(await runJobsCli(['start', 'x'], { manager: h.manager, out, err: (l) => errs.push(l) })).toBe(2); // no start from the CLI
    expect(await runJobsCli(['_run', '/tmp/not-a-job'], { manager: h.manager, out })).toBe(2);
  });
});

const CLI = join(stephenRepoRoot(), 'dist', 'cli.js');
describe.skipIf(!existsSync(CLI))('end to end through the real supervisor process (npm run build first)', () => {
  const real = (o: { jobs?: Record<string, unknown> } = {}) => {
    const h = harness(tmp, { ...o, spawn: undefined, now: undefined, cliPath: CLI, claudePath: FAKE_CLAUDE });
    return h;
  };
  const start = async (m: JobManager, task: string) => {
    const p = await m.plan(task);
    if ('error' in p) throw new Error(p.error);
    const s = await m.start(p, 'voice-ptt');
    if ('refused' in s) throw new Error(s.refused);
    return p;
  };

  it('start → the detached supervisor runs the job → done, with the summary; the job got the scratch env', async () => {
    const h = real();
    const p = await start(h.manager, 'write my lab report draft MODE:ok');
    await until(() => readJobState(h.home, p.id)?.status === 'done', 20_000, 'done');
    const s = readJobState(h.home, p.id)!;
    expect(s).toMatchObject({ turns: 2, costUsd: 0.42, summary: expect.stringMatching(/draft\.md/) });
    expect(s.pid).not.toBe(process.pid);
    const run = JSON.parse(String(execFileSync('cat', [join(p.folder, 'fake-run.json')]))) as { env: Record<string, string> };
    expect(JSON.stringify(run.env)).not.toMatch(/LEAK/);
  });

  it('stop → SIGTERM to the supervisor → stopped; a SIGKILLed supervisor → failed on the next list', async () => {
    const h = real();
    const p = await start(h.manager, 'write my lab report draft MODE:hang');
    await until(() => readJobState(h.home, p.id)?.status === 'running', 20_000, 'running');
    const r = await h.manager.stop(p.id, 'cli');
    expect(r).toMatchObject({ status: 'stopped' });
    const claude = readJobState(h.home, p.id)!.claudePid!;
    await until(() => !isPidAlive(claude), 5000, 'claude gone');

    const p2 = await start(h.manager, 'write my essay draft MODE:hang');
    await until(() => readJobState(h.home, p2.id)?.status === 'running', 20_000, 'running 2');
    const s2 = readJobState(h.home, p2.id)!;
    process.kill(s2.pid!, 'SIGKILL');
    await until(() => !isPidAlive(s2.pid!), 5000, 'supervisor gone');
    expect(h.manager.get(p2.id)).toMatchObject({ status: 'failed' });
    await until(() => !isPidAlive(s2.claudePid!), 5000, 'orphaned claude killed');
  });
});
