/** REVIEW-8 R8-6 helpers on the real lsof / ps: find what still works inside a folder, and when it started. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PS_START_SLACK_MS, pidsWithCwdIn, processStart, startedWithinJob } from '../../src/lib/process.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-cwd-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('pidsWithCwdIn / processStart', () => {
  it('finds a detached process working in a subfolder; not one elsewhere; never this process', async () => {
    mkdirSync(join(tmp, 'job', 'sub'), { recursive: true });
    const t0 = Date.now();
    const inside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: join(tmp, 'job', 'sub'), detached: true, stdio: 'ignore' });
    const outside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: tmp, detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const pids = pidsWithCwdIn(join(tmp, 'job'));
      expect(pids).toContain(inside.pid);
      expect(pids).not.toContain(outside.pid);
      expect(pids).not.toContain(process.pid);
      expect(pidsWithCwdIn(join(tmp, 'jo'))).toEqual([]); // a prefix of the name is not "inside"
      const p = processStart(inside.pid!);
      expect(p?.tty).toBe(process.platform === 'darwin' ? '??' : '?'); // ps: '??' on macOS, '?' on Linux (no controlling tty)
      expect(p!.startedAt).toBeGreaterThanOrEqual(Math.floor(t0 / 1000) * 1000 - (process.platform === 'linux' ? PS_START_SLACK_MS : 0)); // #121
      expect(processStart(999_999)).toBeNull();
    } finally {
      inside.kill();
      outside.kill();
    }
  });
});

describe('startedWithinJob (#121)', () => {
  const job = 10_500; // floor to 10_000
  it('#121 linux accepts 1 s early, rejects 3 s early', () => {
    expect(startedWithinJob(9000, job, 'linux')).toBe(true);
    expect(startedWithinJob(7000, job, 'linux')).toBe(false);
  });
  it('#121 darwin rejects 1 s early, accepts the same second', () => {
    expect(startedWithinJob(9000, job, 'darwin')).toBe(false);
    expect(startedWithinJob(10_000, job, 'darwin')).toBe(true);
  });
});
