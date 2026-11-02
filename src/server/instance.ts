/**
 * `serve --instance <id>`: one serve per id, ever (docs/REVIEW-7.md R7-1).
 *
 * Claude Code silently starts a NEW `stephen serve` when the one it had died (between turns and inside a turn), and
 * `mcp_status` keeps saying `connected`. A new serve builds a fresh gate (no rate-limiter history, no Gmail id
 * allow-list, and with follow-ups off no taint either) while Claude still holds every private text it read. So the
 * voice listener gives each Claude process a fresh random instance id, and:
 *  - the first serve of an id creates `<home>/run/serve-<id>.lock` with O_CREAT|O_EXCL (0600, never through a
 *    symlink) holding its pid;
 *  - a later serve of the same id finds the lock already there: it is a restart. It registers the tools as usual,
 *    but every call answers RESTARTED_NOTICE (nothing acts), and it exits non-zero right after (exit code 75);
 *  - the runner reads the pid from the lock once the tools are connected and, before every command, checks that the
 *    lock still names that pid and that it is alive. If not, the conversation ends (fail closed). It deletes the
 *    lock once the process group is gone.
 * The id is only a name (32 hex characters, no path), so the flag cannot point serve at any other file.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** A serve instance id: 32 lowercase hex characters (16 random bytes). */
export const SERVE_INSTANCE_RE = /^[0-9a-f]{32}$/;
/** Exit code of a restarted serve (EX_TEMPFAIL). */
export const RESTARTED_EXIT_CODE = 75;
/** What every tool of a restarted serve answers. */
export const RESTARTED_NOTICE =
  "Stephen's tools restarted in the middle of this conversation, so they are switched off for the rest of it. Nothing was done. " +
  'Tell the user to say the command again (that starts a new conversation).';

const myUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** A fresh random instance id. */
export function newServeInstance(): string {
  return randomBytes(16).toString('hex');
}

/** `<home>/run` (also holds helper.sock and app.sock). */
export function serveRunDir(home: string): string {
  return join(resolve(home), 'run');
}

/** `<home>/run/serve-<id>.lock`. Throws on an invalid id. */
export function serveLockPath(home: string, id: string): string {
  if (!SERVE_INSTANCE_RE.test(id)) throw new Error('invalid serve instance id');
  return join(serveRunDir(home), `serve-${id}.lock`);
}

/**
 * Claim instance `id` for this process. 'first': the lock was created and holds `pid`. 'restarted': a lock for this id
 * already exists, so an earlier serve of this instance ran (its content is not looked at). Throws on anything else
 * (the run folder is not a real folder of this user, a write failed): the caller must not serve tools then.
 */
export function claimServeInstance(home: string, id: string, pid: number = process.pid): 'first' | 'restarted' {
  const path = serveLockPath(home, id);
  const dir = serveRunDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} must be a real folder (not a symlink)`);
  const uid = myUid();
  if (uid !== null && st.uid !== uid) throw new Error(`${dir} must belong to you`);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'restarted';
    throw e;
  }
  try {
    writeSync(fd, `${pid}\n`);
  } finally {
    closeSync(fd);
  }
  return 'first';
}

/** The pid in a lock file (regular file, this user's, mode 0600, never through a symlink), or null. Never throws. */
export function readServeLock(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const uid = myUid();
    if (!st.isFile() || (uid !== null && st.uid !== uid) || (st.mode & 0o777) !== 0o600 || st.size > 32) return null;
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, 32, 0);
    const m = /^([1-9][0-9]{0,9})\n?$/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Delete a lock file (the runner, once the process group is gone). Never throws. */
export function removeServeLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Delete instance locks last changed before `olderThanMs` (left behind when the listener itself was killed). A live
 * conversation is far younger: a warm process lives 30 minutes at most. Returns how many were deleted. Never throws.
 */
export function sweepServeLocks(home: string, olderThanMs: number): number {
  const dir = serveRunDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!/^serve-[0-9a-f]{32}\.lock$/.test(name)) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile() && st.mtimeMs < olderThanMs) {
        unlinkSync(join(dir, name));
        n++;
      }
    } catch {
      /* gone meanwhile */
    }
  }
  return n;
}

/** Is process `pid` alive (and ours to signal)? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The restarted serve: wrap `mcp` so every tool registered through it keeps its name and schema but answers
 * RESTARTED_NOTICE as an error, without running anything. `onRefused` is called after each answer (serve exits).
 */
export function withRestartRefusal(mcp: McpServer, onRefused: () => void): McpServer {
  return new Proxy(mcp, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: unknown) => {
        const refuse = async () => {
          setImmediate(onRefused);
          return { isError: true, content: [{ type: 'text' as const, text: RESTARTED_NOTICE }] };
        };
        return (target.registerTool as (n: string, c: unknown, f: unknown) => unknown).call(target, name, config, refuse);
      };
    },
  });
}
