/**
 * Owner-only folders under Stephen's home: files there never go to a web page or the model. Today one folder, the
 * replay recordings (src/replay/recorder.ts, issue #48). Claude-reachable code (upload_file) asks isOwnerOnlyFile and
 * never names the folder itself (test/replay/boundary.test.ts).
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isInside } from './fs.js';

/** `<home>/replay`: the saved F5 commands (audio + transcript). */
export const REPLAY_DIR_NAME = 'replay';

/**
 * The real path of `p` as the disk spells it, through its nearest existing parent when `p` does not exist (yet).
 * `realpathSync.native` also fixes letter case: APFS ignores case, so `~/.stephen/Replay` IS `~/.stephen/replay`
 * (#169); plain `realpathSync` follows symlinks but keeps the caller's spelling.
 */
export function realThroughParent(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(realThroughParent(up), basename(abs));
  }
}

/**
 * True when `path` (after symlinks, in any letter case) lies in an owner-only folder of `home`. Also true for a file
 * that does not exist there, so callers can ask before `stat` and never tell the model whether a clip exists.
 */
export function isOwnerOnlyFile(path: string, home: string): boolean {
  const dir = join(home, REPLAY_DIR_NAME);
  // The spelling check ignores case and Unicode form too, so a missing folder answers the same as a present one
  // (#169: otherwise `Replay/x.wav` would tell whether recording was ever on). Cost: on a case-sensitive disk,
  // `<home>/REPLAY/...` is refused as well.
  return insideFolded(path, dir);
}

/** `path` lies in `dir`, after symlinks, ignoring letter case and Unicode form (APFS, #169). */
function insideFolded(path: string, dir: string): boolean {
  const fold = (p: string) => resolve(p).normalize('NFC').toLowerCase();
  // Folded after following links too: through a link to <home>, `Replay/x.wav` must not answer differently before
  // and after the folder exists (review of #170).
  return isInside(fold(realThroughParent(path)), fold(realThroughParent(dir))) || isInside(fold(path), fold(dir));
}

/**
 * What a job's shell may never read (jobSettings denyRead) and upload_file never sends: Stephen's home, the keys
 * folders and the Stephen repo's .env. One list, so the two cannot drift (safety review 0.1.1, M1).
 */
export function neverReadPaths(stephenHome: string, stephenRepo: string): string[] {
  return [stephenHome, '~/.ssh', '~/.aws', '~/.config', '~/Library/Keychains', join(stephenRepo, '.env')];
}

/** True when `path` (after symlinks, in any letter case) lies in one of neverReadPaths, `~` being `userHome`. */
export function isNeverReadFile(path: string, stephenHome: string, stephenRepo: string, userHome: string): boolean {
  return neverReadPaths(stephenHome, stephenRepo).some((d) => insideFolded(path, d.startsWith('~/') ? join(userHome, d.slice(2)) : d));
}
