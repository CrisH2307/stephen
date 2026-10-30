import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { HubError } from './errors.js';
import type { ResolvedConfig } from './types.js';

/** Extra Zen prefs for the AGENT profile only (written into its user.js block). */
export type ZenExtraPrefs = Record<string, string | number | boolean>;

/**
 * Whether browser-hub may start Zen itself.
 *  - 'never': attach-only — use a Zen the user opened with remote control on (the "Zen for Claude"
 *    app / `browser-hub zen-launch`); never spawn one. Default for mode 'real'.
 *  - 'auto': launch Zen when needed (the agent window, or a real-profile relaunch once Zen is quit). Default for mode 'agent'.
 */
export type ZenLaunch = 'never' | 'auto';

/**
 * ResolvedConfig plus settings not (yet) in the frozen contract in types.ts:
 * `zen.extraPrefs` — prefs written into the agent Zen profile's user.js (never the real profile);
 * `zen.launch` — see ZenLaunch.
 */
export type HubConfig = ResolvedConfig & { zen: ResolvedConfig['zen'] & { extraPrefs: ZenExtraPrefs; launch: ZenLaunch } };

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
  .refine((r) => !Object.hasOwn(r, 'remote.prefs.recommended'), 'remote.prefs.recommended is managed by browser-hub')
  .nullish();

const UserConfigSchema = z.strictObject({
  home: optPath,
  defaultBrowser: z.enum(['chrome', 'zen']).nullish(),
  chrome: z
    .strictObject({
      mode,
      executablePath: optPath,
      userDataDir: optPath,
      agentProfileDir: optPath,
      extraArgs: strList,
    })
    .nullish(),
  zen: z
    .strictObject({
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
    .strictObject({
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
    .strictObject({
      maxSnapshotChars: int(1000, 2_000_000),
      maxTextChars: int(1000, 2_000_000),
      saveDir: optPath,
    })
    .nullish(),
  auditLogPath: optPath,
  stateDir: optPath,
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

/**
 * Load config: defaults ← $BROWSER_HUB_CONFIG or <home>/config.json ← `overrides`.
 * home = $BROWSER_HUB_HOME or ~/.browser-hub. Expands '~'. Validates (throws HubError('INVALID_ARG') with a clear message).
 */
export function loadConfig(overrides?: UserConfig, env: NodeJS.ProcessEnv = process.env): HubConfig {
  const userHome = env.HOME && env.HOME.trim() ? env.HOME : homedir();
  const xp = (p: string, base?: string) => expandPath(p, userHome, base);

  const envHome = env.BROWSER_HUB_HOME?.trim();
  const baseHome = xp(envHome || '~/.browser-hub');
  const envConfig = env.BROWSER_HUB_CONFIG?.trim();
  const configPath = envConfig ? xp(envConfig) : join(baseHome, 'config.json');

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
  // Zen defaults to attach-only real mode (use the Zen the user opened for Claude, never start one);
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
  };
}

/** Where loadConfig looks for the config file (for doctor / README). */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const userHome = env.HOME && env.HOME.trim() ? env.HOME : homedir();
  if (env.BROWSER_HUB_CONFIG?.trim()) return expandPath(env.BROWSER_HUB_CONFIG, userHome);
  return join(expandPath(env.BROWSER_HUB_HOME?.trim() || '~/.browser-hub', userHome), 'config.json');
}
