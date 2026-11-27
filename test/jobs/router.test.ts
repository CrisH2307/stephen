/**
 * Starting a job by voice (docs/ADR-004 rules 1 and 2): the anchored grammar, the native dialog for EVERY start (F5,
 * typed and wake word alike; a declined or missing dialog creates nothing), wake-word trust for stop and list, and
 * the Assistant handling job phrases with zero Claude runs.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runListen, type ListenEnv } from '../../src/voice/index.js';
import { fakeClaudePath, readFakeLog, RecordingChimes, RecordingSpeaker } from '../voice/helpers.js';
import { parseJobIntent, startsWithWork } from '../../src/jobs/intent.js';
import { JOB_SOMETHING_WRONG, JobRouter, startPrompt } from '../../src/jobs/router.js';
import { writeJobState, type JobState } from '../../src/jobs/state.js';
import type { ConfirmOutcome, ConfirmPrompt, Confirmer } from '../../src/types.js';
import { Assistant, type CommandRunner } from '../../src/voice/assistant.js';
import type { ClaudeOutcome } from '../../src/voice/claude.js';
import { NOW, TODAY, harness, tempRoot } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-router');
afterAll(cleanup);

class FakeConfirmer implements Confirmer {
  readonly kind = 'fake';
  prompts: ConfirmPrompt[] = [];
  constructor(private readonly answer: ConfirmOutcome | 'throw') {}
  async confirm(p: ConfirmPrompt): Promise<ConfirmOutcome> {
    this.prompts.push(p);
    if (this.answer === 'throw') throw new Error('osascript crashed');
    return this.answer;
  }
}

describe('parseJobIntent: the anchored grammar', () => {
  it.each([
    ["while I'm cooking, write my SOFE 3980 lab report draft", 'write my SOFE 3980 lab report draft'],
    ["Stephen, while I'm cooking write my sofe 3980 lab report draft", 'write my sofe 3980 lab report draft'],
    ['while i am at the gym, research the best budget laptops', 'research the best budget laptops'],
    ["while i'm cooking dinner put together a study guide for chapter 4", 'put together a study guide for chapter 4'],
    ['in the background, research the history of the printing press', 'research the history of the printing press'],
    ['in the background research cheap flights with web', 'research cheap flights with web'],
    ['start a job to write my lab report', 'write my lab report'],
    ['hey stephen start a job that summarizes my lecture notes.', 'summarizes my lecture notes'],
    ['can you start a background job to fix the tests in stephen', 'fix the tests in stephen'],
    ['kick off a job to draft my cover letter', 'draft my cover letter'],
  ])('start: %s', (said, task) => {
    expect(parseJobIntent(said)).toEqual({ kind: 'start', task });
  });

  it.each([
    ['stephen, stop the job', 'one'],
    ['cancel the job', 'one'],
    ['stop my background job', 'one'],
    ['stop all jobs', 'all'],
    ['cancel all my jobs', 'all'],
  ])('stop: %s', (said, which) => {
    expect(parseJobIntent(said)).toEqual({ kind: 'stop', which });
  });

  it('stop the job about <words>', () => {
    expect(parseJobIntent('stop the job about the lab report')).toEqual({ kind: 'stop', which: { query: 'the lab report' } });
  });

  it.each(['what are my jobs', "how's the job going", 'how is my job going', 'is the job done yet', 'list my jobs', 'jobs status', 'what jobs are running'])('list: %s', (said) => {
    expect(parseJobIntent(said)).toEqual({ kind: 'list' });
  });

  it.each([
    "while I'm cooking, play some lofi",
    'while im cooking open youtube',
    "while I'm at it, write my report",
    'play music in the background',
    'in the background play some jazz',
    'write my lab report in the background',
    'research cheap flights while i am away',
    'start a job',
    'what is a job interview',
    'stop the music',
    'set a timer for 10 minutes',
    'remind me to start a job to write my report',
  ])('not a job command (goes to Claude): %s', (said) => {
    expect(parseJobIntent(said)).toBeNull();
  });

  it('work verbs and phrases', () => {
    expect(startsWithWork('write my essay')).toBe(true);
    expect(startsWithWork('figure out the bug')).toBe(true);
    expect(startsWithWork('play a song')).toBe(false);
    expect(startsWithWork('put on some music')).toBe(false);
  });
});

const running = (id: string, task: string, o: Partial<JobState> = {}): JobState => ({
  version: 1, id, task, status: 'running', folder: '/x', cwd: '/x', source: 'voice-ptt', createdAt: NOW - 600_000, startedAt: NOW - 600_000, endedAt: null,
  deadlineAt: NOW + 2_000_000, pid: process.pid, claudePid: null, sessionId: '', model: 'sonnet', web: false, maxTurns: 150, maxBudgetUsd: 5,
  wallClockMs: 2_700_000, repo: null, turns: 7, toolCalls: 3, costUsd: 0.2, denials: 0, summary: '', error: '', ...o,
});

function setup(answer: ConfirmOutcome | 'throw' = 'approved', jobs: Record<string, unknown> = {}) {
  const h = harness(tmp, { jobs });
  const confirmer = new FakeConfirmer(answer);
  const router = new JobRouter({ jobs: h.manager, confirmer, now: () => NOW, stopWaitMs: 50 });
  return { ...h, confirmer, router };
}

describe('JobRouter: every start asks in the native dialog', () => {
  it('F5 (trusted) still gets the dialog; Allow starts the job', async () => {
    const t = setup('approved');
    const r = await t.router.route("while i'm cooking, write my sofe 3980 lab report draft", { source: 'voice-ptt', raw: "While I'm cooking, write my SOFE 3980 lab report draft." });
    expect(t.confirmer.prompts).toHaveLength(1);
    expect(r?.reply).toMatch(/^Bet, job started\. I've got up to 45 minutes/);
    const id = `${TODAY}-write-my-sofe-3980-lab-report-draft`;
    expect(t.manager.get(id)).toMatchObject({ status: 'queued', task: 'write my SOFE 3980 lab report draft', source: 'voice-ptt' });
    expect(t.supervisor.calls).toHaveLength(1);
  });

  it('the dialog shows the exact task, folder, budgets and web off; wake word adds a warning', async () => {
    const t = setup('declined');
    await t.router.route('start a job to write my lab report', { source: 'voice-wake' });
    const p = t.confirmer.prompts[0]!;
    expect(p.title).toBe('Stephen: start a background job?');
    expect(p.body).toContain('Task: «write my lab report»');
    expect(p.body).toContain(`Folder: ${join(t.root, `${TODAY}-write-my-lab-report`)}`);
    expect(p.body).toContain('Budgets: up to 45 minutes, 150 turns, $5.');
    expect(p.body).toContain('Web: off. The job has no internet.');
    expect(p.body).toMatch(/after the wake word/);
    const web = startPrompt({ id: 'x', task: 'research x with web', folder: '/f', cwd: '/f', web: true, model: 'sonnet', maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 60_000 }, 'voice-ptt');
    expect(web.body).toMatch(/Web: ON/);
    expect(web.body).not.toMatch(/wake word/);
  });

  it.each(['declined', 'unavailable', 'throw'] as const)('a %s dialog creates nothing (no folder, no state, no supervisor)', async (answer) => {
    const t = setup(answer);
    const r = await t.router.route('in the background, research the printing press', { source: 'voice-wake' });
    expect(r?.reply).toMatch(answer === 'declined' ? /Okay, I didn't start it/ : /couldn't show the confirmation dialog/);
    expect(existsSync(t.root)).toBe(false);
    expect(existsSync(join(t.home, 'jobs')) ? readdirSync(join(t.home, 'jobs')) : []).toEqual([]);
    expect(t.supervisor.calls).toEqual([]);
    expect(t.audit.entries).toContainEqual(expect.objectContaining({ tool: 'job_start', outcome: 'denied' }));
  });

  it('a capped start never shows a dialog', async () => {
    const t = setup('approved');
    mkdirSync(join(t.home, 'jobs'), { recursive: true });
    writeJobState(t.home, running(`${TODAY}-a`, 'write a'));
    writeJobState(t.home, running(`${TODAY}-b`, 'write b'));
    const r = await t.router.route('start a job to write my lab report', { source: 'voice-ptt' });
    expect(r?.reply).toMatch(/already running/);
    expect(t.confirmer.prompts).toEqual([]);
  });
});

describe('R7: an unexpected job error is one plain sentence', () => {
  const RAW = 'ENOENT: no such file or directory, /Users/x/.stephen/jobs';
  async function withSpy<T>(fn: () => Promise<T>): Promise<{ r: T; logged: string }> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await fn();
      return { r, logged: spy.mock.calls.flat().join('\n') };
    } finally {
      spy.mockRestore();
    }
  }

  it('voice or typed: the reply is the constant; the raw text goes to the log only', async () => {
    const t = setup('approved');
    vi.spyOn(t.manager, 'plan').mockRejectedValue(new Error(RAW));
    const { r, logged } = await withSpy(() => t.router.route('in the background, research the printing press', { source: 'voice-ptt' }));
    expect(r).toEqual({ reply: JOB_SOMETHING_WRONG, changed: false });
    expect(logged).toContain(RAW);
  });

  it('a phone start: the same constant; the raw text goes to the log only', async () => {
    const t = setup('approved');
    vi.spyOn(t.manager, 'plan').mockRejectedValue(new Error(RAW));
    const { r, logged } = await withSpy(() => t.router.startFromPhone('research the printing press', false));
    expect(r).toEqual({ ok: false, text: JOB_SOMETHING_WRONG });
    expect(logged).toContain(RAW);
  });
});

describe('JobRouter: list and stop', () => {
  it('list: details for F5, a count only after the wake word', async () => {
    const t = setup();
    mkdirSync(join(t.home, 'jobs'), { recursive: true });
    writeJobState(t.home, running(`${TODAY}-lab`, 'write my lab report'));
    expect((await t.router.route("how's the job going", { source: 'voice-ptt' }))?.reply).toBe('"write my lab report" has been running for 10 minutes, 7 turns so far.');
    expect((await t.router.route("how's the job going", { source: 'voice-wake' }))?.reply).toBe("You've got 1 job running. Hold F5 and ask again to hear them.");
    expect((await setup().router.route('what are my jobs', { source: 'voice-ptt' }))?.reply).toBe('No jobs running.');
  });

  it('stop: one running job is stopped (F5: no dialog); none → says so', async () => {
    const t = setup('declined');
    expect((await t.router.route('stop the job', { source: 'voice-ptt' }))?.reply).toBe('No job is running.');
    mkdirSync(join(t.home, 'jobs'), { recursive: true });
    // A queued job (no supervisor yet) stops at once.
    writeJobState(t.home, running(`${TODAY}-lab`, 'write my lab report', { status: 'queued', pid: null, createdAt: NOW - 1000 }));
    expect((await t.router.route('stop the job', { source: 'voice-ptt' }))?.reply).toBe('Stopped the job "write my lab report". What it made so far is in its folder.');
    expect(t.confirmer.prompts).toEqual([]);
    expect(t.manager.get(`${TODAY}-lab`)?.status).toBe('stopped');
  });

  it('stop after the wake word asks; Deny keeps it running', async () => {
    const t = setup('declined');
    mkdirSync(join(t.home, 'jobs'), { recursive: true });
    writeJobState(t.home, running(`${TODAY}-lab`, 'write my lab report', { status: 'queued', pid: null, createdAt: NOW - 1000 }));
    expect((await t.router.route('cancel the job', { source: 'voice-wake' }))?.reply).toBe('Okay, it keeps running.');
    expect(t.confirmer.prompts[0]?.title).toBe('Stephen: stop a job?');
    expect(t.manager.get(`${TODAY}-lab`)?.status).toBe('queued');
  });

  it('two running: "stop the job" asks which; "stop the job about lab" picks it', async () => {
    const t = setup();
    mkdirSync(join(t.home, 'jobs'), { recursive: true });
    writeJobState(t.home, running(`${TODAY}-lab`, 'write my lab report', { status: 'queued', pid: null, createdAt: NOW - 1000 }));
    writeJobState(t.home, running(`${TODAY}-essay`, 'draft my history essay', { status: 'queued', pid: null, createdAt: NOW - 2000 }));
    expect((await t.router.route('stop the job', { source: 'voice-ptt' }))?.reply).toMatch(/2 jobs running: .* Say "stop the job about"/);
    expect((await t.router.route('stop the job about the lab report', { source: 'voice-ptt' }))?.reply).toMatch(/Stopped the job "write my lab report"/);
    expect(t.manager.get(`${TODAY}-essay`)?.status).toBe('queued');
  });
});

describe('the Assistant: job phrases never reach Claude', () => {
  it('start / list / stop are answered by the router; other phrases go to Claude', async () => {
    const t = setup('declined');
    const prompts: string[] = [];
    const runner: CommandRunner = {
      async run(p: string): Promise<ClaudeOutcome> {
        prompts.push(p);
        return { kind: 'ok', text: 'ok', sessionId: null, costUsd: null, turns: 1 };
      },
      cancel: () => false,
    };
    const a = new Assistant({ runner, speaker: { speak: () => ({ done: Promise.resolve(), cancel: () => undefined }) }, chimes: { play: () => undefined }, speak: false, status: () => undefined, jobs: t.router });
    for (const s of ["while I'm cooking, write my lab report", 'what are my jobs', 'stop the job']) {
      const r = await a.command(s, { source: 'voice-wake' });
      expect(r.ranClaude, s).toBe(false);
    }
    expect(t.confirmer.prompts).toHaveLength(1); // the start, after the wake word too
    const r = await a.command('write my lab report in the background', { source: 'voice-wake' });
    expect(r.ranClaude).toBe(true);
    expect(prompts).toEqual(['write my lab report in the background']);
  });
});

describe('stephen listen --text', () => {
  it('"start a job to …": the dialog decides; Deny makes nothing; Allow starts the supervisor; the voice Claude never runs', async () => {
    const h = harness(tmp);
    const log = join(h.home, 'fake.log');
    const speaker = new RecordingSpeaker();
    const sup: (readonly string[])[] = [];
    const env = (confirmer: Confirmer): ListenEnv => ({
      loadConfig: () => ({ home: h.home, voice: { claudePath: fakeClaudePath() }, accounts: { timeZone: 'America/Toronto' }, jobs: { root: h.root } }),
      out: () => undefined,
      err: () => undefined,
      speaker,
      chimes: new RecordingChimes(),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      env: { ...process.env, FAKE_CLAUDE_LOG: log, HOME: h.userHome },
      now: () => NOW,
      confirmer,
      jobSpawn: (_cmd, args) => {
        sup.push(args);
        return spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      },
    });
    const deny = new FakeConfirmer('declined');
    expect(await runListen(['--text', 'start a job to write my lab report draft'], env(deny))).toBe(0);
    expect(deny.prompts).toHaveLength(1);
    expect(speaker.said.at(-1)).toBe("Okay, I didn't start it.");
    expect(existsSync(h.root)).toBe(false);
    expect(await runListen(['--text', 'start a job to write my lab report draft'], env(new FakeConfirmer('approved')))).toBe(0);
    expect(speaker.said.at(-1)).toMatch(/^Bet, job started/);
    expect(sup).toHaveLength(1);
    expect(sup[0]!.slice(0, 3)).toEqual(['/opt/stephen/dist/cli.js', 'jobs', '_run']);
    expect(readFakeLog(log)).toHaveLength(0);
  });
});
