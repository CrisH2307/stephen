/**
 * The job supervisor with a fake claude (test/jobs/fake-claude-job.mjs): spawn with the exact argv and the scratch
 * environment, stream-json progress, the lock-down check on init, the wall-clock kill (fake timers; SIGTERM then
 * SIGKILL after 10 s), stop, crash → failed, the sandbox's fail-closed refusal, output cleaning, caffeinate on macOS.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { JobPlan } from '../../src/jobs/manager.js';
import { JobSupervisor, parseJobLine, resultStatus, type SupervisorSpec } from '../../src/jobs/runner.js';
import { JOB_ENV_KEYS, buildJobArgs, jobFiles } from '../../src/jobs/spec.js';
import { readJobState, statePath, type JobState } from '../../src/jobs/state.js';
import { readPrivateJsonFile } from '../../src/lib/fs.js';
import { isPidAlive } from '../../src/lib/process.js';
import { FakeAudit, fakeClaudeSpawn, harness, tempRoot, type Harness } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-runner');
afterAll(cleanup);
afterEach(() => vi.useRealTimers());

/** Plan + start (the supervisor spawn is recorded, not run), then the supervisor spec that start() wrote. */
async function started(task: string, h: Harness = harness(tmp)): Promise<{ h: Harness; plan: JobPlan; sup: SupervisorSpec; state: JobState }> {
  const plan = await h.manager.plan(task);
  if ('error' in plan) throw new Error(plan.error);
  const st = await h.manager.start(plan, 'voice-ptt');
  if ('refused' in st) throw new Error(st.refused);
  const r = readPrivateJsonFile(jobFiles(join(h.home, 'jobs', plan.id)).spec);
  if (!('state' in r)) throw new Error('no spec.json');
  return { h, plan, sup: r.state as SupervisorSpec, state: st };
}

/** Yield to real I/O without timers (works under fake timers). */
const tick = () => new Promise((r) => setImmediate(r));
async function untilIo(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms; // Date is real: only setTimeout/clearTimeout are faked
  while (!cond()) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await tick();
  }
}

describe('parseJobLine / resultStatus', () => {
  it('reads init, assistant turns, denials and the result; ignores the rest', () => {
    expect(parseJobLine('{"type":"system","subtype":"init","tools":["Bash","Read"],"mcp_servers":[],"session_id":"s"}')).toEqual({ kind: 'init', tools: ['Bash', 'Read'], mcpServers: 0, mcpServerNames: [], sessionId: 's' });
    expect(parseJobLine('{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"stephen_phone"},{"x":1}],"session_id":"s"}')).toMatchObject({ mcpServers: 2, mcpServerNames: ['stephen_phone', '?'] });
    expect(parseJobLine('{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use"},{"type":"text"}]}}')).toEqual({ kind: 'assistant', messageId: 'm1', toolUses: 1 });
    expect(parseJobLine('{"type":"system","subtype":"permission_denied"}')).toEqual({ kind: 'denied' });
    expect(parseJobLine('{"type":"stream_event"}')).toBeNull();
    expect(parseJobLine('not json')).toBeNull();
    expect(parseJobLine('{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":3,"total_cost_usd":0.1,"permission_denials":[{},{}]}')).toMatchObject({ kind: 'result', turns: 3, costUsd: 0.1, denials: 2, text: 'ok' });
  });

  it('maps results to statuses in Stephen\'s words', () => {
    const base = { kind: 'result' as const, subtype: 'success', isError: false, text: '', turns: 1, costUsd: 0, denials: 0, startupFailure: '', errors: [] };
    const b = { maxTurns: 150, maxBudgetUsd: 5 };
    expect(resultStatus(base, b)).toEqual({ status: 'done', error: '' });
    expect(resultStatus({ ...base, subtype: 'error_max_turns', isError: true }, b).error).toMatch(/ran out of turns \(150\)/);
    expect(resultStatus({ ...base, subtype: 'error_max_budget_usd', isError: true }, b).error).toMatch(/\$5 budget/);
    expect(resultStatus({ ...base, subtype: 'error_during_execution', isError: true, startupFailure: 'sandbox_required_unavailable' }, b)).toEqual({ status: 'failed', error: expect.stringMatching(/sandbox isn't available.*nothing ran/) });
  });
});

describe('JobSupervisor with a fake claude', () => {
  it('R8-6: whatever still works in the job folder at the end is killed, and the job_end line counts it', async () => {
    const { plan, sup } = await started('write two sentences about rivers MODE:ok');
    const audit = new FakeAudit();
    const killed: [number, string][] = [];
    const asked: string[] = [];
    const end = await new JobSupervisor(sup, {
      spawn: fakeClaudeSpawn().spawn,
      audit,
      platform: 'linux',
      stragglers: (folder) => (asked.push(folder), [4242, 4343]),
      kill: (pid, sig) => killed.push([pid, sig]),
    }).run();
    expect(end.status).toBe('done');
    expect(asked).toEqual([plan.folder]);
    expect(killed).toEqual([[4242, 'SIGKILL'], [4343, 'SIGKILL']]);
    expect(audit.entries.find((e) => e.tool === 'job_end')?.args).toMatchObject({ status: 'done', leftover: 2 });
  });

  it('runs the exact argv in the job folder with only the allow-listed environment; progress and result land in the state', async () => {
    const { h, plan, sup } = await started('write my SOFE 3980 lab report draft MODE:ok');
    // start(): the supervisor is spawned detached, no terminal, scratch env, `node <cli> jobs _run <meta folder>`.
    expect(h.supervisor.calls).toHaveLength(1);
    const call = h.supervisor.calls[0]!;
    expect(call.cmd).toBe(process.execPath);
    expect(call.args.slice(1)).toEqual(['jobs', '_run', join(h.home, 'jobs', plan.id)]);
    expect(call.opts).toMatchObject({ detached: true, stdio: 'ignore', shell: false });
    expect(Object.keys(call.opts.env!).every((k) => (JOB_ENV_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(readJobState(h.home, plan.id)?.status).toBe('queued');

    const audit = new FakeAudit();
    const fake = fakeClaudeSpawn();
    const end = await new JobSupervisor(sup, { spawn: fake.spawn, audit, platform: 'linux', env: { ...process.env, CANVAS_API: 'canvas-LEAK' } }).run();
    expect(end).toMatchObject({ status: 'done', turns: 2, toolCalls: 1, denials: 1, costUsd: 0.42, error: '' });
    expect(end.summary).toBe('I wrote draft.md with the lab report draft. Check the results table.');
    expect(end.pid).toBe(process.pid);
    expect(end.startedAt).not.toBeNull();
    expect(end.deadlineAt! - end.startedAt!).toBe(45 * 60_000);
    // The fake recorded what it got.
    const run = JSON.parse(readFileSync(join(plan.folder, 'fake-run.json'), 'utf8')) as { argv: string[]; cwd: string; envKeys: string[]; env: Record<string, string> };
    expect(run.argv).toEqual(buildJobArgs(sup.spec));
    expect(run.cwd).toBe(plan.folder);
    const inherited = run.envKeys.filter((k) => !(JOB_ENV_KEYS as readonly string[]).includes(k) && !/^(PWD|SHLVL|_|OLDPWD|__CF_USER_TEXT_ENCODING)$/.test(k));
    expect(inherited).toEqual([]);
    expect(JSON.stringify(run.env)).not.toMatch(/LEAK/);
    expect(existsSync(join(plan.folder, 'draft.md'))).toBe(true);
    // Files: log 0600 with the stream, state 0600, meta 0700.
    const f = jobFiles(sup.spec.metaDir);
    expect(statSync(f.log).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.log, 'utf8')).toMatch(/"subtype":"init"/);
    expect(statSync(statePath(h.home, plan.id)).mode & 0o777).toBe(0o600);
    expect(statSync(sup.spec.metaDir).mode & 0o777).toBe(0o700);
    expect(readJobState(h.home, plan.id)?.status).toBe('done');
    // Audit: the end, with numbers, no task text needed.
    await tick();
    expect(audit.entries).toContainEqual(expect.objectContaining({ tool: 'job_end', outcome: 'ok', args: expect.objectContaining({ id: plan.id, status: 'done', turns: 2, costUsd: 0.42, denials: 1 }) }));
    expect(h.audit.entries).toContainEqual(expect.objectContaining({ tool: 'job_start', outcome: 'ok', confirmation: 'approved' }));
    // No caffeinate on Linux.
    expect(fake.calls.map((c) => c.cmd)).toEqual([sup.claudePath]);
  });

  it('macOS: caffeinate -i -w <claude pid> keeps the Mac awake until the job ends', async () => {
    const { sup } = await started('write notes for the midterm MODE:ok');
    const fake = fakeClaudeSpawn();
    const end = await new JobSupervisor(sup, { spawn: fake.spawn, audit: null, platform: 'darwin' }).run();
    expect(end.status).toBe('done');
    const caf = fake.calls.find((c) => c.cmd === '/usr/bin/caffeinate')!;
    expect(caf.args).toEqual(['-i', '-w', String(end.claudePid)]);
  });

  it('wall clock (fake timers): SIGTERM to the group at the deadline → timeout', async () => {
    const { plan, sup } = await started('research the history of printing MODE:hang');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' });
    const done = s.run();
    await untilIo(() => existsSync(join(plan.folder, 'fake-run.json')) && readFileSync(jobFiles(sup.spec.metaDir).log, 'utf8').includes('init'), 'init');
    expect(readJobState(sup.home, plan.id)?.status).toBe('running');
    vi.advanceTimersByTime(45 * 60_000 - 1);
    await tick();
    expect(readJobState(sup.home, plan.id)?.status).toBe('running');
    vi.advanceTimersByTime(1);
    const end = await done;
    expect(end.status).toBe('timeout');
    expect(end.error).toMatch(/45 minute time limit/);
    expect(isPidAlive(end.claudePid!)).toBe(false);
  });

  it('wall clock: a claude that ignores SIGTERM is SIGKILLed 10 s later', async () => {
    const { plan, sup } = await started('research the history of printing MODE:stubborn');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' });
    const done = s.run();
    await untilIo(() => readFileSync(jobFiles(sup.spec.metaDir).log, 'utf8').includes('init'), 'init');
    const pid = readJobState(sup.home, plan.id)!.claudePid!;
    vi.advanceTimersByTime(45 * 60_000);
    for (let i = 0; i < 200; i++) await tick();
    expect(isPidAlive(pid)).toBe(true); // SIGTERM ignored
    vi.advanceTimersByTime(10_000);
    const end = await done;
    expect(end.status).toBe('timeout');
    expect(isPidAlive(pid)).toBe(false);
  });

  it('stop(): SIGTERM → stopped', async () => {
    const { plan, sup } = await started('write my lab report MODE:hang');
    const s = new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' });
    const done = s.run();
    await untilIo(() => existsSync(join(plan.folder, 'fake-run.json')), 'spawn');
    s.stop();
    const end = await done;
    expect(end).toMatchObject({ status: 'stopped', error: 'Stopped by the owner.' });
  });

  it('crash without a result → failed, with the last stderr line', async () => {
    const { sup } = await started('write my lab report MODE:crash');
    const end = await new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' }).run();
    expect(end.status).toBe('failed');
    expect(end.error).toMatch(/exited \(code 3\) without a result: boom: something broke/);
  });

  it('no sandbox → the run refuses to start → failed, nothing ran (fail closed)', async () => {
    const { sup } = await started('write my lab report MODE:sandbox');
    const end = await new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' }).run();
    expect(end.status).toBe('failed');
    expect(end.error).toMatch(/sandbox isn't available/);
  });

  it('lock-down check: an init with an MCP server or an extra tool kills the job at once', async () => {
    const { sup } = await started('write my lab report MODE:badtools');
    const end = await new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' }).run();
    expect(end.status).toBe('failed');
    expect(end.error).toMatch(/wrong tools .*mcp__evil__send.*MCP servers: 1/);
  });

  it('max turns → failed in plain words', async () => {
    const { sup } = await started('write my lab report MODE:turns');
    const end = await new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' }).run();
    expect(end).toMatchObject({ status: 'failed', turns: 150 });
    expect(end.error).toMatch(/ran out of turns/);
  });

  it('the result text is untrusted: keys and links hidden, frame tags escaped', async () => {
    const { sup } = await started('write my lab report MODE:secret');
    const end = await new JobSupervisor(sup, { spawn: fakeClaudeSpawn().spawn, audit: null, platform: 'linux' }).run();
    expect(end.status).toBe('done');
    expect(end.summary).not.toMatch(/sk-ant|Zq9X4mB7|https:|<\/untrusted_job_output>/);
    expect(end.summary).toMatch(/\[secret\].*\[link: evil\.example\]/);
  });

  it('a job stopped while queued never starts claude', async () => {
    const { h, plan, sup } = await started('write my lab report MODE:ok');
    const r = await h.manager.stop(plan.id, 'cli');
    expect(r).toMatchObject({ status: 'stopped' });
    const fake = fakeClaudeSpawn();
    const end = await new JobSupervisor(sup, { spawn: fake.spawn, audit: null }).run();
    expect(end.status).toBe('stopped');
    expect(fake.calls).toEqual([]);
  });

  it('claude not found → failed', async () => {
    const { sup } = await started('write my lab report MODE:ok');
    const end = await new JobSupervisor({ ...sup, claudePath: '/nonexistent/claude' }, { audit: null, platform: 'linux' }).run();
    expect(end.status).toBe('failed');
    expect(end.error).toMatch(/not found/);
  });
});
