/**
 * Account secrets for phase 2a (docs/PLAN-2A-READ-MY-STUFF.md): Canvas token, Notion token, calendar feed URL,
 * Gmail refresh token. Looked up in this order, first hit wins:
 *   1. macOS Keychain, service `stephen-<name>` (`security find-generic-password -s … -a <user> -w`, argv only);
 *   2. Stephen's `.env` file (the repo root, next to package.json; the owner's choice), ONLY the known key names
 *      for that secret, and only if the file is a regular file owned by this user with no group/other access.
 * Secrets are never put in process.env, logs, results or argv of other processes. Values are returned to the
 * caller (the account client) and nowhere else.
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
} as const;
export type SecretName = keyof typeof SECRET_SPECS;

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
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v && !out.has(m[1]!)) out.set(m[1]!, v);
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
  if ((deps.platform ?? process.platform) === 'darwin') {
    const exec = deps.exec ?? defaultExec;
    const r = await exec('security', ['find-generic-password', '-s', spec.keychain, '-a', deps.user ?? userInfo().username, '-w'], { timeoutMs: 10_000 });
    const v = r.stdout.trim();
    if (r.code === 0 && v) return { value: v, source: 'keychain', notes };
    if (r.code !== 0 && r.code !== 44) notes.push(`Keychain lookup for ${spec.keychain} failed: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
  }
  const file = deps.envFile === undefined ? DEFAULT_ENV_FILE : deps.envFile;
  if (file) {
    const { values, note } = readEnvFile(file, spec.env, deps);
    if (note) notes.push(note);
    for (const k of spec.env) {
      const v = values.get(k);
      if (v) return { value: v, source: '.env', notes };
    }
  }
  return { value: null, source: null, notes };
}
