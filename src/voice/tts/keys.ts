/**
 * ElevenLabs API key: lookup (Keychain → $ELEVENLABS_API_KEY → voice.elevenlabs.apiKeyFile) and storage in the
 * macOS Keychain (`stephen voice-key set|status|delete`). Every process runs through ExecFn with an argv array
 * (never a shell), so tests use a fake `security`.
 *
 * Storing without exposing the key: `security add-generic-password … -w <key>` would put the key on argv, where
 * any local process can read it with `ps` while `security` runs. `-w` as the LAST argument (no value) makes
 * `security` prompt for it itself, but it reads that from the terminal, so a piped key can't be used. Instead
 * Stephen runs `security -i` (interactive mode) and writes the add command to its STDIN: the key travels only
 * through a pipe between the two processes, never through argv or a file.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { expandHome, type TtsConfig } from './config.js';
import { API_KEY_RE, redactKey } from './redact.js';

export const KEYCHAIN_SERVICE = 'stephen-elevenlabs';
export const KEY_ENV = 'ELEVENLABS_API_KEY';
/** `security` exit code for "The specified item could not be found in the keychain." */
const ERR_SEC_ITEM_NOT_FOUND = 44;

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

function account(deps: KeyDeps): string {
  return deps.user ?? userInfo().username;
}

const isMac = (deps: KeyDeps) => (deps.platform ?? process.platform) === 'darwin';

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

// ───────────────────────────── stephen voice-key ─────────────────────────────

export const VOICE_KEY_USAGE = `stephen voice-key set      Store your ElevenLabs API key in the macOS Keychain (reads it from stdin:
                           hidden prompt in a terminal, or piped: \`pbpaste | stephen voice-key set\`)
stephen voice-key status   Where the key is found (shows only its last 4 characters)
stephen voice-key delete   Remove it from the Keychain`;

export interface VoiceKeyEnv extends KeyDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Reads the key (default: hidden prompt on a TTY, else all of stdin). */
  readSecret?: (prompt: string) => Promise<string>;
  /** The "voice" section of config.json (for apiKeyFile in `status`). */
  ttsConfig?: () => Pick<TtsConfig, 'elevenlabs'>;
}

/** Read a secret from stdin: hidden (no echo) when stdin is a terminal, otherwise everything piped in. */
export function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d: string) => {
        data += d;
        if (data.length > 4096) {
          stdin.destroy();
          reject(new Error('input too long'));
        }
      });
      stdin.once('end', () => resolve(data));
      stdin.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let data = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.off('data', onData);
      stdin.pause();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(data);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') data = data.slice(0, -1);
        else if (ch >= ' ') data += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function runVoiceKey(argv: string[], env: VoiceKeyEnv = {}): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const err = env.err ?? ((l: string) => console.error(l));
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    (sub ? out : err)(VOICE_KEY_USAGE);
    return sub ? 0 : 2;
  }
  if (rest.length) {
    err(`Unknown option "${rest[0]}".\n${VOICE_KEY_USAGE}`);
    return 2;
  }
  const exec = env.exec ?? defaultExec;
  const user = account(env);
  if (sub === 'status') {
    let cfg: Pick<TtsConfig, 'elevenlabs'> = { elevenlabs: { voiceId: '', modelId: '', timeoutSec: 8, apiKeyFile: null } };
    try {
      if (env.ttsConfig) cfg = env.ttsConfig();
    } catch (e) {
      err((e as Error).message);
    }
    const r = await findApiKey(cfg, env);
    for (const n of r.notes) err(`note: ${n}`);
    if (!r.found) {
      out('No ElevenLabs API key found (looked in: macOS Keychain, $ELEVENLABS_API_KEY, voice.elevenlabs.apiKeyFile).');
      out('Run `stephen voice-key set` to add one. Until then Stephen speaks with the local voice.');
      return 1;
    }
    out(`ElevenLabs API key: ${redactKey(r.found.key)} — from ${r.found.where}.`);
    return 0;
  }
  if (sub !== 'set' && sub !== 'delete') {
    err(`Unknown voice-key command "${sub}".\n${VOICE_KEY_USAGE}`);
    return 2;
  }
  if (!isMac(env)) {
    err(`The Keychain is macOS-only. On this system set $${KEY_ENV} or voice.elevenlabs.apiKeyFile (a mode-0600 file) instead.`);
    return 1;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    err(`Unsupported user name for the Keychain account: ${JSON.stringify(user)}`);
    return 1;
  }
  if (sub === 'delete') {
    const r = await keychainDelete(KEYCHAIN_SERVICE, { exec, user });
    if (r === 'missing') {
      out('There was no ElevenLabs key in the Keychain.');
      return 0;
    }
    if (r !== 'deleted') {
      err(`Could not delete the key: ${r}`);
      return 1;
    }
    out(`Deleted the ElevenLabs key from the Keychain (service "${KEYCHAIN_SERVICE}").`);
    if ((env.env ?? process.env)[KEY_ENV]) out(`Note: $${KEY_ENV} is still set in this shell and will be used.`);
    return 0;
  }

  // set
  let key: string;
  try {
    key = (await (env.readSecret ?? readSecretFromStdin)('ElevenLabs API key (input hidden): ')).trim();
  } catch (e) {
    err(`No key read: ${(e as Error).message}`);
    return 1;
  }
  if (!key) {
    err('No key given. Paste it at the prompt, or pipe it in: `pbpaste | stephen voice-key set`.');
    return 1;
  }
  if (!API_KEY_RE.test(key)) {
    err('That does not look like an ElevenLabs API key (expected one word like "sk_…", no spaces or quotes). Nothing was stored.');
    return 1;
  }
  const bad = await keychainStore(KEYCHAIN_SERVICE, 'Stephen ElevenLabs API key', key, { exec, user });
  if (bad) {
    err(bad);
    return 1;
  }
  out(`Stored the ElevenLabs API key ${redactKey(key)} in the Keychain (service "${KEYCHAIN_SERVICE}", account "${user}").`);
  out('Check it with `stephen doctor --network`. If this key was ever pasted into a chat or a file, rotate it at elevenlabs.io → API keys.');
  return 0;
}

// ───────────────────────────── shared Keychain writes (voice-key, stephen connect) ─────────────────────────────

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
