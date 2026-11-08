/** REVIEW-8 R8-4: job outcomes the listener decides are audited with what really happened. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeJobState, type JobState } from '../../src/jobs/state.js';
import { NOW, TODAY, harness, tempRoot } from './helpers.js';

const { tmp, cleanup } = tempRoot('audit-r8');
afterAll(cleanup);

const job = (o: Partial<JobState>): JobState => ({
  version: 1, id: `${TODAY}-write-a-poem`, task: 'write a poem', status: 'queued', folder: '/x', cwd: '/x', source: 'voice-ptt',
  createdAt: NOW, startedAt: null, endedAt: null, deadlineAt: null, pid: null, claudePid: null, sessionId: 's', model: 'sonnet',
  web: false, maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000, repo: null, turns: 0, toolCalls: 0, costUsd: null, denials: 0,
  summary: '', error: '', ...o,
});

describe('job audit outcomes', () => {
  it('stop is audited after it happened, with the final status', async () => {
    const h = harness(tmp);
    mkdirSync(join(h.home, 'jobs'), { recursive: true, mode: 0o700 });
    writeJobState(h.home, job({}));
    expect(await h.manager.stop(`${TODAY}-write-a-poem`, 'owner', 50)).toMatchObject({ status: 'stopped' });
    expect(h.audit.entries).toEqual([{ tool: 'job_stop', outcome: 'ok', args: { id: `${TODAY}-write-a-poem`, by: 'owner', status: 'stopped' } }]);
  });

  it('a job reconcile marks failed gets exactly one job_end line', () => {
    const h = harness(tmp, { alive: () => false });
    mkdirSync(join(h.home, 'jobs'), { recursive: true, mode: 0o700 });
    writeJobState(h.home, job({ status: 'running', pid: 12345, startedAt: NOW - 60_000, deadlineAt: NOW + 1_000_000 }));
    expect(h.manager.list()[0]).toMatchObject({ status: 'failed' });
    h.manager.list(); // already final: no second line
    const ends = h.audit.entries.filter((e) => e.tool === 'job_end');
    expect(ends).toEqual([{ tool: 'job_end', outcome: 'error', error: expect.stringMatching(/ended without a result/), args: { id: `${TODAY}-write-a-poem`, status: 'failed', by: 'reconcile' } }]);
  });
});
