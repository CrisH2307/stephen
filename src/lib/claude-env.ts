import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * The environment Stephen gives every `claude` it starts (voice, phone): an allow-list, never the whole shell (R23).
 * Kept in src/lib (imports nothing) so model-reachable code such as src/phone/bridge.ts can use it without reaching
 * memory or app code (test/memory/boundary.test.ts).
 */
/**
 * The CLAUDE_CODE_* variables the voice Claude keeps: how it signs in and which provider it uses (an owner who runs
 * Claude Code through a token, Bedrock, Vertex or Foundry). Every other CLAUDE_CODE_* variable, and CLAUDECODE, belongs
 * to a Claude Code session `stephen listen` was started from (CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT…): the
 * voice Claude must not run as part of that session (review 7, R7-12).
 */
export const KEPT_CLAUDE_CODE_ENV: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
]);

/**
 * The ANTHROPIC_* variables the voice Claude keeps: sign-in only (an API key or a token) and the Vertex project. Every
 * other ANTHROPIC_* variable from the shell is dropped, above all the ones that move the endpoint (ANTHROPIC_BASE_URL
 * and the provider base URLs): a changed endpoint would see every prompt, tool result and reply (R23). There is no
 * setting for another endpoint today; ADR-016 may add one explicit setting later.
 */
export const KEPT_ANTHROPIC_ENV: ReadonlySet<string> = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_VERTEX_PROJECT_ID']);

/**
 * Every other variable Claude may get (R23, review of #324). Claude's environment is built from this allow-list, like a
 * job's (`buildJobEnv`), never from the whole shell: a proxy (HTTPS_PROXY, ALL_PROXY), NODE_OPTIONS (code loaded into
 * Claude), NODE_EXTRA_CA_CERTS or NODE_TLS_REJECT_UNAUTHORIZED (a man in the middle), an AWS endpoint override
 * (AWS_ENDPOINT_URL*) and every account secret stay out.
 * - The basics a process needs, and the locale.
 * - CLAUDE_CONFIG_DIR: where the person's Claude sign-in lives. Kept on purpose: `--setting-sources ''` loads no settings
 *   file from it, and transcript cleanup (src/voice/transcripts.ts) reads the same variable, so Claude must write its
 *   transcripts where Stephen deletes them.
 * - Stephen's own home and config (the serve Claude starts inherits this env and must find the same home).
 * - Bedrock and Vertex sign-in and region, for the owners KEPT_CLAUDE_CODE_ENV already allows. No endpoint variable.
 */
export const KEPT_BASE_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM',
  'CLAUDE_CONFIG_DIR',
  'STEPHEN_HOME', 'STEPHEN_CONFIG', 'BROWSER_HUB_HOME', 'BROWSER_HUB_CONFIG',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
]);

/**
 * FAKE_*: settings of the test fakes that stand in for `claude` (test/). The one prefix on the lists, on purpose: Claude
 * Code reads no FAKE_ name, and none can move an endpoint, load code or change TLS. Every other name is listed one by one.
 */
const keptForClaude = (k: string) => KEPT_BASE_ENV.has(k) || KEPT_CLAUDE_CODE_ENV.has(k) || KEPT_ANTHROPIC_ENV.has(k) || k.startsWith('FAKE_');

/** Shell variables that could move Claude's endpoint or trust, and that Stephen drops (names only, for the doctor note). */
export function droppedEndpointEnv(env: NodeJS.ProcessEnv): string[] {
  const risky = /^(ANTHROPIC_|AWS_ENDPOINT_URL|DYLD_|LD_)|^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|AWS_CA_BUNDLE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)$/i;
  return Object.keys(env).filter((k) => risky.test(k) && !keptForClaude(k)).sort();
}

/**
 * Claude's environment, built from the allow-lists above (R23): no Stephen or account secret (review 6, R6-9; Stephen's
 * serve reads them from the Keychain or .env), no variable of a parent Claude Code session (R7-12), and nothing that
 * moves the endpoint or the trust. A name not on a list never reaches Claude.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv, home: string = homedir()): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && keptForClaude(k)) out[k] = v;
  // One value for Claude and for transcript cleanup (src/voice/transcripts.ts): a CLAUDE_CONFIG_DIR that is not safe is
  // dropped here, and cleanup then uses ~/.claude too, so the two always agree (R23 review, L1).
  const dir = claudeConfigDir(env, home);
  if (dir) out.CLAUDE_CONFIG_DIR = dir;
  else delete out.CLAUDE_CONFIG_DIR;
  return out;
}

/**
 * The shell's CLAUDE_CONFIG_DIR when it is safe to use, else undefined (then Claude uses ~/.claude): an absolute path,
 * inside the person's home folder, and a real folder (not a symlink). Returned resolved. The check runs on the real
 * path too, so a symlinked folder on the way (inside the home) cannot point outside it (R23 review L7).
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string = homedir()): string | undefined {
  const v = env.CLAUDE_CONFIG_DIR?.trim();
  if (!v || !isAbsolute(v)) return undefined;
  const dir = resolve(v);
  const rel = relative(resolve(home), dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    const real = relative(realpathSync(home), realpathSync(dir));
    return real && !real.startsWith('..') && !isAbsolute(real) ? dir : undefined;
  } catch {
    return undefined;
  }
}
