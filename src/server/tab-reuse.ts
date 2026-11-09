/**
 * Tab reuse: the ONE place that decides whether opening a page reuses a tab the browser already has, and the
 * one way a page gets opened in an attached browser (tab_open, open_url, play_media all call openPage).
 *
 *  - findReusableTab: a tab already showing the exact page (fragment ignored) → focus it, no reload;
 *    else a tab on the same site (siteKey), the current / most recently used first → navigate it; else null.
 *    Tabs with a pending dialog and non-web tabs (chrome:, about:, file:, …) are never reused.
 *  - openPage: runs AFTER the caller's gate check for the target URL (that decision is unchanged and reused);
 *    a reused tab is loaded through hub.perform with kind "navigate" (landing check, audit, page facts);
 *    focus mode is audited but navigates nothing; otherwise a new tab is opened and loaded (kind "tab_open").
 *
 * The setting is desktop.reuseTabs in config.json ("site" default | "exact" | "never"), read by every caller
 * through reuseModeOf(cfg).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'puppeteer-core';
import { parseDesktopConfig, type ReuseTabs } from '../desktop/config.js';
import { timed } from '../lib/step-timer.js';
import type { BrowserName, GateResult, IBrowserManager, TabId, TabInfo } from '../types.js';
import { NAV_TIMEOUT_MS, type Hub } from './hub.js';
import { okResult, safeUrl } from './util.js';

export type ReuseMode = ReuseTabs;

/** Hosts that serve several apps on different paths: the first path segment is part of the site key. */
const PATH_APP_HOST_RE = /^(?:google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|docs\.google\.com)$/;
/** Hosts that are the same site as another host. */
const HOST_ALIASES: Record<string, string> = {
  'm.youtube.com': 'youtube.com',
  'maps.google.com': 'google.com/maps',
};

/**
 * A normalized "same site" key for a web URL, or null for anything that is not http(s).
 * Lowercase host (IDN as punycode), no leading "www.", non-default port kept; youtube.com = m./www.youtube.com
 * (music.youtube.com is its own site); hosts that serve several apps on paths (google.com, docs.google.com)
 * add the first path segment ("google.com/maps", "google.com/search"); maps.google.com → "google.com/maps".
 * Notion workspaces (www.notion.so/<workspace>/…) → "notion.so"; Canvas instances → their host.
 */
export function siteKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  let host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return null;
  if (host.startsWith('www.')) host = host.slice(4);
  const port = u.port ? `:${u.port}` : '';
  const alias = HOST_ALIASES[host];
  if (alias) return alias;
  if (PATH_APP_HOST_RE.test(host)) {
    const seg = u.pathname.split('/').find((s) => s.length > 0)?.toLowerCase() ?? '';
    return seg ? `${host}${port}/${seg}` : `${host}${port}`;
  }
  return `${host}${port}`;
}

/** The URL without its #fragment, normalized (for "the exact same page"); null if it is not a URL. */
function pageUrlKey(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Only real web pages are reused: never chrome:, about:, file:, extension or other internal tabs. */
function reusableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Friendly names for the result text ("your existing Google Maps tab"); anything else is named by its key. */
const SITE_LABELS: Record<string, string> = {
  'google.com/maps': 'Google Maps',
  'google.com/search': 'Google Search',
  'mail.google.com': 'Gmail',
  'calendar.google.com': 'Google Calendar',
  'drive.google.com': 'Google Drive',
  'docs.google.com/document': 'Google Docs',
  'docs.google.com/spreadsheets': 'Google Sheets',
  'docs.google.com/presentation': 'Google Slides',
  'youtube.com': 'YouTube',
  'music.youtube.com': 'YouTube Music',
  'notion.so': 'Notion',
};

export function siteLabel(key: string): string {
  if (SITE_LABELS[key]) return SITE_LABELS[key];
  if (/\.instructure\.com$/.test(key)) return 'Canvas';
  return key;
}

export interface ReusableTab {
  tab: TabInfo;
  /** focus: the tab already shows this page (no reload); navigate: same site, load the page in it. */
  mode: 'focus' | 'navigate';
}

export interface FindOptions {
  /** desktop.reuseTabs; default "site". */
  reuse?: ReuseMode;
  /** Tabs with a pending dialog are never reused. */
  hasDialog?: (tab: TabId) => boolean;
}

/**
 * The tab of `browser` that opening `targetUrl` should reuse, or null for a new tab. Never throws (a browser
 * that can't list its tabs just gets a new one). Lists only an already-connected browser.
 */
export async function findReusableTab(
  manager: Pick<IBrowserManager, 'listTabs'>,
  browser: BrowserName,
  targetUrl: string,
  opts: FindOptions = {},
): Promise<ReusableTab | null> {
  const reuse = opts.reuse ?? 'site';
  if (reuse === 'never') return null;
  const exact = pageUrlKey(targetUrl);
  const site = siteKey(targetUrl);
  if (!exact || !site) return null;
  let tabs: TabInfo[];
  try {
    tabs = await manager.listTabs(browser, false);
  } catch {
    return null;
  }
  const candidates = tabs
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.browser === browser && reusableUrl(t.url) && !opts.hasDialog?.(t.id))
    // The current tab first, then the most recently used, then the browser's own order (later = newer).
    .sort((a, b) => Number(b.t.current) - Number(a.t.current) || (b.t.lastUsed ?? 0) - (a.t.lastUsed ?? 0) || b.i - a.i)
    .map(({ t }) => t);
  const same = candidates.find((t) => pageUrlKey(t.url) === exact);
  if (same) return { tab: same, mode: 'focus' };
  if (reuse === 'exact') return null;
  const onSite = candidates.find((t) => siteKey(t.url) === site);
  return onSite ? { tab: onSite, mode: 'navigate' } : null;
}

/** desktop.reuseTabs from the server config (validated by src/desktop/config.ts). */
export function reuseModeOf(cfg: object): ReuseMode {
  return parseDesktopConfig((cfg as { desktop?: unknown }).desktop ?? {}).reuseTabs;
}

/** The browser could not give Stephen a new tab (lost connection…); open_url falls back to `open -a`. */
export class TabOpenFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TabOpenFailed';
  }
}

export interface OpenPageSpec {
  tool: string;
  browser: BrowserName;
  /** The target URL, already approved by the caller's gate check `g`. */
  href: string;
  intent: string;
  g: GateResult;
  reuse: ReuseMode;
  /** The user explicitly asked for a new tab. */
  newTab?: boolean;
  /** Audit args (already redacted). A `via` is suffixed with " (reused tab)" when a tab is reused. */
  auditArgs: Record<string, unknown>;
  /** Result line for a new tab, e.g. `Opened z3 in zen and loaded https://…`. */
  newTabDone: (id: TabId) => string;
  includeSnapshot?: boolean;
}

export interface OpenedPage {
  id: TabId;
  page: Page;
  how: 'focus' | 'navigate' | 'new';
  res: CallToolResult;
}

/**
 * Open the (gate-approved) page in the attached browser: reuse a tab when findReusableTab says so, else a new
 * tab. Throws TabOpenFailed when neither an existing nor a new tab could be had.
 */
export async function openPage(hub: Hub, spec: OpenPageSpec): Promise<OpenedPage> {
  const { tool, browser, href, intent, g } = spec;
  const manager = hub.manager;
  if (!spec.newTab && spec.reuse !== 'never') {
    if (manager.status().find((s) => s.name === browser)?.connected !== true) {
      try {
        await manager.connect(browser);
      } catch (e) {
        throw new TabOpenFailed(e);
      }
    }
    const found = await findReusableTab(manager, browser, href, { reuse: spec.reuse, hasDialog: (t) => hub.dialogs.get(t) !== undefined });
    if (found) {
      let page: Page | null = null;
      try {
        page = await manager.getPage(found.tab.id);
      } catch {
        // closed meanwhile: a new tab instead
      }
      if (page) {
        const res =
          found.mode === 'focus'
            ? await focusExisting(hub, spec, found.tab.id, page)
            : await navigateExisting(hub, spec, found.tab.id, page, siteLabel(siteKey(href) ?? ''));
        return { id: found.tab.id, page, how: found.mode, res };
      }
    }
  }
  let tab: { id: TabId; page: Page };
  try {
    tab = await manager.openTab(browser);
  } catch (e) {
    throw new TabOpenFailed(e);
  }
  const { id, page } = tab;
  hub.dialogs.attach(page, id);
  const res = await hub.withTab(id, 'write', () =>
    hub.perform(
      {
        tool,
        kind: 'tab_open',
        tab: id,
        page,
        intent,
        targetUrl: href,
        auditArgs: spec.auditArgs,
        run: () => load(page, href),
        done: spec.newTabDone(id),
        includeSnapshot: spec.includeSnapshot,
        timeoutMs: NAV_TIMEOUT_MS + 5000,
      },
      g,
      'about:blank',
    ),
  );
  return { id, page, how: 'new', res };
}

async function load(page: Page, href: string): Promise<string | void> {
  const r = await timed('page.navigate', () => page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }));
  if (r && !r.ok()) return `(HTTP ${r.status()})`;
}

function reusedArgs(spec: OpenPageSpec, mode: 'focus' | 'navigate'): Record<string, unknown> {
  const via = spec.auditArgs.via;
  return { ...spec.auditArgs, ...(typeof via === 'string' ? { via: `${via} (reused tab)` } : {}), reused: mode };
}

async function bringToFront(hub: Hub, id: TabId): Promise<void> {
  try {
    await hub.manager.focusTab(id);
  } catch {
    // not fatal: the page is still there
  }
}

/** The tab already shows the page: bring it to the front, no reload. Audited (kind tab_open, reused: focus). */
async function focusExisting(hub: Hub, spec: OpenPageSpec, id: TabId, page: Page): Promise<CallToolResult> {
  hub.dialogs.attach(page, id);
  return hub.withTab(id, 'write', async () => {
    const before = safeUrl(page);
    await bringToFront(hub, id);
    const base = hub.auditBase({ tool: spec.tool, kind: 'tab_open', tab: id, intent: spec.intent, auditArgs: reusedArgs(spec, 'focus') }, spec.g, before);
    let text: string;
    try {
      text = await hub.outcomeText(id, page, `Switched to the tab that already had this page (${id}) — nothing was reloaded, no new tab`, before, spec.includeSnapshot);
    } catch (e) {
      await hub.audit({ ...base, urlAfter: safeUrl(page), outcome: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    await hub.audit({ ...base, urlAfter: safeUrl(page), outcome: 'ok' });
    return okResult(text);
  });
}

/** Same site: load the page in that tab (brought to front) through hub.perform, kind navigate. */
async function navigateExisting(hub: Hub, spec: OpenPageSpec, id: TabId, page: Page, label: string): Promise<CallToolResult> {
  hub.dialogs.attach(page, id);
  const before = safeUrl(page);
  await bringToFront(hub, id);
  return hub.withTab(id, 'write', () =>
    hub.perform(
      {
        tool: spec.tool,
        kind: 'navigate',
        tab: id,
        page,
        intent: spec.intent,
        targetUrl: spec.href,
        auditArgs: reusedArgs(spec, 'navigate'),
        run: () => load(page, spec.href),
        done: `Loaded ${spec.href} in your existing ${label} tab (${id}) instead of opening a new tab`,
        doneNamesTab: true,
        includeSnapshot: spec.includeSnapshot,
        timeoutMs: NAV_TIMEOUT_MS + 5000,
      },
      spec.g,
      before || 'about:blank',
    ),
  );
}
