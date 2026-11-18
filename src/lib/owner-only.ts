/**
 * Owner-only folders under Stephen's home: files there never go to a web page or the model. Today one folder, the
 * replay recordings (src/replay/recorder.ts, issue #48). Claude-reachable code (upload_file) asks isOwnerOnlyFile and
 * never names the folder itself (test/replay/boundary.test.ts).
 */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isInside } from './fs.js';

/** `<home>/replay`: the saved F5 commands (audio + transcript). */
export const REPLAY_DIR_NAME = 'replay';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** True when `path` (after symlinks) lies in an owner-only folder of `home`. */
export function isOwnerOnlyFile(path: string, home: string): boolean {
  const dir = join(home, REPLAY_DIR_NAME);
  return isInside(real(path), real(dir)) || isInside(resolve(path), resolve(dir));
}
