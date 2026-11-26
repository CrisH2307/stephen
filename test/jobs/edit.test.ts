/**
 * ADR-010 Edit request ([DEV REVIEW]): an edited job is a NEW job (new id, editOf, version) that starts only after the
 * owner approves the same job dialog, with every field shown. The old job's state, folder, logs and worktree are
 * never written or reused; its folder is copied (regular files only, symlinks skipped, capped). Only the window socket
 * may ask, and never while the old job is queued or running.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppServer } from '../../src/app/server.js';
import { COPY_GONE, COPY_MAX_FILES, COPY_TOO_BIG, EDIT_STOP_FIRST, copyJobFolder, type GitFn } from '../../src/jobs/manager.js';
import { JobRouter } from '../../src/jobs/router.js';
import { EDIT_RECORD_HEAD, EDIT_REQUEST_MAX, EDIT_REQUEST_TOO_LONG, TASK_MAX, editedTask, jobFiles, requestOf } from '../../src/jobs/spec.js';
import { parseJobState, readJobState, statePath, writeJobState, type JobState } from '../../src/jobs/state.js';
import { readPrivateJsonFile } from '../../src/lib/fs.js';
import type { ConfirmPrompt } from '../../src/types.js';
import { appJobs, jobVersions } from '../../src/voice/job-rows.js';
import { TestClient } from '../app/helpers.js';
import { NOW, TODAY, harness, tempRoot, type Harness } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-edit');
afterAll(cleanup);

/** Every path under `dir` (no follow) with its type, size, mode and content hash: "never written" means equal. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
      const hash = kind === 'file' ? createHash('sha256').update(readFileSync(p)).digest('hex') : '';
      out.push(`${relative(dir, p)} ${kind} ${st.size} ${st.mode} ${st.mtimeMs} ${hash}`);
      if (kind === 'dir') walk(p);
    }
  };
  walk(dir);
  return out;
}

/** A dialog that records what it showed and answers `answer`. */
function dialog(answer: 'approved' | 'declined' | 'unavailable' | 'throw') {
  const shown: ConfirmPrompt[] = [];
  return {
    shown,
    confirmer: {
      kind: 'fake',
      confirm: async (p: ConfirmPrompt) => {
        shown.push(p);
        if (answer === 'throw') throw new Error('no dialog');
        return answer;
      },
    },
  };
}

/** A real job started through the manager (supervisor recorded, not run), then marked `status`. */
async function oldJob(h: Harness, task: string, status: JobState['status'] = 'done', extra: Partial<JobState> = {}): Promise<JobState> {
  const p = await h.manager.plan(task);
  if ('error' in p) throw new Error(p.error);
  const s = await h.manager.start(p, 'voice-ptt');
  if ('refused' in s) throw new Error(s.refused);
  const final = status === 'queued' || status === 'running';
  const next: JobState = { ...s, status, endedAt: final ? null : NOW - 1000, summary: final ? '' : 'Wrote the draft.', ...(status === 'running' ? { pid: process.pid } : {}), ...extra };
  writeJobState(h.home, next);
  return next;
}

const jobIds = (h: Harness) => h.manager.list().map((j) => j.id).sort();

describe('the edited task and the state fields', () => {
  it('quotes the old request as "Earlier request (a record)", then the edited request; an edit of an edit quotes only the last request', () => {
    const t = editedTask('write my lab report draft', 'write my lab report draft for SOFE 3980');
    expect(t).toBe(`${EDIT_RECORD_HEAD}"write my lab report draft" Edited request: write my lab report draft for SOFE 3980`);
    expect(requestOf(t)).toBe('write my lab report draft for SOFE 3980');
    const t2 = editedTask(t, 'write it in French');
    expect(t2).toBe(`${EDIT_RECORD_HEAD}"write my lab report draft for SOFE 3980" Edited request: write it in French`);
    // Within TASK_MAX, the edited request kept whole: the quoted old one is what gets shortened.
    const long = editedTask('a '.repeat(400), 'b '.repeat(150));
    expect([...long].length).toBeLessThanOrEqual(TASK_MAX);
    expect(long.endsWith(` Edited request: ${'b '.repeat(150).trim()}`)).toBe(true);
  });

  it('editOf and editVersion parse field by field; bad values are dropped, not trusted', () => {
    const base = { version: 1, id: `${TODAY}-x-v2`, task: 't t', status: 'done', folder: '/a', cwd: '/a', source: 'app', createdAt: 1 };
    expect(parseJobState({ ...base, editOf: `${TODAY}-x`, editVersion: 2 }, base.id)).toMatchObject({ editOf: `${TODAY}-x`, editVersion: 2 });
    expect(parseJobState(base, base.id)).not.toHaveProperty('editOf');
    for (const bad of [
      { editOf: '../etc', editVersion: 2 },
      { editOf: `${TODAY}-x`, editVersion: 1 },
      { editOf: `${TODAY}-x`, editVersion: 2.5 },
      { editOf: `${TODAY}-x`, editVersion: '2' },
      { editOf: `${TODAY}-x` },
      { editOf: base.id, editVersion: 2 },
    ]) {
      const s = parseJobState({ ...base, ...bad }, base.id);
      expect(s).not.toBeNull();
      expect(s).not.toHaveProperty('editOf');
      expect(s).not.toHaveProperty('editVersion');
    }
  });
});

describe('Edit request: a NEW job, only after the owner approves the job dialog again', () => {
  it('approved: a new id with editOf and version 2; the dialog showed every field; the old state, folder and logs are untouched', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    writeFileSync(join(old.folder, 'draft.md'), '# Draft\n');
    mkdirSync(join(old.folder, 'notes'));
    writeFileSync(join(old.folder, 'notes', 'a.txt'), 'note');
    const oldState = readFileSync(statePath(h.home, old.id), 'utf8');
    const oldFolder = snapshot(old.folder);
    const oldMeta = snapshot(join(h.home, 'jobs', old.id));
    const d = dialog('approved');
    const router = new JobRouter({ jobs: h.manager, confirmer: d.confirmer, now: () => NOW });
    const r = await router.editJob(old.id, 'write my lab report draft for SOFE 3980');
    if ('refused' in r) throw new Error(r.refused);
    expect(r.id).toBe(`${TODAY}-write-my-lab-report-draft-v2`);
    expect(r.id).not.toBe(old.id);
    expect(r).toMatchObject({ status: 'queued', editOf: old.id, editVersion: 2, source: 'app', folder: join(h.root, r.id) });
    expect(r.task).toBe(`${EDIT_RECORD_HEAD}"write my lab report draft" Edited request: write my lab report draft for SOFE 3980`);
    expect(readJobState(h.home, r.id)).toMatchObject({ editOf: old.id, editVersion: 2 });
    // The dialog, once, with every field: the edit, the task, the folder, the copied input, budgets, web, model.
    expect(d.shown).toHaveLength(1);
    const body = d.shown[0]!.body;
    expect(d.shown[0]!.title).toBe('Stephen: start a background job?');
    expect(body).toContain(`Edited job, from ${old.id}.`);
    expect(body).toContain('Task: ');
    expect(body).toContain('Earlier request (a record)');
    expect(body).toContain(`Folder: a new folder in ${h.root}, next to the old one. Its name is shown when the job starts.`);
    expect(body).not.toMatch(/-v\d/);
    expect(body).not.toMatch(/version/i);
    expect(body).toContain(`Input files: a copy of the old job folder ${old.folder} (2 files, 0.0 MB; symlinks are skipped). The inbox is not used.`);
    expect(body).toMatch(/Budgets: up to 45 minutes, 150 turns, \$5\./);
    expect(body).toContain('Web: off.');
    expect(body).toMatch(/Model: /);
    // The copy is in the new folder; the old job is exactly as it was.
    expect(readFileSync(join(r.folder, 'draft.md'), 'utf8')).toBe('# Draft\n');
    expect(readFileSync(join(r.folder, 'notes', 'a.txt'), 'utf8')).toBe('note');
    expect(readFileSync(statePath(h.home, old.id), 'utf8')).toBe(oldState);
    expect(snapshot(old.folder)).toEqual(oldFolder);
    expect(snapshot(join(h.home, 'jobs', old.id))).toEqual(oldMeta);
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: 'job_start', outcome: 'ok', args: { id: r.id, editOf: old.id, version: 2, source: 'app' } });
  });

  it.each(['declined', 'unavailable', 'throw'] as const)('dialog %s: no state file, no meta folder, no job folder; nothing starts', async (answer) => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const before = { ids: jobIds(h), root: readdirSync(h.root).sort(), jobs: readdirSync(join(h.home, 'jobs')).sort(), spawns: h.supervisor.calls.length };
    const d = dialog(answer);
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'write my lab report draft again');
    expect(r).toHaveProperty('refused');
    expect(d.shown).toHaveLength(1);
    expect(jobIds(h)).toEqual(before.ids);
    expect(readdirSync(h.root).sort()).toEqual(before.root);
    expect(readdirSync(join(h.home, 'jobs')).sort()).toEqual(before.jobs); // no state file, no meta folder
    expect(h.supervisor.calls.length).toBe(before.spawns);
  });

  it.each(['queued', 'running'] as const)('refused while the old job is %s: no dialog, nothing created', async (status) => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft', status);
    const d = dialog('approved');
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'write my lab report draft again');
    expect(r).toEqual({ refused: EDIT_STOP_FIRST });
    expect(EDIT_STOP_FIRST).toBe('Stop the job first to change its request.');
    expect(d.shown).toEqual([]);
    expect(jobIds(h)).toEqual([old.id]);
  });

  it.each(['done', 'failed', 'stopped', 'timeout'] as const)('a %s job can be edited', async (status) => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft', status);
    const r = await new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer }).editJob(old.id, 'write my lab report draft again');
    expect(r).toMatchObject({ editOf: old.id, editVersion: 2 });
  });

  it('nothing of the old job is reused unless the dialog shows it: web, budgets and the inbox come fresh', async () => {
    const h = harness(tmp);
    // The old job had web and bigger budgets (as if the settings were different then).
    const old = await oldJob(h, 'find 5 internships with web', 'done', { web: true, maxBudgetUsd: 50, maxTurns: 900, wallClockMs: 240 * 60_000 });
    mkdirSync(join(h.root, 'inbox'), { recursive: true });
    writeFileSync(join(h.root, 'inbox', 'resume.pdf'), 'pdf');
    const d = dialog('approved');
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'find 5 internships in Toronto');
    if ('refused' in r) throw new Error(r.refused);
    expect(r).toMatchObject({ web: false, maxBudgetUsd: h.config.maxBudgetUsd, maxTurns: h.config.maxTurns, wallClockMs: h.config.wallClockMin * 60_000 });
    expect(d.shown[0]!.body).toContain('Web: off. The job has no internet.');
    // The inbox stays for the next new job; the new job's input is only the copy the dialog named.
    expect(existsSync(join(h.root, 'inbox', 'resume.pdf'))).toBe(true);
    expect(existsSync(join(r.folder, 'input', 'resume.pdf'))).toBe(false);
    // Web again only when the edited request asks and the dialog says so.
    writeJobState(h.home, { ...r, status: 'done', endedAt: NOW });
    const r2 = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(r.id, 'find 5 internships in Toronto with web');
    if ('refused' in r2) throw new Error(r2.refused);
    expect(r2.web).toBe(true);
    expect(d.shown[1]!.body).toMatch(/Web: ON\./);
    expect(d.shown[1]!.body).not.toContain('-v3'); // the old id (a -v2 job) is named; the new version never is
  });

  it('an edit of an edit is version 3 with the same name; versions show as "Version N of M"', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const router = new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer });
    const v2 = await router.editJob(old.id, 'write my lab report draft longer');
    if ('refused' in v2) throw new Error(v2.refused);
    writeJobState(h.home, { ...v2, status: 'done', endedAt: NOW });
    const v3 = await router.editJob(v2.id, 'write my lab report draft shorter');
    if ('refused' in v3) throw new Error(v3.refused);
    expect(v3).toMatchObject({ id: `${TODAY}-write-my-lab-report-draft-v3`, editOf: v2.id, editVersion: 3 });
    const v = jobVersions(h.manager.list());
    expect(v.get(old.id)).toEqual({ version: 1, versions: 3 });
    expect(v.get(v2.id)).toEqual({ version: 2, versions: 3 });
    expect(v.get(v3.id)).toEqual({ version: 3, versions: 3 });
    const rows = appJobs(h.manager, router).list();
    expect(rows.find((x) => x.id === v3.id)).toMatchObject({ version: 3, versions: 3, request: 'write my lab report draft shorter' });
  });
});

describe('versions and ids: the family\'s top version + 1, claimed atomically; the caps count edits', () => {
  it('two edits of version 1 give version 2 and version 3, with distinct ids', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const router = new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer });
    const a = await router.editJob(old.id, 'write my lab report draft longer');
    const b = await router.editJob(old.id, 'write my lab report draft shorter');
    if ('refused' in a || 'refused' in b) throw new Error('refused');
    expect([a.editVersion, b.editVersion]).toEqual([2, 3]);
    expect([a.editOf, b.editOf]).toEqual([old.id, old.id]);
    expect([a.id, b.id]).toEqual([`${TODAY}-write-my-lab-report-draft-v2`, `${TODAY}-write-my-lab-report-draft-v3`]);
    expect(jobVersions(h.manager.list()).get(old.id)).toEqual({ version: 1, versions: 3 });
  });

  it('a race (two dialogs open at once, both planned as version 2): the second start claims the next version; two distinct ids', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    // Both dialogs are open before either is answered, so both plans pick the same id.
    let release: () => void = () => undefined;
    const bothShown = new Promise<void>((r) => (release = r));
    const shown: ConfirmPrompt[] = [];
    const confirmer = {
      kind: 'fake',
      confirm: async (p: ConfirmPrompt) => {
        shown.push(p);
        if (shown.length === 2) release();
        await bothShown;
        return 'approved' as const;
      },
    };
    const router = new JobRouter({ jobs: h.manager, confirmer });
    const [a, b] = await Promise.all([router.editJob(old.id, 'write my lab report draft longer'), router.editJob(old.id, 'write my lab report draft shorter')]);
    if ('refused' in a || 'refused' in b) throw new Error('refused');
    // Neither dialog named a version, a -v<N> folder or a -v<N> branch: what they showed stays true after the retry.
    expect(shown).toHaveLength(2);
    for (const p of shown) {
      expect(p.body).not.toMatch(/-v\d/);
      expect(p.body).not.toMatch(/version/i);
      expect(p.body).toContain(`Folder: a new folder in ${h.root}, next to the old one.`);
    }
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect([a.editVersion, b.editVersion].sort()).toEqual([2, 3]);
    for (const j of [a, b]) {
      expect(readJobState(h.home, j.id)).toMatchObject({ id: j.id, folder: join(h.root, j.id), editVersion: j.editVersion });
      expect(existsSync(j.folder)).toBe(true);
    }
  });

  it('the same race through the manager: planned twice, started twice, the folders never shared', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    writeFileSync(join(old.folder, 'draft.md'), 'v1');
    const p1 = await h.manager.planEdit(old.id, 'write my lab report draft longer');
    const p2 = await h.manager.planEdit(old.id, 'write my lab report draft shorter');
    if ('error' in p1 || 'error' in p2) throw new Error('error');
    expect(p1.id).toBe(p2.id);
    const s1 = await h.manager.start(p1, 'app');
    const s2 = await h.manager.start(p2, 'app');
    if ('refused' in s1 || 'refused' in s2) throw new Error('refused');
    expect(s1.id).toBe(`${TODAY}-write-my-lab-report-draft-v2`);
    expect(s2.id).toBe(`${TODAY}-write-my-lab-report-draft-v3`);
    expect(s2).toMatchObject({ editVersion: 3, folder: join(h.root, s2.id), cwd: join(h.root, s2.id) });
    expect(s2.task).toContain('shorter');
    expect(readFileSync(join(s2.folder, 'draft.md'), 'utf8')).toBe('v1');
  });

  it('an edited job counts toward the daily cap, the one a phone start is checked against too', async () => {
    const h = harness(tmp, { jobs: { dailyStarts: 2 } });
    const old = await oldJob(h, 'write my lab report draft');
    const router = new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer });
    const e = await router.editJob(old.id, 'write my lab report draft longer');
    if ('refused' in e) throw new Error(e.refused);
    expect(e.id.startsWith(TODAY)).toBe(true);
    expect(h.manager.capError()).toBe("That's 2 jobs today already, the daily limit.");
    expect(await h.manager.plan('write a poem about rain')).toEqual({ error: "That's 2 jobs today already, the daily limit." });
    expect(await router.startFromPhone('write a poem about rain', false)).toEqual({ ok: false, text: "That's 2 jobs today already, the daily limit." });
    writeJobState(h.home, { ...e, status: 'done', endedAt: NOW });
    expect(await router.editJob(e.id, 'write my lab report draft again')).toEqual({ refused: "That's 2 jobs today already, the daily limit." });
  });
});

describe('the folder copy: regular files only, symlinks skipped, capped, the old folder never written', () => {
  it('skips symlinks (to a file, to a folder, dangling) and never follows them', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const outside = join(tmp, 'outside-secret');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    writeFileSync(join(old.folder, 'keep.txt'), 'keep');
    symlinkSync(join(outside, 'secret.txt'), join(old.folder, 'link-file'));
    symlinkSync(outside, join(old.folder, 'link-dir'));
    symlinkSync(join(tmp, 'nowhere'), join(old.folder, 'dangling'));
    const before = snapshot(old.folder);
    const r = await new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer }).editJob(old.id, 'write my lab report draft again');
    if ('refused' in r) throw new Error(r.refused);
    expect(readdirSync(r.folder).sort()).toEqual(['input', 'keep.txt']);
    expect(lstatSync(join(r.folder, 'keep.txt')).isFile()).toBe(true);
    expect(statSync(join(r.folder, 'keep.txt')).mode & 0o777).toBe(0o600);
    expect(snapshot(old.folder)).toEqual(before);
  });

  it(`over ${COPY_MAX_FILES} files: refused with the message before the dialog; nothing is created`, async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const many = join(old.folder, 'many');
    mkdirSync(many);
    for (let i = 0; i < COPY_MAX_FILES; i++) writeFileSync(join(many, `f${i}`), '');
    const d = dialog('approved');
    const before = readdirSync(h.root).sort();
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'write my lab report draft again');
    expect(r).toEqual({ refused: COPY_TOO_BIG });
    expect(COPY_TOO_BIG).toBe('The old job folder is too big to copy. Start a new job instead.');
    expect(d.shown).toEqual([]);
    expect(readdirSync(h.root).sort()).toEqual(before);
    expect(jobIds(h)).toEqual([old.id]);
    // The dry walk counts folders too (many/ and input/), so this is over the cap as well.
    expect(copyJobFolder(old.folder, null)).toEqual({ error: COPY_TOO_BIG });
  }, 60_000);

  it('over 500 MB: refused with the message before the dialog; nothing is created', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const big = join(old.folder, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 500 * 1024 * 1024 + 1); // sparse: the size counts, no disk used
    const d = dialog('approved');
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'write my lab report draft again');
    expect(r).toEqual({ refused: COPY_TOO_BIG });
    expect(d.shown).toEqual([]);
    expect(jobIds(h)).toEqual([old.id]);
    truncateSync(big, 500 * 1024 * 1024); // exactly the cap is allowed
    expect(copyJobFolder(old.folder, null)).toMatchObject({ files: 1 });
  });

  it('a folder that grew past the cap while the dialog was open: the start refuses and removes the new folders', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    writeFileSync(join(old.folder, 'small.txt'), 'x');
    const confirmer = {
      kind: 'fake',
      confirm: async () => {
        mkdirSync(join(old.folder, 'grown'));
        for (let i = 0; i < COPY_MAX_FILES; i++) writeFileSync(join(old.folder, 'grown', `g${i}`), '');
        return 'approved' as const;
      },
    };
    const before = readdirSync(h.root).sort();
    const r = await new JobRouter({ jobs: h.manager, confirmer }).editJob(old.id, 'write my lab report draft again');
    expect(r).toEqual({ refused: COPY_TOO_BIG });
    expect(readdirSync(h.root).sort()).toEqual(before);
    expect(readdirSync(join(h.home, 'jobs')).filter((n) => n.includes('-v2'))).toEqual([]);
    expect(h.supervisor.calls.length).toBe(1); // only the old job's
  }, 60_000);
});

describe('code jobs: a NEW worktree branch cut from the old job\'s branch; the old worktree is untouched', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

  it('new branch from the old branch\'s commit, new cwd; the old branch and worktree stay as they were', async () => {
    const repo = join(tmp, 'edit-repo', 'myapp');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# app\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const h = harness(tmp, { jobs: { repos: { myapp: repo } } });
    const old = await oldJob(h, 'fix the tests in myapp');
    const oldTree = join(old.folder, 'repo');
    writeFileSync(join(oldTree, 'fix.txt'), 'fixed\n');
    git(oldTree, 'add', '.');
    git(oldTree, 'commit', '-q', '-m', 'job work');
    const oldHead = git(repo, 'rev-parse', `refs/heads/${old.repo!.branch}`).trim();
    const oldSnap = snapshot(oldTree);
    const d = dialog('approved');
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'fix the tests in myapp and the lint');
    if ('refused' in r) throw new Error(r.refused);
    expect(r.repo).toEqual({ name: 'myapp', branch: `stephen/job-fix-the-tests-in-myapp-v2` });
    expect(r.repo!.branch).not.toBe(old.repo!.branch);
    expect(r.cwd).toBe(join(r.folder, 'repo'));
    expect(r.cwd).not.toBe(old.cwd);
    expect(git(r.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(r.repo!.branch);
    expect(git(r.cwd, 'rev-parse', 'HEAD').trim()).toBe(oldHead);
    expect(readFileSync(join(r.cwd, 'fix.txt'), 'utf8')).toBe('fixed\n');
    expect(git(repo, 'rev-parse', `refs/heads/${old.repo!.branch}`).trim()).toBe(oldHead);
    expect(snapshot(oldTree)).toEqual(oldSnap);
    expect(d.shown[0]!.body).toContain(`on a new branch, cut from the old job's branch ${old.repo!.branch}. Its name is shown when the job starts. The old worktree is not used. Nothing is pushed.`);
    expect(d.shown[0]!.body).not.toMatch(/-v\d/);
  });

  const repoAt = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), '# app\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
  };

  it('stays on the old job\'s repo when the edited text names another repo or a path', async () => {
    const repo = repoAt(join(tmp, 'edit-repo3', 'myapp'));
    const other = repoAt(join(tmp, 'edit-repo3', 'otherapp'));
    const h = harness(tmp, { jobs: { repos: { myapp: repo, otherapp: other } } });
    const old = await oldJob(h, 'fix the tests in myapp');
    const router = new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer });
    const r = await router.editJob(old.id, 'fix the tests in otherapp instead');
    if ('refused' in r) throw new Error(r.refused);
    expect(r.repo?.name).toBe('myapp');
    expect(git(repo, 'branch', '--list', r.repo!.branch).trim()).not.toBe('');
    expect(git(other, 'branch', '--list', 'stephen/*').trim()).toBe('');
    writeJobState(h.home, { ...r, status: 'done', endedAt: NOW });
    const r2 = await router.editJob(r.id, `fix the tests in ${other} and /tmp`);
    if ('refused' in r2) throw new Error(r2.refused);
    expect(r2.repo?.name).toBe('myapp');
    expect(git(r2.cwd, 'rev-parse', '--show-toplevel').trim()).toBe(r2.cwd);
    expect(git(other, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('declined: no state file, no meta folder, no job folder, no worktree, no branch', async () => {
    const repo = repoAt(join(tmp, 'edit-repo4', 'myapp'));
    const h = harness(tmp, { jobs: { repos: { myapp: repo } } });
    const old = await oldJob(h, 'fix the tests in myapp');
    const before = { jobs: readdirSync(join(h.home, 'jobs')).sort(), root: readdirSync(h.root).sort(), trees: git(repo, 'worktree', 'list'), branches: git(repo, 'branch', '--list') };
    const d = dialog('declined');
    expect(await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'fix the tests in myapp again')).toEqual({ refused: "Okay, I didn't start it." });
    expect(d.shown).toHaveLength(1);
    expect(readdirSync(join(h.home, 'jobs')).sort()).toEqual(before.jobs);
    expect(readdirSync(h.root).sort()).toEqual(before.root);
    expect(git(repo, 'worktree', 'list')).toBe(before.trees);
    expect(git(repo, 'branch', '--list')).toBe(before.branches);
  });

  it('the old branch is gone: refused, no dialog', async () => {
    const repo = join(tmp, 'edit-repo2', 'myapp');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# app\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const h = harness(tmp, { jobs: { repos: { myapp: repo } } });
    const old = await oldJob(h, 'fix the tests in myapp');
    git(repo, 'worktree', 'remove', '--force', join(old.folder, 'repo'));
    git(repo, 'branch', '-D', old.repo!.branch);
    const d = dialog('approved');
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'fix the tests in myapp again');
    expect(r).toEqual({ refused: `The old job's branch ${old.repo!.branch} is gone. Start a new job instead.` });
    expect(d.shown).toEqual([]);
  });
});

describe('review fixes: a symlink swap while the dialog is open, a failed worktree add, the edited text kept whole', () => {
  /** A folder outside the job root with a secret, standing in for ~/.ssh. */
  const secretDir = (name: string) => {
    const d = join(tmp, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'id_ed25519'), 'SECRET KEY');
    return d;
  };
  const anyFileHolds = (dir: string, text: string): boolean =>
    readdirSync(dir, { recursive: true, withFileTypes: true }).some((e) => e.isFile() && readFileSync(join(e.parentPath, e.name), 'utf8').includes(text));

  it('the top folder swapped for a symlink after planning: nothing is copied, the start fails closed, no new folders', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    writeFileSync(join(old.folder, 'draft.md'), 'draft');
    const p = await h.manager.planEdit(old.id, 'write my lab report draft again');
    if ('error' in p) throw new Error(p.error);
    // While the dialog is open: the old folder becomes a symlink to the secret folder.
    renameSync(old.folder, `${old.folder}.moved`);
    symlinkSync(secretDir('ssh-top'), old.folder);
    const root = readdirSync(h.root).sort();
    const jobs = readdirSync(join(h.home, 'jobs')).sort();
    expect(await h.manager.start(p, 'app')).toEqual({ refused: COPY_GONE });
    expect(readdirSync(h.root).sort()).toEqual(root);
    expect(readdirSync(join(h.home, 'jobs')).sort()).toEqual(jobs);
    expect(existsSync(p.folder)).toBe(false);
    expect(anyFileHolds(join(h.home, 'jobs'), 'SECRET KEY')).toBe(false);
  });

  it('a subfolder swapped for a symlink between the check and the read: the copy fails closed and copies nothing of it', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    mkdirSync(join(old.folder, 'notes'));
    writeFileSync(join(old.folder, 'notes', 'a.txt'), 'note');
    const dst = join(tmp, 'sub-swap-dst');
    mkdirSync(dst);
    const outside = secretDir('ssh-sub');
    const swap = (dir: string) => {
      if (dir !== join(old.folder, 'notes')) return;
      renameSync(dir, `${dir}.moved`);
      symlinkSync(outside, dir);
    };
    expect(copyJobFolder(old.folder, dst, swap)).toEqual({ error: COPY_GONE });
    expect(anyFileHolds(dst, 'SECRET KEY')).toBe(false);
  });

  it('a subfolder swapped for a symlink after planning: the start copies the rest and never follows it', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    mkdirSync(join(old.folder, 'notes'));
    writeFileSync(join(old.folder, 'notes', 'a.txt'), 'note');
    const p = await h.manager.planEdit(old.id, 'write my lab report draft again');
    if ('error' in p) throw new Error(p.error);
    rmSync(join(old.folder, 'notes'), { recursive: true });
    symlinkSync(secretDir('ssh-sub2'), join(old.folder, 'notes'));
    const s = await h.manager.start(p, 'app');
    if ('refused' in s) throw new Error(s.refused);
    expect(existsSync(join(s.folder, 'notes'))).toBe(false);
    expect(anyFileHolds(s.folder, 'SECRET KEY')).toBe(false);
  });

  it('a code job whose worktree add fails after approval: the claimed job folder and meta folder are removed', async () => {
    const repo = join(tmp, 'edit-repo5', 'myapp');
    mkdirSync(repo, { recursive: true });
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# app\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    let failWorktree = false;
    const gitFn: GitFn = async (args) => {
      if (failWorktree && args.includes('worktree')) return { code: 128, stdout: '', stderr: 'fatal: could not create work tree' };
      try {
        return { code: 0, stdout: execFileSync('git', args as string[], { encoding: 'utf8' }), stderr: '' };
      } catch (e) {
        return { code: 1, stdout: '', stderr: String((e as { stderr?: string }).stderr ?? '') };
      }
    };
    const h = harness(tmp, { jobs: { repos: { myapp: repo } }, git: gitFn });
    const old = await oldJob(h, 'fix the tests in myapp');
    failWorktree = true;
    const root = readdirSync(h.root).sort();
    const jobs = readdirSync(join(h.home, 'jobs')).sort();
    const r = await new JobRouter({ jobs: h.manager, confirmer: dialog('approved').confirmer }).editJob(old.id, 'fix the tests in myapp again');
    expect(r).toEqual({ refused: expect.stringMatching(/couldn't make a git worktree of myapp \(fatal: could not create work tree\)/) });
    expect(readdirSync(h.root).sort()).toEqual(root);
    expect(readdirSync(join(h.home, 'jobs')).sort()).toEqual(jobs);
    // A new (not edited) code job fails the same way, and leaves nothing either.
    const p = await h.manager.plan('fix the lint in myapp');
    if ('error' in p) throw new Error(p.error);
    expect(await h.manager.start(p, 'voice-ptt')).toHaveProperty('refused');
    expect(readdirSync(h.root).sort()).toEqual(root);
    expect(readdirSync(join(h.home, 'jobs')).sort()).toEqual(jobs);
  });

  it(`an edited request of ${EDIT_REQUEST_MAX} characters is kept whole, even after a long old request; one more is refused`, async () => {
    const h = harness(tmp);
    const old = await oldJob(h, `write ${'my lab report draft '.repeat(30)}`.trim());
    expect([...old.task].length).toBe(TASK_MAX); // the longest old request
    const max = `write ${'x'.repeat(EDIT_REQUEST_MAX - 6)}`;
    expect([...max].length).toBe(EDIT_REQUEST_MAX);
    const d = dialog('approved');
    const router = new JobRouter({ jobs: h.manager, confirmer: d.confirmer });
    const r = await router.editJob(old.id, max);
    if ('refused' in r) throw new Error(r.refused);
    expect([...r.task].length).toBeLessThanOrEqual(TASK_MAX);
    expect(r.task.endsWith(` Edited request: ${max}`)).toBe(true);
    expect(requestOf(r.task)).toBe(max);
    expect(d.shown[0]!.body).toContain(max);
    // One character more: refused with the message, before any dialog.
    writeJobState(h.home, { ...r, status: 'done', endedAt: NOW });
    const before = d.shown.length;
    expect(await router.editJob(r.id, `${max}y`)).toEqual({ refused: EDIT_REQUEST_TOO_LONG });
    expect(EDIT_REQUEST_TOO_LONG).toBe(`The edited request is too long (at most ${EDIT_REQUEST_MAX} characters). Shorten it and try again.`);
    expect(d.shown.length).toBe(before);
  });
});

describe('jobs.edit over app.sock: the window only', () => {
  const servers: AppServer[] = [];
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) await s.close();
  });

  async function serve(h: Harness, answer: 'approved' | 'declined' = 'approved') {
    const d = dialog(answer);
    const server = new AppServer({
      home: h.home,
      socketPath: join(tmp, `e-${Math.random().toString(36).slice(2, 8)}.sock`),
      queue: { busy: () => false, start: () => null, stop: () => undefined },
      listening: () => true,
      model: 'sonnet',
      memory: null,
      endConversation: () => undefined,
      history: null,
      audit: null,
      settings: () => ({ config: {}, configPath: '/x/config.json' }),
      jobs: appJobs(h.manager, new JobRouter({ jobs: h.manager, confirmer: d.confirmer }), 100),
      speakReplies: false,
      openWindow: () => null,
    });
    await server.start();
    servers.push(server);
    const connect = async (hello: boolean) => {
      const c = await TestClient.connect(server.socketPath);
      clients.push(c);
      if (hello) await c.request({ id: 'h', type: 'hello', version: '1', confirms: true });
      return c;
    };
    return { d, connect };
  }

  it('from the window: the new job comes back as a row with its version', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const s = await serve(h);
    const w = await s.connect(true);
    const r = await w.request({ id: 'e1', type: 'jobs.edit', jobId: old.id, text: 'write my lab report draft again' });
    expect(r).toMatchObject({ id: 'e1', type: 'job', job: { id: `${TODAY}-write-my-lab-report-draft-v2`, status: 'queued', version: 2, versions: 2, request: 'write my lab report draft again' } });
    expect(s.d.shown).toHaveLength(1);
  });

  it('refused from a non-window socket and from a gate (serve) socket: no dialog, nothing created', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const s = await serve(h);
    const plain = await s.connect(false);
    expect(await plain.request({ id: 'e1', type: 'jobs.edit', jobId: old.id, text: 'write my lab report draft again' })).toEqual({ id: 'e1', type: 'error', message: 'Only the Stephen window can edit a job request.' });
    const gate = await s.connect(true);
    gate.send({ id: 'g0', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await gate.request({ id: 'e2', type: 'jobs.edit', jobId: old.id, text: 'write my lab report draft again' })).toEqual({ id: 'e2', type: 'error', message: 'Only the Stephen window can edit a job request.' });
    expect(s.d.shown).toEqual([]);
    expect(jobIds(h)).toEqual([old.id]);
  });

  it('refused on the server while the old job is running', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft', 'running');
    const s = await serve(h);
    const w = await s.connect(true);
    expect(await w.request({ id: 'e1', type: 'jobs.edit', jobId: old.id, text: 'write my lab report draft again' })).toEqual({ id: 'e1', type: 'error', message: EDIT_STOP_FIRST });
    expect(s.d.shown).toEqual([]);
  });

  it('declined in the dialog: an error answer, nothing created', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const s = await serve(h, 'declined');
    const w = await s.connect(true);
    expect(await w.request({ id: 'e1', type: 'jobs.edit', jobId: old.id, text: 'write my lab report draft again' })).toEqual({ id: 'e1', type: 'error', message: "Okay, I didn't start it." });
    expect(jobIds(h)).toEqual([old.id]);
  });

  it('a bad job id or a too-long request is invalid before anything runs', async () => {
    const h = harness(tmp);
    const s = await serve(h);
    const w = await s.connect(true);
    expect(await w.request({ id: 'e1', type: 'jobs.edit', jobId: '../x', text: 'a b' })).toMatchObject({ type: 'error' });
    expect(await w.request({ id: 'e2', type: 'jobs.edit', jobId: `${TODAY}-x`, text: 'a'.repeat(501) })).toMatchObject({ type: 'error', message: expect.stringMatching(/too long/) });
    expect(s.d.shown).toEqual([]);
  });
});

describe('R9 L2: an edited job says it starts from an earlier job\'s files (src/jobs/manager.ts)', () => {
  const specOf = (h: Harness, id: string) => {
    const r = readPrivateJsonFile(jobFiles(join(h.home, 'jobs', id)).spec);
    if (!('state' in r)) throw new Error('no spec.json');
    return (r.state as { spec: { earlier?: boolean; task: string } }).spec;
  };

  it('the edit\'s spec is marked earlier (its prompt will say the files are data); a new job\'s is not', async () => {
    const h = harness(tmp);
    const old = await oldJob(h, 'write my lab report draft');
    const d = dialog('approved');
    const r = await new JobRouter({ jobs: h.manager, confirmer: d.confirmer }).editJob(old.id, 'write my lab report draft for SOFE 3980');
    if ('refused' in r) throw new Error(r.refused);
    expect(specOf(h, r.id).earlier).toBe(true);
    expect(specOf(h, old.id).earlier).toBeUndefined();
  }, 60_000);
});
