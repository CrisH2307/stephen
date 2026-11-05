/**
 * The finish flow (docs/ADR-004): a job that reaches a final status is announced once (notification + spoken summary),
 * a restart doesn't repeat it, the summary is only ever cleaned text, "show my job" speaks the latest finished job, and
 * the Jobs tab protocol (jobs.list / jobs.stop) carries no secrets and caps its text.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppServer } from '../../src/app/server.js';
import { APP_JOB_ID_RE } from '../../src/app/jobs-status.js';
import { JOB_ID_RE } from '../../src/jobs/spec.js';
import { appJobs, jobRow } from '../../src/voice/job-rows.js';
import { FinishWatcher, firstSentence, finishTitle, spokenFinish } from '../../src/jobs/finish.js';
import { parseJobIntent } from '../../src/jobs/intent.js';
import { JobRouter } from '../../src/jobs/router.js';
import { jobsDir, writeJobState, type JobState } from '../../src/jobs/state.js';
import { notifyArgv } from '../../src/timers/notify.js';
import { TestClient } from '../app/helpers.js';
import { NOW, TODAY, harness, tempRoot } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-finish');
afterAll(cleanup);

const job = (id: string, o: Partial<JobState> = {}): JobState => ({
  version: 1, id, task: 'write my lab report draft', status: 'running', folder: `/Users/x/Stephen Jobs/${id}`, cwd: `/Users/x/Stephen Jobs/${id}`, source: 'voice-ptt',
  createdAt: NOW - 600_000, startedAt: NOW - 600_000, endedAt: null, deadlineAt: NOW + 2_000_000, pid: process.pid, claudePid: null, sessionId: 'sess-1', model: 'sonnet',
  web: false, maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000, repo: null, turns: 7, toolCalls: 3, costUsd: 0.2, denials: 0, summary: '', error: '', ...o,
});
const finished = (id: string, o: Partial<JobState> = {}) => job(id, { status: 'done', endedAt: NOW - 60_000, pid: null, summary: 'I wrote the draft. It has four sections and a short conclusion.', ...o });

describe('spoken text', () => {
  it('first sentence, capped, no ellipsis', () => {
    expect(firstSentence('I wrote the draft. It has four sections.')).toBe('I wrote the draft');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
    const long = `${'word '.repeat(80)}end.`;
    const s = firstSentence(long, 200);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith(' ')).toBe(false);
    expect(firstSentence('')).toBe('');
  });

  it('the line names the task, says what happened and points at "show my job" and the Jobs tab', () => {
    expect(spokenFinish(finished('2026-11-05-a'))).toBe("Your job 'write my lab report draft' is done: I wrote the draft. Say 'show my job' or open the Jobs tab for the rest.");
    expect(spokenFinish(finished('2026-11-05-a', { status: 'failed', error: 'The job ran out of budget.' }))).toContain("failed: The job ran out of budget.");
    expect(spokenFinish(finished('2026-11-05-a', { status: 'timeout', summary: '', error: '' }))).toBe("Your job 'write my lab report draft' hit its time limit. Say 'show my job' or open the Jobs tab for the rest.");
    expect(finishTitle('done')).toBe('Stephen job done');
    expect(finishTitle('failed')).toBe('Stephen job failed');
    expect(finishTitle('stopped')).toBe('Stephen job stopped');
    expect(finishTitle('timeout')).toBe('Stephen job timed out');
  });

  it('the notification text only ever travels as argv, never inside the script', () => {
    const argv = notifyArgv('Stephen job done', 'x" & do shell script "touch /tmp/pwned" & "');
    expect(argv.slice(0, 6).join(' ')).not.toContain('pwned');
    expect(argv.slice(0, 6).join(' ')).toContain('item 2 of argv');
    expect(argv.at(-2)).toContain('pwned');
    expect(argv.at(-1)).toBe('Stephen job done');
  });
});

describe('FinishWatcher', () => {
  function watch(jobs: () => JobState[], home: string, o: { now?: () => number } = {}) {
    const said: string[] = [];
    const notes: [string, string][] = [];
    const w = new FinishWatcher({ home, list: jobs, notify: (t, b) => notes.push([t, b]), say: (t) => said.push(t), now: o.now ?? (() => NOW) });
    return { w, said, notes };
  }

  it('announces a job that reached a final status once, not while it runs, and not again on the next poll', () => {
    const h = harness(tmp);
    let list = [job('2026-11-05-a')];
    const t = watch(() => list, h.home);
    t.w.poll();
    expect(t.said).toEqual([]);
    list = [finished('2026-11-05-a')];
    t.w.poll();
    t.w.poll();
    expect(t.said).toHaveLength(1);
    expect(t.notes).toEqual([['Stephen job done', 'write my lab report draft']]);
  });

  it('a restart (new watcher, same home) does not repeat it; a job that ends meanwhile is announced', () => {
    const h = harness(tmp);
    const list = [finished('2026-11-05-a')];
    const first = watch(() => list, h.home);
    first.w.poll();
    expect(first.said).toHaveLength(1);
    const second = watch(() => list, h.home);
    second.w.poll();
    expect(second.said).toEqual([]);
    expect(second.notes).toEqual([]);
    list.push(finished('2026-11-05-b', { task: 'research laptops', status: 'failed', error: 'Out of turns.' }));
    second.w.poll();
    expect(second.said).toHaveLength(1);
    expect(second.notes).toEqual([['Stephen job failed', 'research laptops']]);
    const mode = statSync(join(jobsDir(h.home), '.announced.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('jobs that ended long ago are marked seen without a word; at most three are told at once', () => {
    const h = harness(tmp);
    const old = finished('2026-11-01-old', { endedAt: NOW - 3 * 86_400_000 });
    const many = ['a', 'b', 'c', 'd', 'e'].map((x, i) => finished(`2026-11-05-${x}`, { endedAt: NOW - 1000 * (10 - i) }));
    const t = watch(() => [old, ...many], h.home);
    t.w.poll();
    expect(t.said).toHaveLength(3);
    expect(t.said.join(' ')).not.toContain('2026-11-01');
    t.w.poll();
    expect(t.said).toHaveLength(3);
  });

  it('a throwing list does not throw', () => {
    const h = harness(tmp);
    const t = watch(() => {
      throw new Error('disk gone');
    }, h.home);
    expect(() => t.w.poll()).not.toThrow();
  });

  it('reads real state files: a job the supervisor finishes is announced', () => {
    const h = harness(tmp);
    mkdirOf(h.home);
    writeJobState(h.home, job('2026-11-05-real'));
    const t = watch(() => h.manager.list(), h.home);
    t.w.poll();
    expect(t.said).toEqual([]);
    writeJobState(h.home, finished('2026-11-05-real', { summary: 'Done <b>now</b>. Link https://evil.example/x?token=abc.' }));
    t.w.poll();
    expect(t.said).toHaveLength(1);
    expect(t.said[0]).not.toContain('https://');
  });
});

import { mkdirSync } from 'node:fs';
function mkdirOf(home: string): void {
  mkdirSync(jobsDir(home), { recursive: true, mode: 0o700 });
}

describe('"show my job"', () => {
  it.each(['show my job', 'show the job', 'what did the job say', 'what did my job find', 'read me the job summary', 'show me the latest job result', 'the job summary'])('is the show intent: %s', (said) => {
    expect(parseJobIntent(said)).toEqual({ kind: 'show' });
  });
  it('the list phrases stay lists', () => {
    for (const s of ['show my jobs', 'list my jobs', 'what are my jobs', 'is the job done yet']) expect(parseJobIntent(s)).toEqual({ kind: 'list' });
  });

  it('speaks the latest finished job (capped), prints the folder, runs no Claude; the wake word gets a count only', async () => {
    const h = harness(tmp);
    mkdirOf(h.home);
    writeJobState(h.home, finished('2026-11-04-old', { task: 'old one', endedAt: NOW - 86_400_000, summary: 'Old summary.' }));
    writeJobState(h.home, finished('2026-11-05-new', { summary: `${'Lots of words. '.repeat(100)}` }));
    writeJobState(h.home, job('2026-11-05-run', { task: 'still going' }));
    const printed: string[] = [];
    const router = new JobRouter({ jobs: h.manager, confirmer: { kind: 'fake', confirm: async () => 'declined' }, now: () => NOW, print: (l) => printed.push(l) });
    const r = await router.route('show my job', { source: 'voice-ptt' });
    expect(r?.reply).toBe("Your job 'write my lab report draft' is done: Lots of words.");
    expect(printed).toEqual(['Job folder: /Users/x/Stephen Jobs/2026-11-05-new']);
    const w = await router.route('show my job', { source: 'voice-wake' });
    expect(w?.reply).toMatch(/Hold F5/);
    expect(w?.reply).not.toContain('Lots');
    expect(printed).toHaveLength(1);
  });

  it('nothing finished yet', async () => {
    const h = harness(tmp);
    const router = new JobRouter({ jobs: h.manager, confirmer: { kind: 'fake', confirm: async () => 'declined' }, now: () => NOW });
    expect((await router.route('show my job', { source: 'voice-ptt' }))?.reply).toBe('No finished jobs yet.');
    mkdirOf(h.home);
    writeJobState(h.home, job('2026-11-05-run'));
    expect((await router.route('what did the job say', { source: 'voice-ptt' }))?.reply).toBe("Your job hasn't finished yet.");
    expect(TODAY).toBe('2026-11-05');
  });
});

describe('jobs.list / jobs.stop over app.sock', () => {
  const servers: AppServer[] = [];
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) await s.close();
  });

  async function serve(h: ReturnType<typeof harness> | null) {
    const server = new AppServer({
      home: h?.home ?? tmp,
      socketPath: join(tmp, `app-${Math.random().toString(36).slice(2, 8)}.sock`),
      queue: { busy: () => false, start: () => null, stop: () => undefined },
      listening: () => true,
      model: 'sonnet',
      memory: null,
      endConversation: () => undefined,
      history: null,
      audit: null,
      settings: () => ({ config: {}, configPath: '/x/config.json' }),
      ...(h ? { jobs: appJobs(h.manager, 100) } : {}),
      speakReplies: false,
      openWindow: () => null,
    });
    await server.start();
    servers.push(server);
    const c = await TestClient.connect(server.socketPath);
    clients.push(c);
    return c;
  }

  it('lists rows with capped, cleaned text and no pids, session ids or secrets', async () => {
    const h = harness(tmp);
    mkdirOf(h.home);
    writeJobState(h.home, finished('2026-11-05-a', { summary: `ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD ${'x '.repeat(2000)}`, sessionId: 'sess-secret-1' }));
    const c = await serve(h);
    const r = await c.request({ id: 'j1', type: 'jobs.list' });
    expect(r.type).toBe('jobs');
    const rows = r.jobs as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '2026-11-05-a', status: 'done', turns: 7, folder: '/Users/x/Stephen Jobs/2026-11-05-a' });
    expect((rows[0]!.summary as string).length).toBeLessThanOrEqual(1500);
    const wire = JSON.stringify(r);
    expect(wire).not.toContain('ghp_');
    expect(wire).not.toContain('sess-secret-1');
    expect(wire).not.toContain('"pid"');
    expect(Object.keys(jobRow(finished('2026-11-05-a'))).sort()).toEqual(['costUsd', 'createdAt', 'endedAt', 'error', 'folder', 'id', 'startedAt', 'status', 'summary', 'task', 'turns']);
  });

  it('the window and the jobs module agree on what a job id is', () => {
    expect(APP_JOB_ID_RE.source).toBe(JOB_ID_RE.source);
  });

  it('jobs off: an empty list and a refusal to stop', async () => {
    const c = await serve(null);
    expect(await c.request({ id: 'j2', type: 'jobs.list' })).toEqual({ id: 'j2', type: 'jobs', jobs: [] });
    expect(await c.request({ id: 'j3', type: 'jobs.stop', jobId: '2026-11-05-a' })).toEqual({ id: 'j3', type: 'error', message: 'jobs are turned off' });
  });

  it('stop: an unknown id is refused, a bad id is invalid, a queued job is stopped by "app" without a dialog', async () => {
    const h = harness(tmp);
    mkdirOf(h.home);
    writeJobState(h.home, job('2026-11-05-q', { status: 'queued', pid: null, startedAt: null, createdAt: NOW - 1000 }));
    const c = await serve(h);
    expect(await c.request({ id: 's1', type: 'jobs.stop', jobId: '2026-11-01-gone' })).toEqual({ id: 's1', type: 'error', message: "There's no job 2026-11-01-gone." });
    expect((await c.request({ id: 's2', type: 'jobs.stop', jobId: '../x' })).type).toBe('error');
    const r = await c.request({ id: 's3', type: 'jobs.stop', jobId: '2026-11-05-q' });
    expect(r).toMatchObject({ id: 's3', type: 'job', job: { id: '2026-11-05-q', status: 'stopped' } });
    expect(h.audit.entries.some((e) => e.tool === 'job_stop' && (e.args as { by: string }).by === 'app')).toBe(true);
    // Stopping an already-final job returns it as it is.
    expect(await c.request({ id: 's4', type: 'jobs.stop', jobId: '2026-11-05-q' })).toMatchObject({ type: 'job', job: { status: 'stopped' } });
  });
});
