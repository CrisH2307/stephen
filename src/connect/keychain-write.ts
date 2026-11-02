/**
 * Keychain writes (owner-only CLI paths: `stephen voice-key set|delete`, `stephen connect|disconnect gmail`). Lives in
 * src/connect/ so nothing `stephen serve` loads can store or delete a secret (review 7, R7-8).
 *
 * Storing without exposing the secret: `security add-generic-password … -w <secret>` would put it on argv, where
 * any local process can read it with `ps` while `security` runs. `-w` as the LAST argument (no value) makes
 * `security` prompt for it itself, but it reads that from the terminal, so a piped value can't be used. Instead
 * Stephen runs `security -i` (interactive mode) and writes the add command to its STDIN: the secret travels only
 * through a pipe between the two processes, never through argv or a file.
 */
import { defaultExec, ERR_SEC_ITEM_NOT_FOUND, type ExecFn } from '../voice/tts/keys.js';

/** What `keychainStore` accepts: a token-like word (no space, quote or leading dash), so it can't change the `security -i` command line. */
const STORABLE_SECRET = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,4095}$/;
const SERVICE_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * Store a generic password without exposing it (see the header): `security -i` gets the add command on STDIN, so
 * the secret is never on any process's argv. Then the item is read back, because `security -i` exits 0 even when a
 * command failed. Returns null when stored, else a message that never contains the secret.
 */
export async function keychainStore(service: string, label: string, secret: string, deps: { exec?: ExecFn; user: string }): Promise<string | null> {
  if (!SERVICE_NAME.test(service) || !/^[A-Za-z0-9 ()._-]{1,80}$/.test(label) || !/^[A-Za-z0-9._-]{1,64}$/.test(deps.user)) return 'Could not store it: unsupported Keychain item name.';
  if (!STORABLE_SECRET.test(secret)) return 'Could not store it: the value has characters Stephen does not store.';
  const exec = deps.exec ?? defaultExec;
  const command = `add-generic-password -U -s ${service} -a ${deps.user} -l "${label}" -w ${secret}\n`;
  const r = await exec('security', ['-i'], { input: command, timeoutMs: 30_000 });
  if (r.code !== 0 || /error|usage/i.test(r.stderr)) {
    return `Could not store it: ${r.stderr.split(secret).join('[secret]').trim().split('\n')[0] || `security exit ${r.code}`}`;
  }
  const check = await exec('security', ['find-generic-password', '-s', service, '-a', deps.user, '-w'], { timeoutMs: 10_000 });
  if (check.code !== 0 || check.stdout.trim() !== secret) return 'It was not found in the Keychain after storing it. Nothing changed.';
  return null;
}

/** Delete a generic password: 'deleted', 'missing', or an error message. */
export async function keychainDelete(service: string, deps: { exec?: ExecFn; user: string }): Promise<'deleted' | 'missing' | string> {
  const r = await (deps.exec ?? defaultExec)('security', ['delete-generic-password', '-s', service, '-a', deps.user], { timeoutMs: 15_000 });
  if (r.code === ERR_SEC_ITEM_NOT_FOUND) return 'missing';
  if (r.code !== 0) return r.stderr.trim().split('\n')[0] || `security exit ${r.code}`;
  return 'deleted';
}
