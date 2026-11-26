/**
 * Today's daily cost limit on job starts (T1): at 100% no NEW job starts, on every entry point (voice, phone, edit),
 * and a job already running is not stopped. At 99% a job starts as before. The check is the voice DailyLimit, the
 * same one that stops a model run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { JOB_LIMIT_USED } from '../../src/jobs/manager.js';
import { JobRouter } from '../../src/jobs/router.js';
import { writeJobState } from '../../src/jobs/state.js';
import type { ConfirmPrompt, Confirmer } from '../../src/types.js';
import { DailyLimit } from '../../src/voice/daily-limit.js';
import { NOW, harness, tempRoot } from './helpers.js';

const { tmp, cleanup } = tempRoot('jobs-daily-limit');
afterAll(cleanup);

/** The real DailyLimit at usd 1; the test sets how much of it today's jobs have used. */
function limitAt(spent: { usd: number }): DailyLimit {
  return new DailyLimit({ limit: () => ({ enabled: true, usd: 1 }), records: () => [], jobSpend: () => spent.usd, now: () => NOW });
}

function approvingDialog() {
  const prompts: ConfirmPrompt[] = [];
  const confirmer: Confirmer = {
    kind: 'fake',
    confirm: async (p) => {
      prompts.push(p);
      return 'approved';
    },
  };
  return { prompts, confirmer };
}

describe("a new job once today's cost limit is used", () => {
  it('voice: refused with the plain message, and no dialog is shown', async () => {
    const spent = { usd: 1 };
    const limit = limitAt(spent);
    const h = harness(tmp, { dailyLimitUsed: () => !limit.allowed() });
    const dialog = approvingDialog();
    const router = new JobRouter({ jobs: h.manager, confirmer: dialog.confirmer });
    const r = await router.route('start a job to write my lab report', { source: 'voice-ptt' });
    expect(r).toEqual({ reply: "Today's limit is used. The job did not start.", changed: false });
    expect(dialog.prompts).toHaveLength(0);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.supervisor.calls).toHaveLength(0);
  });

  it('phone: refused the same way', async () => {
    const spent = { usd: 1 };
    const limit = limitAt(spent);
    const h = harness(tmp, { dailyLimitUsed: () => !limit.allowed() });
    const router = new JobRouter({ jobs: h.manager, confirmer: approvingDialog().confirmer });
    expect(await router.startFromPhone('write a poem about rain', false)).toEqual({ ok: false, text: JOB_LIMIT_USED });
    expect(h.manager.list()).toHaveLength(0);
  });

  it('edit: refused the same way, the old job is left as it was', async () => {
    const spent = { usd: 0 };
    const limit = limitAt(spent);
    const h = harness(tmp, { dailyLimitUsed: () => !limit.allowed() });
    const router = new JobRouter({ jobs: h.manager, confirmer: approvingDialog().confirmer });
    const plan = await h.manager.plan('write my lab report draft');
    if ('error' in plan) throw new Error(plan.error);
    const old = await h.manager.start(plan, 'voice-ptt');
    if ('refused' in old) throw new Error(old.refused);
    writeJobState(h.home, { ...old, status: 'done', endedAt: NOW - 1000 });
    spent.usd = 1;
    expect(await router.editJob(old.id, 'write my lab report draft longer')).toEqual({ refused: JOB_LIMIT_USED });
    expect(h.manager.list().map((j) => j.id)).toEqual([old.id]);
  });

  it('the manager refuses a start that got past the router too (every start goes through the same check)', async () => {
    const spent = { usd: 0 };
    const limit = limitAt(spent);
    const h = harness(tmp, { dailyLimitUsed: () => !limit.allowed() });
    const plan = await h.manager.plan('write my lab report draft');
    if ('error' in plan) throw new Error(plan.error);
    spent.usd = 1;
    expect(await h.manager.start(plan, 'voice-ptt')).toEqual({ refused: JOB_LIMIT_USED });
    expect(h.manager.list()).toHaveLength(0);
  });

  it('a job already running is not stopped when the limit is used', async () => {
    const spent = { usd: 0 };
    const limit = limitAt(spent);
    const h = harness(tmp, { dailyLimitUsed: () => !limit.allowed() });
    const plan = await h.manager.plan('write my lab report draft');
    if ('error' in plan) throw new Error(plan.error);
    const s = await h.manager.start(plan, 'voice-ptt');
    if ('refused' in s) throw new Error(s.refused);
    spent.usd = 1;
    expect(h.manager.running().map((j) => j.id)).toEqual([s.id]);
    expect(h.manager.get(s.id)?.status).toBe(s.status);
    expect(h.supervisor.calls).toHaveLength(1);
  });

  it('at 99% of the limit a job starts as before', async () => {
    const spent = { usd: 0.99 };
    const limit = limitAt(spent);
    const h = harness(tmp, { dailyLimitUsed: () => !limit.allowed() });
    const dialog = approvingDialog();
    const router = new JobRouter({ jobs: h.manager, confirmer: dialog.confirmer });
    const r = await router.route('start a job to write my lab report', { source: 'voice-ptt' });
    expect(dialog.prompts).toHaveLength(1);
    expect(r?.reply).toMatch(/^Bet, job started\./);
    expect(h.manager.list()).toHaveLength(1);
  });
});
