/**
 * Phone commands (source 'phone', docs/ADR-005): wake-word data rules, no confirmation dialogs (nobody is at the Mac),
 * no memory writes. Routers, trust and the serve argv.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JobRouter, PHONE_DAILY_JOBS, PHONE_JOB_START_REPLY, PHONE_JOB_STOP_REPLY } from '../../src/jobs/router.js';
import { TASK_MAX } from '../../src/jobs/spec.js';
import { writeJobState, type JobState } from '../../src/jobs/state.js';
import { PHONE_MAX_TASK } from '../../src/phone/setup.js';
import { MemoryStore } from '../../src/memory/store.js';
import { PHONE_CANCEL_REPLY, TimerRouter } from '../../src/timers/router.js';
import { TimerStore } from '../../src/timers/store.js';
import { trustOf } from '../../src/voice/assistant.js';
import { mcpConfig } from '../../src/voice/claude.js';
import { MemoryRouter, PHONE_MEMORY_REPLY } from '../../src/voice/memory-router.js';
import { NOW, TODAY, harness } from '../jobs/helpers.js';
import { FakeConfirmer } from '../server/fakes.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-phone-routers-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `h${++n}`);

describe('phone trust and serve argv', () => {
  it("source 'phone' is its own trust; its serve gets wake-word data rules and declines every confirmation", () => {
    expect(trustOf('phone')).toBe('phone');
    expect(trustOf('voice-wake')).toBe('wake');
    expect(trustOf('app')).toBe('trusted');
    expect(mcpConfig('/n', '/c', null, null, null, 'phone').mcpServers.stephen!.args).toEqual(['/c', 'serve', '--confirm', 'deny', '--voice', '--trust', 'wake']);
  });
});

describe('memory from the phone', () => {
  const setup = async () => {
    const store = new MemoryStore({ home: fresh() });
    await store.add('my gym is goodlife on king st', 'voice-ptt');
    const confirmer = new FakeConfirmer();
    return { store, confirmer, router: new MemoryRouter({ store, confirmWakeWord: true, confirmer }) };
  };

  it('remember / forget / forget everything are refused without a dialog; nothing changes', async () => {
    const t = await setup();
    for (const said of ['remember my bank is evil-bank.com', 'remember my locker is blue and play lofi', 'forget my gym', 'forget that', 'forget everything']) {
      const r = await t.router.route(said, { source: 'phone' });
      expect(r, said).toEqual({ reply: PHONE_MEMORY_REPLY, changed: false });
    }
    expect(t.confirmer.prompts).toEqual([]);
    expect((await t.store.list()).map((i) => i.text)).toEqual(['my gym is goodlife on king st']);
  });

  it('listing gives the count only', async () => {
    const r = await (await setup()).router.route('what do you remember', { source: 'phone' });
    expect(r?.reply).toMatch(/^I remember 1 thing\. Hold F5/);
    expect(r?.reply).not.toContain('goodlife');
  });
});

describe('timers from the phone', () => {
  const NOW = Date.parse('2026-11-05T19:00:00Z');
  it('R8-8: setting and cancelling are refused without a dialog; the list is a count', async () => {
    const store = new TimerStore({ home: fresh(), now: () => NOW, onFire: () => undefined });
    const confirmer = new FakeConfirmer();
    const router = new TimerRouter({ store, timeZone: 'America/Toronto', now: () => NOW, confirmer });
    expect((await router.route('set a timer for 10 minutes', { source: 'phone' }))?.reply).toBe(PHONE_CANCEL_REPLY);
    expect((await router.route('remind me in 5 minutes to call mom', { source: 'phone' }))?.reply).toBe(PHONE_CANCEL_REPLY);
    expect(store.list()).toHaveLength(0);
    store.add('timer', NOW + 600_000, '', 600_000, false); // one set at the Mac
    expect((await router.route('what timers do i have', { source: 'phone' }))?.reply).toMatch(/^You've got 1 timer.*Hold F5/);
    expect((await router.route('cancel my timer', { source: 'phone' }))?.reply).toBe(PHONE_CANCEL_REPLY);
    expect((await router.route('cancel all timers', { source: 'phone' }))?.reply).toBe(PHONE_CANCEL_REPLY);
    expect(confirmer.prompts).toEqual([]);
    expect(store.list()).toHaveLength(1);
    store.stop();
  });
});

describe('jobs from the phone (through ask)', () => {
  it('start and stop are refused without a dialog; the list works', async () => {
    const h = harness(join(tmp, 'jobs'));
    const confirmer = new FakeConfirmer();
    const router = new JobRouter({ jobs: h.manager, confirmer, stopWaitMs: 50 });
    expect(await router.route('start a job to write a poem about rivers', { source: 'phone' })).toEqual({ reply: PHONE_JOB_START_REPLY, changed: false });
    expect(await router.route('stop the job', { source: 'phone' })).toEqual({ reply: PHONE_JOB_STOP_REPLY, changed: false });
    expect((await router.route("how's the job going", { source: 'phone' }))?.reply).toBeTruthy();
    expect(confirmer.prompts).toEqual([]);
  });
});

describe('a job approved on the phone (startFromPhone)', () => {
  const done = (id: string, source: string): JobState => ({
    version: 1, id, task: 'x y', status: 'done', folder: '/x', cwd: '/x', source, createdAt: NOW - 600_000, startedAt: NOW - 600_000, endedAt: NOW - 1000,
    deadlineAt: NOW, pid: null, claudePid: null, sessionId: '', model: 'sonnet', web: false, maxTurns: 150, maxBudgetUsd: 5,
    wallClockMs: 2_700_000, repo: null, turns: 1, toolCalls: 0, costUsd: 0.1, denials: 0, summary: '', error: '',
  });

  it('starts with no Mac dialog, source phone, web only as asked; same budgets as the Mac', async () => {
    const h = harness(join(tmp, 'jobs2'));
    const confirmer = new FakeConfirmer();
    const router = new JobRouter({ jobs: h.manager, confirmer, stopWaitMs: 50 });
    const reply = await router.startFromPhone('research the history of the printing press on the web', false);
    expect(reply.ok).toBe(true);
    expect(reply.text).toMatch(/^Job started: "research the history of the printing press on the web"\. Up to 45 minutes, web off, no input files/);
    expect(confirmer.prompts).toEqual([]);
    const [job] = h.manager.list();
    expect(job).toMatchObject({ source: 'phone', web: false, maxTurns: 150, maxBudgetUsd: 5 });
    expect(h.supervisor.calls).toHaveLength(1);
    expect((await router.startFromPhone('find three articles about rivers', true)).text).toMatch(/web on/);
    expect(h.manager.list().find((j) => j.task.startsWith('find'))).toMatchObject({ web: true, source: 'phone' });
  });

  it(`at most ${PHONE_DAILY_JOBS} a day from the phone (jobs from the Mac don't count)`, async () => {
    const h = harness(join(tmp, 'jobs3'));
    mkdirSync(join(h.home, 'jobs'), { recursive: true, mode: 0o700 });
    for (let i = 1; i <= PHONE_DAILY_JOBS; i++) writeJobState(h.home, done(`${TODAY}-phone-job-${i}`, 'phone'));
    writeJobState(h.home, done(`${TODAY}-mac-job`, 'voice-ptt'));
    const router = new JobRouter({ jobs: h.manager, confirmer: new FakeConfirmer(), stopWaitMs: 50 });
    expect(await router.startFromPhone('write a poem about rivers', false)).toEqual({ ok: false, text: expect.stringMatching(/jobs from your phone today already/) });
    expect(h.supervisor.calls).toHaveLength(0);
  });

  it('the manager refusals pass through (too short, jobs off)', async () => {
    const h = harness(join(tmp, 'jobs4'), { jobs: { enabled: false } });
    const router = new JobRouter({ jobs: h.manager, confirmer: new FakeConfirmer(), stopWaitMs: 50 });
    expect(await router.startFromPhone('write a poem', false)).toEqual({ ok: false, text: expect.stringMatching(/turned off/) });
  });

  it('R8-2: no inbox files join a phone job; a task naming a repo is refused; over 500 characters is refused, not cut', async () => {
    const repo = join(tmp, 'myrepo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    const h = harness(join(tmp, 'jobs5'), { jobs: { repos: { stephen: repo } } });
    mkdirSync(join(h.root, 'inbox'), { recursive: true });
    writeFileSync(join(h.root, 'inbox', 'transcript.pdf'), 'private');
    const router = new JobRouter({ jobs: h.manager, confirmer: new FakeConfirmer(), stopWaitMs: 50 });
    expect((await router.startFromPhone('summarize my notes about rivers', true)).ok).toBe(true);
    const [job] = h.manager.list();
    expect(readdirSync(join(job!.folder, 'input'))).toEqual([]);
    expect(existsSync(join(h.root, 'inbox', 'transcript.pdf'))).toBe(true); // still there for a Mac job
    expect(await router.startFromPhone('add a short comment to the readme in stephen', false)).toEqual({ ok: false, text: expect.stringMatching(/Start code jobs at the Mac/) });
    expect(await router.startFromPhone(`write ${'x'.repeat(500)}`, false)).toEqual({ ok: false, text: expect.stringMatching(/too long/) });
    expect(h.supervisor.calls).toHaveLength(1);
    expect(PHONE_MAX_TASK).toBe(TASK_MAX);
  });

  it('R8-3: parallel phone starts cannot pass the caps together', async () => {
    const h = harness(join(tmp, 'jobs6'), { jobs: { maxRunning: 1 } });
    const router = new JobRouter({ jobs: h.manager, confirmer: new FakeConfirmer(), stopWaitMs: 50 });
    const rs = await Promise.all(['one', 'two', 'three', 'four'].map((n) => router.startFromPhone(`write poem number ${n}`, false)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(h.manager.list()).toHaveLength(1);
    // R8-4: each refusal after approval is audited with its reason.
    expect(h.audit.entries.filter((e) => e.tool === 'job_start' && e.outcome === 'error')).toHaveLength(3);
  });
});
