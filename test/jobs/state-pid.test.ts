/** REVIEW-8 R8-5: a recorded pid counts as the job's only if its command line is this job's supervisor / Claude. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { reconcile, supervisorRuns, writeJobState, type JobState } from '../../src/jobs/state.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-pid-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sleeper = (...words: string[]) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', ...words], { stdio: 'ignore' });

const job = (o: Partial<JobState>): JobState => ({
  version: 1, id: '2026-11-07-write-a-poem', task: 'write a poem', status: 'running', folder: '/x', cwd: '/x', source: 'voice-ptt',
  createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, endedAt: null, deadlineAt: Date.now() + 2_000_000, pid: null,
  claudePid: null, sessionId: 'sess-123', model: 'sonnet', web: false, maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000,
  repo: null, turns: 0, toolCalls: 0, costUsd: null, denials: 0, summary: '', error: '', ...o,
});

describe('job pids are checked by command line', () => {
  it('supervisorRuns: only `jobs _run <meta of this id>`', async () => {
    const mine = sleeper('jobs', '_run', '/h/jobs/2026-11-07-write-a-poem');
    const other = sleeper('jobs', '_run', '/h/jobs/2026-11-07-something-else');
    const stranger = sleeper('vim', 'notes.txt');
    await new Promise((r) => setTimeout(r, 200));
    try {
      const s = job({});
      expect(supervisorRuns(s, mine.pid!)).toBe(true);
      expect(supervisorRuns(s, other.pid!)).toBe(false);
      expect(supervisorRuns(s, stranger.pid!)).toBe(false);
      expect(supervisorRuns(s, 999_999)).toBe(false);
    } finally {
      for (const p of [mine, other, stranger]) p.kill();
    }
  });

  it('reconcile: a reused supervisor pid → failed; a Claude pid that is not this session is never killed', async () => {
    const home = join(tmp, 'h');
    mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
    const stranger = sleeper('vim', 'notes.txt');
    await new Promise((r) => setTimeout(r, 200));
    const killed: number[] = [];
    try {
      const s = job({ pid: stranger.pid!, claudePid: stranger.pid! });
      writeJobState(home, s);
      const out = reconcile(home, s, { kill: (pid) => (killed.push(pid), true) });
      expect(out.status).toBe('failed');
      expect(killed).toEqual([]);
    } finally {
      stranger.kill();
    }
  });
});
