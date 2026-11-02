/**
 * Account secrets for phase 2a (docs/PLAN-2A-READ-MY-STUFF.md): Canvas token, Notion token, calendar feed URL,
 * Google OAuth client secret. Looked up in this order, first hit wins:
 *   1. macOS Keychain, service `stephen-<name>` (`security find-generic-password -s … -a <user> -w`, argv only);
 *   2. Stephen's `.env` file (the repo root, next to package.json; the owner's choice), ONLY the known key names
 *      for that secret, and only if the file is a regular file owned by this user with no group/other access.
 * Secrets are never put in process.env, logs, results or argv of other processes. Values are returned to the
 * caller (the account client) and nowhere else.
 *
 * Gmail refresh tokens are per account label and live ONLY in the Keychain (`stephen-gmail-<label>`, written by
 * `stephen connect gmail <label>`): lookupGmailToken.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExec, type ExecFn } from '../voice/tts/keys.js';

/** Each secret: Keychain service suffix and the `.env` names accepted for it (first present wins). */
export const SECRET_SPECS = {
  'canvas-token': { keychain: 'stephen-canvas', env: ['CANVAS_API', 'CANVAS_TOKEN', 'STEPHEN_CANVAS_TOKEN'] },
  'canvas-url': { keychain: 'stephen-canvas-url', env: ['CANVAS_URL', 'STEPHEN_CANVAS_URL'] },
  'notion-token': { keychain: 'stephen-notion', env: ['NOTION_API', 'NOTION_TOKEN', 'STEPHEN_NOTION_TOKEN'] },
  'calendar-ics': { keychain: 'stephen-calendar-ics', env: ['GOOGLE_CALENDAR_ICS', 'CALENDAR_ICS_URL', 'STEPHEN_CALENDAR_ICS'] },
  /** The Google OAuth desktop client's secret (optional: PKCE works without it, but Google's desktop clients ask for it). */
  'google-oauth-client-secret': { keychain: 'stephen-google-oauth', env: ['GOOGLE_OAUTH_CLIENT_SECRET'] },
} as const;
export type SecretName = keyof typeof SECRET_SPECS;

/** Every environment name an account secret may use (stripped from claude's environment; review 6, R6-9). */
export const ACCOUNT_ENV_NAMES: readonly string[] = Object.values(SECRET_SPECS).flatMap((s) => [...s.env]);

const URL_SECRETS: ReadonlySet<SecretName> = new Set(['canvas-url', 'calendar-ics']);

/**
 * A plausible value for this secret, else a note. Tokens: printable ASCII only, so a bad paste (NUL, newline,
 * smart quotes) can't end up in a header error message (review 6, R6-6). Addresses: https/webcal URLs.
 */
export function checkSecretValue(name: SecretName, v: string): string | null {
  if (!/^[\x21-\x7e]{8,4096}$/.test(v)) return `the ${name} value has characters that can't be right (re-paste it)`;
  // (http only for loopback: the tests' fake servers. ApiClient still refuses plain http outside tests.)
  if (URL_SECRETS.has(name) && !/^(https|webcals?):\/\/[^/\s]+/i.test(v) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(v)) {
    return `the ${name} value is not an https address`;
  }
  return null;
}

/** Stephen's repo root: this file is src/accounts/secrets.ts or dist/accounts/secrets.js. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_ENV_FILE = join(REPO_ROOT, '.env');
/** A `.env` larger than this is not read (it is a few lines). */
const MAX_ENV_BYTES = 64 * 1024;

export interface SecretDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  user?: string;
  /** `.env` path (default: the repo root); null = don't use a file. */
  envFile?: string | null;
  uid?: number | null;
}

export interface SecretLookup {
  value: string | null;
  /** 'keychain' | '.env' — never the value. */
  source: 'keychain' | '.env' | null;
  /** Problems on the way (refused file, Keychain error); never contains a secret. */
  notes: string[];
}

/**
 * Minimal `.env` parser: `KEY=value` lines, optional `export `, `#` comments, optional matching quotes. No
 * variable expansion, no multi-line values. Only `wanted` keys are returned.
 */
export function parseEnvFile(text: string, wanted: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !wanted.includes(m[1]!)) continue;
    let v = m[2]!.trim();
    const q = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(v); // KEY="v" # note (review 6, R6-10)
    if (q) v = q[2]!;
    else v = v.replace(/\s+#.*$/, '');
    if (v) out.set(m[1]!, v); // the last one wins, like dotenv
  }
  return out;
}

/** Read the `.env` file, refused unless it is a private regular file of this user. */
export function readEnvFile(path: string, wanted: readonly string[], deps: SecretDeps = {}): { values: Map<string, string>; note?: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { values: new Map() };
  }
  if (!st.isFile()) return { values: new Map(), note: `${path} is not a regular file — ignored` };
  const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
  if (uid !== null && st.uid !== uid) return { values: new Map(), note: `${path} is not owned by you — ignored` };
  if ((st.mode & 0o077) !== 0) return { values: new Map(), note: `${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}) — ignored. Fix: chmod 600 ${path}` };
  if (st.size > MAX_ENV_BYTES) return { values: new Map(), note: `${path} is too large — ignored` };
  try {
    return { values: parseEnvFile(readFileSync(path, 'utf8'), wanted) };
  } catch (e) {
    return { values: new Map(), note: `${path}: ${(e as Error).message}` };
  }
}

/** Find one secret (Keychain, then `.env`). Never throws. */
export async function lookupSecret(name: SecretName, deps: SecretDeps = {}): Promise<SecretLookup> {
  const spec = SECRET_SPECS[name];
  const notes: string[] = [];
  const kc = await keychainFind(spec.keychain, (v) => checkSecretValue(name, v), deps, notes);
  if (kc) return { value: kc, source: 'keychain', notes };
  const file = deps.envFile === undefined ? DEFAULT_ENV_FILE : deps.envFile;
  if (file) {
    const { values, note } = readEnvFile(file, spec.env, deps);
    if (note) notes.push(note);
    for (const k of spec.env) {
      const v = values.get(k);
      if (!v) continue;
      const bad = checkSecretValue(name, v);
      if (!bad) return { value: v, source: '.env', notes };
      notes.push(`.env ${k}: ${bad}`);
    }
  }
  return { value: null, source: null, notes };
}

/** One Keychain item (macOS only; argv only, never a shell), checked by `check`; null when absent or bad. */
async function keychainFind(service: string, check: (v: string) => string | null, deps: SecretDeps, notes: string[]): Promise<string | null> {
  if ((deps.platform ?? process.platform) !== 'darwin') return null;
  const exec = deps.exec ?? defaultExec;
  const r = await exec('security', ['find-generic-password', '-s', service, '-a', deps.user ?? userInfo().username, '-w'], { timeoutMs: 10_000 });
  const v = r.stdout.trim();
  if (r.code === 0 && v) {
    const bad = check(v);
    if (!bad) return v;
    notes.push(`Keychain ${service}: ${bad}`);
  }
  if (r.code !== 0 && r.code !== 44) notes.push(`Keychain lookup for ${service} failed: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
  return null;
}

/** A Gmail account label: what `stephen connect gmail <label>` takes and `accounts.gmail.accounts` lists. */
export const GMAIL_LABEL_RE = /^[a-z0-9_-]{1,32}$/;
/** The Keychain service holding that account's refresh token. */
export const gmailKeychainService = (label: string): string => {
  if (!GMAIL_LABEL_RE.test(label)) throw new Error('a Gmail account label is 1 to 32 of a-z, 0-9, _ and -');
  return `stephen-gmail-${label}`;
};
/** What a Google OAuth token looks like (refresh "1//0g…", access "ya29.…"): a token word, nothing else. */
export const GOOGLE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,2047}$/;

/** A Gmail account's refresh token: Keychain only (never .env, config or the environment). */
export async function lookupGmailToken(label: string, deps: SecretDeps = {}): Promise<SecretLookup> {
  const notes: string[] = [];
  const v = await keychainFind(gmailKeychainService(label), (x) => (GOOGLE_TOKEN_RE.test(x) ? null : 'it does not look like a Google token (connect again)'), deps, notes);
  return v ? { value: v, source: 'keychain', notes } : { value: null, source: null, notes };
}

// ───────────── presence only (the Stephen window's accounts.status; review 7, R7-9) ─────────────

export interface SecretPresence {
  present: boolean;
  source: 'keychain' | '.env' | null;
}

/** Is there a Keychain item? `security find-generic-password` WITHOUT `-w`: attributes only, the value is never read. */
async function keychainHas(service: string, deps: SecretDeps): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'darwin') return false;
  const r = await (deps.exec ?? defaultExec)('security', ['find-generic-password', '-s', service, '-a', deps.user ?? userInfo().username], { timeoutMs: 10_000 });
  return r.code === 0;
}

/**
 * Whether a secret is set (Keychain item exists, else a non-empty `.env` key in a private file of this user), without
 * reading the Keychain value. The `.env` file has to be read to see its key names, but only the names are kept.
 * Never throws.
 */
export async function secretPresent(name: SecretName, deps: SecretDeps = {}): Promise<SecretPresence> {
  const spec = SECRET_SPECS[name];
  if (await keychainHas(spec.keychain, deps)) return { present: true, source: 'keychain' };
  const file = deps.envFile === undefined ? DEFAULT_ENV_FILE : deps.envFile;
  if (file && readEnvFile(file, spec.env, deps).values.size > 0) return { present: true, source: '.env' };
  return { present: false, source: null };
}

/** Whether a Gmail account has a refresh token in the Keychain, without reading it. */
export async function gmailTokenPresent(label: string, deps: SecretDeps = {}): Promise<SecretPresence> {
  return (await keychainHas(gmailKeychainService(label), deps)) ? { present: true, source: 'keychain' } : { present: false, source: null };
}
