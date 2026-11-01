/**
 * `serve --session-state <file>`: the safety gate's memory for one voice CONVERSATION.
 *
 * The voice listener resumes Claude's conversation (`claude -p --resume <id>`) for follow-up commands, and every
 * `claude -p` starts a NEW `stephen serve`. Claude remembers everything earlier commands read — private page text,
 * injected instructions — so the gate must remember it too, or data read in command 1 could leave in command 2
 * without a prompt (docs/REVIEW-3.md finding 1). This file carries the gate's private reads (cross-site taint) and
 * the hosts the user approved after them from one server to the next. The listener deletes it whenever it starts a
 * new Claude conversation, so the gate's memory lives and dies with Claude's. The rate limiter is not carried.
 *
 * Rules:
 *  - The path must be a file directly inside `<stephen home>/voice/` (a real folder owned by this user, not a
 *    symlink; checked after resolving symlinks in the home path) — see checkSessionStatePath.
 *  - It is imported only if it is a regular file (opened with O_NOFOLLOW), owned by this user, mode 0600, small,
 *    and valid (validateGateState). Anything else is ignored and logged.
 *  - Every change is written BEFORE the read's text or the approved action goes back to the model: synchronously,
 *    atomically (temp file + rename, 0600, O_EXCL|O_NOFOLLOW), merged with what is on disk (so two servers can only
 *    add to the taint). If it can't be written, the server exits instead of returning the data (fail closed).
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { IAuditLog, ISafetyGate, ResolvedConfig } from '../types.js';
import { SafetyGate, type GateState } from './gate.js';
import type { SafetyDeps } from './index.js';

/** The file name the voice listener uses (in `<home>/voice/`). */
export const SESSION_STATE_FILE = 'conversation-state.json';
/** A state file larger than this is not read (the caps keep a real one far below it). */
export const MAX_SESSION_STATE_BYTES = 512 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/;

/** `<home>/voice` — the only folder a session-state file may live in. */
export function sessionStateDir(home: string): string {
  return join(resolve(home), 'voice');
}

const myUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * Validate a `--session-state` value: an absolute, normalized path of a `.json` file directly inside
 * `<home>/voice/`; that folder must be a real folder (not a symlink) owned by this user whose real path is
 * `<real home>/voice`; an existing file there must be a regular file, not a symlink. Returns the path or an error.
 */
export function checkSessionStatePath(p: string, home: string): { path: string } | { error: string } {
  return checkVoiceFilePath(p, home, { flag: '--session-state', name: NAME_RE, nameHint: 'a .json file' });
}

/**
 * The rules of checkSessionStatePath for any serve flag that names a private file in `<home>/voice/`
 * (`--session-state`, `--tool-log`). `name` is the allowed file-name pattern; errors start with `flag`.
 */
export function checkVoiceFilePath(
  p: string,
  home: string,
  opts: { flag: string; name: RegExp; nameHint: string },
): { path: string } | { error: string } {
  const bad = (why: string) => ({ error: `${opts.flag} ${why}` });
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return bad('needs a file path');
  if (!isAbsolute(p)) return bad('must be an absolute path');
  if (normalize(p) !== p || p.endsWith('/')) return bad('must be a normalized path (no "..", "." or "//")');
  const dir = sessionStateDir(home);
  if (dirname(p) !== dir) return bad(`must be a file directly inside ${dir}/`);
  if (!opts.name.test(basename(p))) return bad(`must name ${opts.nameHint} (letters, digits, ".", "_", "-")`);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return bad(`folder ${dir} does not exist`);
  }
  if (!st.isDirectory()) return bad(`folder ${dir} must be a real folder (not a symlink)`);
  const uid = myUid();
  if (uid !== null && st.uid !== uid) return bad(`folder ${dir} must belong to you`);
  try {
    if (realpathSync(dir) !== join(realpathSync(resolve(home)), 'voice')) return bad(`folder ${dir} resolves outside Stephen's home`);
  } catch {
    return bad(`folder ${dir} could not be resolved`);
  }
  let fst;
  try {
    fst = lstatSync(p);
  } catch {
    fst = null; // not created yet: fine
  }
  if (fst && !fst.isFile()) return bad('must be a regular file (not a symlink or folder)');
  return { path: p };
}

export type ReadStateResult = { state: unknown } | { missing: true } | { error: string };

/** Read a session-state file (see readPrivateJsonFile). Never throws. */
export function readSessionStateFile(path: string): ReadStateResult {
  return readPrivateJsonFile(path);
}

/** Read a private JSON file: O_NOFOLLOW, regular file, this user's, mode 0600, ≤ MAX_SESSION_STATE_BYTES. Never throws. */
export function readPrivateJsonFile(path: string): ReadStateResult {
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
    if (st.size > MAX_SESSION_STATE_BYTES) return { error: 'is too large' };
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

/** Write a gate state atomically (see writePrivateJsonFileSync). Throws. */
export function writeSessionStateFileSync(path: string, state: GateState): void {
  writePrivateJsonFileSync(path, state);
}

/** Write JSON atomically: temp file in the same folder (O_EXCL|O_NOFOLLOW, 0600) → fsync → rename. Throws. */
export function writePrivateJsonFileSync(path: string, state: unknown): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeSync(fd, JSON.stringify(state) + '\n');
      fchmodSync(fd, 0o600); // exactly 0600, whatever the umask
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path); // replaces a symlink at `path` instead of writing through it
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

/** Delete a state file (listener: new conversation). Missing is fine; anything else throws. */
export function removeSessionStateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export interface BindOptions {
  /** Where problems are reported (never stdout: that is the MCP channel). */
  log?: (line: string) => void;
  /**
   * The state could not be written. Default: log and exit the server at once, so the page text or approved
   * action that caused the change never reaches the model without its taint on disk. A custom handler that
   * returns makes the error propagate (noteRead / check throws).
   */
  onWriteError?: (e: unknown) => void;
}

const defaultLog = (line: string) => process.stderr.write(`[stephen] ${line}\n`);

/** Import `path` into `gate` (if valid) and persist every later change of its state there. */
export function bindSessionState(gate: SafetyGate, path: string, opts: BindOptions = {}): void {
  const log = opts.log ?? defaultLog;
  const r = readSessionStateFile(path);
  if ('error' in r) log(`session state ${path} ${r.error} — ignored (starting with no remembered reads)`);
  else if ('state' in r) {
    const imp = gate.importState(r.state);
    if (!imp.ok) log(`session state ${path} is invalid (${imp.error}) — ignored (starting with no remembered reads)`);
  }
  gate.onStateChange(() => {
    try {
      // Another server of the same conversation may have written meanwhile: keep its entries too (only adds taint).
      const cur = readSessionStateFile(path);
      if ('state' in cur) gate.importState(cur.state);
      writeSessionStateFileSync(path, gate.exportState());
    } catch (e) {
      if (opts.onWriteError) {
        opts.onWriteError(e);
        throw e;
      }
      log(`could not save the session state to ${path} (${(e as Error).message}) — stopping, so nothing read is returned without it`);
      process.exit(70);
    }
  });
}

type SafetyFactory = (cfg: ResolvedConfig, deps?: SafetyDeps) => { gate: ISafetyGate; audit: IAuditLog };

/** Wrap createSafety so the gate it builds is bound to `path` (serve --session-state). */
export function withSessionState(factory: SafetyFactory, path: string, opts: BindOptions = {}): SafetyFactory {
  return (cfg, deps) => {
    const s = factory(cfg, deps);
    if (!(s.gate instanceof SafetyGate)) throw new Error('session state needs the built-in safety gate');
    bindSessionState(s.gate, path, opts);
    return s;
  };
}
