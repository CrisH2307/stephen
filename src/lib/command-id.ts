/**
 * The command id file (plan A2, issue #43): `<home>/voice/command.json` holds `{"id":"h_<16 hex>"}`, the id of the
 * command the listener is sending to Claude right now. `stephen serve --command-file` reads it per tool call and puts
 * the id on its tool-log records and audit entries as `cmd`, so one id joins history, latency, tool log and audit.
 *
 * The id is a label. Nothing reads it to decide anything: the safety gate never sees it.
 * Reading never throws. A missing, unreadable, oversized, symlinked, foreign or malformed file gives no id, and the
 * record is written without `cmd`.
 */
import { unlinkSync } from 'node:fs';
import { readPrivateJsonFile, writePrivateJsonFileSync } from './fs.js';

/** The only shape accepted as a command id (newHistoryId in src/history/store.ts). */
export const COMMAND_ID_RE = /^h_[0-9a-f]{16}$/;
/** A command file larger than this is not read (a real one is 27 bytes). */
export const MAX_COMMAND_FILE_BYTES = 256;

/** `v` when it is a valid command id, else undefined. */
export function validCommandId(v: unknown): string | undefined {
  return typeof v === 'string' && COMMAND_ID_RE.test(v) ? v : undefined;
}

/** Write `{id}` atomically and privately (0600, temp file + rename). Throws on a bad id or a failed write. */
export function writeCommandFile(path: string, id: string): void {
  if (!validCommandId(id)) throw new Error('not a command id');
  writePrivateJsonFileSync(path, { id });
}

/** Remove the command file (no command is going out). Missing is fine. Throws on anything else. */
export function clearCommandFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** The id in the command file, or undefined. Never throws. */
export function readCommandId(path: string): string | undefined {
  try {
    const r = readPrivateJsonFile(path, MAX_COMMAND_FILE_BYTES);
    if (!('state' in r) || !r.state || typeof r.state !== 'object' || Array.isArray(r.state)) return undefined;
    return validCommandId((r.state as { id?: unknown }).id);
  } catch {
    return undefined;
  }
}
