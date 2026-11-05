/**
 * macOS Keychain READS (generic passwords) and the argv-only process runner they use. Every process runs through
 * ExecFn with an argv array (never a shell), so tests use a fake `security`.
 *
 * Read-only on purpose: this file is loaded by `stephen serve` (the process Claude talks to). Storing and deleting
 * Keychain items lives in src/connect/keychain-write.ts, which only owner CLI paths load on demand (review 7, R7-8;
 * boundary test in test/memory/boundary.test.ts).
 */
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

/** `security` exit code for "The specified item could not be found in the keychain." */
export const ERR_SEC_ITEM_NOT_FOUND = 44;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type ExecFn = (file: string, args: string[], opts: { input?: string; timeoutMs: number }) => Promise<ExecResult>;

/** spawn with an argv array; resolves with the exit code (null on a signal); `code: -1` when the binary is missing. */
export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, timeout: opts.timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('error', (e: NodeJS.ErrnoException) => resolve({ code: -1, stdout, stderr: e.code === 'ENOENT' ? `${file} not found` : e.message }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });

export interface KeychainDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  /** Keychain account (default: the login user name). */
  user?: string;
}

/** The Keychain account: `deps.user`, else the login user name. */
export const keychainAccount = (deps: KeychainDeps): string => deps.user ?? userInfo().username;

export const isMac = (deps: Pick<KeychainDeps, 'platform'>): boolean => (deps.platform ?? process.platform) === 'darwin';

/**
 * Read one generic password (`security find-generic-password -s <service> -a <account> -w`, argv only).
 * `value` is the trimmed output when the item exists (possibly ''), null when it is absent or not on macOS;
 * `error` is the first line of `security`'s error output (or "exit N") when the lookup itself failed. The caller
 * checks the value's shape. Never throws.
 */
export async function keychainRead(service: string, deps: KeychainDeps): Promise<{ value: string | null; error?: string }> {
  if (!isMac(deps)) return { value: null };
  const exec = deps.exec ?? defaultExec;
  const r = await exec('security', ['find-generic-password', '-s', service, '-a', keychainAccount(deps), '-w'], { timeoutMs: 10_000 });
  if (r.code === 0) return { value: r.stdout.trim() };
  if (r.code === ERR_SEC_ITEM_NOT_FOUND) return { value: null };
  return { value: null, error: r.stderr.trim().split('\n')[0] || `exit ${r.code}` };
}

/** Is there a Keychain item? `security find-generic-password` WITHOUT `-w`: attributes only, the value is never read. */
export async function keychainHas(service: string, deps: KeychainDeps): Promise<boolean> {
  if (!isMac(deps)) return false;
  const r = await (deps.exec ?? defaultExec)('security', ['find-generic-password', '-s', service, '-a', keychainAccount(deps)], { timeoutMs: 10_000 });
  return r.code === 0;
}
