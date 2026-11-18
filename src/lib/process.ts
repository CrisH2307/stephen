/** Process helpers shared by the drivers, memory (lock files), the voice Claude, jobs and the self-test. */
import { execFile, execFileSync } from 'node:child_process';

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

/**
 * The command line of a live pid ('' when gone or unreadable). A recorded pid can be reused by an unrelated process
 * after a crash or reboot (REVIEW-8 R8-5): check the command before trusting or signalling it.
 */
export function commandOf(pid: number): string {
  if (!isPidAlive(pid)) return '';
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Longest wait for one async `ps` (commandOfAsync). */
export const PS_TIMEOUT_MS = 2_000;

/**
 * commandOf without blocking the event loop (the listener's job watcher, #202 B2). null when ps did not answer in
 * time: unknown, so the caller must not act on it. No cache: every call runs ps, a pid can be reused (R8-5).
 */
export function commandOfAsync(pid: number, timeoutMs = PS_TIMEOUT_MS): Promise<string | null> {
  if (!isPidAlive(pid)) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err?.killed) resolve(null);
      else resolve(err ? '' : stdout.trim());
    });
  });
}

/**
 * Pids of this user's processes whose working directory is `dir` or inside it (macOS/Linux `lsof`), never this
 * process. One `lsof` over all cwds, filtered by path: fast however big `dir` is. [] when lsof is missing or fails.
 */
export function pidsWithCwdIn(dir: string): number[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return [];
  let out: string;
  try {
    out = execFileSync('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch (e) {
    out = typeof (e as { stdout?: unknown }).stdout === 'string' ? ((e as { stdout: string }).stdout) : ''; // lsof exits 1 on partial results
  }
  const root = dir.replace(/\/+$/, '');
  const pids: number[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 0 && pid !== process.pid) {
      const cwd = line.slice(1);
      if (cwd === root || cwd.startsWith(`${root}/`)) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/** A live pid's terminal ('??' = none) and start time (ms, second precision); null when gone or unreadable. */
export function processStart(pid: number): { tty: string; startedAt: number } | null {
  try {
    const [tty, ...rest] = execFileSync('ps', ['-o', 'tty=,lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
    const startedAt = Date.parse(rest.join(' '));
    return tty && Number.isFinite(startedAt) ? { tty, startedAt } : null;
  } catch {
    return null;
  }
}

/**
 * #121: on Linux, `ps -o lstart=` can read up to 1 s earlier than a `Date.now()` taken just before the spawn, so we
 * allow 2 s of slack there. macOS has no slack.
 */
export const PS_START_SLACK_MS = 2000;

/** True when a process that started at `startedAt` (ps, second precision) counts as started at or after `jobStart`. */
export function startedWithinJob(startedAt: number, jobStart: number, platform: NodeJS.Platform = process.platform): boolean {
  const slack = platform === 'linux' ? PS_START_SLACK_MS : 0;
  return startedAt >= Math.floor(jobStart / 1000) * 1000 - slack;
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
