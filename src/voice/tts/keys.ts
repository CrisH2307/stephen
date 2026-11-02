/**
 * ElevenLabs API key lookup (Keychain → $ELEVENLABS_API_KEY → voice.elevenlabs.apiKeyFile). Every process runs
 * through ExecFn with an argv array (never a shell), so tests use a fake `security`.
 *
 * Read-only on purpose: this file is loaded by `stephen serve` (the process Claude talks to). Storing and deleting
 * Keychain items (`stephen voice-key set|delete`, `stephen connect gmail`) lives in src/connect/, which only CLI
 * paths load on demand (review 7, R7-8; boundary test in test/memory/boundary.test.ts).
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { expandHome, type TtsConfig } from './config.js';
import { API_KEY_RE, redactKey } from './redact.js';

export const KEYCHAIN_SERVICE = 'stephen-elevenlabs';
export const KEY_ENV = 'ELEVENLABS_API_KEY';
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

export interface KeyDeps {
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Keychain account (default: the login user name). */
  user?: string;
  home?: string;
  /** For the key-file check (default: process.getuid()). */
  uid?: number | null;
}

export type KeySource = 'keychain' | 'env' | 'file';

export interface FoundKey {
  key: string;
  source: KeySource;
  /** Human description of where, e.g. 'macOS Keychain (service "stephen-elevenlabs")'. */
  where: string;
}

export interface KeyLookup {
  found: FoundKey | null;
  /** Problems met on the way (refused key file, Keychain error…); never contains a key. */
  notes: string[];
}

export function account(deps: KeyDeps): string {
  return deps.user ?? userInfo().username;
}

export const isMac = (deps: KeyDeps): boolean => (deps.platform ?? process.platform) === 'darwin';

export async function keychainLookup(deps: KeyDeps): Promise<{ key: string | null; note?: string }> {
  if (!isMac(deps)) return { key: null };
  const exec = deps.exec ?? defaultExec;
  const r = await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account(deps), '-w'], { timeoutMs: 10_000 });
  if (r.code === 0) {
    const key = r.stdout.trim();
    if (API_KEY_RE.test(key)) return { key };
    return { key: null, note: `the Keychain item "${KEYCHAIN_SERVICE}" does not look like an API key — run \`stephen voice-key set\` again` };
  }
  if (r.code === ERR_SEC_ITEM_NOT_FOUND) return { key: null };
  return { key: null, note: `Keychain lookup failed: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}` };
}

/** Read a key file; refused unless it is a regular file owned by this user with no group/other permissions. */
export async function readKeyFile(path: string, deps: KeyDeps = {}): Promise<{ key: string | null; note?: string }> {
  const p = expandHome(path, deps.home);
  let st;
  try {
    st = await stat(p);
  } catch (e) {
    return { key: null, note: `voice.elevenlabs.apiKeyFile ${p}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : (e as Error).message}` };
  }
  if (!st.isFile()) return { key: null, note: `voice.elevenlabs.apiKeyFile ${p} is not a regular file` };
  const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
  if (uid !== null && st.uid !== uid) return { key: null, note: `voice.elevenlabs.apiKeyFile ${p} is not owned by you — refused` };
  if ((st.mode & 0o077) !== 0) {
    return {
      key: null,
      note: `voice.elevenlabs.apiKeyFile ${p} is readable by other users (mode ${(st.mode & 0o777).toString(8)}) — refused. Fix: chmod 600 ${p}`,
    };
  }
  const key = (await readFile(p, 'utf8')).trim();
  if (!API_KEY_RE.test(key)) return { key: null, note: `voice.elevenlabs.apiKeyFile ${p} does not contain an API key (one line, no spaces)` };
  return { key };
}

/** Keychain → $ELEVENLABS_API_KEY → voice.elevenlabs.apiKeyFile. */
export async function findApiKey(cfg: Pick<TtsConfig, 'elevenlabs'>, deps: KeyDeps = {}): Promise<KeyLookup> {
  const notes: string[] = [];
  const kc = await keychainLookup(deps);
  if (kc.note) notes.push(kc.note);
  if (kc.key) return { found: { key: kc.key, source: 'keychain', where: `macOS Keychain (service "${KEYCHAIN_SERVICE}")` }, notes };

  const envKey = (deps.env ?? process.env)[KEY_ENV]?.trim();
  if (envKey) {
    if (API_KEY_RE.test(envKey)) return { found: { key: envKey, source: 'env', where: `$${KEY_ENV}` }, notes };
    notes.push(`$${KEY_ENV} is set but does not look like an API key — ignored`);
  }

  const file = cfg.elevenlabs.apiKeyFile;
  if (file) {
    const r = await readKeyFile(file, deps);
    if (r.note) notes.push(r.note);
    if (r.key) return { found: { key: r.key, source: 'file', where: expandHome(file, deps.home) }, notes };
  }
  return { found: null, notes };
}
