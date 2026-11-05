/**
 * What the Chrome and Zen drivers share: the connection state with its single-flight connect(), status(), adopting a
 * new Browser, and watching a spawned browser process for an early exit.
 */
import type { Browser } from 'puppeteer-core';
import type { BrowserDriver, BrowserName, BrowserStatus, ProfileMode, Protocol } from '../types.js';
import type { SpawnedProcess } from './util.js';

export abstract class DriverBase implements BrowserDriver {
  abstract readonly name: BrowserName;
  abstract readonly protocol: Protocol;

  protected browser: Browser | null = null;
  protected mode: ProfileMode | null = null;
  protected version: string | null = null;
  protected detail = 'Not connected.';
  #pending: { mode: ProfileMode; promise: Promise<Browser> } | null = null;
  #lostDetail: () => string = () => 'Not connected.';

  /** Attach or launch for `mode` (no other connect runs at the same time). */
  protected abstract doConnect(mode: ProfileMode): Promise<Browser>;
  abstract disconnect(): Promise<void>;

  current(): Browser | null {
    const b = this.browser;
    if (b && !isLive(b)) this.#forget(b);
    return this.browser;
  }

  status(): BrowserStatus {
    const connected = this.current() !== null;
    return {
      name: this.name,
      connected,
      mode: connected ? this.mode : null,
      protocol: this.protocol,
      version: connected ? this.version : null,
      detail: this.detail,
    };
  }

  async connect(mode: ProfileMode): Promise<Browser> {
    const live = this.current();
    if (live && this.mode === mode) return live;
    if (this.#pending) {
      if (this.#pending.mode === mode) return this.#pending.promise;
      await this.#pending.promise.catch(() => undefined);
      return this.connect(mode);
    }
    const promise = this.doConnect(mode);
    this.#pending = { mode, promise };
    try {
      return await promise;
    } finally {
      if (this.#pending?.promise === promise) this.#pending = null;
    }
  }

  /** Make `browser` the current one; when it disconnects by itself the state is cleared and `lostDetail()` shown. */
  protected adopt(browser: Browser, mode: ProfileMode, lostDetail: () => string): void {
    this.browser = browser;
    this.mode = mode;
    this.#lostDetail = lostDetail;
    browser.once('disconnected', () => this.#forget(browser));
    void browser
      .version()
      .then((v) => {
        if (this.browser === browser) this.version = v;
      })
      .catch(() => undefined);
  }

  /** The adopted browser is gone: clear the state so the next connect() attaches again. */
  #forget(browser: Browser): void {
    if (this.browser !== browser) return;
    this.browser = null;
    this.mode = null;
    this.version = null;
    this.detail = this.#lostDetail();
  }
}

/**
 * puppeteer 25 over WebDriver BiDi (Zen): when the socket drops (Zen quit or crashed), the connection marks itself
 * closed but `connected` stays true and 'disconnected' never fires, so every call fails with "Connection closed."
 * until the server restarts. `connection.closed` is the only signal; CDP browsers have no such getter.
 */
export function isLive(browser: Browser): boolean {
  if (!browser.connected) return false;
  try {
    return (browser as unknown as { connection?: { closed?: boolean } }).connection?.closed !== true;
  } catch {
    return true;
  }
}

/**
 * Track how a spawned browser process ends: `launch.exited` becomes "exit code N", "signal X" or "spawn error: …".
 * Call `stop()` when done waiting (removes the listeners).
 */
export function watchLaunch(child: SpawnedProcess): { launch: { exited: string | null }; stop: () => void } {
  const launch: { exited: string | null } = { exited: null };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    launch.exited = signal ? `signal ${signal}` : `exit code ${code}`;
  };
  const onError = (err: Error): void => {
    launch.exited = `spawn error: ${err.message}`;
  };
  child.on('exit', onExit);
  child.on('error', onError);
  return {
    launch,
    stop: () => {
      child.off('exit', onExit);
      child.off('error', onError);
    },
  };
}
