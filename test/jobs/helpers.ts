/** Shared set-up for the job tests: a temp Stephen home and job root, a JobManager, the fake claude, spawn recorders. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobsConfig, type JobsConfig } from '../../src/jobs/config.js';
import { JobManager, type JobManagerOptions } from '../../src/jobs/manager.js';
import type { SpawnFn } from '../../src/jobs/runner.js';
import { isPidAlive } from '../../src/lib/process.js';
import type { AuditEntry, IAuditLog } from '../../src/types.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = join(HERE, 'fake-claude-job.mjs');
export const TZ = 'America/Toronto';
/** Thu Nov 5 2026, 10:00 Toronto. */
export const NOW = Date.parse('2026-11-05T15:00:00Z');
export const TODAY = '2026-11-05';

export function tempRoot(name: string): { tmp: string; cleanup: () => void } {
  // realpath: macOS tmpdir() is a /var symlink to /private/var, and job folders are realpath-checked (rule 4).
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), `stephen-${name}-`)));
  return { tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

export class FakeAudit implements IAuditLog {
  entries: (Omit<AuditEntry, 'ts'> & { ts?: string })[] = [];
  async append(e: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    this.entries.push(e);
  }
  async recent(): Promise<AuditEntry[]> {
    return [];
  }
}

export interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: SpawnOptions;
}

/** Records every spawn and starts a harmless `node -e ""` in its place (a real ChildProcess for .on/.unref). */
export function recordingSpawn(): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    },
  };
}

/** Runs the fake claude for `claude`; records caffeinate (and anything else) without running it. */
export function fakeClaudeSpawn(): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (cmd, args, opts): ChildProcess => {
      calls.push({ cmd, args, opts });
      if (cmd === '/usr/bin/caffeinate') return spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      return spawn(process.execPath, [FAKE_CLAUDE, ...args], opts);
    },
  };
}

export interface Harness {
  home: string;
  root: string;
  userHome: string;
  manager: JobManager;
  audit: FakeAudit;
  supervisor: { spawn: SpawnFn; calls: SpawnCall[] };
  config: JobsConfig;
}

let n = 0;
export function harness(tmp: string, o: Partial<JobManagerOptions> & { jobs?: Record<string, unknown> } = {}): Harness {
  const base = join(tmp, `h${++n}`);
  const userHome = join(base, 'user');
  const home = join(userHome, '.stephen');
  const root = join(userHome, 'Stephen Jobs');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = parseJobsConfig({ root, ...(o.jobs ?? {}) });
  const audit = new FakeAudit();
  const supervisor = recordingSpawn();
  const manager = new JobManager({
    home,
    config,
    timeZone: TZ,
    claudePath: FAKE_CLAUDE,
    audit,
    userHome,
    env: { ...process.env, CANVAS_API: 'canvas-LEAK', NOTION_API: 'ntn_LEAK', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-LEAK' },
    stephenRepo: join(base, 'stephen-repo'),
    now: () => NOW,
    spawn: supervisor.spawn,
    // Fixtures use this test's own pid as a pretend supervisor: liveness by pid here; the real command-line check
    // (REVIEW-8 R8-5) has its own tests.
    alive: isPidAlive,
    ...o,
  });
  return { home, root, userHome, manager, audit, supervisor, config };
}

/** Wait (real time) until `cond` holds. */
export async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
