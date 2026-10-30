/**
 * `stephen selftest` — proves on the user's machine that each browser works end to end, safely:
 *  - always the AGENT mode with a fresh temporary profile under <home>/selftest/<browser>-<random>
 *    (mode 0700), never the user's real profile, whatever the config says;
 *  - only local fixture pages served from this process on 127.0.0.1 (two origins: 127.0.0.1 and localhost);
 *  - its own audit log / state / output inside that temp dir (the user's audit log and config are untouched);
 *  - closes the browser it launched and deletes the temp dir (unless --keep-open), and only ever
 *    signals processes it started itself.
 */
import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { ZEN_EXECUTABLE_CANDIDATES, configFilePath, loadConfig, type HubConfig, type ZenExtraPrefs } from '../config.js';
import { findZenExecutable } from '../drivers/macos.js';
import { ensurePrivateDir, isExecutable } from '../drivers/util.js';
import { isZenAttachOnly } from '../drivers/zen.js';
import { errorMessage } from '../errors.js';
import { packageVersion } from '../server/index.js';
import type { BrowserName, Protocol, ResolvedConfig } from '../types.js';
import { CHECK_NAMES, DISCONNECT_CHECK_ID, REPORT_HINT, runChecks, type CheckEnv, type CheckResult, type CheckStatus } from './checks.js';
import { startFixtureServer, type FixtureServer } from './fixtures.js';
import { liveSpawnedPids, openSelftestSession, type SelftestSession, type SessionOptions } from './session.js';

export type { CheckResult, CheckStatus } from './checks.js';
export { CHECK_NAMES } from './checks.js';

export type BrowserChoice = BrowserName | 'all';

export interface SelftestOptions {
  browser: BrowserChoice;
  keepOpen: boolean;
  json: boolean;
}

export interface BrowserReport {
  browser: BrowserName;
  status: CheckStatus;
  protocol: Protocol;
  executablePath: string | null;
  /** Browser product/version as reported over the protocol. */
  version: string | null;
  /** Temporary profile dir used (deleted afterwards unless --keep-open). */
  profileDir: string | null;
  /** Why the browser was skipped / could not be tested at all. */
  reason?: string;
  hint?: string;
  checks: CheckResult[];
}

export interface SelftestReport {
  ok: boolean;
  exitCode: number;
  /** Stephen's version. */
  stephen: string;
  node: string;
  platform: string;
  fixtures: { a: string; b: string } | null;
  browsers: BrowserReport[];
  summary: string;
}

export type Locate = { found: true; path: string } | { found: false; searched: string[]; suggestion?: string };

export interface SelftestDeps {
  /** The user's config (read only; only binary paths and extraArgs are taken from it). */
  loadConfig(): ResolvedConfig;
  locate(browser: BrowserName, cfg: ResolvedConfig): Promise<Locate>;
  startFixtures(): Promise<FixtureServer>;
  /** Create <home>/selftest/<browser>-<random> (0700). */
  createRunDir(cfg: ResolvedConfig, browser: BrowserName): Promise<string>;
  removeRunDir(dir: string, cfg: ResolvedConfig): Promise<void>;
  openSession(cfg: ResolvedConfig, browser: BrowserName): Promise<SelftestSession>;
  runChecks(env: CheckEnv): Promise<CheckResult[]>;
  /** Text-mode live output (one call per line). */
  out(line: string): void;
  configPath(): string;
}

const NICE: Record<BrowserName, string> = { chrome: 'Chrome', zen: 'Zen' };
const PROTOCOL: Record<BrowserName, Protocol> = { chrome: 'cdp', zen: 'webDriverBiDi' };
const PROTOCOL_NAME: Record<Protocol, string> = { cdp: 'CDP', webDriverBiDi: 'WebDriver BiDi' };

/**
 * Extra Chrome flags for the throwaway selftest profile: no background downloads/sync, and on macOS
 * no access to the user's login keychain (a fresh profile would otherwise touch "Chrome Safe Storage").
 */
export const CHROME_SELFTEST_ARGS: readonly string[] = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--no-pings',
  '--use-mock-keychain',
];

/**
 * Prefs written into the throwaway Zen profile before launch: no first-run/welcome pages or update
 * checks (which would reach the internet), no telemetry.
 */
export const ZEN_SELFTEST_USER_JS = [
  '// Stephen selftest: temporary profile, deleted after the run',
  'user_pref("browser.startup.page", 0);',
  'user_pref("browser.startup.homepage", "about:blank");',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("startup.homepage_welcome_url", "about:blank");',
  'user_pref("startup.homepage_welcome_url.additional", "");',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);',
  'user_pref("zen.welcome-screen.seen", true);',
  'user_pref("browser.newtabpage.enabled", false);',
  'user_pref("app.update.auto", false);',
  'user_pref("app.update.enabled", false);',
  'user_pref("app.update.checkInstallTime", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("datareporting.healthreport.uploadEnabled", false);',
  'user_pref("toolkit.telemetry.enabled", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("extensions.update.enabled", false);',
  '',
].join('\n');

// ───────────────────────────── config ─────────────────────────────

/**
 * The config the selftest runs with: binary paths and extra args from the user's config, everything
 * else forced — agent mode for BOTH browsers, profile/state/output/audit inside `runDir`, real-profile
 * locations pointed at a nonexistent dir inside `runDir`, and a safety gate that never asks a human.
 * `zen.extraPrefs` (agent-profile prefs) is carried over too, so an opt-in such as the iframe-click
 * workaround (README) can be verified by re-running the selftest.
 */
export function buildSelftestConfig(user: ResolvedConfig, browser: BrowserName, runDir: string, executablePath: string): HubConfig {
  const extraPrefs = (user.zen as Partial<HubConfig['zen']>).extraPrefs;
  const nowhere = join(runDir, 'no-real-profile');
  return {
    home: runDir,
    defaultBrowser: browser,
    chrome: {
      mode: 'agent',
      executablePath: browser === 'chrome' ? executablePath : user.chrome.executablePath,
      userDataDir: nowhere,
      agentProfileDir: join(runDir, 'profile'),
      extraArgs: [...user.chrome.extraArgs, ...CHROME_SELFTEST_ARGS],
    },
    zen: {
      mode: 'agent',
      executablePath: browser === 'zen' ? executablePath : user.zen.executablePath,
      profilePath: null,
      zenAppSupportDir: nowhere,
      agentProfileDir: join(runDir, 'profile'),
      extraArgs: [...user.zen.extraArgs],
      extraPrefs: { ...((extraPrefs ?? {}) as ZenExtraPrefs) },
      // The selftest starts (and stops) its own temporary agent Zen, whatever the user's zen.launch says.
      launch: 'auto',
    },
    safety: {
      confirm: 'deny',
      blockedDomains: [],
      sensitiveDomains: [],
      allowEvaluate: false,
      maxActionsPerMinute: 40,
      confirmCrossSiteTyping: true,
      confirmTimeoutSec: 5,
    },
    output: { maxSnapshotChars: 20_000, maxTextChars: 20_000, saveDir: join(runDir, 'output') },
    auditLogPath: join(runDir, 'audit.log'),
    stateDir: join(runDir, 'state'),
    // Desktop actions and the voice listener are not exercised by the browser selftest.
    desktop: {},
    voice: {},
  };
}

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

/** Throws unless `cfg` can only ever run agent mode inside `runDir`. */
export function assertSelftestConfig(cfg: ResolvedConfig, runDir: string): void {
  const problems: string[] = [];
  if (cfg.chrome.mode !== 'agent' || cfg.zen.mode !== 'agent') problems.push('a browser is not in agent mode');
  if (cfg.zen.profilePath !== null) problems.push('zen.profilePath is set');
  if (isZenAttachOnly(cfg)) problems.push('zen.launch is "never"');
  for (const [k, p] of Object.entries({
    'chrome.agentProfileDir': cfg.chrome.agentProfileDir,
    'chrome.userDataDir': cfg.chrome.userDataDir,
    'zen.agentProfileDir': cfg.zen.agentProfileDir,
    'zen.zenAppSupportDir': cfg.zen.zenAppSupportDir,
    stateDir: cfg.stateDir,
    auditLogPath: cfg.auditLogPath,
    'output.saveDir': cfg.output.saveDir,
  })) {
    if (!isInside(p, runDir)) problems.push(`${k} is outside the temporary dir`);
  }
  if (cfg.safety.confirm !== 'deny') problems.push('confirmations are not set to deny');
  if (problems.length) throw new Error(`internal error, refusing to run: ${problems.join('; ')}`);
}

// ───────────────────────────── hints ─────────────────────────────

function binaryHint(browser: BrowserName, searched: string[], configPath: string, suggestion?: string): string {
  const where = `looked in: ${searched.join(', ')}`;
  if (suggestion) return `${where}. Found ${NICE[browser]} at ${suggestion} — set "${browser}.executablePath" to it in ${configPath}.`;
  const install = browser === 'zen' ? 'Install Zen (https://zen-browser.app) into /Applications' : 'Install Google Chrome';
  return `${where}. ${install}, or set "${browser}.executablePath" in ${configPath} to the binary (…app/Contents/MacOS/${browser === 'zen' ? 'zen' : 'Google Chrome'}).`;
}

/** Turn a failed browser_connect into the most likely cause and fix. */
export function connectHint(browser: BrowserName, message: string, configPath: string): string {
  const key = `"${browser}.executablePath"`;
  if (/was not found at|binary not found/i.test(message)) {
    return `The ${NICE[browser]} binary is missing or not executable. Set ${key} in ${configPath}.`;
  }
  if (/has not enabled remote control within/i.test(message)) {
    return (
      'Zen started but never printed "WebDriver BiDi listening on ws://…" in time. Likely causes: the first launch after a Zen update ' +
      'is slow (re-run the selftest), the binary is not Zen/Firefox (check zen.executablePath), or security software blocked its ' +
      'loopback port. The Zen it started was stopped.'
    );
  }
  if (/exited (right after launch|without enabling|before)/i.test(message)) {
    return `${NICE[browser]} quit right after starting. Check that ${key} points at a working ${NICE[browser]} binary and that it opens normally; see the log lines above.`;
  }
  if (/did not open its debugging port/i.test(message)) {
    return `Chrome started but did not open its debugging port. Check ${key} and "chrome.extraArgs" in ${configPath}.`;
  }
  if (/active sessions|automation session/i.test(message)) {
    return 'Zen refused a new automation session. Re-run the selftest; if it persists, report it.';
  }
  return `Run \`stephen doctor\` and fix anything red, then re-run. ${REPORT_HINT}`;
}

// ───────────────────────────── default deps ─────────────────────────────

function selftestRoot(cfg: ResolvedConfig): string {
  return join(cfg.home, 'selftest');
}

async function defaultLocate(browser: BrowserName, cfg: ResolvedConfig): Promise<Locate> {
  const configured = cfg[browser].executablePath;
  if (await isExecutable(configured)) return { found: true, path: configured };
  // What `serve` would use is exactly cfg.<browser>.executablePath — test that, and only suggest others.
  let searched = [configured];
  if (browser === 'zen' && (ZEN_EXECUTABLE_CANDIDATES as readonly string[]).includes(configured)) {
    searched = [...new Set([configured, ...ZEN_EXECUTABLE_CANDIDATES])];
  }
  let suggestion: string | undefined;
  if (browser === 'zen') suggestion = (await findZenExecutable().catch(() => null)) ?? undefined;
  else {
    const userApp = join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
    if (userApp !== configured && (await isExecutable(userApp))) suggestion = userApp;
  }
  if (suggestion && !searched.includes(suggestion)) return { found: false, searched, suggestion };
  return { found: false, searched };
}

async function defaultCreateRunDir(cfg: ResolvedConfig, browser: BrowserName): Promise<string> {
  const root = selftestRoot(cfg);
  await ensurePrivateDir(root, cfg.home);
  const dir = await mkdtemp(join(root, `${browser}-`));
  await chmod(dir, 0o700);
  emergencyDirs.add(dir);
  return dir;
}

async function defaultRemoveRunDir(dir: string, cfg: ResolvedConfig): Promise<void> {
  const root = selftestRoot(cfg);
  if (!isInside(dir, root)) throw new Error(`refusing to delete ${dir}: not inside ${root}`);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  emergencyDirs.delete(dir);
  await rmdir(root).catch(() => undefined); // only if empty
}

export function defaultSelftestDeps(sessionOpts: SessionOptions = {}): SelftestDeps {
  return {
    loadConfig: () => loadConfig(),
    locate: defaultLocate,
    startFixtures: startFixtureServer,
    createRunDir: defaultCreateRunDir,
    removeRunDir: defaultRemoveRunDir,
    openSession: async (cfg, browser) => {
      if (browser === 'zen') {
        await mkdir(cfg.zen.agentProfileDir, { recursive: true, mode: 0o700 });
        await writeFile(join(cfg.zen.agentProfileDir, 'user.js'), ZEN_SELFTEST_USER_JS, { mode: 0o600 });
      }
      return openSelftestSession(cfg, browser, sessionOpts);
    },
    runChecks,
    out: (line) => console.log(line),
    configPath: () => configFilePath(),
  };
}

// ───────────────────────────── emergency cleanup (Ctrl-C) ─────────────────────────────

const emergencyDirs = new Set<string>();

/**
 * Synchronous best-effort cleanup for SIGINT/SIGTERM during a run: SIGTERM the browsers this run
 * started (their own process groups — nothing else) and delete the temporary dirs.
 */
export function emergencyCleanup(): void {
  for (const pid of liveSpawnedPids) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
  liveSpawnedPids.clear();
  for (const dir of emergencyDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
  emergencyDirs.clear();
}

// ───────────────────────────── formatting ─────────────────────────────

const STATUS_WORD: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

export function formatCheckRow(r: CheckResult): string[] {
  const time = r.status === 'skip' ? '' : `${r.ms} ms`;
  const lines = [`  ${String(r.id).padStart(2)}  ${r.name.padEnd(34)} ${STATUS_WORD[r.status]}  ${time.padStart(8)}${r.detail ? `  ${firstLine(r.detail)}` : ''}`];
  if (r.status === 'fail' && r.detail && r.detail.includes('\n')) {
    for (const l of r.detail.split('\n').slice(1, 12)) lines.push(`        ${l}`);
  }
  if (r.status === 'fail' && r.hint) lines.push(`        fix: ${r.hint}`);
  return lines;
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}

export function formatBrowserHeader(b: Pick<BrowserReport, 'browser' | 'executablePath' | 'profileDir'>, configuredMode?: string): string[] {
  const lines = [`${NICE[b.browser]} (${PROTOCOL_NAME[PROTOCOL[b.browser]]}) — ${b.executablePath ?? 'not found'}`];
  if (b.profileDir) {
    const note = configuredMode === 'real' ? '; your configured real profile is never used' : '';
    lines.push(`  temporary agent profile: ${b.profileDir}${note}`);
  }
  return lines;
}

export function formatBrowserFooter(b: BrowserReport): string[] {
  const lines: string[] = [];
  if (b.status === 'skip' || (b.status === 'fail' && !b.checks.length)) {
    lines.push(`  ${STATUS_WORD[b.status]}: ${b.reason ?? ''}`);
    if (b.hint) lines.push(`  fix: ${b.hint}`);
    return lines;
  }
  if (b.version) lines.push(`  browser version: ${b.version}`);
  const passed = b.checks.filter((c) => c.status === 'pass').length;
  lines.push(`  → ${STATUS_WORD[b.status]} (${passed}/${b.checks.length} checks passed)`);
  return lines;
}

function browserSummary(b: BrowserReport): string {
  if (b.status === 'skip') return `${b.browser} skipped (${b.reason ?? 'not tested'})`;
  if (!b.checks.length) return `${b.browser} FAILED (${b.reason ?? 'not tested'})`;
  const passed = b.checks.filter((c) => c.status === 'pass').length;
  const failed = b.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  return b.status === 'pass'
    ? `${b.browser} ${passed}/${b.checks.length} passed`
    : `${b.browser} FAILED (${passed}/${b.checks.length} passed; failed: ${failed.join(', ')})`;
}

/** Exit code 0 only if at least one browser was tested and nothing that was not skipped failed. */
export function summarize(browsers: BrowserReport[]): { ok: boolean; exitCode: number; summary: string } {
  const tested = browsers.filter((b) => b.status !== 'skip');
  const failed = browsers.filter((b) => b.status === 'fail');
  const ok = tested.length > 0 && failed.length === 0;
  const parts = browsers.map(browserSummary).join(' · ');
  const summary = !tested.length
    ? `Result: FAIL — no browser could be tested (${parts})`
    : `Result: ${ok ? 'PASS' : 'FAIL'} — ${parts}`;
  return { ok, exitCode: ok ? 0 : 1, summary };
}

// ───────────────────────────── orchestration ─────────────────────────────

/** Fill in checks 1–15 that did not report (e.g. the session could not be opened). */
function completeChecks(checks: CheckResult[], failure?: string): CheckResult[] {
  const out: CheckResult[] = [];
  let failed = false;
  for (let id = 1; id < DISCONNECT_CHECK_ID; id++) {
    const have = checks.find((c) => c.id === id);
    if (have) {
      out.push(have);
      continue;
    }
    if (failure && !failed && !checks.some((c) => c.status === 'fail')) {
      out.push({ id, name: CHECK_NAMES[id - 1]!, status: 'fail', ms: 0, detail: failure, hint: REPORT_HINT });
      failed = true;
    } else {
      out.push({ id, name: CHECK_NAMES[id - 1]!, status: 'skip', ms: 0, detail: 'not run' });
    }
  }
  return out;
}

export async function runSelftest(opts: SelftestOptions, deps: SelftestDeps = defaultSelftestDeps()): Promise<SelftestReport> {
  const say = (lines: string | string[]) => {
    if (opts.json) return;
    for (const l of Array.isArray(lines) ? lines : [lines]) deps.out(l);
  };
  const user = deps.loadConfig();
  const configPath = deps.configPath();
  const names: BrowserName[] = opts.browser === 'all' ? ['chrome', 'zen'] : [opts.browser];
  const explicit = opts.browser !== 'all';
  const base = { stephen: packageVersion(), node: process.versions.node, platform: process.platform };

  say(`stephen selftest v${base.stephen} · Node ${base.node} · ${base.platform}`);
  const fixtures = await deps.startFixtures();
  say([`Local test pages: ${fixtures.a} and ${fixtures.b} (loopback only)`, '']);

  const browsers: BrowserReport[] = [];
  try {
    for (const browser of names) {
      const report = await runOne(browser);
      browsers.push(report);
      say([...formatBrowserFooter(report), '']);
    }
  } finally {
    await fixtures.close().catch(() => undefined);
  }
  const s = summarize(browsers);
  say(s.summary);
  return { ...s, ...base, fixtures: { a: fixtures.a, b: fixtures.b }, browsers };

  async function runOne(browser: BrowserName): Promise<BrowserReport> {
    const loc = await deps.locate(browser, user);
    if (!loc.found) {
      const report: BrowserReport = {
        browser,
        status: explicit ? 'fail' : 'skip',
        protocol: PROTOCOL[browser],
        executablePath: null,
        version: null,
        profileDir: null,
        reason: `${NICE[browser]} not found`,
        hint: binaryHint(browser, loc.searched, configPath, loc.suggestion),
        checks: [],
      };
      say(formatBrowserHeader(report));
      return report;
    }

    const runDir = await deps.createRunDir(user, browser);
    const cfg = buildSelftestConfig(user, browser, runDir, loc.path);
    try {
      assertSelftestConfig(cfg, runDir);
    } catch (e) {
      await deps.removeRunDir(runDir, user).catch(() => undefined);
      throw e;
    }
    const profileDir = cfg[browser].agentProfileDir;
    say(formatBrowserHeader({ browser, executablePath: loc.path, profileDir }, user[browser].mode));

    let session: SelftestSession | null = null;
    let checks: CheckResult[] = [];
    let version: string | null = null;
    let failure: string | undefined;
    try {
      session = await deps.openSession(cfg, browser);
      checks = await deps.runChecks({
        browser,
        call: session.call,
        fixtures,
        onResult: (r) => say(formatCheckRow(r)),
        connectHint: (m) => connectHint(browser, m, configPath),
      });
      version = await session.version().catch(() => null);
      const first = checks.find((c) => c.id === 1);
      if (first?.status === 'fail') {
        const log = await session.diagnostics().catch(() => null);
        if (log) first.hint = `${first.hint ?? ''}${first.hint ? ' ' : ''}${NICE[browser]} said: ${log}`;
      }
    } catch (e) {
      failure = `selftest error: ${errorMessage(e)}`;
    }
    const before = checks.length;
    checks = completeChecks(checks, failure);
    for (const c of checks.slice(before)) say(formatCheckRow(c));

    const connected = checks.find((c) => c.id === 1)?.status === 'pass';
    const last = await finish(session, runDir, connected);
    say(formatCheckRow(last));
    checks.push(last);

    const status: CheckStatus = checks.some((c) => c.status === 'fail') ? 'fail' : 'pass';
    return { browser, status, protocol: PROTOCOL[browser], executablePath: loc.path, version, profileDir, checks };
  }

  /** Check 16: disconnect, verify, close the browser we started, delete the temp dir. Every phase runs even if an earlier one failed. */
  async function finish(session: SelftestSession | null, runDir: string, connected: boolean): Promise<CheckResult> {
    const t0 = performance.now();
    const notes: string[] = [];
    const problems: string[] = [];
    const attempt = async (what: string, fn: () => Promise<string | void>) => {
      try {
        const note = await fn();
        if (note) notes.push(note);
      } catch (e) {
        problems.push(`${what}: ${errorMessage(e)}`);
      }
    };
    if (session) {
      await attempt('disconnect', () => session.disconnect());
      if (connected) await attempt('after disconnect', () => session.verifyDisconnected());
      if (opts.keepOpen) await attempt('keep open', () => session.release());
      else await attempt('closing the browser', () => session.closeBrowser());
    }
    if (opts.keepOpen) notes.push(`profile kept at ${runDir} — quit that browser and delete the folder when done`);
    else await attempt('deleting the temporary profile', async () => {
      await deps.removeRunDir(runDir, user);
      return 'temp profile deleted';
    });
    const ms = Math.round(performance.now() - t0);
    const name = CHECK_NAMES[DISCONNECT_CHECK_ID - 1]!;
    if (problems.length) {
      return {
        id: DISCONNECT_CHECK_ID,
        name,
        status: 'fail',
        ms,
        detail: [...problems, ...notes].join('; '),
        hint: `If a browser window from the selftest is still open, quit it; then delete ${runDir} if it still exists. ${REPORT_HINT}`,
      };
    }
    return { id: DISCONNECT_CHECK_ID, name, status: 'pass', ms, detail: notes.join('; ') };
  }
}

// ───────────────────────────── CLI ─────────────────────────────

export const SELFTEST_USAGE = 'stephen selftest [--browser chrome|zen|all] [--keep-open] [--json]';

/** Parse `selftest` flags. Returns an error string for bad input. */
export function parseSelftestArgs(argv: string[]): SelftestOptions | { error: string } {
  const opts: SelftestOptions = { browser: 'all', keepOpen: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--keep-open') opts.keepOpen = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--browser' || a.startsWith('--browser=')) {
      const v = a === '--browser' ? argv[++i] : a.slice('--browser='.length);
      if (v !== 'chrome' && v !== 'zen' && v !== 'all') return { error: `--browser must be chrome, zen or all (got ${v ?? 'nothing'})` };
      opts.browser = v;
    } else return { error: `unknown option ${a}` };
  }
  return opts;
}
