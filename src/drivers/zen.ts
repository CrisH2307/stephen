/**
 * ZenDriver — Zen (Gecko) over WebDriver BiDi.
 *
 * Gecko only starts its Remote Agent when launched with --remote-debugging-port, so we always
 * launch Zen ourselves (detached, so it outlives the server) and read the
 * "WebDriver BiDi listening on ws://…" line it prints, then connect to `<url>/session`.
 *
 * 'agent' uses a dedicated profile and runs alongside the user's normal Zen (--new-instance).
 * 'real'  uses the user's profile; Zen must be fully quit first. We never force-quit it.
 *
 * `zen.launch: 'never'` (the default for 'real') makes the driver ATTACH-ONLY: it never spawns Zen.
 * It reattaches to the Zen named by the state file — started with remote control by
 * `stephen zen-launch` (the "Zen for Stephen" app, see launchForClaude()) — and otherwise fails with
 * a NEEDS_USER error telling the user to open Zen with that app.
 *
 * Gecko allows ONE BiDi session at a time, so disconnect() must end the session (see the
 * note in disconnect()). A state file lets a restarted server reattach to a Zen it launched; it
 * also records which Stephen process owns the session, so a second Claude Code session gets
 * a clear "someone else is using it" error instead of being told to quit Zen.
 *
 * We never kill Zen — not even one we just launched that is slow to start (first launch after an
 * update can take a minute): it is left running and the next connect resumes waiting for it.
 */
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { HubError } from '../errors.js';
import type { ProfileMode, ResolvedConfig } from '../types.js';
import type { ZenLaunch } from '../config.js';
import { isProcessRunning, parseBidiListening, resolveZenRealProfile } from './macos.js';
import {
  type Clock,
  type ConnectFn,
  type SpawnFn,
  type SpawnedProcess,
  connectWithTimeout,
  defaultConnect,
  defaultSpawn,
  errText,
  probeWsEndpoint,
  realClock,
  withTimeout,
} from './util.js';
import { DriverBase, watchLaunch } from './common.js';
import { ensurePrivateDir, isExecutable } from '../lib/fs.js';
import { isPidAlive } from '../lib/process.js';

export interface ZenDriverDeps {
  connect: ConnectFn;
  spawn: SpawnFn;
  clock: Clock;
  isExecutable: (file: string) => Promise<boolean>;
  isProcessRunning: (name: string) => Promise<boolean>;
  isPidAlive: (pid: number) => boolean;
  resolveRealProfile: (cfg: ResolvedConfig) => Promise<string | null>;
  /** Does something answer at this ws:// endpoint? (TCP only — never opens a BiDi session.) */
  probeEndpoint: (wsUrl: string) => Promise<boolean>;
  /** How long to wait for the "WebDriver BiDi listening" line (first launch after an update is slow). */
  listenTimeoutMs: number;
  /** This server's pid, recorded as the owner of the BiDi session. */
  ownerPid: number;
  connectTimeoutMs: number;
  /** Reattach to a Zen from the state file. */
  reattachTimeoutMs: number;
  disconnectTimeoutMs: number;
  pollIntervalMs: number;
}

const DEFAULT_DEPS: ZenDriverDeps = {
  connect: defaultConnect,
  spawn: defaultSpawn,
  clock: realClock,
  isExecutable,
  isProcessRunning,
  isPidAlive,
  resolveRealProfile: resolveZenRealProfile,
  probeEndpoint: (wsUrl) => probeWsEndpoint(wsUrl),
  listenTimeoutMs: 60_000,
  ownerPid: process.pid,
  connectTimeoutMs: 20_000,
  reattachTimeoutMs: 5_000,
  disconnectTimeoutMs: 5_000,
  pollIntervalMs: 100,
};

/** Persisted to `<stateDir>/zen.json` so a restarted server can reattach. */
export interface ZenState {
  pid: number;
  /** '' while `starting` (launched, BiDi endpoint not reported yet). */
  wsUrl: string;
  profileDir: string;
  mode: ProfileMode;
  /** pid of the Stephen server whose BiDi session is open on this Zen (absent = none). */
  ownerPid?: number;
  /** Launched but still starting up: the next connect keeps waiting on `logPath` instead of relaunching. */
  starting?: boolean;
  logPath?: string;
}

/** Name of the launcher app `stephen install-zen-launcher` creates in ~/Applications. */
export const ZEN_LAUNCHER_APP_NAME = 'Zen for Stephen';
/** The launcher's name before the rename (from browser-hub); doctor suggests replacing it. */
export const LEGACY_ZEN_LAUNCHER_APP_NAME = 'Zen for Claude';

/** How browser_status / browser_connect / doctor describe attach-only Zen. */
export const ZEN_ATTACH_ONLY_LABEL = 'attach-only (uses your open Zen; never launches one)';

/** Why a normal Zen window does not work (#89). True to the code: Gecko opens its remote-control port only when started with --remote-debugging-port, which `stephen zen-launch` passes. */
export const ZEN_WHY_LAUNCHER =
  "Stephen can only connect to a Zen that was started with its remote-control port open. " +
  "A normal Zen window does not open that port. The 'Zen for Stephen' app opens Zen with it.";

/** Attach-only: Zen runs, but not with remote control (it was opened normally). */
export const ZEN_NOT_CLAUDE_READY_MESSAGE =
  "Zen is open, but it wasn't started with Stephen access, so Stephen can't connect to it. Stephen needs \"Zen for Stephen\". " +
  `${ZEN_WHY_LAUNCHER} ` +
  "Quit Zen (⌘Q) and reopen it with the 'Zen for Stephen' app (or run `stephen zen-launch`). " +
  'Your tabs come back if Zen is set to restore your previous session.';

/** Attach-only: no Zen at all. */
export const ZEN_NOT_RUNNING_MESSAGE =
  "Zen isn't open. Open Zen with the 'Zen for Stephen' app (or run `stephen zen-launch`) so Stephen can use it. " +
  `${ZEN_WHY_LAUNCHER} Stephen never starts Zen itself. ` +
  '(One-time setup if that app is missing: `stephen install-zen-launcher`.)';

const ATTACH_ONLY_MODEL_HINT = ' Tell the user; retrying will not help until they have done this.';

/** `zen.launch` from the config (not part of the frozen ResolvedConfig contract); absent = 'auto' (the original behaviour). */
export function zenLaunchOf(cfg: ResolvedConfig): ZenLaunch {
  const v = (cfg.zen as ResolvedConfig['zen'] & { launch?: unknown }).launch;
  return v === 'never' ? 'never' : 'auto';
}

/** True when Stephen must never start Zen (it only attaches to a Zen opened for Stephen). */
export function isZenAttachOnly(cfg: ResolvedConfig): boolean {
  return zenLaunchOf(cfg) === 'never';
}

/** What a Zen started by launchForClaude() looks like (for `stephen zen-launch`). */
export interface ZenLaunchInfo {
  pid: number;
  wsUrl: string;
  profileDir: string;
  logPath: string;
  /** true = an earlier launch was still starting and we waited for it instead of launching. */
  resumed: boolean;
}

/**
 * Is a Stephen-ready Zen running for `mode`? Read-only (never connects, never edits the state file).
 *  - ready:    state names a live pid in this mode/profile whose ws endpoint answers;
 *  - starting: state names a live pid that was launched and has not reported its endpoint yet;
 *  - none:     no usable state.
 */
export interface ZenReadiness {
  kind: 'ready' | 'starting' | 'none';
  state: ZenState | null;
  /** The profile this mode uses; null if it could not be resolved. */
  profileDir: string | null;
}

export const ZEN_RUNNING_MESSAGE =
  'Quit Zen (⌘Q) and retry — Zen must be relaunched with remote control enabled; Stephen never force-quits it.';

const USER_JS_BEGIN = '// >>> stephen';
const USER_JS_END = '// <<< stephen';
/** Our block in user.js — also the one browser-hub (the pre-rename name) wrote, which is replaced in place. */
const USER_JS_BLOCK_RE = /\/\/ >>> (stephen|browser-hub)\b[^\n]*\n[\s\S]*?\/\/ <<< \1\b[^\n]*(?:\n|$)/;

export type ZenPrefValue = string | number | boolean;
export type ZenPrefs = Readonly<Record<string, ZenPrefValue>>;

/** Pref names Stephen writes: dotted identifiers only (nothing that could break out of user_pref("…")). */
export const ZEN_PREF_NAME_RE = /^[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-[\]]+)*$/;

/**
 * Turns off Firefox's "recommended automation preferences" (RemoteAgent applies them at startup when
 * launched with --remote-debugging-port unless this is false). They disable Safe Browsing, replace the
 * Remote Settings server (security blocklists stop updating), turn off app/extension updates and
 * password saving — wrong for a long-running browser the user signs into and Claude browses
 * (review #2 finding 9). Set in BOTH profiles; it can't be overridden by zen.extraPrefs.
 */
const RECOMMENDED_OFF: [string, ZenPrefValue] = ['remote.prefs.recommended', false];

/**
 * What the agent profile needs that the recommended prefs used to provide: no first-run / welcome
 * pages or default-browser nag (they would steal the first tab). Updates, Safe Browsing and the
 * blocklist stay at Zen's defaults.
 */
export const ZEN_AGENT_PREFS: ReadonlyArray<[string, ZenPrefValue]> = [
  ['browser.startup.homepage_override.mstone', 'ignore'],
  ['startup.homepage_welcome_url', 'about:blank'],
  ['startup.homepage_welcome_url.additional', ''],
  ['browser.aboutwelcome.enabled', false],
  ['trailhead.firstrun.didSeeAboutWelcome', true],
  ['zen.welcome-screen.seen', true],
  ['browser.shell.checkDefaultBrowser', false],
];

function prefLine(name: string, value: ZenPrefValue): string {
  return `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;
}

/** Valid extra prefs only (name pattern, integer numbers, strings without line breaks); the recommended-prefs switch is reserved. */
export function sanitizeExtraPrefs(prefs: ZenPrefs | undefined | null): [string, ZenPrefValue][] {
  const out: [string, ZenPrefValue][] = [];
  for (const [name, value] of Object.entries(prefs ?? {})) {
    if (name === RECOMMENDED_OFF[0] || !ZEN_PREF_NAME_RE.test(name)) continue;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) continue;
    if (typeof value === 'string' && /[\r\n\u2028\u2029]/.test(value)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    out.push([name, value]);
  }
  return out;
}

/**
 * The marked user.js block for a profile.
 *  - real: only `remote.prefs.recommended=false` (never anything else in the user's profile);
 *  - agent: that, the first-run prefs above, then the user's `zen.extraPrefs` (they win over the defaults).
 */
export function buildUserJsBlock(mode: ProfileMode, extraPrefs?: ZenPrefs | null): string {
  const lines: string[] = [];
  if (mode === 'real') {
    lines.push(`${USER_JS_BEGIN} (managed by Stephen; keeps automation prefs out of your real profile)`, prefLine(...RECOMMENDED_OFF));
  } else {
    const prefs = new Map<string, ZenPrefValue>(ZEN_AGENT_PREFS);
    for (const [k, v] of sanitizeExtraPrefs(extraPrefs)) prefs.set(k, v);
    lines.push(
      `${USER_JS_BEGIN} (managed by Stephen; agent profile: Safe Browsing, blocklist and updates stay on)`,
      prefLine(...RECOMMENDED_OFF),
      ...[...prefs].map(([k, v]) => prefLine(k, v)),
    );
  }
  lines.push(USER_JS_END);
  return `${lines.join('\n')}\n`;
}

const REAL_BLOCK = buildUserJsBlock('real');

/** Zen launch arguments (agent and real). */
export function buildZenArgs(profileDir: string, extraArgs: readonly string[]): string[] {
  return ['--profile', profileDir, '--new-instance', '--remote-debugging-port', '0', ...extraArgs];
}

/** `ws://127.0.0.1:N` → `ws://127.0.0.1:N/session` (Gecko's BiDi WebSocket path). */
export function bidiSessionEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/session') ? trimmed : `${trimmed}/session`;
}

/** Pure: return user.js content containing exactly one Stephen block (default: the real-profile one); the rest is preserved. */
export function upsertUserJsBlock(existing: string, block: string = REAL_BLOCK): string {
  if (USER_JS_BLOCK_RE.test(existing)) {
    // The first block (ours or browser-hub's) is replaced in place; any further one is dropped.
    let first = true;
    return existing.replace(new RegExp(USER_JS_BLOCK_RE.source, 'g'), () => {
      const out = first ? block : '';
      first = false;
      return out;
    });
  }
  if (existing.length === 0) return block;
  return `${existing}${existing.endsWith('\n') ? '' : '\n'}${block}`;
}

/** Ensure `<profileDir>/user.js` has the Stephen block. Returns true if the file was changed. */
export async function ensureUserJsBlock(profileDir: string, block: string = REAL_BLOCK): Promise<boolean> {
  const file = join(profileDir, 'user.js');
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const next = upsertUserJsBlock(existing, block);
  if (next === existing) return false;
  await writeFile(file, next, { encoding: 'utf8', mode: 0o600 });
  return true;
}

/** Gecko refuses a second WebDriver session while one is open. */
export function isSessionLimitError(e: unknown): boolean {
  return /maximum number of active sessions|session not created/i.test(errText(e));
}

export const ZEN_OTHER_SESSION_MESSAGE =
  "another Claude Code session is using Zen's automation session right now (Zen allows only one at a time). " +
  'Close that Claude Code session (or finish there), or use Chrome for this task. Do not quit Zen — that would break the other session.';

function otherSessionError(mode: ProfileMode, ownerPid: number, cause: unknown): HubError {
  const which = mode === 'agent' ? "Zen's agent profile" : 'your Zen';
  return new HubError(
    'NEEDS_USER',
    `Can't connect: ${ZEN_OTHER_SESSION_MESSAGE.replace("Zen's automation session", `${which} (Stephen pid ${ownerPid})`)}`,
    { cause },
  );
}

function sessionLimitError(mode: ProfileMode, cause: unknown, attachOnly = false): HubError {
  const which = mode === 'agent' ? 'the Stephen agent Zen window' : 'Zen';
  const then = attachOnly
    ? "then reopen it with the 'Zen for Stephen' app (or `stephen zen-launch`) and retry."
    : 'then retry browser_connect — Stephen will relaunch it.';
  return new HubError(
    'NEEDS_USER',
    `Zen still has a previous automation session open (it allows only one at a time, e.g. after a crash of an earlier Stephen server). ` +
      `Quit ${which} (⌘Q), ${then}`,
    { cause },
  );
}

/** `zen.extraPrefs` from the config (not part of the frozen ResolvedConfig contract yet). */
function extraPrefsOf(cfg: ResolvedConfig): ZenPrefs {
  const v = (cfg.zen as ResolvedConfig['zen'] & { extraPrefs?: unknown }).extraPrefs;
  return v && typeof v === 'object' ? (v as ZenPrefs) : {};
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export class ZenDriver extends DriverBase {
  readonly name = 'zen' as const;
  readonly protocol = 'webDriverBiDi' as const;

  readonly #cfg: ResolvedConfig;
  readonly #deps: ZenDriverDeps;

  constructor(cfg: ResolvedConfig, deps: Partial<ZenDriverDeps> = {}) {
    super();
    this.#cfg = cfg;
    this.#deps = { ...DEFAULT_DEPS, ...deps };
    if (isZenAttachOnly(cfg)) this.detail = `Not connected (${ZEN_ATTACH_ONLY_LABEL}).`;
  }

  get statePath(): string {
    return join(this.#cfg.stateDir, 'zen.json');
  }

  async disconnect(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.mode = null;
    this.version = null;
    if (!b) return;
    await this.#releaseOwnership();
    this.detail = 'Disconnected by Stephen (BiDi session ended, Zen left running).';
    // What puppeteer-core 25.16.0 does over BiDi (lib/puppeteer/bidi/Browser.js):
    //   BidiBrowser.disconnect() → `await this.#browserCore.session.end()` — sends the BiDi
    //   `session.end` command (core/Session.js end()) — then `this.connection.dispose()` closes
    //   the WebSocket. It does NOT send `browser.close`.
    //   BidiBrowser.close() instead runs browserCore.close() + the connector's closeCallback,
    //   which sends `browser.close` and QUITS Zen — so we never call close().
    // So disconnect() already ends the session and frees Gecko's single session slot; we only
    // bound it with a timeout so a hung Zen cannot block shutdown. If session.end itself fails,
    // puppeteer still disposes the socket, and Gecko ends a session whose WebSocket closed.
    try {
      await withTimeout(b.disconnect(), this.#deps.disconnectTimeoutMs, 'Ending the Zen BiDi session');
    } catch {
      // already gone, or timed out (then the socket closes when the process exits)
    }
  }

  protected async doConnect(mode: ProfileMode): Promise<Browser> {
    if (this.browser) await this.disconnect();
    const profileDir = await this.#profileFor(mode);
    const attachOnly = isZenAttachOnly(this.#cfg);

    // 1) Reattach to a Zen from the state file (launched by us, by `zen-launch`, or still starting up), if it is still alive.
    const state = await this.readState();
    if (state && !this.#deps.isPidAlive(state.pid)) {
      await rm(this.statePath, { force: true });
    } else if (state && state.mode === mode && state.profileDir === profileDir) {
      if (state.starting) {
        // It was launched earlier and is slow to start: keep waiting for it, never launch a second one.
        const wsUrl = await this.#waitForListening(state.logPath ?? this.#logPath(mode), state.pid, null, mode, profileDir);
        return this.#connectLaunched(state.pid, wsUrl, mode, profileDir, 'Connected to the Zen that was starting');
      }
      const browser = await this.#reattach(state, mode, profileDir);
      if (browser) return browser;
      // Endpoint gone (pid reused, or Zen restarted without the debug port) → launch below (or, attach-only, explain).
    }

    // 2) Attach-only: never start Zen — tell the user how to open it for Stephen.
    if (attachOnly) throw await this.#notReadyError(mode, state);

    // 3) Launch.
    if (mode === 'real') {
      if (await this.#deps.isProcessRunning('zen')) {
        this.detail = 'Zen is running without remote control; it must be quit first.';
        throw new HubError('NEEDS_USER', `${ZEN_RUNNING_MESSAGE}${this.#agentHint(state)}`);
      }
      await ensureUserJsBlock(profileDir, REAL_BLOCK);
    } else {
      await ensureUserJsBlock(profileDir, buildUserJsBlock('agent', extraPrefsOf(this.#cfg)));
    }
    const { pid, wsUrl } = await this.#launch(profileDir, mode);
    return this.#connectLaunched(pid, wsUrl, mode, profileDir);
  }

  /** Connect to the Zen named by `state`. null = its endpoint is gone; throws on Gecko's one-session limit. */
  async #reattach(state: ZenState, mode: ProfileMode, profileDir: string): Promise<Browser | null> {
    try {
      const browser = await this.#connectBidi(state.wsUrl, this.#deps.reattachTimeoutMs);
      this.#adopt(browser, mode);
      await this.#writeState({ ...state, ownerPid: this.#deps.ownerPid });
      this.detail = `${isZenAttachOnly(this.#cfg) ? 'Attached to your open Zen' : 'Reattached to the running Zen'} (pid ${state.pid}, ${mode} profile ${profileDir}).`;
      return browser;
    } catch (e) {
      if (isSessionLimitError(e)) {
        const owner = state.ownerPid;
        if (owner !== undefined && owner !== this.#deps.ownerPid && this.#deps.isPidAlive(owner)) {
          this.detail = `Zen's automation session is in use by another Stephen server (pid ${owner}).`;
          throw otherSessionError(mode, owner, e);
        }
        this.detail = 'A previous automation session is still open in Zen.';
        throw sessionLimitError(mode, e, isZenAttachOnly(this.#cfg));
      }
      return null;
    }
  }

  #agentHint(state: ZenState | null): string {
    return state && state.mode === 'agent' && this.#deps.isPidAlive(state.pid)
      ? ' (The Stephen agent Zen counts too — quit that window as well.)'
      : '';
  }

  /** Attach-only and nothing to attach to: the NEEDS_USER error for this situation. Never spawns or quits anything. */
  async #notReadyError(mode: ProfileMode, state: ZenState | null): Promise<HubError> {
    if (mode === 'agent') {
      this.detail = 'zen.launch is "never": the agent Zen is not started by Stephen.';
      return new HubError(
        'NEEDS_USER',
        'The Stephen agent Zen is not running, and "zen.launch" is "never", so Stephen will not start it. ' +
          'The user can set "zen": {"mode": "agent", "launch": "auto"} in ~/.stephen/config.json (separate agent window), ' +
          'or remove "mode" to use their own Zen opened with the \'Zen for Stephen\' app.' +
          ATTACH_ONLY_MODEL_HINT,
      );
    }
    if (await this.#deps.isProcessRunning('zen')) {
      this.detail = `Zen is open without Stephen access (${ZEN_ATTACH_ONLY_LABEL}).`;
      return new HubError('NEEDS_USER', `${ZEN_NOT_CLAUDE_READY_MESSAGE}${this.#agentHint(state)}${ATTACH_ONLY_MODEL_HINT}`);
    }
    this.detail = `Zen is not open (${ZEN_ATTACH_ONLY_LABEL}).`;
    return new HubError('NEEDS_USER', `${ZEN_NOT_RUNNING_MESSAGE}${ATTACH_ONLY_MODEL_HINT}`);
  }

  /** Read-only: is a Stephen-ready Zen running for `mode`? See ZenReadiness. */
  async inspect(mode: ProfileMode = 'real'): Promise<ZenReadiness> {
    let profileDir: string | null = null;
    try {
      profileDir = mode === 'agent' ? this.#cfg.zen.agentProfileDir : await this.#deps.resolveRealProfile(this.#cfg);
    } catch {
      profileDir = null;
    }
    const state = await this.readState();
    if (!state || !profileDir || state.mode !== mode || state.profileDir !== profileDir || !this.#deps.isPidAlive(state.pid)) {
      return { kind: 'none', state, profileDir };
    }
    if (state.starting) return { kind: 'starting', state, profileDir };
    return { kind: (await this.#deps.probeEndpoint(state.wsUrl)) ? 'ready' : 'none', state, profileDir };
  }

  /**
   * `stephen zen-launch`: start Zen on the user's REAL profile with remote control on, record it in
   * the state file (no owner — nobody holds a BiDi session) and return. Never opens a BiDi session, so a
   * server can attach later (Gecko allows one at a time). If an earlier launch is still starting, waits
   * for it instead. The caller checks first that no other Zen runs (a second Zen on an in-use profile
   * exits at once; that exit is reported as NEEDS_USER).
   */
  async launchForClaude(): Promise<ZenLaunchInfo> {
    const mode: ProfileMode = 'real';
    const profileDir = await this.#profileFor(mode);
    const state = await this.readState();
    if (state && state.starting && state.mode === mode && state.profileDir === profileDir && this.#deps.isPidAlive(state.pid)) {
      const logPath = state.logPath ?? this.#logPath(mode);
      const wsUrl = await this.#waitForListening(logPath, state.pid, null, mode, profileDir);
      await this.#writeState({ pid: state.pid, wsUrl, profileDir, mode });
      this.detail = `Zen (pid ${state.pid}) finished starting with remote control on.`;
      return { pid: state.pid, wsUrl, profileDir, logPath, resumed: true };
    }
    await ensureUserJsBlock(profileDir, REAL_BLOCK);
    const { pid, wsUrl } = await this.#launch(profileDir, mode);
    await this.#writeState({ pid, wsUrl, profileDir, mode });
    this.detail = `Started Zen (pid ${pid}, real profile ${profileDir}) with remote control on.`;
    return { pid, wsUrl, profileDir, logPath: this.#logPath(mode), resumed: false };
  }

  async #connectLaunched(pid: number, wsUrl: string, mode: ProfileMode, profileDir: string, verb = 'Launched Zen'): Promise<Browser> {
    let browser: Browser;
    try {
      browser = await this.#connectBidi(wsUrl, this.#deps.connectTimeoutMs);
    } catch (e) {
      await this.#writeState({ pid, wsUrl, profileDir, mode }); // reattachable later
      if (isSessionLimitError(e)) {
        this.detail = 'A previous automation session is still open in Zen.';
        throw sessionLimitError(mode, e, isZenAttachOnly(this.#cfg));
      }
      this.detail = `Launched Zen but could not connect: ${errText(e)}`;
      throw new HubError(
        'NOT_CONNECTED',
        `Launched Zen (pid ${pid}) but could not open a WebDriver BiDi session at ${wsUrl} (${errText(e).split('\n')[0]}). Retry browser_connect.`,
        { cause: e },
      );
    }
    this.#adopt(browser, mode);
    await this.#writeState({ pid, wsUrl, profileDir, mode, ownerPid: this.#deps.ownerPid });
    this.detail = `${verb} (pid ${pid}, ${mode} profile ${profileDir}) and connected over WebDriver BiDi.`;
    return browser;
  }

  /** On disconnect: drop our ownership mark so another session is not told we still use Zen. */
  async #releaseOwnership(): Promise<void> {
    try {
      const st = await this.readState();
      if (st && st.ownerPid === this.#deps.ownerPid) {
        const { ownerPid: _drop, ...rest } = st;
        await this.#writeState(rest);
      }
    } catch {
      // best effort
    }
  }

  async #profileFor(mode: ProfileMode): Promise<string> {
    if (mode === 'agent') {
      const dir = this.#cfg.zen.agentProfileDir;
      await ensurePrivateDir(dir, this.#cfg.home);
      return dir;
    }
    const dir = await this.#deps.resolveRealProfile(this.#cfg);
    if (!dir) {
      this.detail = 'Could not find the real Zen profile.';
      throw new HubError(
        'NEEDS_USER',
        `Could not find your Zen profile (no usable profiles.ini in ${this.#cfg.zen.zenAppSupportDir}). ` +
          `In Zen open about:profiles, copy the "Root Directory" of the profile marked "in use", and set "zen.profilePath" to it in ~/.stephen/config.json — or use mode "agent".`,
      );
    }
    if (!(await isDir(dir))) {
      this.detail = `Zen profile ${dir} does not exist.`;
      throw new HubError(
        'NEEDS_USER',
        `The Zen profile ${dir} does not exist. Check "zen.profilePath" in ~/.stephen/config.json against the "Root Directory" shown in Zen's about:profiles.`,
      );
    }
    return dir;
  }

  #adopt(browser: Browser, mode: ProfileMode): void {
    super.adopt(browser, mode, () =>
      isZenAttachOnly(this.#cfg)
        ? "Zen connection lost (Zen was closed or the connection dropped). Reopen Zen with the 'Zen for Stephen' app."
        : 'Zen connection lost (Zen was closed or the connection dropped). It relaunches on next use.',
    );
  }

  #connectBidi(wsUrl: string, timeoutMs: number): Promise<Browser> {
    return connectWithTimeout(
      this.#deps.connect,
      { browserWSEndpoint: wsUrl, protocol: 'webDriverBiDi', defaultViewport: null },
      timeoutMs,
      'Connecting to Zen',
    );
  }

  #logPath(mode: ProfileMode): string {
    return join(this.#cfg.stateDir, `zen-${mode}.log`);
  }

  /**
   * Spawn Zen detached and wait for its BiDi listening line.
   *
   * Zen's stdout+stderr go to `<stateDir>/zen-<mode>.log` rather than a pipe: a pipe would make
   * Zen's later log writes block once nobody drains it, or fail with EPIPE after the server exits,
   * and Zen must outlive the server. We poll that file for the line; the server keeps no handle on
   * Zen afterwards (child.unref()), so it can exit freely.
   */
  async #launch(profileDir: string, mode: ProfileMode): Promise<{ pid: number; wsUrl: string }> {
    const exe = this.#cfg.zen.executablePath;
    if (!(await this.#deps.isExecutable(exe))) {
      this.detail = `Zen binary not found at ${exe}.`;
      throw new HubError(
        'NOT_CONNECTED',
        `Zen was not found at ${exe}. Install Zen (zen-browser.app), or set "zen.executablePath" in ~/.stephen/config.json to the binary inside Zen.app/Contents/MacOS/.`,
      );
    }
    await ensurePrivateDir(this.#cfg.stateDir, this.#cfg.home);
    const logPath = this.#logPath(mode);
    const log = await open(logPath, 'w', 0o600);
    let child: SpawnedProcess;
    try {
      child = this.#deps.spawn(exe, buildZenArgs(profileDir, this.#cfg.zen.extraArgs), {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
    } finally {
      await log.close();
    }
    const { launch, stop } = watchLaunch(child);
    child.unref();
    try {
      if (child.pid === undefined) {
        // Spawn failed outright (the 'error' event follows); give it a moment to report why.
        await this.#deps.clock.sleep(this.#deps.pollIntervalMs);
        throw new HubError('NOT_CONNECTED', `Could not start Zen (${launch.exited ?? 'no process id'}). Check zen.executablePath.`);
      }
      const wsUrl = await this.#waitForListening(logPath, child.pid, launch, mode, profileDir);
      return { pid: child.pid, wsUrl };
    } finally {
      stop();
    }
  }

  /**
   * Poll Zen's log for "WebDriver BiDi listening". `launch` tracks exit of a child we spawned in this
   * process (null when resuming a launch from an earlier attempt — then the pid is polled instead).
   * On timeout Zen is LEFT RUNNING (never killed: it may be the user's real profile, or just slow)
   * and the state file marks it as starting, so the next connect resumes waiting for it.
   */
  async #waitForListening(
    logPath: string,
    pid: number,
    launch: { exited: string | null } | null,
    mode: ProfileMode,
    profileDir: string,
  ): Promise<string> {
    const deadline = this.#deps.clock.now() + this.#deps.listenTimeoutMs;
    for (;;) {
      const text = await readFile(logPath, 'utf8').catch(() => '');
      for (const line of text.split(/\r?\n/)) {
        const url = parseBidiListening(line);
        if (url) return bidiSessionEndpoint(url);
      }
      const exited = launch ? launch.exited : this.#deps.isPidAlive(pid) ? null : 'process exited';
      if (exited) {
        await rm(this.statePath, { force: true }).catch(() => undefined);
        const tail = lastLines(text, 5);
        this.detail = `Zen exited before enabling remote control (${exited}).`;
        if (mode === 'real' || /already running|is already open|profile.*(locked|in use)/i.test(text)) {
          throw new HubError(
            'NEEDS_USER',
            `Zen exited without enabling remote control (${exited}) — another Zen is probably using profile ${profileDir}. ${ZEN_RUNNING_MESSAGE}${tail ? ` Zen said: ${tail}` : ''}`,
          );
        }
        throw new HubError(
          'NOT_CONNECTED',
          `Zen exited right after launch (${exited}) without enabling remote control.${tail ? ` Zen said: ${tail}` : ''} Log: ${logPath}`,
        );
      }
      if (this.#deps.clock.now() >= deadline) {
        await this.#writeState({ pid, wsUrl: '', profileDir, mode, starting: true, logPath });
        this.detail = `Zen (pid ${pid}) is still starting; it has not enabled remote control yet.`;
        throw new HubError(
          'NOT_CONNECTED',
          `Zen (pid ${pid}) was started but has not enabled remote control within ${Math.round(this.#deps.listenTimeoutMs / 1000)} s — ` +
            `the first launch after a Zen update can take longer. Stephen left it running (it never quits Zen). ` +
            `Ask the user to wait until that Zen window has finished opening, then retry browser_connect (it will pick up the same Zen). ` +
            `If it seems stuck, the user can quit that Zen window (⌘Q) and retry. Log: ${logPath}`,
        );
      }
      await this.#deps.clock.sleep(this.#deps.pollIntervalMs);
    }
  }

  async readState(): Promise<ZenState | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      const s = raw as Record<string, unknown>;
      if (
        typeof s.pid !== 'number' ||
        typeof s.wsUrl !== 'string' ||
        typeof s.profileDir !== 'string' ||
        (s.mode !== 'agent' && s.mode !== 'real')
      ) {
        return null;
      }
      const starting = s.starting === true;
      if (!starting && !s.wsUrl) return null;
      return {
        pid: s.pid,
        wsUrl: s.wsUrl,
        profileDir: s.profileDir,
        mode: s.mode,
        ...(typeof s.ownerPid === 'number' ? { ownerPid: s.ownerPid } : {}),
        ...(starting ? { starting: true } : {}),
        ...(typeof s.logPath === 'string' ? { logPath: s.logPath } : {}),
      };
    } catch {
      return null;
    }
  }

  async #writeState(state: ZenState): Promise<void> {
    await ensurePrivateDir(this.#cfg.stateDir, this.#cfg.home);
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ')
    .slice(0, 400);
}

