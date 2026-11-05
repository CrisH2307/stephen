/** Process helpers shared by the drivers, memory (lock files), the voice Claude, jobs and the self-test. */

/** True if a process with this pid exists (signal 0 probe). EPERM means it exists but isn't ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal a whole process group (negative pid); false on "no such process" or any other error. */
export function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
