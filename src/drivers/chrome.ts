/**
 * ChromeDriver — Google Chrome over CDP.
 *
 * 'real'  attaches to the user's everyday Chrome through the Chrome 144+ consent flow
 *         (chrome://inspect/#remote-debugging → DevToolsActivePort → per-connection Allow dialog).
 *         We keep ONE long-lived connection because each new one re-prompts the user.
 * 'agent' uses a dedicated profile owned by Stephen; launched detached so it outlives the
 *         server, and reattached on restart through its DevToolsActivePort.
 *
 * disconnect() only ever calls browser.disconnect() — the user's Chrome is never closed.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { HubError } from '../errors.js';
import type { ProfileMode, ResolvedConfig } from '../types.js';
import { readDevToolsActivePort } from './macos.js';
import {
  type Clock,
  type ConnectFn,
  type SpawnFn,
  TimeoutError,
  connectWithTimeout,
  defaultConnect,
  defaultSpawn,
  errText,
  killProcessGroup,
  realClock,
  withTimeout,
} from './util.js';
import { DriverBase, watchLaunch } from './common.js';
import { ensurePrivateDir, isExecutable } from '../lib/fs.js';

export interface ChromeDriverDeps {
  connect: ConnectFn;
  spawn: SpawnFn;
  clock: Clock;
  isExecutable: (file: string) => Promise<boolean>;
  /** Kill a process we spawned whose launch failed. */
  kill: (pid: number) => void;
  /** Real mode: how long to wait for the user to click Allow. */
  realConnectTimeoutMs: number;
  /** Agent mode: how long to wait for DevToolsActivePort after spawning. */
  launchTimeoutMs: number;
  /** Agent mode: connect timeout (reattach and after launch). */
  agentConnectTimeoutMs: number;
  pollIntervalMs: number;
}

const DEFAULT_DEPS: ChromeDriverDeps = {
  connect: defaultConnect,
  spawn: defaultSpawn,
  clock: realClock,
  isExecutable,
  kill: killProcessGroup,
  // The user has to notice Chrome's "Allow remote debugging?" dialog and click Allow.
  realConnectTimeoutMs: 60_000,
  launchTimeoutMs: 15_000,
  agentConnectTimeoutMs: 10_000,
  pollIntervalMs: 100,
};

export const CHROME_ENABLE_STEPS =
  'In your everyday Chrome (version 144 or newer): 1) open chrome://inspect/#remote-debugging, ' +
  '2) turn on "Allow remote debugging for this browser instance", ' +
  '3) retry, then click "Allow" when Chrome asks whether to allow remote debugging.';

/** Build the agent-mode launch arguments. Args from config are passed verbatim, except --remote-allow-origins. */
export function buildChromeAgentArgs(profileDir: string, extraArgs: readonly string[]): string[] {
  const extras = extraArgs.filter((a) => !/^--remote-allow-origins(=|$)/.test(a));
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    ...extras,
    'about:blank',
  ];
}

function looksRefused(e: unknown): boolean {
  return /ECONNREFUSED|ECONNRESET|socket hang up|connect E|ENOTFOUND|EHOSTUNREACH/i.test(errText(e));
}

export class ChromeDriver extends DriverBase {
  readonly name = 'chrome' as const;
  readonly protocol = 'cdp' as const;

  readonly #cfg: ResolvedConfig;
  readonly #deps: ChromeDriverDeps;

  constructor(cfg: ResolvedConfig, deps: Partial<ChromeDriverDeps> = {}) {
    super();
    this.#cfg = cfg;
    this.#deps = { ...DEFAULT_DEPS, ...deps };
  }

  async disconnect(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.mode = null;
    this.version = null;
    if (!b) return;
    this.detail = 'Disconnected by Stephen (Chrome left running).';
    try {
      // NEVER browser.close(): that would quit the user's Chrome.
      await withTimeout(b.disconnect(), 5000, 'Disconnecting from Chrome');
    } catch {
      // already gone
    }
  }

  protected async doConnect(mode: ProfileMode): Promise<Browser> {
    if (this.browser) await this.disconnect();
    const browser = mode === 'real' ? await this.#connectReal() : await this.#connectAgent();
    this.adopt(browser, mode, () => 'Chrome connection lost (Chrome was closed or the debugging connection dropped). It reconnects on next use.');
    return browser;
  }

  async #connectReal(): Promise<Browser> {
    const dir = this.#cfg.chrome.userDataDir;
    const port = await readDevToolsActivePort(dir);
    if (!port) {
      this.detail = `No DevToolsActivePort in ${dir}: remote debugging is not enabled in Chrome.`;
      throw new HubError(
        'NEEDS_USER',
        `Chrome is not accepting remote control yet (no DevToolsActivePort in ${dir}). ${CHROME_ENABLE_STEPS} ` +
          `Alternatively use mode "agent" for a separate Stephen Chrome profile.`,
      );
    }
    const timeout = this.#deps.realConnectTimeoutMs;
    this.detail = `Waiting (up to ${Math.round(timeout / 1000)} s) for you to click "Allow" in Chrome's "Allow remote debugging?" dialog.`;
    try {
      const browser = await connectWithTimeout(
        this.#deps.connect,
        { browserWSEndpoint: port.wsEndpoint, defaultViewport: null },
        timeout,
        'Connecting to Chrome',
      );
      this.detail = `Connected to your real Chrome profile via DevToolsActivePort (port ${port.port}).`;
      return browser;
    } catch (e) {
      if (e instanceof TimeoutError) {
        this.detail = `Timed out after ${Math.round(timeout / 1000)} s waiting for "Allow" in Chrome (remote debugging is on, port ${port.port}).`;
        throw new HubError(
          'NEEDS_USER',
          `Chrome did not allow the connection within ${Math.round(timeout / 1000)} s (status: remote debugging is enabled on port ${port.port}, ` +
            `but nobody clicked "Allow"). Ask the user to look for Chrome's "Allow remote debugging?" dialog — it can be hidden behind other ` +
            `windows, on another desktop/Space, or in another Chrome window — click "Allow", then retry browser_connect. ` +
            `If no dialog appears, check chrome://inspect/#remote-debugging still shows remote debugging as allowed.`,
          { cause: e },
        );
      }
      if (looksRefused(e)) {
        this.detail = `DevToolsActivePort in ${dir} is stale (port ${port.port} refused).`;
        throw new HubError(
          'NEEDS_USER',
          `Chrome is not running or remote debugging was turned off (port ${port.port} refused the connection). ` +
            `Start Chrome, then: ${CHROME_ENABLE_STEPS}`,
          { cause: e },
        );
      }
      this.detail = `Chrome rejected the connection: ${errText(e)}`;
      throw new HubError(
        'NEEDS_USER',
        `Chrome rejected the debugging connection (${errText(e).split('\n')[0]}). If you clicked "Deny", retry and click "Allow". ` +
          `If no dialog appeared: ${CHROME_ENABLE_STEPS}`,
        { cause: e },
      );
    }
  }

  async #connectAgent(): Promise<Browser> {
    const { agentProfileDir: dir, executablePath, extraArgs } = this.#cfg.chrome;
    await ensurePrivateDir(dir, this.#cfg.home);
    const portFile = join(dir, 'DevToolsActivePort');

    // 1) Reattach to an agent Chrome that is still running (e.g. after a server restart).
    const existing = await readDevToolsActivePort(dir);
    if (existing) {
      try {
        const browser = await connectWithTimeout(
          this.#deps.connect,
          { browserWSEndpoint: existing.wsEndpoint, defaultViewport: null },
          this.#deps.agentConnectTimeoutMs,
          'Reattaching to agent Chrome',
        );
        this.detail = `Reattached to the running Stephen Chrome (profile ${dir}).`;
        return browser;
      } catch {
        // Stale file from a crashed/quit agent Chrome — fall through and relaunch.
      }
    }

    // 2) Launch a fresh agent Chrome.
    await rm(portFile, { force: true });
    if (!(await this.#deps.isExecutable(executablePath))) {
      this.detail = `Chrome binary not found at ${executablePath}.`;
      throw new HubError(
        'NOT_CONNECTED',
        `Google Chrome was not found at ${executablePath}. Install Chrome, or set "chrome.executablePath" in ~/.stephen/config.json to your Chrome binary.`,
      );
    }
    const args = buildChromeAgentArgs(dir, extraArgs);
    const child = this.#deps.spawn(executablePath, args, { detached: true, stdio: 'ignore' });
    const { launch, stop } = watchLaunch(child);
    child.unref();

    try {
      const deadline = this.#deps.clock.now() + this.#deps.launchTimeoutMs;
      let port = await readDevToolsActivePort(dir);
      while (!port) {
        const exited = launch.exited;
        if (exited) {
          this.detail = `Agent Chrome exited before enabling remote debugging (${exited}).`;
          throw new HubError(
            'NOT_CONNECTED',
            `The Stephen Chrome exited right after launch (${exited}). If another Chrome window is already using the profile ${dir}, quit it and retry.`,
          );
        }
        if (this.#deps.clock.now() >= deadline) {
          if (child.pid !== undefined) this.#deps.kill(child.pid);
          this.detail = 'Agent Chrome did not start remote debugging in time.';
          throw new HubError(
            'NOT_CONNECTED',
            `Launched Chrome (${executablePath}) but it did not open its debugging port within ${Math.round(this.#deps.launchTimeoutMs / 1000)} s. Retry; if it keeps failing check chrome.executablePath and chrome.extraArgs in the config.`,
          );
        }
        await this.#deps.clock.sleep(this.#deps.pollIntervalMs);
        port = await readDevToolsActivePort(dir);
      }
      try {
        const browser = await connectWithTimeout(
          this.#deps.connect,
          { browserWSEndpoint: port.wsEndpoint, defaultViewport: null },
          this.#deps.agentConnectTimeoutMs,
          'Connecting to agent Chrome',
        );
        this.detail = `Launched and connected to the Stephen Chrome (profile ${dir}).`;
        return browser;
      } catch (e) {
        this.detail = `Could not connect to the launched agent Chrome: ${errText(e)}`;
        throw new HubError('NOT_CONNECTED', `Launched Chrome but could not connect to it (${errText(e).split('\n')[0]}). Retry browser_connect.`, {
          cause: e,
        });
      }
    } finally {
      stop();
    }
  }
}

