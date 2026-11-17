import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSuiteLock } from './suite-lock.js';

const dirs: string[] = [];
const lockPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'stephen-lock-test-'));
  dirs.push(d);
  return join(d, 'suite.lock');
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('one suite per machine (#109)', () => {
  it('#109 refuses when the pid in the lock is alive, naming the pid and folder', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: process.pid, dir: '/some/other/worktree' }));
    expect(() => acquireSuiteLock(p, { pid: 1, dir: 'x' })).toThrow(new RegExp(`pid ${process.pid}, folder /some/other/worktree`));
    expect(readFileSync(p, 'utf8')).toContain('/some/other/worktree'); // the holder's lock is untouched
  });

  it('#109 takes over a stale lock (dead pid), and teardown removes the lock', async () => {
    const p = lockPath();
    const child = spawn(process.execPath, ['-e', '']);
    const dead = child.pid!;
    await new Promise((r) => child.on('exit', r));
    writeFileSync(p, JSON.stringify({ pid: dead, dir: '/gone' }));
    const release = acquireSuiteLock(p, { pid: process.pid, dir: '/mine' });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ pid: process.pid, dir: '/mine' });
    release();
    expect(existsSync(p)).toBe(false);
  });

  it('#109 a second start while the first holds the lock is refused', () => {
    const p = lockPath();
    const release = acquireSuiteLock(p, { pid: process.pid, dir: '/first' });
    expect(() => acquireSuiteLock(p, { pid: 1, dir: '/second' })).toThrow(/already running/);
    release();
  });
});
