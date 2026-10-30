/**
 * Fakes for server tests: a fake puppeteer Page/Dialog, BrowserManager, PageEngine and safety gate/audit.
 * Nothing here touches a real browser or the (separately built) drivers/page/safety modules.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'puppeteer-core';
import { vi } from 'vitest';
import { loadConfig, type UserConfig } from '../../src/config.js';
import { HubError } from '../../src/errors.js';
import { browserOfTab } from '../../src/refs.js';
import type { SafetyDeps } from '../../src/safety/index.js';
import { buildServer, type ServerDeps } from '../../src/server/index.js';
import type {
  ActionRequest,
  AuditEntry,
  BrowserName,
  BrowserStatus,
  ConfirmOutcome,
  ConfirmPrompt,
  Confirmer,
  ElementInfo,
  GateResult,
  IAuditLog,
  IBrowserManager,
  ISafetyGate,
  PageEngine,
  PolicyDecision,
  ProfileMode,
  TabInfo,
} from '../../src/types.js';

// ───────────────────────────── page / dialog ─────────────────────────────

export class FakeDialog {
  accepted: string | true | null = null;
  dismissed = false;
  /** Runs when the dialog is accepted (e.g. a beforeunload dialog closing its tab). */
  onAccept: (() => void) | null = null;
  constructor(
    private readonly t: string,
    private readonly m: string,
  ) {}
  type() {
    return this.t;
  }
  message() {
    return this.m;
  }
  async accept(text?: string) {
    this.accepted = text ?? true;
    this.onAccept?.();
  }
  async dismiss() {
    this.dismissed = true;
  }
}

export class FakePage {
  gotoCalls: [string, unknown][] = [];
  history: string[] = [];
  closed = false;
  /** If set, closing the tab shows a beforeunload dialog with this message instead of closing. */
  beforeUnload: string | null = null;
  /** Frame URLs (main frame first) reported by the fake engine's frameUrls; default: just the page URL. */
  frameList: string[] | null = null;
  private handlers = new Map<string, ((arg: unknown) => void)[]>();
  constructor(
    public currentUrl = 'about:blank',
    public currentTitle = '',
  ) {}
  url() {
    return this.currentUrl;
  }
  isClosed() {
    return this.closed;
  }
  async title() {
    return this.currentTitle;
  }
  async goto(url: string, opts?: unknown) {
    this.gotoCalls.push([url, opts]);
    this.history.push(this.currentUrl);
    this.currentUrl = url;
    this.currentTitle = `Title of ${url}`;
    return { ok: () => true, status: () => 200 };
  }
  async goBack() {
    const prev = this.history.pop();
    if (!prev) return null;
    this.currentUrl = prev;
    return { ok: () => true, status: () => 200 };
  }
  async goForward() {
    return null;
  }
  async reload() {
    return { ok: () => true, status: () => 200 };
  }
  async evaluate(expr: string) {
    return { evaluated: expr };
  }
  on(event: string, handler: (arg: unknown) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  listenerCount(event: string) {
    return this.handlers.get(event)?.length ?? 0;
  }
  emitDialog(type: string, message: string): FakeDialog {
    const d = new FakeDialog(type, message);
    for (const h of this.handlers.get('dialog') ?? []) h(d);
    return d;
  }
  asPage(): Page {
    return this as unknown as Page;
  }
}

// ───────────────────────────── manager ─────────────────────────────

export class FakeManager implements IBrowserManager {
  pages = new Map<string, FakePage>();
  connected: Record<BrowserName, boolean> = { chrome: false, zen: true };
  modes: Record<BrowserName, ProfileMode> = { chrome: 'real', zen: 'agent' };
  current = new Map<BrowserName, string>();
  connectCalls: [BrowserName, ProfileMode | undefined][] = [];
  shutdownCalls = 0;
  /** Tabs opened through openTab (Stephen's own); everything else counts as the user's. */
  opened = new Set<string>();
  closeCalls: string[] = [];
  private seq: Record<BrowserName, number> = { chrome: 0, zen: 0 };

  addPage(id: string, page: FakePage): FakePage {
    this.pages.set(id, page);
    const n = Number(id.slice(1));
    const b = browserOfTab(id);
    this.seq[b] = Math.max(this.seq[b], n);
    this.connected[b] = true;
    return page;
  }
  async connect(name: BrowserName, mode?: ProfileMode) {
    this.connectCalls.push([name, mode]);
    this.connected[name] = true;
    if (mode) this.modes[name] = mode;
    return {} as never;
  }
  status(): BrowserStatus[] {
    return (['chrome', 'zen'] as const).map((name) => ({
      name,
      connected: this.connected[name],
      mode: this.connected[name] ? this.modes[name] : null,
      protocol: name === 'chrome' ? 'cdp' : 'webDriverBiDi',
      version: this.connected[name] ? `${name}/1.0` : null,
      detail: '',
    }));
  }
  async listTabs(browser?: BrowserName): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    for (const [id, p] of this.pages) {
      const b = browserOfTab(id);
      if (browser && b !== browser) continue;
      out.push({ id, browser: b, title: p.currentTitle, url: p.currentUrl, current: this.current.get(b) === id });
    }
    return out;
  }
  async openTab(browser: BrowserName) {
    const id = `${browser === 'chrome' ? 'c' : 'z'}${++this.seq[browser]}`;
    const page = new FakePage();
    this.pages.set(id, page);
    this.current.set(browser, id);
    this.opened.add(id);
    return { id, page: page.asPage() };
  }
  openedByHub(tab: string): boolean {
    return this.opened.has(tab);
  }
  async getPage(tab: string): Promise<Page> {
    const p = this.pages.get(tab);
    if (!p) throw new HubError('TAB_NOT_FOUND', `No tab ${tab}. Use tabs_list.`);
    this.current.set(browserOfTab(tab), tab);
    return p.asPage();
  }
  async focusTab(tab: string) {
    await this.getPage(tab);
  }
  async closeTab(tab: string) {
    const p = this.pages.get(tab);
    if (!p) throw new HubError('TAB_NOT_FOUND', `No tab ${tab}. Use tabs_list.`);
    this.closeCalls.push(tab);
    const close = () => {
      p.closed = true;
      this.pages.delete(tab);
      this.opened.delete(tab);
    };
    if (p.beforeUnload !== null) {
      // Like page.close({runBeforeUnload: true}): the page asks; accepting the dialog closes it.
      const d = p.emitDialog('beforeunload', p.beforeUnload);
      d.onAccept = close;
      await new Promise((r) => setTimeout(r, 30));
      return;
    }
    close();
  }
  browserOf(tab: string): BrowserName {
    return browserOfTab(tab);
  }
  async shutdown() {
    this.shutdownCalls++;
  }
}

// ───────────────────────────── engine ─────────────────────────────

export function element(ref: string, over: Partial<ElementInfo> = {}): ElementInfo {
  return {
    ref,
    role: 'button',
    name: 'Send',
    tag: 'button',
    inputType: null,
    autocomplete: null,
    nameAttr: null,
    idAttr: null,
    placeholder: null,
    labelText: null,
    ariaLabel: null,
    text: 'Send',
    href: null,
    isEditable: false,
    isDisabled: false,
    isSubmit: false,
    inForm: false,
    formAction: null,
    frameUrl: 'https://mail.example.com/inbox',
    ...over,
  };
}

export type FakeEngine = { [K in keyof PageEngine]: ReturnType<typeof vi.fn> & PageEngine[K] };

export function makeEngine(elements: Record<string, Partial<ElementInfo>> = {}): FakeEngine {
  const fp = (page: Page) => page as unknown as FakePage;
  const engine = {
    snapshot: vi.fn(async (page: Page, tab: string) => ({
      text: `Page: ${fp(page).currentTitle}\nURL: ${fp(page).currentUrl}\n- button "Send" [ref=${tab}:e1]`,
      url: fp(page).currentUrl,
      title: fp(page).currentTitle,
      refCount: 1,
      hiddenOmitted: 0,
      truncated: false,
    })),
    find: vi.fn(async (_page: Page, tab: string) => [{ ref: `${tab}:e1`, role: 'button', name: 'Send', context: 'form "Compose"' }]),
    readText: vi.fn(async (page: Page) => ({ text: 'Hello world', url: fp(page).currentUrl, title: fp(page).currentTitle, truncated: false })),
    describe: vi.fn(async (_page: Page, ref: string) => element(ref, elements[ref] ?? {})),
    describeFocused: vi.fn(async () => null),
    click: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    selectOption: vi.fn(async (_p: Page, _r: string, values: string[]) => values),
    pressKey: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    uploadFile: vi.fn(async () => {}),
    frameUrls: vi.fn(async (page: Page) => fp(page).frameList ?? [fp(page).currentUrl]),
  };
  return engine as unknown as FakeEngine;
}

// ───────────────────────────── safety ─────────────────────────────

export function allow(rules: string[] = []): GateResult {
  return {
    allowed: true,
    decision: { verdict: 'allow', risk: 'low', rules, reason: 'ok' },
    confirmation: 'not-needed',
    message: '',
  };
}

export function deny(message: string): GateResult {
  return {
    allowed: false,
    decision: { verdict: 'deny', risk: 'high', rules: ['test-deny'], reason: message },
    confirmation: 'not-needed',
    message,
  };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

export class FakeGate implements ISafetyGate {
  checks: ActionRequest[] = [];
  reads: string[] = [];
  evaluations: ActionRequest[] = [];
  /** Hosts isPrivate() reports as private (mail, private apps…). */
  privateHosts = new Set<string>();
  /** Hosts evaluate() denies with the 'blocked-url' rule. */
  blockedHosts = new Set<string>();
  decide: (req: ActionRequest) => GateResult | Promise<GateResult> = () => allow();
  async check(req: ActionRequest): Promise<GateResult> {
    this.checks.push(req);
    return this.decide(req);
  }
  evaluate(req: ActionRequest): PolicyDecision {
    this.evaluations.push(req);
    const url = req.kind === 'navigate' || req.kind === 'tab_open' ? (req.targetUrl ?? '') : req.pageUrl;
    if (this.blockedHosts.has(hostOf(url))) {
      return { verdict: 'deny', risk: 'high', rules: ['blocked-url'], reason: `${hostOf(url)} is on Stephen's blocked list.` };
    }
    return allow().decision;
  }
  noteRead(url: string): void {
    this.reads.push(url);
  }
  isPrivate(url: string): boolean {
    return this.privateHosts.has(hostOf(url));
  }
  wasRead(url: string): boolean {
    return this.reads.some((r) => hostOf(r) === hostOf(url));
  }
  isSecretField(el: ElementInfo): boolean {
    return el.inputType === 'password' || el.autocomplete === 'one-time-code';
  }
}

export class FakeAudit implements IAuditLog {
  entries: AuditEntry[] = [];
  async append(entry: Omit<AuditEntry, 'ts'> & { ts?: string }) {
    this.entries.push({ ts: entry.ts ?? new Date().toISOString(), ...entry });
  }
  /** Newest first, like the real AuditLog. */
  async recent(limit: number) {
    return this.entries.slice(-limit).reverse();
  }
}

export class FakeConfirmer implements Confirmer {
  readonly kind = 'fake';
  prompts: ConfirmPrompt[] = [];
  answer: ConfirmOutcome = 'approved';
  async confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome> {
    this.prompts.push(prompt);
    return this.answer;
  }
}

/** A promise you resolve/reject from outside. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks / timers run. */
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── harness ─────────────────────────────

export interface SetupOptions {
  overrides?: UserConfig;
  elicitation?: boolean;
  onElicit?: (params: ElicitRequest['params']) => ElicitResult | Promise<ElicitResult>;
  elements?: Record<string, Partial<ElementInfo>>;
  actionTimeoutMs?: number;
  orphanWaitMs?: number;
}

export async function setup(opts: SetupOptions = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'bh-server-'));
  const cfg = loadConfig(opts.overrides, { HOME: tmp, STEPHEN_HOME: join(tmp, 'hub') });
  const manager = new FakeManager();
  const page = manager.addPage('z1', new FakePage('https://mail.example.com/inbox', 'Inbox – Mail'));
  const engine = makeEngine(opts.elements);
  const gate = new FakeGate();
  const audit = new FakeAudit();
  const safety: { deps: SafetyDeps | undefined } = { deps: undefined };
  const safetyFactory = vi.fn((_cfg: unknown, deps?: SafetyDeps) => {
    safety.deps = deps;
    return { gate, audit };
  });

  const confirmer = new FakeConfirmer();
  const deps: ServerDeps = {
    cfg,
    manager,
    engine,
    safetyFactory: safetyFactory as unknown as ServerDeps['safetyFactory'],
    confirmerFactory: () => confirmer,
    ...(opts.actionTimeoutMs !== undefined ? { actionTimeoutMs: opts.actionTimeoutMs } : {}),
    orphanWaitMs: opts.orphanWaitMs ?? 500, // fakes that hang forever must not stall the suite
  };
  const server = buildServer(deps);
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: opts.elicitation ? { elicitation: {} } : {} },
  );
  const elicitRequests: ElicitRequest['params'][] = [];
  if (opts.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitRequests.push(req.params);
      return opts.onElicit ? opts.onElicit(req.params) : { action: 'accept', content: { approve: true } };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  return { tmp, cfg, manager, page, engine, gate, audit, confirmer, safety, safetyFactory, server, client, call, elicitRequests };
}

export function textOf(res: CallToolResult): string {
  return res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
