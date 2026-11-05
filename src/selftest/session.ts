/**
 * The real selftest session: the actual MCP server (buildServer — every tool handler, the page
 * engine, the safety gate and the real ChromeDriver/ZenDriver) wired to an in-process MCP client
 * over an in-memory transport. Nothing is launched until the checks call browser_connect, and the
 * browser is launched by the drivers' own code paths (binary check, args, DevToolsActivePort /
 * "WebDriver BiDi listening on" parsing, connect).
 *
 * The drivers' spawn is wrapped only to RECORD the processes they start: those — and nothing
 * else — may be closed or signalled at the end.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import puppeteer, { type Browser } from 'puppeteer-core';
import { ChromeDriver, ZenDriver, createBrowserManager } from '../drivers/index.js';
import { readDevToolsActivePort } from '../drivers/macos.js';
import { defaultSpawn, withTimeout, type SpawnFn } from '../drivers/util.js';
import { isPidAlive } from '../lib/process.js';
import { isSessionLimitError } from '../drivers/zen.js';
import { errorMessage } from '../errors.js';
import { pageEngine } from '../page/index.js';
import { createSafety } from '../safety/index.js';
import { buildServer, packageVersion } from '../server/index.js';
import type { BrowserName, ResolvedConfig } from '../types.js';
import type { ToolCaller, ToolResult } from './checks.js';

export interface SelftestSession {
  call: ToolCaller;
  /** Browser product/version as reported over the protocol (null if not connected). */
  version(): Promise<string | null>;
  /** Pids of the processes this session started (the only ones it may ever signal). */
  spawnedPids(): number[];
  /** Tail of the browser's launch log, for failure hints (Zen); null if none. */
  diagnostics(): Promise<string | null>;
  /** Close the MCP client + server and disconnect the hub from the browser (as `serve` does on exit). */
  disconnect(): Promise<void>;
  /** After disconnect: the hub holds no connection, and (BiDi) no session is left open. Returns a detail line; throws on failure. */
  verifyDisconnected(): Promise<string>;
  /** Close the browser this session started and wait for it to exit. Returns a detail line; throws if it could not be stopped. */
  closeBrowser(): Promise<string>;
  /** --keep-open: let go of everything without closing the browser. Returns a detail line. */
  release(): Promise<string>;
}

/** Pids started by any live selftest session (for SIGINT cleanup). */
export const liveSpawnedPids = new Set<number>();

interface Child {
  pid: number;
  exited: boolean;
  exit: Promise<void>;
}

const CALL_TIMEOUT_MS = 60_000;
/** Zen may need up to 60 s to print its BiDi line, then up to 20 s to accept the session. */
const CONNECT_CALL_TIMEOUT_MS = 100_000;
const PROBE_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 10_000;
const TERM_WAIT_MS = 5_000;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // the drivers spawn detached: pid is its own process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

function waitFor(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    t.unref?.();
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ')
    .slice(0, 600);
}

export interface SessionOptions {
  /** Zen: how long to wait for "WebDriver BiDi listening on" (default: the driver's 60 s). Tests shorten it. */
  zenListenTimeoutMs?: number;
}

export async function openSelftestSession(cfg: ResolvedConfig, browser: BrowserName, opts: SessionOptions = {}): Promise<SelftestSession> {
  const children = new Map<number, Child>();
  const spawn: SpawnFn = (command, args, options) => {
    const child = defaultSpawn(command, args, options);
    const pid = child.pid;
    if (pid !== undefined) {
      const rec: Child = { pid, exited: false, exit: Promise.resolve() };
      rec.exit = new Promise<void>((resolve) => {
        child.on('exit', () => {
          rec.exited = true;
          liveSpawnedPids.delete(pid);
          resolve();
        });
        child.on('error', () => {
          rec.exited = true;
          liveSpawnedPids.delete(pid);
          resolve();
        });
      });
      children.set(pid, rec);
      liveSpawnedPids.add(pid);
    }
    return child;
  };

  const chrome = new ChromeDriver(cfg, { spawn });
  const zen = new ZenDriver(cfg, { spawn, ...(opts.zenListenTimeoutMs !== undefined ? { listenTimeoutMs: opts.zenListenTimeoutMs } : {}) });
  const driver = browser === 'chrome' ? chrome : zen;
  const manager = createBrowserManager(cfg, { chrome, zen });
  const mcp = buildServer({ cfg, manager, engine: pageEngine, safetyFactory: createSafety });
  // No elicitation capability: with confirm "deny" nothing can ever ask a human.
  const client = new Client({ name: 'stephen-selftest', version: packageVersion() }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);

  let hubBrowser: Browser | null = null;
  let probe: Browser | null = null;
  let disconnected = false;

  const call: ToolCaller = async (name, args) => {
    const ms = name === 'browser_connect' ? CONNECT_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
    const r = (await withTimeout(client.callTool({ name, arguments: args }, undefined, { timeout: ms }), ms + 1000, `${name}`)) as ToolResult;
    hubBrowser = driver.current() ?? hubBrowser;
    return r;
  };

  const liveChildren = () => [...children.values()].filter((c) => !c.exited);

  return {
    call,

    async version() {
      const b = driver.current();
      if (!b) return null;
      try {
        return await withTimeout(b.version(), 5000, 'browser version');
      } catch {
        return null;
      }
    },

    spawnedPids: () => [...children.keys()],

    async diagnostics() {
      if (browser !== 'zen') return null;
      try {
        const tail = lastLines(await readFile(join(cfg.stateDir, 'zen-agent.log'), 'utf8'), 8);
        return tail || null;
      } catch {
        return null;
      }
    },

    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      hubBrowser = driver.current() ?? hubBrowser;
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      // What `serve` does on exit: never quits the browser, ends Zen's BiDi session.
      await withTimeout(manager.shutdown(), 15_000, 'disconnecting the browser');
    },

    async verifyDisconnected() {
      if (driver.current()) throw new Error('the hub still reports a live browser connection after disconnect');
      if (hubBrowser?.connected) throw new Error("the hub's browser connection is still open after disconnect");
      if (!children.size) return 'no browser was started';
      if (!liveChildren().length) throw new Error('the browser exited during disconnect (it must be left running)');

      if (browser === 'zen') {
        const state = await zen.readState();
        if (!state?.wsUrl) return 'no BiDi endpoint recorded (Zen never finished starting)';
        if (state.ownerPid !== undefined) throw new Error(`the Zen state file still names pid ${state.ownerPid} as the session owner`);
        // Gecko allows ONE BiDi session: opening a new one proves the hub's session was ended.
        try {
          probe = await withTimeout(
            puppeteer.connect({ browserWSEndpoint: state.wsUrl, protocol: 'webDriverBiDi', defaultViewport: null }),
            PROBE_TIMEOUT_MS,
            'opening a new BiDi session',
          );
        } catch (e) {
          if (isSessionLimitError(e)) throw new Error('a BiDi session is still open after disconnect (Zen refused a new one)');
          throw new Error(`could not open a new BiDi session after disconnect: ${errorMessage(e)}`);
        }
        return 'BiDi session ended (a new one could be opened)';
      }

      const port = await readDevToolsActivePort(cfg.chrome.agentProfileDir);
      if (!port) throw new Error('the agent Chrome no longer advertises its DevTools port');
      try {
        probe = await withTimeout(
          puppeteer.connect({ browserWSEndpoint: port.wsEndpoint, defaultViewport: null }),
          PROBE_TIMEOUT_MS,
          'reconnecting to the agent Chrome',
        );
      } catch (e) {
        throw new Error(`could not reconnect to the agent Chrome after disconnect: ${errorMessage(e)}`);
      }
      return 'hub connection closed, browser left running';
    },

    async closeBrowser() {
      const started = [...children.keys()];
      if (!started.length) {
        await probe?.disconnect().catch(() => undefined);
        return 'no browser to close';
      }
      // 1) Ask the browser to quit (CDP Browser.close / BiDi browser.close), on a connection of our own.
      let pending = liveChildren();
      if (probe?.connected) {
        await withTimeout(probe.close(), CLOSE_WAIT_MS, 'closing the browser').catch(() => undefined);
        await Promise.all(pending.map((c) => waitFor(c.exit, CLOSE_WAIT_MS)));
      }
      probe = null;
      // 2) Still running: signal the process groups WE started (never anything else).
      let how = 'quit on request';
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        pending = liveChildren();
        if (!pending.length) break;
        how = signal === 'SIGTERM' ? 'stopped with SIGTERM' : 'stopped with SIGKILL';
        for (const c of pending) if (isPidAlive(c.pid)) signalGroup(c.pid, signal);
        await Promise.all(pending.map((c) => waitFor(c.exit, TERM_WAIT_MS)));
      }
      pending = liveChildren();
      if (pending.length) throw new Error(`could not stop the browser it started (pid ${pending.map((c) => c.pid).join(', ')})`);
      return `browser ${how} (pid ${started.join(', ')} exited)`;
    },

    async release() {
      if (probe?.connected) await withTimeout(probe.disconnect(), PROBE_TIMEOUT_MS, 'detaching').catch(() => undefined);
      probe = null;
      for (const pid of children.keys()) liveSpawnedPids.delete(pid);
      const live = liveChildren().map((c) => c.pid);
      return live.length ? `left running (pid ${live.join(', ')})` : 'browser not running';
    },
  };
}
