/**
 * Shared contracts for browser-hub. FROZEN for the parallel build: every worktree
 * codes against these types. Changing them requires a coordinated update.
 */
import type { Browser, Page } from 'puppeteer-core';

// ───────────────────────────── Basics ─────────────────────────────

export type BrowserName = 'chrome' | 'zen';
/** 'real' = the user's everyday profile (with logins). 'agent' = a dedicated profile owned by browser-hub. */
export type ProfileMode = 'real' | 'agent';
export type Protocol = 'cdp' | 'webDriverBiDi';

/** Tab ids are short and browser-prefixed: Chrome → c1, c2…  Zen → z1, z2… */
export type TabId = string;
/** Element refs: `<tabId>:e<n>` (main frame) or `<tabId>:f<k>e<n>` (child frame k). See src/refs.ts. */
export type Ref = string;

// ───────────────────────────── Config ─────────────────────────────

/** Fully-resolved configuration (all paths absolute, all defaults applied). Produced by src/config.ts. */
export interface ResolvedConfig {
  /** Root dir for state/profiles/output/audit. Default ~/.browser-hub (env BROWSER_HUB_HOME). */
  home: string;
  defaultBrowser: BrowserName;
  chrome: {
    mode: ProfileMode;
    /** Chrome binary. Default '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'. */
    executablePath: string;
    /** The user's real Chrome user-data dir (where DevToolsActivePort appears in 'real' mode).
     *  Default '~/Library/Application Support/Google/Chrome'. */
    userDataDir: string;
    /** Dedicated agent profile dir. Default '<home>/profiles/chrome'. */
    agentProfileDir: string;
    /** Extra args for agent-mode launches (tests use this for headless/sandbox flags). */
    extraArgs: string[];
  };
  zen: {
    mode: ProfileMode;
    /** Zen binary. Default: first existing of /Applications/{Zen,Zen Browser,Zen Twilight}.app/Contents/MacOS/zen */
    executablePath: string;
    /** Real profile path; null = discover from profiles.ini under zenAppSupportDir. */
    profilePath: string | null;
    /** Default '~/Library/Application Support/zen'. */
    zenAppSupportDir: string;
    /** Default '<home>/profiles/zen'. */
    agentProfileDir: string;
    extraArgs: string[];
  };
  safety: {
    confirm: 'auto' | 'elicit' | 'dialog' | 'deny';
    /** Extra blocked hosts/registrable domains (merged with built-in defaults). */
    blockedDomains: string[];
    /** Extra sensitive hosts/registrable domains (merged with built-in defaults). */
    sensitiveDomains: string[];
    allowEvaluate: boolean;
    maxActionsPerMinute: number;
    confirmCrossSiteTyping: boolean;
    /** Seconds before an unanswered confirmation counts as "deny". Default 120. */
    confirmTimeoutSec: number;
  };
  output: {
    maxSnapshotChars: number; // default 20000
    maxTextChars: number; // default 20000
    /** Where save_to_file output goes. Default '<home>/output'. */
    saveDir: string;
  };
  /** Default '<home>/audit.log'. */
  auditLogPath: string;
  /** Default '<home>/state'. */
  stateDir: string;
}

// ───────────────────────────── Drivers ─────────────────────────────

export interface BrowserStatus {
  name: BrowserName;
  connected: boolean;
  mode: ProfileMode | null;
  protocol: Protocol;
  /** Browser product/version string when connected. */
  version: string | null;
  /** Human-readable note (e.g. how it connected, or why it is not connected). */
  detail: string;
}

/** One driver per browser. Implementations: ChromeDriver, ZenDriver (src/drivers/). */
export interface BrowserDriver {
  readonly name: BrowserName;
  readonly protocol: Protocol;
  /** Connect (attach or launch per mode). Idempotent: returns the live Browser if already connected in that mode. */
  connect(mode: ProfileMode): Promise<Browser>;
  /** The live Browser or null. */
  current(): Browser | null;
  status(): BrowserStatus;
  /** Detach WITHOUT quitting the browser. Ends the BiDi session for Zen. Safe to call twice. */
  disconnect(): Promise<void>;
}

export interface TabInfo {
  id: TabId;
  browser: BrowserName;
  title: string;
  url: string;
  /** True for the tab browser-hub considers current for that browser (last opened/focused/used). */
  current: boolean;
}

/** Owns drivers + tab registry. Implementation: src/drivers/manager.ts (BrowserManager). */
export interface IBrowserManager {
  /** Connect using `mode` or the configured default mode. */
  connect(name: BrowserName, mode?: ProfileMode): Promise<Browser>;
  status(): BrowserStatus[];
  /** Refreshes from the live browsers (user-opened tabs appear). Connects lazily only if `connectIfNeeded`. */
  listTabs(browser?: BrowserName, connectIfNeeded?: boolean): Promise<TabInfo[]>;
  /** Opens a new tab (about:blank if no url — navigation itself is done by the caller after the safety check). */
  openTab(browser: BrowserName): Promise<{ id: TabId; page: Page }>;
  /** Resolves a tab id to its Page; throws HubError('TAB_NOT_FOUND') if unknown/closed. Marks it current. */
  getPage(tab: TabId): Promise<Page>;
  /** Brings the tab to front and marks it current. */
  focusTab(tab: TabId): Promise<void>;
  closeTab(tab: TabId): Promise<void>;
  /** Which browser a tab id belongs to (from its prefix). */
  browserOf(tab: TabId): BrowserName;
  /** Disconnect all (never quits user browsers). */
  shutdown(): Promise<void>;
}

// ───────────────────────────── Page engine ─────────────────────────────

/** Live facts about one element, read from the page right before acting. Used by the safety gate. */
export interface ElementInfo {
  ref: Ref;
  role: string; // computed role, e.g. 'button', 'textbox', 'link'
  name: string; // accessible name (≤ 200 chars)
  tag: string; // lowercase tag name
  inputType: string | null; // <input type>, lowercase
  autocomplete: string | null;
  nameAttr: string | null; // name="…"
  idAttr: string | null;
  placeholder: string | null;
  labelText: string | null; // associated <label> text
  ariaLabel: string | null;
  /** Visible text / value of a button-like element (e.g. input[type=submit] value). */
  text: string | null;
  href: string | null; // absolute href for links
  isEditable: boolean; // input/textarea/select/contenteditable not disabled/readonly
  isDisabled: boolean;
  /** Element is a submit control (button[type=submit|default in form], input[type=submit|image]). */
  isSubmit: boolean;
  /** Element is inside a <form>; formAction absolute URL or null. */
  inForm: boolean;
  formAction: string | null;
  /** URL of the frame the element lives in (top page URL for main frame). */
  frameUrl: string;
  /**
   * For submit / button-like controls inside a <form> or a dialog ([role=dialog], <dialog>, aria-modal):
   * a compact summary of the visible field values that the click would send, e.g.
   * 'To: maria@example.com · Subject: Q3 summary · Message: Hi Maria, here are…' (≤ 600 chars,
   * secret fields shown as [redacted]). null/absent otherwise. Shown to the human in confirmations.
   */
  formSummary?: string | null;
  /**
   * Page-computed evidence that this field holds a secret even when its attributes don't say so
   * (review #2 finding 10/13): 'text-security' (CSS-masked, -webkit-text-security), 'otp-digit-group'
   * (one of several adjacent 1-character boxes), 'became-password' (type switched to password on focus),
   * or another short machine-readable reason. null/absent = no extra evidence. The gate treats any
   * non-empty value as a secret field.
   */
  secretHint?: string | null;
}

export interface SnapshotOptions {
  filter: 'interactive' | 'all';
  /** Restrict to the subtree of this ref. */
  scope?: Ref;
  maxChars: number;
}

export interface SnapshotResult {
  /** The rendered tree (see DESIGN.md §3.2), already truncated to maxChars with a trailing summary line. */
  text: string;
  url: string;
  title: string;
  refCount: number;
  hiddenOmitted: number;
  truncated: boolean;
}

export interface FindMatch {
  ref: Ref;
  role: string;
  name: string;
  /** Nearest heading/landmark context, e.g. 'form "Sign up" › group "Address"'. */
  context: string;
}

export interface ReadTextResult {
  text: string;
  url: string;
  title: string;
  truncated: boolean;
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** Implementation: src/page/index.ts exports `pageEngine: PageEngine`. All refs must belong to `page`'s tab. */
export interface PageEngine {
  snapshot(page: Page, tab: TabId, opts: SnapshotOptions): Promise<SnapshotResult>;
  find(page: Page, tab: TabId, query: string, maxResults: number): Promise<FindMatch[]>;
  readText(page: Page, opts: { scope?: Ref; maxChars: number }): Promise<ReadTextResult>;
  /** Re-resolve a ref against the live DOM. Throws HubError('STALE_REF') if gone. */
  describe(page: Page, ref: Ref): Promise<ElementInfo>;
  /** The element that currently has keyboard focus (through shadow roots and iframes), or null. Feeds key-press safety rules. */
  describeFocused(page: Page, tab: TabId): Promise<ElementInfo | null>;
  click(page: Page, ref: Ref, opts?: { double?: boolean; button?: 'left' | 'right' | 'middle' }): Promise<void>;
  hover(page: Page, ref: Ref): Promise<void>;
  /** Types into an editable element. clear=true replaces existing content. submit=true presses Enter after. */
  type(page: Page, ref: Ref, text: string, opts?: { clear?: boolean; submit?: boolean }): Promise<void>;
  /** Select by option value OR visible label. Returns the values actually selected. */
  selectOption(page: Page, ref: Ref, values: string[]): Promise<string[]>;
  /** key: puppeteer KeyInput name or combo 'Meta+A' / 'Control+Shift+K'. */
  pressKey(page: Page, key: string): Promise<void>;
  scroll(page: Page, opts: { ref?: Ref; direction: ScrollDirection; amount: number }): Promise<void>;
  /** Resolves when text appears (or text_gone disappears) or throws HubError('TIMEOUT'). */
  waitFor(page: Page, opts: { text?: string; textGone?: string; timeoutMs: number }): Promise<void>;
  /** PNG, scaled (0.1–1). ref → element screenshot. */
  screenshot(page: Page, opts: { ref?: Ref; fullPage?: boolean; scale: number }): Promise<Buffer>;
  uploadFile(page: Page, ref: Ref, paths: string[]): Promise<void>;
  /**
   * URLs of every frame whose content snapshot / find / readText / screenshot can expose (main frame
   * first, then child frames incl. cross-origin ones; skip detached and empty about:blank). The server
   * calls gate.noteRead() for each after any read, so private content inside iframes taints the
   * session (review #2 finding 2).
   */
  frameUrls(page: Page): Promise<string[]>;
}

// ───────────────────────────── Safety ─────────────────────────────

export type ActionKind =
  | 'navigate'
  | 'click'
  | 'hover'
  | 'type'
  | 'select'
  | 'press'
  | 'scroll'
  | 'upload'
  | 'dialog'
  | 'evaluate'
  | 'tab_open'
  | 'tab_close'
  | 'read';

export interface ActionRequest {
  kind: ActionKind;
  /** MCP tool name, for audit. */
  tool: string;
  browser: BrowserName;
  tab: TabId;
  /** URL of the page the action happens on (before the action). For tab_open, 'about:blank'. */
  pageUrl: string;
  /** Destination for navigate/tab_open. */
  targetUrl?: string;
  /** Live element (click/type/select/upload/hover; for press: the focused element). */
  element?: ElementInfo;
  /**
   * press only: what has keyboard focus. 'element' = `element` is the focused element;
   * 'none' = nothing specific (page body) has focus; 'unknown' = focus could not be determined
   * (error, closed shadow root…) — the gate must fail closed for text-producing keys.
   */
  focus?: 'element' | 'none' | 'unknown';
  /** Text to type / values to select / key to press / code to evaluate / file names to upload. */
  text?: string;
  key?: string;
  files?: string[];
  /** For dialog: dialog type ('alert'|'confirm'|'prompt'|'beforeunload') and accept flag. */
  dialog?: { type: string; message: string; accept: boolean };
  /** The model's one-line description of why. Shown to the human as "Claude says: …", never trusted. */
  intent: string;
}

export type Risk = 'low' | 'medium' | 'high';

export interface PolicyDecision {
  verdict: 'allow' | 'confirm' | 'deny';
  risk: Risk;
  /** Machine-readable rule ids that fired, e.g. ['sensitive-domain', 'high-risk-click']. */
  rules: string[];
  /** Human-readable explanation (returned to the model on deny; shown to the human on confirm). */
  reason: string;
}

export interface ConfirmPrompt {
  title: string; // e.g. 'Claude wants to click "Send" on mail.google.com'
  /** Multi-line body built from LIVE page facts; secrets redacted. */
  body: string;
}

export type ConfirmOutcome = 'approved' | 'declined' | 'unavailable';

export interface Confirmer {
  readonly kind: string; // 'elicit' | 'dialog' | 'deny' | 'chain' | test fakes
  confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome>;
}

export interface GateResult {
  allowed: boolean;
  decision: PolicyDecision;
  confirmation: 'not-needed' | 'approved' | 'declined' | 'unavailable';
  /** Message to return to the model when !allowed. */
  message: string;
}

/** Implementation: src/safety/gate.ts (SafetyGate). */
export interface ISafetyGate {
  /** Evaluate policy, ask a human if needed, write the "decision" audit entry. */
  check(req: ActionRequest): Promise<GateResult>;
  /** Pure policy evaluation (no confirmation, no audit). */
  evaluate(req: ActionRequest): PolicyDecision;
  /** Record that content from `url` was read (snapshot/read_text/find/screenshot) — feeds cross-site typing rule. */
  noteRead(url: string): void;
  /** True if a field must never be typed into / revealed (password, OTP, payment…). */
  isSecretField(el: ElementInfo): boolean;
  /**
   * True if `url` is a private origin (mail, private apps, sensitive domains, user sensitiveDomains) —
   * the same definition that arms the cross-site taint. Pure; no side effects.
   */
  isPrivate(url: string): boolean;
  /**
   * True if content from `url`'s taint scope (host, or document for per-document hosts) was already
   * read this session. The server shows titles of private tabs only when isPrivate(url) is false or
   * wasRead(url) is true; otherwise it hides the title (review #2 finding 1).
   */
  wasRead(url: string): boolean;
}

export interface AuditEntry {
  ts: string; // ISO
  tool: string;
  browser?: BrowserName;
  tab?: TabId;
  kind?: ActionKind;
  urlBefore?: string;
  urlAfter?: string;
  /** e.g. 'button "Send"' — never values. */
  element?: string;
  /** Redacted args summary, e.g. {text: '[23 chars] "Hello Mar…"'}. */
  args?: Record<string, unknown>;
  risk?: Risk;
  verdict?: PolicyDecision['verdict'];
  confirmation?: GateResult['confirmation'];
  outcome: 'ok' | 'denied' | 'error';
  error?: string;
  intent?: string;
}

/** Implementation: src/safety/audit.ts (AuditLog). */
export interface IAuditLog {
  append(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void>;
  recent(limit: number): Promise<AuditEntry[]>;
}
