/**
 * BrowserManager — owns the two drivers and the tab registry.
 *
 * Tab ids are short and browser-prefixed (c1, c2… / z1, z2…), assigned once per Page and never
 * reused within a process. The registry is refreshed from browser.pages() so tabs the user opened
 * get ids too, and entries are purged when pages close or the browser disconnects.
 */
import type { Browser, Page, Target } from 'puppeteer-core';
import { HubError } from '../errors.js';
import { browserOfTab, makeTabId } from '../refs.js';
import type { BrowserDriver, BrowserName, BrowserStatus, IBrowserManager, ProfileMode, ResolvedConfig, TabId, TabInfo } from '../types.js';
import { TimeoutError, withTimeout } from './util.js';

const BROWSERS: readonly BrowserName[] = ['chrome', 'zen'];
const TITLE_TIMEOUT_MS = 1500;
/** browser.pages() attaches to every tab; with 100+ tabs (many discarded) this can take a while. */
const PAGES_TIMEOUT_MS = 30_000;
/** Read at most this many tab titles at once (each is a round-trip into the page). */
const TITLE_CONCURRENCY = 16;
/** closeTab waits this long for the tab to go away (a "leave page?" dialog keeps it open). */
const CLOSE_WAIT_MS = 5_000;

export interface BrowserManagerOptions {
  pagesTimeoutMs?: number;
  closeWaitMs?: number;
}
/** Tabs that are browser/extension UI rather than web pages the user is working in. */
const NON_USER_PAGE_RE = /^(devtools|chrome-extension|moz-extension|chrome-untrusted):/i;

interface TabRegistry {
  /** Last number handed out; ids are never reused within a process. */
  seq: number;
  byId: Map<TabId, Page>;
  byPage: Map<Page, TabId>;
  current: TabId | null;
  /** Tabs Stephen opened itself (openTab). Every other tab is the user's (review #2 finding 11). */
  opened: Set<TabId>;
  /** The Browser instance the registered pages belong to. */
  browser: Browser | null;
  unhook: (() => void) | null;
}

export class BrowserManager implements IBrowserManager {
  readonly #cfg: ResolvedConfig;
  readonly #drivers: Record<BrowserName, BrowserDriver>;
  readonly #tabs: Record<BrowserName, TabRegistry>;
  readonly #inflight = new Map<BrowserName, { mode: ProfileMode; promise: Promise<Browser> }>();
  readonly #pagesTimeoutMs: number;
  readonly #closeWaitMs: number;

  constructor(cfg: ResolvedConfig, drivers: Record<BrowserName, BrowserDriver>, opts: BrowserManagerOptions = {}) {
    this.#cfg = cfg;
    this.#drivers = drivers;
    this.#pagesTimeoutMs = opts.pagesTimeoutMs ?? PAGES_TIMEOUT_MS;
    this.#closeWaitMs = opts.closeWaitMs ?? CLOSE_WAIT_MS;
    const empty = (): TabRegistry => ({
      seq: 0,
      byId: new Map(),
      byPage: new Map(),
      current: null,
      opened: new Set(),
      browser: null,
      unhook: null,
    });
    this.#tabs = { chrome: empty(), zen: empty() };
  }

  driver(name: BrowserName): BrowserDriver {
    return this.#drivers[name];
  }

  async connect(name: BrowserName, mode?: ProfileMode): Promise<Browser> {
    const m = mode ?? this.#cfg[name].mode;
    const inflight = this.#inflight.get(name);
    if (inflight) {
      if (inflight.mode === m) return inflight.promise;
      await inflight.promise.catch(() => undefined);
      return this.connect(name, m);
    }
    const promise = this.#drivers[name].connect(m).then((browser) => {
      this.#hook(name, browser);
      return browser;
    });
    this.#inflight.set(name, { mode: m, promise });
    try {
      return await promise;
    } finally {
      if (this.#inflight.get(name)?.promise === promise) this.#inflight.delete(name);
    }
  }

  status(): BrowserStatus[] {
    return BROWSERS.map((n) => this.#drivers[n].status());
  }

  async listTabs(browser?: BrowserName, connectIfNeeded = false): Promise<TabInfo[]> {
    const names = browser ? [browser] : BROWSERS;
    const out: TabInfo[] = [];
    for (const name of names) {
      let b = this.#sync(name);
      if (!b) {
        if (!connectIfNeeded) continue;
        b = await this.connect(name);
      }
      const reg = this.#tabs[name];
      let pages: Page[];
      try {
        pages = (await withTimeout(b.pages(), this.#pagesTimeoutMs, `Listing ${name} tabs`)).filter(isUserPage);
        const live = new Set(pages);
        for (const [page, id] of [...reg.byPage]) {
          if (!live.has(page) || page.isClosed()) this.#unregister(name, id);
        }
      } catch (e) {
        // Degrade gracefully (huge sessions, a hung tab): fall back to the tabs we already know.
        pages = [...reg.byPage.keys()].filter((p) => !p.isClosed());
        if (!pages.length) throw e;
      }
      const ids = pages.map((p) => this.#register(name, p));
      const titles = await mapLimit(pages, TITLE_CONCURRENCY, (p) => titleOf(p));
      pages.forEach((p, i) => {
        const id = ids[i]!;
        out.push({ id, browser: name, title: titles[i] ?? '', url: p.url(), current: reg.current === id });
      });
    }
    return out;
  }

  async openTab(browser: BrowserName): Promise<{ id: TabId; page: Page }> {
    const b = this.#sync(browser) ?? (await this.connect(browser));
    const page = await b.newPage();
    const id = this.#register(browser, page);
    this.#tabs[browser].current = id;
    this.#tabs[browser].opened.add(id);
    return { id, page };
  }

  /** True if Stephen opened this tab (tab_open) in this process; user tabs and unknown ids → false. */
  openedByHub(tab: TabId): boolean {
    try {
      return this.#tabs[browserOfTab(tab)].opened.has(tab);
    } catch {
      return false;
    }
  }

  async getPage(tab: TabId): Promise<Page> {
    const name = browserOfTab(tab);
    this.#sync(name);
    const reg = this.#tabs[name];
    const page = reg.byId.get(tab);
    if (!page || page.isClosed()) {
      if (page) this.#unregister(name, tab);
      throw new HubError('TAB_NOT_FOUND', `Tab ${tab} is closed or unknown. Use tabs_list.`);
    }
    reg.current = tab;
    return page;
  }

  async focusTab(tab: TabId): Promise<void> {
    const page = await this.getPage(tab);
    await page.bringToFront();
    this.#tabs[browserOfTab(tab)].current = tab;
  }

  /**
   * Close with runBeforeUnload, so a page with unsaved changes can show its "leave page?" dialog
   * (the caller sees it as a page 'dialog' event). Waits up to closeWaitMs for the tab to go away;
   * if it is still open then (dialog shown, or the user chose to stay) it stays registered — check
   * page.isClosed() afterwards.
   */
  async closeTab(tab: TabId): Promise<void> {
    const page = await this.getPage(tab);
    const name = browserOfTab(tab);
    let onClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      onClose = resolve;
      page.once('close', resolve);
    });
    try {
      await withTimeout(
        (async () => {
          await page.close({ runBeforeUnload: true });
          if (!page.isClosed()) await closed;
        })(),
        this.#closeWaitMs,
        'Closing the tab',
      );
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      // Still open after the wait: a beforeunload dialog, or the page kept itself open.
    } finally {
      if (onClose) page.off('close', onClose);
      if (page.isClosed()) this.#unregister(name, tab);
    }
  }

  browserOf(tab: TabId): BrowserName {
    return browserOfTab(tab);
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      BROWSERS.map(async (name) => {
        try {
          await this.#drivers[name].disconnect();
        } catch {
          // shutting down: nothing useful to do with this
        }
        this.#reset(name);
      }),
    );
  }

  // ───────────── registry internals ─────────────

  /** Align the registry with the driver's live Browser; returns it (or null if not connected). */
  #sync(name: BrowserName): Browser | null {
    const b = this.#drivers[name].current();
    if (!b || !b.connected) {
      if (this.#tabs[name].browser) this.#reset(name);
      return null;
    }
    this.#hook(name, b);
    return b;
  }

  #hook(name: BrowserName, browser: Browser): void {
    const reg = this.#tabs[name];
    if (reg.browser === browser) return;
    this.#reset(name);
    reg.browser = browser;
    const onDisconnected = (): void => {
      if (reg.browser === browser) this.#reset(name);
    };
    const onTargetDestroyed = (target: Target): void => {
      for (const [page, id] of [...reg.byPage]) {
        let same = false;
        try {
          same = page.target() === target;
        } catch {
          // target() may throw on some protocol paths; isClosed() still covers it
        }
        if (same || page.isClosed()) this.#unregister(name, id);
      }
    };
    browser.on('disconnected', onDisconnected);
    browser.on('targetdestroyed', onTargetDestroyed);
    reg.unhook = () => {
      browser.off('disconnected', onDisconnected);
      browser.off('targetdestroyed', onTargetDestroyed);
    };
  }

  /** Drop every tab of this browser (ids are NOT reset — they're never reused). */
  #reset(name: BrowserName): void {
    const reg = this.#tabs[name];
    reg.unhook?.();
    reg.unhook = null;
    reg.browser = null;
    reg.byId.clear();
    reg.byPage.clear();
    reg.opened.clear();
    reg.current = null;
  }

  #register(name: BrowserName, page: Page): TabId {
    const reg = this.#tabs[name];
    const known = reg.byPage.get(page);
    if (known) return known;
    reg.seq += 1;
    const id = makeTabId(name, reg.seq);
    reg.byId.set(id, page);
    reg.byPage.set(page, id);
    page.once('close', () => {
      if (reg.byId.get(id) === page) this.#unregister(name, id);
    });
    return id;
  }

  #unregister(name: BrowserName, id: TabId): void {
    const reg = this.#tabs[name];
    const page = reg.byId.get(id);
    reg.byId.delete(id);
    if (page) reg.byPage.delete(page);
    reg.opened.delete(id);
    if (reg.current === id) reg.current = null;
  }
}

function isUserPage(page: Page): boolean {
  if (page.isClosed()) return false;
  try {
    if (page.target().type() !== 'page') return false;
  } catch {
    // Some BiDi paths may not expose a target type; fall back to the URL check.
  }
  return !NON_USER_PAGE_RE.test(page.url());
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function titleOf(page: Page): Promise<string> {
  try {
    return await withTimeout(page.title(), TITLE_TIMEOUT_MS, 'Reading tab title');
  } catch {
    return '';
  }
}
