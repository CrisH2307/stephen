/**
 * B5: how many other people's accounts this Mac has. "Zen for Stephen" opens a remote-control port on 127.0.0.1 with
 * no password, so on a shared Mac any account could drive the signed-in browser. Only a count ever leaves this
 * module: account names are read from dscl and dropped at once, never logged or shown.
 */
import { execNoThrow } from './process.js';

export type ListUsers = () => Promise<{ code: number | null; stdout: string }>;

const dsclUsers: ListUsers = () => execNoThrow('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID'], 5_000);

/**
 * Other login accounts (uid 501 and up, not a `_` service account, not this one), or null when the list could not be
 * read: callers treat null as "maybe shared" (fail closed). Not macOS: 0, there is no Zen launcher there.
 */
export async function otherUserCount(
  platform: NodeJS.Platform = process.platform,
  list: ListUsers = dsclUsers,
  myUid: number = process.getuid?.() ?? -1,
): Promise<number | null> {
  if (platform !== 'darwin') return 0;
  const r = await list();
  if (r.code !== 0) return null;
  let n = 0;
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+)\s+(-?\d+)\s*$/.exec(line.trim());
    if (!m || m[1]!.startsWith('_')) continue;
    const uid = Number(m[2]);
    if (uid >= 501 && uid !== myUid) n++;
  }
  return n;
}

/** The refusal and doctor text for a shared Mac: a count, never a name. */
export function sharedMacReason(count: number | null): string {
  const who = count === null ? "Stephen couldn't check this Mac's user accounts" : `This Mac has ${count} other user account${count === 1 ? '' : 's'}`;
  return (
    `${who}, so Stephen will not open Zen with its remote-control port: that port has no password, and any account on ` +
    'this Mac could control your signed-in Zen. Use Chrome with Stephen instead (it asks you to Allow each connection).'
  );
}
