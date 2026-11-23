/**
 * A job whose supervisor is gone is revisited while `ps` cannot answer for its Claude pid. An unanswered ps means
 * unknown: the job stays as it is and nothing is killed. Once ps answers, the job is handled.
 */
import * as cp from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const hang = new Set<number>();
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: vi.fn((file: string, args: string[], opts: unknown, cb: (...a: unknown[]) => void) => {
      if (file === 'ps' && hang.has(Number(args[1]))) {
        setImmediate(() => cb(Object.assign(new Error('ps timed out'), { killed: true }), '', ''));
        return {} as never;
      }
      return (real.execFile as (...x: unknown[]) => unknown)(file, args, opts, cb);
    }),
  };
});

const { listJobStatesAsync, readJobState, writeJobState } = await import('../../src/jobs/state.js');
type JobState = import('../../src/jobs/state.js').JobState;

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-rcp-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sleeper = (...words: string[]) => cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', ...words], { stdio: 'ignore' });

const ID = '2026-11-07-write-a-poem';
const job = (o: Partial<JobState>): JobState => ({
  version: 1, id: ID, task: 'write a poem', status: 'running', folder: '/x', cwd: '/x', source: 'voice-ptt',
  createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, endedAt: null, deadlineAt: Date.now() + 2_000_000, pid: null,
  claudePid: null, sessionId: 'sess-123', model: 'sonnet', web: false, maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000,
  repo: null, turns: 0, toolCalls: 0, costUsd: null, denials: 0, summary: '', error: '', ...o,
});

function home(name: string): string {
  const h = join(tmp, name);
  mkdirSync(join(h, 'jobs'), { recursive: true, mode: 0o700 });
  return h;
}

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('unanswered ps for the Claude pid (post-release review of #233)', () => {
  it('a ps timeout for the Claude pid keeps the job non-final; the next real answer handles it', async () => {
    const h = home('a');
    const claude = sleeper('--', '--session-id', 'sess-123'); // '--': node must not read it as its own flag
    await new Promise((r) => setTimeout(r, 200));
    const kills: number[] = [];
    const kill = (pid: number) => (kills.push(pid), true);
    try {
      writeJobState(h, job({ pid: null, claudePid: claude.pid! }));

      hang.add(claude.pid!);
      const [first] = await listJobStatesAsync(h, { kill });
      expect(first!.status).toBe('running');
      expect(readJobState(h, ID)!.status).toBe('running');
      expect(kills).toEqual([]);

      hang.delete(claude.pid!);
      const [second] = await listJobStatesAsync(h, { kill });
      expect(second!.status).toBe('failed');
      expect(readJobState(h, ID)!.status).toBe('failed');
      expect(kills).toEqual([claude.pid]);
    } finally {
      hang.clear();
      claude.kill();
    }
  });

  it('a real ps answer that Claude is gone marks the job failed without a kill', async () => {
    const h = home('b');
    const gone = 2_147_000_000; // no such pid: ps answers that it is gone
    const kills: number[] = [];
    writeJobState(h, job({ pid: null, claudePid: gone }));
    const [out] = await listJobStatesAsync(h, { kill: (pid) => (kills.push(pid), true) });
    expect(out!.status).toBe('failed');
    expect(kills).toEqual([]);
  });
});
