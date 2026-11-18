/**
 * #202 B2: the listener's job watcher must not block the audio loop with a sync `ps`. It uses async `ps` (execFile,
 * with a timeout), never a cached answer, and runs a fresh check right before any kill (R8-5).
 */
import * as cp from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: vi.fn((...a: Parameters<typeof real.execFileSync>) => {
      events.push(`sync ${a[0]}`);
      return real.execFileSync(...a);
    }),
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      events.push(`async ${file} ${args[1]} timeout=${(rest[0] as { timeout?: number }).timeout}`);
      return (real.execFile as (...x: unknown[]) => unknown)(file, args, ...rest);
    }),
  };
});

const { FinishWatcher } = await import('../../src/jobs/finish.js');
const { listJobStatesAsync, readJobState, writeJobState } = await import('../../src/jobs/state.js');
type JobState = import('../../src/jobs/state.js').JobState;

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-wps-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sleeper = (...words: string[]) => cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', ...words], { stdio: 'ignore' });

const job = (o: Partial<JobState>): JobState => ({
  version: 1, id: '2026-11-07-write-a-poem', task: 'write a poem', status: 'running', folder: '/x', cwd: '/x', source: 'voice-ptt',
  createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, endedAt: null, deadlineAt: Date.now() + 2_000_000, pid: null,
  claudePid: null, sessionId: 'sess-123', model: 'sonnet', web: false, maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000,
  repo: null, turns: 0, toolCalls: 0, costUsd: null, denials: 0, summary: '', error: '', ...o,
});

function home(name: string): string {
  const h = join(tmp, name);
  mkdirSync(join(h, 'jobs'), { recursive: true, mode: 0o700 });
  return h;
}

beforeEach(() => {
  events.length = 0;
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('job watcher ps (#202 B2)', () => {
  it('the watcher path runs only async ps, with a timeout, and a new ps on every poll (no cache)', async () => {
    const h = home('a');
    const sup = sleeper('jobs', '_run', '/h/jobs/2026-11-07-write-a-poem');
    await new Promise((r) => setTimeout(r, 200));
    try {
      writeJobState(h, job({ pid: sup.pid! }));
      const w = new FinishWatcher({ home: h, list: () => listJobStatesAsync(h), notify: () => undefined, say: () => undefined });
      await w.poll();
      await w.poll();
      expect(events.filter((e) => e.startsWith('sync'))).toEqual([]);
      expect(events).toEqual([`async ps ${sup.pid} timeout=2000`, `async ps ${sup.pid} timeout=2000`]);
      expect(readJobState(h, '2026-11-07-write-a-poem')!.status).toBe('running');
    } finally {
      sup.kill();
    }
  });

  it('a kill comes right after a fresh ps of that Claude pid; a stranger pid is never killed', async () => {
    const h = home('b');
    const stranger = sleeper('vim', 'notes.txt');
    const claude = sleeper('--', '--session-id', 'sess-123'); // '--': node must not read it as its own flag
    await new Promise((r) => setTimeout(r, 200));
    try {
      writeJobState(h, job({ pid: stranger.pid!, claudePid: claude.pid! }));
      const kill = (pid: number) => (events.push(`kill ${pid}`), true);
      const [out] = await listJobStatesAsync(h, { kill });
      expect(out!.status).toBe('failed');
      expect(events.filter((e) => e.startsWith('sync'))).toEqual([]);
      expect(events.slice(-2)).toEqual([`async ps ${claude.pid} timeout=2000`, `kill ${claude.pid}`]);

      events.length = 0;
      const h2 = home('c');
      writeJobState(h2, job({ pid: stranger.pid!, claudePid: stranger.pid! }));
      await listJobStatesAsync(h2, { kill });
      expect(events.some((e) => e.startsWith('kill'))).toBe(false);
    } finally {
      stranger.kill();
      claude.kill();
    }
  });
});
