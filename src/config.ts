import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { HubError } from './errors.js';
import type { ResolvedConfig } from './types.js';

/** Extra Zen prefs for the AGENT profile only (written into its user.js block). */
export type ZenExtraPrefs = Record<string, string | number | boolean>;

/**
 * Whether Stephen may start Zen itself.
 *  - 'never': attach-only — use a Zen the user opened with remote control on (the "Zen for Stephen"
 *    app / `stephen zen-launch`); never spawn one. Default for mode 'real'.
 *  - 'auto': launch Zen when needed (the agent window, or a real-profile relaunch once Zen is quit). Default for mode 'agent'.
 */
export type ZenLaunch = 'never' | 'auto';

/**
 * ResolvedConfig plus settings not (yet) in the frozen contract in types.ts:
 * `zen.extraPrefs` — prefs written into the agent Zen profile's user.js (never the real profile);
 * `zen.launch` — see ZenLaunch.
 */
export type HubConfig = ResolvedConfig & {
  zen: ResolvedConfig['zen'] & { extraPrefs: ZenExtraPrefs; launch: ZenLaunch };
  /** Raw "desktop" section of config.json ({} if absent); src/desktop validates and applies defaults. */
  desktop: Record<string, unknown>;
  /** Raw "voice" section of config.json ({} if absent); src/voice validates and applies defaults. */
  voice: Record<string, unknown>;
  /** Raw "memory" section of config.json ({} if absent); src/memory/config.ts validates and applies defaults. */
  memory: Record<string, unknown>;
  /** Raw "history" section of config.json ({} if absent); src/history/config.ts validates and applies defaults. */
  history?: Record<string, unknown>;
  /** Raw "accounts" section of config.json ({} if absent); src/accounts/config.ts validates it (phase 2a). */
  accounts?: Record<string, unknown>;
  /** Raw "app" section of config.json ({} if absent); src/app/config.ts validates and applies defaults. */
  app?: Record<string, unknown>;
  /** Raw "jobs" section of config.json ({} if absent); src/jobs/config.ts validates and applies defaults. */
  jobs?: Record<string, unknown>;
};

type BaseUserConfig = {
  [K in keyof ResolvedConfig]?: ResolvedConfig[K] extends object
    ? ResolvedConfig[K] extends unknown[]
      ? ResolvedConfig[K]
      : Partial<ResolvedConfig[K]>
    : ResolvedConfig[K];
};

/** Deep-partial user config as stored in config.json. */
export type UserConfig = Omit<BaseUserConfig, 'zen'> & { zen?: Partial<HubConfig['zen']> };

export const DEFAULT_CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_CHROME_USER_DATA_DIR = '~/Library/Application Support/Google/Chrome';
export const DEFAULT_ZEN_APP_SUPPORT_DIR = '~/Library/Application Support/zen';
/** Probed in order; the first that exists wins. */
export const ZEN_EXECUTABLE_CANDIDATES = [
  '/Applications/Zen.app/Contents/MacOS/zen',
  '/Applications/Zen Browser.app/Contents/MacOS/zen',
  '/Applications/Zen Twilight.app/Contents/MacOS/zen',
] as const;

/** First existing Zen binary among the known macOS app names, else the conventional default path. */
export function detectZenExecutable(exists: (p: string) => boolean = existsSync): string {
  for (const p of ZEN_EXECUTABLE_CANDIDATES) {
    if (exists(p)) return p;
  }
  return ZEN_EXECUTABLE_CANDIDATES[0];
}

// ───────────────────────────── Validation schema ─────────────────────────────
// `null` is accepted anywhere a path/default is optional (DESIGN §3.5 shows nulls) and means "use the default".

const pathStr = z.string().trim().min(1, 'must be a non-empty path');
const optPath = pathStr.nullish();
const mode = z.enum(['real', 'agent']).nullish();
const strList = z.array(z.string().trim().min(1, 'entries must be non-empty strings')).nullish();
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullish();
/** Same rule as src/drivers/zen.ts ZEN_PREF_NAME_RE. */
const PREF_NAME_RE = /^[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-[\]]+)*$/;
const prefs = z
  .record(
    z.string().regex(PREF_NAME_RE, 'pref names are dotted identifiers like "fission.webContentIsolationStrategy"'),
    z.union([z.boolean(), z.number().int(), z.string().max(2000).regex(/^[^\r\n\u2028\u2029]*$/, 'string prefs must be one line')], {
      error: 'pref values must be true/false, integers, or one-line strings',
    }),
  )
  .refine((r) => !Object.hasOwn(r, 'remote.prefs.recommended'), 'remote.prefs.recommended is managed by Stephen')
  .nullish();

// Unknown keys are dropped, not refused: userConfigUnknownKeys lists them for doctor.
const UserConfigSchema = z.object({
  home: optPath,
  defaultBrowser: z.enum(['chrome', 'zen']).nullish(),
  chrome: z
    .object({
      mode,
      executablePath: optPath,
      userDataDir: optPath,
      agentProfileDir: optPath,
      extraArgs: strList,
    })
    .nullish(),
  zen: z
    .object({
      mode,
      executablePath: optPath,
      profilePath: optPath,
      zenAppSupportDir: optPath,
      agentProfileDir: optPath,
      extraArgs: strList,
      extraPrefs: prefs,
      launch: z.enum(['never', 'auto']).nullish(),
    })
    .nullish(),
  safety: z
    .object({
      confirm: z.enum(['auto', 'elicit', 'dialog', 'deny']).nullish(),
      blockedDomains: strList,
      sensitiveDomains: strList,
      allowEvaluate: z.boolean().nullish(),
      maxActionsPerMinute: int(1, 10_000),
      confirmCrossSiteTyping: z.boolean().nullish(),
      confirmTimeoutSec: int(5, 3600),
    })
    .nullish(),
  output: z
    .object({
      maxSnapshotChars: int(1000, 2_000_000),
      maxTextChars: int(1000, 2_000_000),
      saveDir: optPath,
    })
    .nullish(),
  auditLogPath: optPath,
  stateDir: optPath,
  /** Stephen desktop actions — validated by src/desktop (raw here so the two can evolve independently). */
  desktop: z.record(z.string(), z.unknown()).nullish(),
  /** "Hey Stephen" voice listener — validated by src/voice. */
  voice: z.record(z.string(), z.unknown()).nullish(),
  /** Saved memories ("remember …") — validated by src/memory/config.ts. */
  memory: z.record(z.string(), z.unknown()).nullish(),
  /** Command history (retention): validated by src/history/config.ts. */
  history: z.record(z.string(), z.unknown()).nullish(),
  /** Read-only account tools (Canvas, calendar, Notion, Gmail): validated by src/accounts/config.ts. */
  accounts: z.record(z.string(), z.unknown()).nullish(),
  /** The Stephen window's socket (app.sock): validated by src/app/config.ts. */
  app: z.record(z.string(), z.unknown()).nullish(),
  /** Background jobs ("start a job to …", docs/ADR-004): validated by src/jobs/config.ts. */
  jobs: z.record(z.string(), z.unknown()).nullish(),
});

type ParsedUserConfig = z.infer<typeof UserConfigSchema>;

function describeIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const key = i.path.map(String).join('.');
      if (i.code === 'unrecognized_keys') {
        const keys = i.keys.map((k) => (key ? `${key}.${k}` : k));
        return `unknown key${keys.length > 1 ? 's' : ''} ${keys.map((k) => `"${k}"`).join(', ')}`;
      }
      return `"${key || '(root)'}": ${i.message}`;
    })
    .join('; ');
}

function validate(raw: unknown, source: string): ParsedUserConfig {
  const r = UserConfigSchema.safeParse(raw ?? {});
  if (!r.success) {
    throw new HubError('INVALID_ARG', `Invalid config in ${source}: ${describeIssues(r.error)}`);
  }
  return r.data;
}

/**
 * Dotted paths (e.g. "voice.fooBar") of the keys in `raw` that `parsed` does not keep. The readers drop unknown keys
 * instead of refusing them, so `stephen doctor` can name them. Only key names are returned, never values.
 */
export function unknownKeyPaths(raw: unknown, parsed: unknown, prefix = ''): string[] {
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Object.hasOwn(parsed, k)) out.push(...unknownKeyPaths(v, parsed[k], path));
    else out.push(path);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unknown keys in a raw config.json: top level and the keys of the sections validated here. [] if it is invalid. */
export function userConfigUnknownKeys(raw: unknown): string[] {
  const r = UserConfigSchema.safeParse(raw ?? {});
  return r.success ? unknownKeyPaths(raw ?? {}, r.data) : [];
}

/** The parsed config.json at the path loadConfig reads (an empty object when there is no file). Throws on bad JSON. */
export function readUserConfigFile(env: NodeJS.ProcessEnv = process.env): unknown {
  return readConfigFile(configFilePath(env));
}

/**
 * A key name that looks like it holds a secret (key, token, secret or password). Secrets belong in the Keychain, never
 * in config.json, so such a key stops the start. `apiKeyFile` is a path, not a secret. Takes a dotted path or a bare name.
 */
export function looksLikeSecretKey(path: string): boolean {
  const name = path.slice(path.lastIndexOf('.') + 1);
  return name !== 'apiKeyFile' && /key|token|secret|password/i.test(name);
}

/** Strip null/undefined so they never overwrite a lower layer. */
function compact<T extends Record<string, unknown>>(o: T | null | undefined): Partial<T> {
  const out: Record<string, unknown> = {};
  if (!o) return out as Partial<T>;
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new HubError('INVALID_ARG', `Cannot read config file ${path}: ${(e as Error).message}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new HubError('INVALID_ARG', `Config file ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Expand a leading '~' and make absolute (relative paths resolve against `base`). */
export function expandPath(p: string, home: string, base: string = process.cwd()): string {
  let s = p.trim();
  if (s === '~') s = home;
  else if (s.startsWith('~/')) s = join(home, s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(base, s);
}

/** Stephen's home folder name under the user's home directory. */
export const STEPHEN_HOME_DIRNAME = '.stephen';
/** browser-hub's home folder (before the rename); still used when it exists and ~/.stephen does not. */
export const LEGACY_HOME_DIRNAME = '.browser-hub';

/** Where Stephen's home folder came from (see resolveStephenHome). */
export type HomeSource = 'STEPHEN_HOME' | 'BROWSER_HUB_HOME' | 'default' | 'legacy';

export interface StephenHome {
  /** Absolute path of the home folder (state, profiles, output, audit log, config.json). */
  dir: string;
  source: HomeSource;
  /** true = using the pre-rename ~/.browser-hub because ~/.stephen does not exist (doctor explains how to move it). */
  legacy: boolean;
}

function userHomeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.trim() ? env.HOME : homedir();
}

/**
 * Stephen's home folder, before any `"home"` key in config.json is applied:
 *   $STEPHEN_HOME → $BROWSER_HUB_HOME (pre-rename name, still honoured) → ~/.stephen,
 *   except that ~/.browser-hub keeps being used while it exists and ~/.stephen does not. It is never moved
 *   automatically: a running agent Zen and the state files point inside it.
 */
export function resolveStephenHome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): StephenHome {
  const userHome = userHomeOf(env);
  const fromEnv = env.STEPHEN_HOME?.trim();
  if (fromEnv) return { dir: expandPath(fromEnv, userHome), source: 'STEPHEN_HOME', legacy: false };
  const legacyEnv = env.BROWSER_HUB_HOME?.trim();
  if (legacyEnv) return { dir: expandPath(legacyEnv, userHome), source: 'BROWSER_HUB_HOME', legacy: false };
  const dir = join(resolve(userHome), STEPHEN_HOME_DIRNAME);
  const legacyDir = join(resolve(userHome), LEGACY_HOME_DIRNAME);
  if (!exists(dir) && exists(legacyDir)) return { dir: legacyDir, source: 'legacy', legacy: true };
  return { dir, source: 'default', legacy: false };
}

/** Doctor's note when Stephen still uses browser-hub's ~/.browser-hub (it is never moved automatically). */
export function legacyHomeNotice(dir: string): string {
  return (
    `using the legacy folder ${dir} (from browser-hub), because ~/${STEPHEN_HOME_DIRNAME} does not exist. ` +
    'To move it: quit the Zen and Chrome windows Stephen uses (agent windows, and a Zen opened with the "Zen for Stephen" app), ' +
    `then run: mv ~/${LEGACY_HOME_DIRNAME} ~/${STEPHEN_HOME_DIRNAME}`
  );
}

/** $STEPHEN_CONFIG, else $BROWSER_HUB_CONFIG (pre-rename name), else <home>/config.json. */
function configPathFor(env: NodeJS.ProcessEnv, home: string): string {
  const userHome = userHomeOf(env);
  const fromEnv = env.STEPHEN_CONFIG?.trim() || env.BROWSER_HUB_CONFIG?.trim();
  return fromEnv ? expandPath(fromEnv, userHome) : join(home, 'config.json');
}

/**
 * Load config: defaults ← $STEPHEN_CONFIG (or $BROWSER_HUB_CONFIG) or <home>/config.json ← `overrides`.
 * home = resolveStephenHome(env) (~/.stephen by default; see there for the env vars and the legacy ~/.browser-hub),
 * unless config.json sets "home". Expands '~'. Validates (throws HubError('INVALID_ARG') with a clear message).
 */
export function loadConfig(overrides?: UserConfig, env: NodeJS.ProcessEnv = process.env): HubConfig {
  const userHome = userHomeOf(env);
  const xp = (p: string, base?: string) => expandPath(p, userHome, base);

  const baseHome = resolveStephenHome(env).dir;
  const configPath = configPathFor(env, baseHome);

  const file = validate(readConfigFile(configPath), configPath);
  const over = validate(overrides ?? {}, 'overrides');

  // Layer merge (shallow per section; arrays replace).
  const pick = <K extends keyof ParsedUserConfig>(k: K) => ({
    ...compact(file[k] as Record<string, unknown> | null | undefined),
    ...compact(over[k] as Record<string, unknown> | null | undefined),
  });
  const top = { ...compact(file as Record<string, unknown>), ...compact(over as Record<string, unknown>) } as {
    home?: string;
    defaultBrowser?: 'chrome' | 'zen';
    auditLogPath?: string;
    stateDir?: string;
  };
  const chrome = pick('chrome') as NonNullable<ParsedUserConfig['chrome']>;
  const zen = pick('zen') as NonNullable<ParsedUserConfig['zen']>;
  const safety = pick('safety') as NonNullable<ParsedUserConfig['safety']>;
  const output = pick('output') as NonNullable<ParsedUserConfig['output']>;

  const home = top.home ? xp(top.home) : baseHome;
  // Zen defaults to attach-only real mode (use the Zen the user opened for Stephen, never start one);
  // an explicit agent mode keeps launching its own window unless launch says otherwise.
  const zenMode = zen.mode ?? 'real';
  const zenLaunch: ZenLaunch = zen.launch ?? (zenMode === 'agent' ? 'auto' : 'never');
  const hp = (p: string | null | undefined, dflt: string) => (p ? xp(p, home) : xp(dflt, home));

  return {
    home,
    defaultBrowser: top.defaultBrowser ?? 'zen',
    chrome: {
      mode: chrome.mode ?? 'real',
      executablePath: hp(chrome.executablePath, DEFAULT_CHROME_EXECUTABLE),
      userDataDir: hp(chrome.userDataDir, DEFAULT_CHROME_USER_DATA_DIR),
      agentProfileDir: hp(chrome.agentProfileDir, join(home, 'profiles', 'chrome')),
      extraArgs: [...(chrome.extraArgs ?? [])],
    },
    zen: {
      mode: zenMode,
      executablePath: zen.executablePath ? xp(zen.executablePath, home) : detectZenExecutable(),
      profilePath: zen.profilePath ? xp(zen.profilePath, home) : null,
      zenAppSupportDir: hp(zen.zenAppSupportDir, DEFAULT_ZEN_APP_SUPPORT_DIR),
      agentProfileDir: hp(zen.agentProfileDir, join(home, 'profiles', 'zen')),
      extraArgs: [...(zen.extraArgs ?? [])],
      extraPrefs: { ...(zen.extraPrefs ?? {}) },
      launch: zenLaunch,
    },
    safety: {
      confirm: safety.confirm ?? 'auto',
      blockedDomains: [...(safety.blockedDomains ?? [])],
      sensitiveDomains: [...(safety.sensitiveDomains ?? [])],
      allowEvaluate: safety.allowEvaluate ?? false,
      maxActionsPerMinute: safety.maxActionsPerMinute ?? 40,
      confirmCrossSiteTyping: safety.confirmCrossSiteTyping ?? true,
      confirmTimeoutSec: safety.confirmTimeoutSec ?? 120,
    },
    output: {
      maxSnapshotChars: output.maxSnapshotChars ?? 20_000,
      maxTextChars: output.maxTextChars ?? 20_000,
      saveDir: hp(output.saveDir, join(home, 'output')),
    },
    auditLogPath: hp(top.auditLogPath, join(home, 'audit.log')),
    stateDir: hp(top.stateDir, join(home, 'state')),
    desktop: { ...((file as { desktop?: Record<string, unknown> | null }).desktop ?? {}), ...((over as { desktop?: Record<string, unknown> | null }).desktop ?? {}) },
    voice: { ...((file as { voice?: Record<string, unknown> | null }).voice ?? {}), ...((over as { voice?: Record<string, unknown> | null }).voice ?? {}) },
    memory: { ...((file as { memory?: Record<string, unknown> | null }).memory ?? {}), ...((over as { memory?: Record<string, unknown> | null }).memory ?? {}) },
    history: { ...(file.history ?? {}), ...(over.history ?? {}) },
    accounts: { ...(file.accounts ?? {}), ...(over.accounts ?? {}) },
    app: { ...(file.app ?? {}), ...(over.app ?? {}) },
    jobs: { ...(file.jobs ?? {}), ...(over.jobs ?? {}) },
  };
}

/** Where loadConfig looks for the config file (for doctor / README). */
export function configFilePath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  return configPathFor(env, resolveStephenHome(env, exists).dir);
}
