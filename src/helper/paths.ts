/** Where "Stephen Helper.app" and its socket live. */
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** `<stephen home>/logs/helper.log` (written by the helper). */
export function helperLogPath(stephenHome: string): string {
  return join(stephenHome, 'logs', 'helper.log');
}

/** Unix socket paths are limited to 104 bytes on macOS (including the NUL). */
export const MAX_SOCKET_PATH_BYTES = 103;
