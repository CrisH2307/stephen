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
  const fold = (p: string) => resolve(p).normalize('NFC').toLowerCase();
  // Folded after following links too: through a link to <home>, `Replay/x.wav` must not answer differently before
  // and after the folder exists (review of #170).
  return isInside(fold(realThroughParent(path)), fold(realThroughParent(dir))) || isInside(fold(path), fold(dir));
}
