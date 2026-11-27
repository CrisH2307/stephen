/** Where "Stephen Helper.app" and its socket live. */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HELPER_APP_NAME = 'Stephen Helper';
export const HELPER_BUNDLE_ID = 'dev.stephen.helper';
/** The executable inside Contents/MacOS. */
export const HELPER_EXECUTABLE = 'Stephen Helper';

function userHome(): string {
  return process.env.HOME?.trim() || homedir();
}

/** `~/Applications/Stephen Helper.app` */
export function helperAppPath(home: string = userHome()): string {
  return join(home, 'Applications', `${HELPER_APP_NAME}.app`);
}

/** `<stephen home>/run/helper.sock` (created by the helper: dir 0700, socket 0600). */
export function helperSocketPath(stephenHome: string): string {
  return join(stephenHome, 'run', 'helper.sock');
}

/**
 * F15: the helper's per-launch secret, next to its socket: `{"nonce":"<64 hex>"}`, 0600. A client sends it as its first
 * line (`{"type":"auth","nonce":…}`) or the helper drops it.
 */
export function helperNoncePath(socketPath: string): string {
  return join(dirname(socketPath), 'helper.nonce');
}

/** `<stephen home>/logs/helper.log` (written by the helper). */
export function helperLogPath(stephenHome: string): string {
  return join(stephenHome, 'logs', 'helper.log');
}

export { MAX_SOCKET_PATH_BYTES } from '../lib/private-socket.js';
