/** The daily cost limit in the Assistant: refuse only a new model run, routers stay free, warn once, fail open. */
import { describe, expect, it, vi } from 'vitest';
import { Assistant, type CommandReport, type CommandRunner, type LocalRouter } from '../../src/voice/assistant.js';
import type { ClaudeOutcome } from '../../src/voice/claude.js';
import { DailyLimit, LIMIT_REACHED, LIMIT_WARNING } from '../../src/voice/daily-limit.js';
import type { MemoryRouter } from '../../src/voice/memory-router.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const OK: ClaudeOutcome = { kind: 'ok', text: 'Hi.', sessionId: null, costUsd: 0.25, turns: 1 };

function make(o: { limit?: Partial<Pick<DailyLimit, 'allowed' | 'add' | 'warnNow'>> | DailyLimit | null; out?: ClaudeOutcome; timers?: LocalRouter; jobs?: LocalRouter; memory?: MemoryRouter } = {}) {
  const runs: string[] = [];
  const runner: CommandRunner = { run: async (p) => (runs.push(p), o.out ?? OK), cancel: () => false };
  const reports: CommandReport[] = [];
  const status: string[] = [];
  const limit = o.limit === undefined ? { allowed: vi.fn(() => true), add: vi.fn(), warnNow: vi.fn(() => false) } : o.limit;
  const assistant = new Assistant({
    runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: (l) => status.push(l),
    ...(o.timers ? { timers: o.timers } : {}), ...(o.jobs ? { jobs: o.jobs } : {}), ...(o.memory ? { memory: o.memory } : {}),
    limit: limit as DailyLimit | null, onDone: (r) => reports.push(r),
  });
  return { assistant, runs, reports, status, limit };
}
const denied = () => ({ allowed: vi.fn(() => false), add: vi.fn(), warnNow: vi.fn(() => false) });
const local = (reply: string, rest?: string): LocalRouter => ({ route: async () => ({ reply, changed: false, ...(rest ? { rest } : {}) }) });

describe('daily limit in the assistant', () => {
  it('at 100% no model run starts and Stephen says the limit message', async () => {
    const { assistant, runs, limit } = make({ limit: denied() });
    const r = await assistant.command('what is the weather', { source: 'voice-ptt' });
    expect(runs).toEqual([]);
    expect(r).toMatchObject({ reply: LIMIT_REACHED, ranClaude: false, result: 'error', route: 'model' });
    expect(limit!.add).not.toHaveBeenCalled();
  });

  it('memory, timers and jobs still answer at 100% (the check is never reached)', async () => {
    const memory = { route: async () => ({ reply: 'Saved.', changed: true }) } as unknown as MemoryRouter;
    for (const [opt, reply, route] of [[{ memory }, 'Saved.', 'memory'], [{ timers: local('Timer set.') }, 'Timer set.', 'timer'], [{ jobs: local('No jobs running.') }, 'No jobs running.', 'job']] as const) {
      const { assistant, runs, limit } = make({ ...opt, limit: denied() });
      const r = await assistant.command('x', { source: 'voice-ptt' });
      expect(r).toMatchObject({ reply, route, ranClaude: false });
      expect(runs).toEqual([]);
      expect(limit!.allowed).not.toHaveBeenCalled();
    }
  });

  it('"remember X and play Y" at 100%: X is handled, Y is refused', async () => {
    const { assistant, runs } = make({ timers: local('Saved.', 'play jazz'), limit: denied() });
    const r = await assistant.command('remember X and play jazz', { source: 'voice-ptt' });
    expect(runs).toEqual([]);
    expect(r).toMatchObject({ reply: `Saved. ${LIMIT_REACHED}`, route: 'model', ranClaude: false });
  });

  it('under the limit: the run happens and its cost is counted under the command id', async () => {
    const { assistant, runs, limit } = make();
    const r = await assistant.command('hello', { source: 'voice-ptt' });
    expect(runs).toEqual(['hello']);
    expect(r.reply).toBe('Hi.');
    expect(limit!.add).toHaveBeenCalledWith(r.id, 0.25);
  });

  it('the 80% warning is added to the reply', async () => {
    const { assistant } = make({ limit: { allowed: () => true, add: () => {}, warnNow: () => true } });
    expect((await assistant.command('hello')).reply).toBe(`Hi. ${LIMIT_WARNING}`);
  });

  it('fails open: a throwing check still runs the model and logs; a throwing add or warnNow keeps the reply', async () => {
    const a = make({ limit: { allowed: () => { throw new Error('x'); }, add: () => {}, warnNow: () => false } });
    expect((await a.assistant.command('hello')).reply).toBe('Hi.');
    expect(a.runs).toEqual(['hello']);
    expect(a.status.join('\n')).toContain('could not check the daily limit');
    const b = make({ limit: { allowed: () => true, add: () => { throw new Error('x'); }, warnNow: () => { throw new Error('y'); } } });
    expect(await b.assistant.command('hello')).toMatchObject({ reply: 'Hi.', result: 'ok' });
    expect(b.status.join('\n')).toContain('could not count the cost');
  });

  it('no limit: works as before', async () => {
    expect((await make({ limit: null }).assistant.command('hello')).reply).toBe('Hi.');
  });

  it('a cancelled run is counted (cost unknown) and gives no warning', async () => {
    const { assistant, limit } = make({ out: { kind: 'cancelled', sessionId: null } as ClaudeOutcome });
    const r = await assistant.command('hello');
    expect(r.result).toBe('cancelled');
    expect(limit!.add).toHaveBeenCalledWith(r.id, undefined);
    expect(limit!.warnNow).not.toHaveBeenCalled();
  });

  it('a failed run that cost money is counted too (review-B M2); a failure with no cost adds nothing', async () => {
    const failed = make({ out: { kind: 'error', message: 'I ran out of steps before finishing.', sessionId: null, costUsd: 0.3 } });
    const r = await failed.assistant.command('do a lot', { source: 'voice-ptt' });
    expect(failed.limit!.add).toHaveBeenCalledWith(r.id, 0.3);
    expect(r.costUsd).toBe(0.3); // the latency line gets it too
    const free = make({ out: { kind: 'error', message: 'x', sessionId: null } });
    const r2 = await free.assistant.command('hi', { source: 'voice-ptt' });
    expect(free.limit!.add).toHaveBeenCalledWith(r2.id, undefined);
    expect(r2.costUsd).toBeUndefined();
  });

  it('end to end with the real DailyLimit: failing runs alone reach the limit and the next run is refused', async () => {
    const lim = new DailyLimit({ limit: () => ({ enabled: true, usd: 0.5 }), records: () => [] });
    const { assistant, runs } = make({ limit: lim, out: { kind: 'error', message: 'I ran out of steps before finishing.', sessionId: null, costUsd: 0.3 } });
    await assistant.command('one');
    await assistant.command('two'); // 0.60 spent by two failed runs
    expect((await assistant.command('three')).reply).toBe(LIMIT_REACHED);
    expect(runs).toEqual(['one', 'two']);
  });

  it('end to end with the real DailyLimit: warn, then refuse, timers still free', async () => {
    const lim = new DailyLimit({ limit: () => ({ enabled: true, usd: 0.5 }), records: () => [] });
    const { assistant, runs } = make({ limit: lim, timers: { route: async (t) => (t === 'set a timer' ? { reply: 'Timer set.', changed: false } : null) } });
    expect((await assistant.command('one')).reply).toBe('Hi.'); // 0.25 = 50%
    expect((await assistant.command('two')).reply).toBe(`Hi. ${LIMIT_WARNING}`); // 0.50 = 100%: warned once
    expect((await assistant.command('three')).reply).toBe(LIMIT_REACHED);
    expect((await assistant.command('set a timer')).reply).toBe('Timer set.');
    expect(runs).toEqual(['one', 'two']);
  });
});
