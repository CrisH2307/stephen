/**
 * ElevenLabs API key lookup (Keychain → $ELEVENLABS_API_KEY → voice.elevenlabs.apiKeyFile). The Keychain read itself
 * (argv-only `security`, a fake one in tests) is src/lib/keychain.ts.
 *
 * Read-only on purpose: this file is loaded by `stephen serve` (the process Claude talks to). Storing and deleting
 * Keychain items (`stephen voice-key set|delete`, `stephen connect gmail`) lives in src/connect/, which only CLI
 * paths load on demand (review 7, R7-8; boundary test in test/memory/boundary.test.ts).
 */
import { readFile, stat } from 'node:fs/promises';
import { keychainRead, type KeychainDeps } from '../../lib/keychain.js';
import { expandHome, type TtsConfig } from './config.js';
import { API_KEY_RE } from './redact.js';

export const KEYCHAIN_SERVICE = 'stephen-elevenlabs';
export const KEY_ENV = 'ELEVENLABS_API_KEY';

export interface KeyDeps extends KeychainDeps {
  env?: NodeJS.ProcessEnv;
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

/** The Keychain item holding the key: service "stephen-elevenlabs", account = the login user (src/lib/keychain.ts). */
export async function keychainLookup(deps: KeyDeps): Promise<{ key: string | null; note?: string }> {
  const r = await keychainRead(KEYCHAIN_SERVICE, deps);
  if (r.error) return { key: null, note: `Keychain lookup failed: ${r.error}` };
  if (r.value === null) return { key: null };
  if (API_KEY_RE.test(r.value)) return { key: r.value };
  return { key: null, note: `the Keychain item "${KEYCHAIN_SERVICE}" does not look like an API key — run \`stephen voice-key set\` again` };
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
