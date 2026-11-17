/**
 * One test suite per machine (#109). Two suites at once (two worktrees, or agents building) starve each other of CPU
 * and make timing tests flaky. The lock is a file holding the pid and folder of the running suite.
 */
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK_PATH = join(tmpdir(), 'stephen-test-suite.lock');

interface Holder {
  pid: number;
  dir: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, owned by another user
  }
}

function read(path: string): Holder | null {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Holder;
    return Number.isInteger(h.pid) ? h : null;
  } catch {
    return null;
  }
}

/** Take the lock or throw with a plain message naming the other suite. A lock whose pid is dead is taken over. */
export function acquireSuiteLock(path = LOCK_PATH, me: Holder = { pid: process.pid, dir: process.cwd() }): () => void {
  // Write a private file, then link it into place: the link fails if the lock exists, and the lock never shows half written.
  const tmp = `${path}.${me.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(me));
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(tmp, path);
        return () => {
          if (read(path)?.pid === me.pid) rmSync(path, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const other = read(path);
      if (other && alive(other.pid)) {
        throw new Error(`Another test suite is already running on this machine (pid ${other.pid}, folder ${other.dir}). Wait for it to finish, then run again.`);
      }
      rmSync(path, { force: true }); // stale: its suite is gone
    }
    throw new Error(`Could not take the test suite lock at ${path}.`);
  } finally {
    rmSync(tmp, { force: true });
  }
}
