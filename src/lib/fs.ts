/**
 * Private files and folders: the one implementation of "write a private file atomically", "read a private JSON
 * file" and "make a private folder". Used by the gate's session state, memory, timers, history, the voice Claude's
 * MCP config and config.json updates. src/lib/ imports nothing outside src/lib/ (boundary test).
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { access, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** A private JSON file larger than this is not read (the callers' caps keep real ones far below it). */
export const MAX_PRIVATE_JSON_BYTES = 512 * 1024;

const myUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * Write `data` to `path` atomically and privately: a fresh temp file in the same folder (O_EXCL|O_NOFOLLOW, mode
 * exactly 0600 whatever the umask) → fsync → rename over `path`. rename() replaces a symlink at `path` instead of
 * writing through it, so a planted link can't redirect the write. The temp file is removed on failure. Throws.
 */
export function writePrivateFileAtomicSync(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeSync(fd, data);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

/** Write JSON (one line) with writePrivateFileAtomicSync. Throws. */
export function writePrivateJsonFileSync(path: string, value: unknown): void {
  writePrivateFileAtomicSync(path, JSON.stringify(value) + '\n');
}

export type ReadPrivateJsonResult = { state: unknown } | { missing: true } | { error: string };

/** Read a private JSON file: O_NOFOLLOW, regular file, this user's, mode 0600, ≤ MAX_PRIVATE_JSON_BYTES. Never throws. */
export function readPrivateJsonFile(path: string): ReadPrivateJsonResult {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { missing: true };
    if (code === 'ELOOP') return { error: 'is a symlink' };
    return { error: `could not be opened (${code ?? (e as Error).message})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'is not a regular file' };
    const uid = myUid();
    if (uid !== null && st.uid !== uid) return { error: 'belongs to another user' };
    if ((st.mode & 0o777) !== 0o600) return { error: `has mode ${(st.mode & 0o777).toString(8)}, not 600` };
    if (st.size > MAX_PRIVATE_JSON_BYTES) return { error: 'is too large' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    try {
      return { state: JSON.parse(buf.subarray(0, off).toString('utf8')) as unknown };
    } catch {
      return { error: 'is not valid JSON' };
    }
  } catch (e) {
    return { error: `could not be read (${(e as Error).message})` };
  } finally {
    closeSync(fd);
  }
}

// ───────────── private directories (D3) ─────────────

/** Directories we must never chmod even if a config points there. */
function isProtectedDir(dir: string): boolean {
  const d = resolve(dir);
  return d === resolve(homedir()) || d === resolve('/') || dirname(d) === d;
}

/** True if `dir` is `root` or lies inside it. */
export function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/**
 * mkdir -p `dir` with mode 0700 and chmod it (and, when it lies inside `root`, every directory
 * between `root` and `dir`, root included) to 0700: profile, state and output dirs hold cookies,
 * session state and page content that other local users must not read.
 */
export async function ensurePrivateDir(dir: string, root?: string): Promise<void> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const chain: string[] = [target];
  if (root && isInside(target, root)) {
    for (let d = dirname(target); isInside(d, root); d = dirname(d)) {
      chain.push(d);
      if (resolve(d) === resolve(root)) break;
    }
  }
  for (const d of chain) {
    if (isProtectedDir(d)) continue;
    await chmod(d, 0o700);
  }
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
