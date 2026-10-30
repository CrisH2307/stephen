/** Test helpers for the drivers layer: temp-dir ResolvedConfig + fake puppeteer Browser/Page. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import type { HubConfig } from '../../src/config.js';
import type { ResolvedConfig } from '../../src/types.js';

export interface TestConfig {
  cfg: ResolvedConfig;
  home: string;
  cleanup(): void;
}

type Overrides = {
  chrome?: Partial<ResolvedConfig['chrome']>;
  zen?: Partial<HubConfig['zen']>;
};

/** A fully resolved config rooted in a fresh temp dir (no real macOS paths). */
export function makeTestConfig(overrides: Overrides = {}): TestConfig {
  const home = mkdtempSync(join(tmpdir(), 'bh-drivers-'));
  const cfg: ResolvedConfig = {
    home,
    defaultBrowser: 'zen',
    chrome: {
      mode: 'agent',
      executablePath: join(home, 'bin', 'chrome-does-not-exist'),
      userDataDir: join(home, 'chrome-real'),
      agentProfileDir: join(home, 'profiles', 'chrome'),
      extraArgs: [],
      ...overrides.chrome,
    },
    zen: {
      mode: 'agent',
      executablePath: join(home, 'bin', 'zen-does-not-exist'),
      profilePath: null,
      zenAppSupportDir: join(home, 'zen-support'),
      agentProfileDir: join(home, 'profiles', 'zen'),
      extraArgs: [],
      ...overrides.zen,
    },
    safety: {
      confirm: 'deny',
      blockedDomains: [],
      sensitiveDomains: [],
      allowEvaluate: false,
      maxActionsPerMinute: 40,
      confirmCrossSiteTyping: true,
      confirmTimeoutSec: 120,
    },
    output: { maxSnapshotChars: 20000, maxTextChars: 20000, saveDir: join(home, 'output') },
    auditLogPath: join(home, 'audit.log'),
    stateDir: join(home, 'state'),
  };
  return { cfg, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// ───────────── fakes ─────────────

export class FakeTarget {
  constructor(private readonly kind: string) {}
  type(): string {
    return this.kind;
  }
}

export class FakePage extends EventEmitter {
  closed = false;
  fronted = 0;
  readonly targetObj: FakeTarget;
  constructor(
    private readonly owner: FakeBrowser,
    public urlValue = 'about:blank',
    public titleValue = '',
    kind = 'page',
  ) {
    super();
    this.targetObj = new FakeTarget(kind);
  }
  url(): string {
    return this.urlValue;
  }
  async title(): Promise<string> {
    return this.titleValue;
  }
  isClosed(): boolean {
    return this.closed;
  }
  target(): FakeTarget {
    return this.targetObj;
  }
  async bringToFront(): Promise<void> {
    this.fronted += 1;
  }
  /** Options of every close() call. */
  closeOpts: unknown[] = [];
  /** 'now' = closes before close() resolves; 'later' = closes a moment after (CDP Page.close); 'stay' = a beforeunload dialog keeps it open. */
  closeMode: 'now' | 'later' | 'stay' = 'now';
  async close(opts?: unknown): Promise<void> {
    this.closeOpts.push(opts);
    if (this.closeMode === 'now') this.userClose();
    else if (this.closeMode === 'later') setTimeout(() => this.userClose(), 20);
  }
  /** Simulate the user (or anything) closing the tab. */
  userClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.pageList = this.owner.pageList.filter((p) => p !== this);
    this.emit('close');
    this.owner.emit('targetdestroyed', this.targetObj);
  }
  asPage(): Page {
    // Test double: implements only what BrowserManager touches.
    return this as unknown as Page;
  }
}

export class FakeBrowser extends EventEmitter {
  connected = true;
  pageList: FakePage[] = [];
  disconnectCalls = 0;
  closeCalls = 0;
  addPage(url = 'about:blank', title = '', kind = 'page'): FakePage {
    const p = new FakePage(this, url, title, kind);
    this.pageList.push(p);
    return p;
  }
  async pages(): Promise<Page[]> {
    // Returns every page-like target (incl. non-'page' kinds) so the manager's filtering is exercised.
    return this.pageList.map((p) => p.asPage());
  }
  async newPage(): Promise<Page> {
    return this.addPage().asPage();
  }
  async version(): Promise<string> {
    return 'FakeBrowser/1.0';
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.drop();
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.drop();
  }
  /** Simulate the connection dropping (browser quit). */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected');
  }
  asBrowser(): Browser {
    // Test double: implements only what the drivers/manager touch.
    return this as unknown as Browser;
  }
}
