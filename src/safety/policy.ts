/**
 * The policy engine: a pure function from (request, state) to a verdict. No I/O, no clock reads —
 * `state.now` and the session history are passed in, so every rule is unit-testable.
 *
 * Rule table (id → verdict → trigger):
 *   blocked-url          deny     navigate/tab_open target not http(s)/about:blank or on a blocked list;
 *                                 any other action/read on a page (or frame) that is not http(s)/about:blank/
 *                                 about:srcdoc or is on a blocked list; click on a link into a blocked site
 *   missing-element      deny     click/type/select/upload without live element facts (fail closed)
 *   secret-field         deny     type/select/upload into a secret field; a text-producing key or paste
 *                                 combo while a secret field has focus
 *   focus-unknown        deny     press of a text-producing / paste / Enter / Tab / Backspace / Delete key
 *                                 while focus is 'unknown' or not reported (fail closed)
 *   control-in-text      deny     `type` text with a Tab or line break into a single-line field (next field / submit)
 *   evaluate-disabled    deny     evaluate while safety.allowEvaluate is false
 *   evaluate-too-long    deny     evaluate code longer than EVALUATE_MAX_CHARS (the human must see all of it)
 *   rate-limit           deny     ≥ maxActionsPerMinute actions (mutating, hover, scroll) allowed in the last 60 s
 *   evaluate             confirm  evaluate while allowed (full code shown to the human)
 *   sensitive-domain     confirm  navigate/tab_open/link to a sensitive site; any mutation on a sensitive page
 *   high-risk-click      confirm  click (or Enter/Space on a focused control) whose label matches the
 *                                 multilingual high-risk words, or a submit control
 *   high-risk-key        confirm  Meta/Ctrl+Enter anywhere; Enter (press, or type with key 'Enter' = submit) in a
 *                                 single-line field (not a search box) or a textarea/contenteditable
 *   destructive-shortcut confirm  Delete/Backspace/'#'/'!' when no text field has focus (web-app shortcuts)
 *   upload               confirm  every upload
 *   dialog-accept        confirm  accepting any dialog other than alert
 *   paste                confirm  every paste combo (Meta/Ctrl+V, Meta+Shift+V, Shift+Insert, Paste) wherever focus
 *                                 is: the page receives the clipboard (which may hold a copied password)
 *   cross-site-typing    confirm  entering text whose destination differs from a private scope read this session;
 *                                 after a private read any text-producing key counts, whatever has focus
 *   cross-site-navigate  confirm  a data-carrying URL to another host (or any open endpoint) after a private read
 *   first-interaction    confirm  after a private read, an interaction (click/type/select/press/hover/scroll/upload/
 *                                 dialog/same-host navigate) on a host neither read privately nor approved; the
 *                                 gate trusts the host for the session once the user approves
 * Decision messages never contain page-supplied text (labels, dialog messages): elements are named by role + ref,
 * hosts are normalized host names. They are returned to the model outside any untrusted-content wrapper.
 * Most restrictive verdict wins; all fired ids are reported. The cross-site rules are documented in egress.ts.
 */
import type { ActionRequest, ElementInfo, PolicyDecision, ResolvedConfig, Risk } from '../types.js';
import {
  baseRisk,
  countsTowardRateLimit,
  destructiveShortcut,
  highRiskReason,
  isActivatable,
  isEnterKey,
  isInteraction,
  isMultilineEditor,
  isMutating,
  isPasteKey,
  isSearchField,
  isSingleLineField,
  isTextEntry,
  isTextInsertingKey,
  isTextProducingKey,
  keyRisk,
  maxRisk,
  needsKnownFocus,
  parseKey,
  producedChar,
  secretFieldReason,
} from './classify.js';
import {
  BUILTIN_BLOCKED_DOMAINS,
  BUILTIN_MAIL_DOMAINS,
  BUILTIN_PRIVATE_APP_DOMAINS,
  BUILTIN_SENSITIVE_DOMAINS,
  compilePatterns,
  type DomainPattern,
  findMatch,
  hostOf,
  OPEN_ENDPOINT_DOMAINS,
  type ParsedUrl,
  parseUrl,
  registrableDomain,
} from './domains.js';
import {
  assessOutbound,
  describeSources,
  type PrivateRead,
  privateReadOf as privateReadOfRaw,
  taintFromOtherHosts,
  taintFromOtherScopes,
  taintScope,
} from './egress.js';
import { clean } from './text.js';

export const RATE_WINDOW_MS = 60_000;
/** The human must be able to read every character of code they approve; longer code is denied, never truncated. */
export const EVALUATE_MAX_CHARS = 2000;

export type SafetySettings = ResolvedConfig['safety'];
export type { PrivateRead };

export interface PolicyLists {
  blocked: DomainPattern[];
  sensitive: DomainPattern[];
  /** Mail + private apps + sensitive (built-in and user): reading these arms the cross-site rules. */
  privateSources: DomainPattern[];
  /** Redirectors, shorteners, form/script endpoints, collectors, tunnels, pastebins. */
  openEndpoints: DomainPattern[];
}

/** Built-in lists merged with the user's config lists. */
export function compileLists(safety: Pick<SafetySettings, 'blockedDomains' | 'sensitiveDomains'>): PolicyLists {
  const blocked = compilePatterns([...BUILTIN_BLOCKED_DOMAINS, ...safety.blockedDomains]);
  const sensitive = compilePatterns([...BUILTIN_SENSITIVE_DOMAINS, ...safety.sensitiveDomains]);
  const priv = compilePatterns([...BUILTIN_MAIL_DOMAINS, ...BUILTIN_PRIVATE_APP_DOMAINS]);
  return {
    blocked,
    sensitive,
    privateSources: [...priv, ...sensitive],
    openEndpoints: compilePatterns(OPEN_ENDPOINT_DOMAINS),
  };
}

export interface PolicyState {
  safety: SafetySettings;
  lists: PolicyLists;
  now: number;
  /** Timestamps (ms) of mutating actions that were allowed. */
  mutationTimes: readonly number[];
  /** Private scopes read this session (no expiry). */
  privateReads: readonly PrivateRead[];
  /** Hosts the user allowed Claude to interact with after a private read (first-interaction rule). */
  trustedHosts?: readonly string[];
}

/** If `url` is a private origin, the taint record to store; else null. */
export function privateReadOf(url: string, lists: PolicyLists, at: number): PrivateRead | null {
  return privateReadOfRaw(url, lists.privateSources, at);
}

/** True for a private origin (mail, private apps, sensitive + user sensitiveDomains): reading it arms the taint. */
export function isPrivateUrl(url: string, lists: PolicyLists): boolean {
  return privateReadOf(url, lists, 0) !== null;
}

// ───────────────────────────── landing check (review #2 finding 12) ─────────────────────────────

export type LandingVerdict = 'ok' | 'blocked' | 'sensitive';

/** Browser error pages (failed navigation, certificate error, crash, Safe Browsing block): harmless to land on. */
function isErrorPage(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u) return false;
  if (u.protocol === 'chrome-error:') return true;
  return u.protocol === 'about:' && /^(?:neterror|certerror|tabcrashed|blocked|httpsonlyerror)$/i.test(u.pathname);
}

/**
 * Where an action actually LANDED (script navigation, history back/forward, redirects, form posts): the server
 * calls this with the tab's URL after every action. 'blocked' → the page must not stay open or be described
 * (blank the tab, return an error without title/URL); 'sensitive' → apply the sensitive-site arrival
 * confirmation after the fact; 'ok' otherwise (web pages, about:blank, browser error pages).
 */
export function landingVerdict(url: string, lists: PolicyLists): LandingVerdict {
  if (isErrorPage(url)) return 'ok';
  if (blockedPageReason(url, lists) !== null) return 'blocked';
  return sensitiveHost(url, lists) ? 'sensitive' : 'ok';
}

// ───────────────────────────── first-interaction (review #2 finding 6) ─────────────────────────────

/**
 * Web hosts whose page scripts observe this action: the page's host, plus the element's frame host when
 * it lives in another frame. [] for kinds that are not interactions, for tab_open, and for navigations to
 * another host (those are judged by the outbound-URL rule).
 */
export function interactionHosts(req: ActionRequest): string[] {
  if (!isInteraction(req.kind)) return [];
  const page = parseUrl(req.pageUrl);
  const pageHost = page?.isWeb ? page.host : '';
  if (req.kind === 'navigate' && req.targetUrl) {
    const t = parseUrl(req.targetUrl);
    if (!t || !t.isWeb || t.host !== pageHost) return [];
  }
  const hosts = new Set<string>();
  if (pageHost) hosts.add(pageHost);
  const frame = req.element?.frameUrl ? parseUrl(req.element.frameUrl) : null;
  if (frame?.isWeb && frame.host) hosts.add(frame.host);
  return [...hosts];
}

/** Interaction hosts that are neither tainted (read privately) nor approved by the user. */
export function untrustedInteractionHosts(req: ActionRequest, reads: readonly PrivateRead[], trusted: readonly string[]): string[] {
  if (reads.length === 0) return [];
  const ok = new Set<string>([...reads.map((r) => r.host), ...trusted]);
  return interactionHosts(req).filter((h) => !ok.has(h));
}

// ───────────────────────────── URL verdicts ─────────────────────────────

const ASK_USER = 'Ask the user to do this themselves.';

function blockedListMessage(host: string): string {
  return `${host} is on browser-hub's blocked list (password-manager vaults and sites the user has blocked) and is off-limits. ${ASK_USER}`;
}

/** Why a navigation target is blocked, or null. Only http(s) and about:blank may be opened. */
export function blockedTargetReason(url: string, lists: PolicyLists): string | null {
  const u = parseUrl(url);
  if (!u) return `"${clean(url, 100)}" is not an absolute URL; browser-hub only opens http(s) URLs.`;
  if (u.protocol === 'about:' && u.href === 'about:blank') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `${u.protocol} URLs (browser-internal pages, local files, scripts, extensions, app links) are off-limits to browser-hub. ${ASK_USER}`;
  }
  if (findMatch(u, lists.blocked)) return blockedListMessage(u.host);
  return null;
}

/** Why acting on/reading a page (or frame) at `url` is blocked, or null. */
export function blockedPageReason(url: string, lists: PolicyLists, what = 'This page'): string | null {
  const u = parseUrl(url);
  if (!u) return `${what}'s URL could not be determined, so browser-hub will not act on it.`;
  if (u.protocol === 'about:' && (u.href === 'about:blank' || u.href === 'about:srcdoc')) return null;
  if (!u.isWeb) {
    return `${what} is a ${u.protocol} page (browser-internal page, local file, extension or other non-web content), which is off-limits to browser-hub. ${ASK_USER}`;
  }
  if (findMatch(u, lists.blocked)) return blockedListMessage(u.host);
  return null;
}

function sensitiveHost(url: string, lists: PolicyLists): string | null {
  const u = parseUrl(url);
  if (!u || !u.isWeb) return null;
  return findMatch(u, lists.sensitive) ? u.host : null;
}

// ───────────────────────────── helpers ─────────────────────────────

interface Fired {
  verdict: 'deny' | 'confirm';
  risk: Risk;
  messages: string[];
}

const SENSITIVE_WHAT = 'is on the sensitive-sites list (banking, payments, investing, government, health or account security)';

/** What has keyboard focus for a press. A missing `focus` is treated as unknown (fail closed). */
export function resolveFocus(req: ActionRequest): 'element' | 'none' | 'unknown' {
  if (req.focus === 'none') return 'none';
  if (req.focus === 'element' && req.element) return 'element';
  return 'unknown';
}

/**
 * 'button z1:e4' — computed role + ref. NEVER the page-supplied label: decision messages go to the model
 * outside the untrusted-content wrapper (review #2 finding 8) and into the prompt's computed-facts part.
 */
export function elementRef(el: ElementInfo): string {
  const role = (el.role || el.tag || 'element').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'element';
  const ref = el.ref.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 40);
  return ref ? `${role} ${ref}` : role;
}
const label = elementRef;

/** An outbound URL an action would load, and whether it carries form fields. */
interface OutboundCandidate {
  url: string;
  what: string;
  form: boolean;
}

/**
 * Every web URL this action would load: the navigation target, a clicked (or Enter/Space-activated) link's
 * href, a submit control's formAction, the formAction of a single-line field Enter is pressed in.
 * One source for the outbound rules in evaluate() and for the hosts the gate trusts on approval.
 */
export function outboundCandidates(req: ActionRequest): OutboundCandidate[] {
  const isPress = req.kind === 'press';
  const focus = isPress ? resolveFocus(req) : null;
  const el = isPress ? (focus === 'element' ? req.element : undefined) : req.element;
  const parsedKey = req.key ? parseKey(req.key) : null;
  const keyName = parsedKey?.key ?? '';
  const cmdMod = !!parsedKey && (parsedKey.modifiers.has('meta') || parsedKey.modifiers.has('control'));
  const plainEnter = !!parsedKey && isEnterKey(keyName) && !cmdMod && !parsedKey.modifiers.has('shift');
  const isNav = req.kind === 'navigate' || req.kind === 'tab_open';
  const activates =
    isPress && !!el && isActivatable(el) && !cmdMod && (plainEnter || (parsedKey ? producedChar(parsedKey) === ' ' : false));
  const clickLike = (req.kind === 'click' && !!el) || activates;
  const enterInto = el && isTextEntry(el) && plainEnter && (isPress || req.kind === 'type') ? el : null;
  const out: OutboundCandidate[] = [];
  if (isNav && req.targetUrl) out.push({ url: req.targetUrl, what: 'address', form: false });
  if (clickLike && el) {
    if (el.href) out.push({ url: el.href, what: 'link', form: false });
    if (el.isSubmit && el.formAction) out.push({ url: el.formAction, what: 'form', form: true });
  }
  if (enterInto && enterInto.inForm && enterInto.formAction && isSingleLineField(enterInto)) {
    out.push({ url: enterInto.formAction, what: 'form', form: true });
  }
  return out;
}

/**
 * Destination hosts that need the first-destination confirmation (review #2 residual gap: after taint a
 * short URL such as evil.com/482913 or 482913.evil.com still fits the data budget). After a private read,
 * a URL that carries ANYTHING beyond a bare origin (a path, or a sub-domain other than www) to a host that
 * was neither read privately nor approved by the user asks once; approval trusts the host for the session,
 * exactly like the first-interaction rule. Bare origins (https://news.ycombinator.com/) stay frictionless.
 */
export function untrustedDestinationHosts(req: ActionRequest, reads: readonly PrivateRead[], trusted: readonly string[], openEndpoints: readonly DomainPattern[]): string[] {
  if (reads.length === 0) return [];
  const ok = new Set<string>([...reads.map((r) => r.host), ...trusted]);
  const hosts = new Set<string>();
  for (const c of outboundCandidates(req)) {
    const o = assessOutbound(c.url, openEndpoints, c.form);
    if (!o || o.openEndpoint || ok.has(o.url.host)) continue;
    if (carriesAnything(o.url)) hosts.add(o.url.host);
  }
  return [...hosts];
}

/** True unless the URL is a bare origin: no path beyond '/', no sub-domain other than www. */
export function carriesAnything(u: ParsedUrl): boolean {
  const reg = registrableDomain(u.host);
  const sub = u.host.length > reg.length ? u.host.slice(0, u.host.length - reg.length - 1) : '';
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return path.length > 0 || (sub !== '' && sub !== 'www') || u.search.length > 1 || u.hash.length > 1;
}

// ───────────────────────────── evaluate ─────────────────────────────

export function evaluate(req: ActionRequest, state: PolicyState): PolicyDecision {
  const { kind } = req;
  const { lists, safety, now } = state;
  const fired = new Map<string, Fired>();
  const fire = (id: string, verdict: Fired['verdict'], risk: Risk, message: string): void => {
    const f = fired.get(id);
    if (f) {
      if (!f.messages.includes(message)) f.messages.push(message);
      f.risk = maxRisk(f.risk, risk);
      if (verdict === 'deny') f.verdict = 'deny';
    } else fired.set(id, { verdict, risk, messages: [message] });
  };

  const isPress = kind === 'press';
  const focus = isPress ? resolveFocus(req) : null;
  // For a press, only a reported focused element counts; otherwise the live target element.
  const el = isPress ? (focus === 'element' ? req.element : undefined) : req.element;
  const parsedKey = req.key ? parseKey(req.key) : null;
  const keyName = parsedKey?.key ?? '';
  const cmdMod = !!parsedKey && (parsedKey.modifiers.has('meta') || parsedKey.modifiers.has('control'));
  const plainEnter = !!parsedKey && isEnterKey(keyName) && !cmdMod && !parsedKey.modifiers.has('shift');
  const isNav = kind === 'navigate' || kind === 'tab_open';
  const target = isNav && req.targetUrl ? req.targetUrl : null;
  const frameUrl = el?.frameUrl && el.frameUrl !== req.pageUrl ? el.frameUrl : null;
  // Enter / Space on a focused button or link activates it exactly like a click.
  const activates =
    isPress && !!el && isActivatable(el) && !cmdMod && (plainEnter || (parsedKey ? producedChar(parsedKey) === ' ' : false));
  const clickLike = (kind === 'click' && !!el) || activates;
  const linkHref = clickLike && el?.href ? parseUrl(el.href) : null;
  const webLink = linkHref?.isWeb ? linkHref : null; // javascript:void(0) links are normal; judge by page
  // Enter (press, or type with submit → key 'Enter') in a single-line field / message editor.
  const enterInto: ElementInfo | null =
    el && isTextEntry(el) && plainEnter && (isPress || kind === 'type') ? el : null;
  // The page engine inserts typed text as text (not key presses): line breaks / tabs land as characters in
  // multi-line editors, but in a single-line field they would mean Enter (submit) / Tab (next field).
  const typedIntoSingleLine = kind === 'type' && !!el && !isMultilineEditor(el);

  // ── blocked-url (deny)
  if (isNav) {
    if (target) {
      const why = blockedTargetReason(target, lists);
      if (why) fire('blocked-url', 'deny', 'high', why);
    }
  } else if (kind !== 'tab_close' && !(kind === 'dialog' && req.dialog?.accept === false)) {
    // Closing a tab / dismissing a dialog only de-escalates, so they stay allowed everywhere.
    const why =
      blockedPageReason(req.pageUrl, lists) ?? (frameUrl ? blockedPageReason(frameUrl, lists, 'The frame') : null);
    if (why) fire('blocked-url', 'deny', 'high', why);
    if (webLink && findMatch(webLink, lists.blocked)) fire('blocked-url', 'deny', 'high', blockedListMessage(webLink.host));
  }

  // ── missing-element (deny, fail closed)
  if ((kind === 'click' || kind === 'type' || kind === 'select' || kind === 'upload') && !el) {
    fire('missing-element', 'deny', 'high', `browser-hub could not read the target element, so the ${kind} was not performed. Re-run snapshot and try again.`);
  }

  // ── secret-field (deny)
  if (el) {
    const inserts = kind === 'type' || kind === 'select' || kind === 'upload' || (isPress && !!req.key && isTextInsertingKey(req.key));
    if (inserts && secretFieldReason(el)) {
      fire(
        'secret-field',
        'deny',
        'high',
        'That field holds a password/one-time code/payment detail. browser-hub never types these — ask the user to enter it themselves.',
      );
    }
  }

  // ── focus-unknown (deny, fail closed)
  if (isPress && focus === 'unknown' && req.key && needsKnownFocus(req.key)) {
    fire(
      'focus-unknown',
      'deny',
      'high',
      `browser-hub could not tell which element has keyboard focus, so it did not press ${clean(req.key, 30)} (it could type into a password field, submit a form or delete something). Click the field or control you mean first (click with its ref), then press the key again — or use the type tool.`,
    );
  }

  // ── control-in-text (deny): Tab / line break typed into a single-line field
  if (typedIntoSingleLine && (req.text ?? '').includes('\t')) {
    fire(
      'control-in-text',
      'deny',
      'high',
      'The text contains a Tab character, which in a single-line field would move focus to the next field (possibly a password field). Type each field separately (fill_form), without Tab characters.',
    );
  }
  if (typedIntoSingleLine && /[\r\n]/.test(req.text ?? '')) {
    fire(
      'control-in-text',
      'deny',
      'high',
      'The text contains a line break, which in a single-line field would press Enter and submit the form. Remove the line break; to press Enter after typing, use submit: true (the user will be asked).',
    );
  }

  // ── evaluate (deny | confirm)
  if (kind === 'evaluate') {
    const len = (req.text ?? '').length;
    if (!safety.allowEvaluate) {
      fire('evaluate-disabled', 'deny', 'high', 'Running JavaScript in pages is disabled in browser-hub (safety.allowEvaluate is false).');
    } else if (len > EVALUATE_MAX_CHARS) {
      fire(
        'evaluate-too-long',
        'deny',
        'high',
        `The expression is ${len} characters; the user must be able to read all of the code they approve, so browser-hub only runs expressions of at most ${EVALUATE_MAX_CHARS} characters. Shorten it.`,
      );
    } else {
      fire('evaluate', 'confirm', 'high', 'Runs arbitrary JavaScript in the page, with access to everything the logged-in page can do.');
    }
  }

  // ── rate-limit (deny) — hover and scroll count too (page scripts see them)
  if (countsTowardRateLimit(kind)) {
    const recent = state.mutationTimes.filter((t) => now - t < RATE_WINDOW_MS && t <= now);
    if (recent.length >= safety.maxActionsPerMinute) {
      const oldest = Math.min(...recent);
      const wait = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
      fire(
        'rate-limit',
        'deny',
        'medium',
        `Rate limit: ${recent.length} actions in the last minute (limit ${safety.maxActionsPerMinute}). Wait about ${wait} s before the next action, and check with the user that this many actions is intended.`,
      );
    }
  }

  // ── sensitive-domain (confirm)
  if (isNav) {
    const host = target ? sensitiveHost(target, lists) : null;
    if (host) fire('sensitive-domain', 'confirm', 'medium', `${host} ${SENSITIVE_WHAT}.`);
  } else if (isMutating(kind) && kind !== 'tab_close') {
    const host = sensitiveHost(req.pageUrl, lists) ?? (frameUrl ? sensitiveHost(frameUrl, lists) : null);
    if (host) fire('sensitive-domain', 'confirm', 'high', `${host} ${SENSITIVE_WHAT}; every change there needs your OK.`);
  }
  if (webLink && findMatch(webLink, lists.sensitive)) {
    fire('sensitive-domain', 'confirm', 'medium', `The link leads to ${webLink.host}, which ${SENSITIVE_WHAT}.`);
  }

  // ── high-risk-click (confirm) — a click, or Enter/Space on a focused control
  if (clickLike && el) {
    const why = highRiskReason(el);
    if (why) {
      const what = why === 'form submit' ? 'submits a form' : `looks like it will ${why}`;
      const how = kind === 'click' ? 'Clicking' : `Pressing ${clean(req.key, 20)} on`;
      fire('high-risk-click', 'confirm', 'high', `${how} ${label(el)} ${what}.`);
    }
  }

  // ── high-risk-key (confirm)
  if ((isPress || kind === 'type') && req.key && keyRisk(req.key) === 'high') {
    fire('high-risk-key', 'confirm', 'high', `${clean(req.key, 30)} usually sends or submits.`);
  }
  if (enterInto) {
    if (isSingleLineField(enterInto) && !isSearchField(enterInto)) {
      fire('high-risk-key', 'confirm', 'high', `Pressing Enter in ${label(enterInto)} usually submits the form (it may send, save or delete something).`);
    } else if (isMultilineEditor(enterInto)) {
      fire('high-risk-key', 'confirm', 'high', 'Pressing Enter in a message editor usually sends the message.');
    }
  }

  // ── destructive-shortcut (confirm): app shortcuts when no text field has focus
  if (isPress && req.key && (focus === 'none' || (focus === 'element' && !!el && !isTextEntry(el)))) {
    const why = destructiveShortcut(req.key);
    if (why) fire('destructive-shortcut', 'confirm', 'high', `No text field has focus, and ${why}.`);
  }

  // ── paste (confirm): the page's paste handler reads the clipboard, whatever has focus, tainted or not
  if (isPress && req.key && isPasteKey(req.key)) {
    const dest = hostOf(frameUrl ?? req.pageUrl) || 'this page';
    fire(
      'paste',
      'confirm',
      'high',
      `Pasting gives the clipboard contents to ${dest} (the clipboard may hold a password or other private data copied earlier).`,
    );
  }

  // ── upload (confirm)
  if (kind === 'upload') {
    const n = req.files?.length ?? 0;
    fire('upload', 'confirm', 'high', `Uploads ${n} local file${n === 1 ? '' : 's'} to the website.`);
  }

  // ── dialog-accept (confirm)
  if (kind === 'dialog' && req.dialog?.accept && req.dialog.type.toLowerCase() !== 'alert') {
    fire('dialog-accept', 'confirm', 'high', `Accepting a ${clean(req.dialog.type, 20) || 'page'} dialog may commit an action.`);
  }

  // ── cross-site-typing / cross-site-navigate (confirm) — see egress.ts for the rule and its trade-off
  const reads = state.privateReads;
  if (safety.confirmCrossSiteTyping && reads.length > 0) {
    // Any text-producing key counts, whatever has focus: with a button or the body focused the characters still
    // reach the page's key listeners (review #2 finding 4). Pastes into a text field too.
    const entersText =
      ((kind === 'type' || kind === 'select') && (req.text ?? '') !== '') ||
      (isPress && !!req.key && isTextProducingKey(req.key)) ||
      (isPress && !!el && isTextEntry(el) && !!req.key && isTextInsertingKey(req.key)) ||
      (kind === 'dialog' && !!req.dialog?.accept && (req.text ?? '') !== '');
    if (entersText) {
      const destUrl = kind === 'dialog' ? req.pageUrl : (frameUrl ?? req.pageUrl);
      const others = taintFromOtherScopes(reads, taintScope(destUrl));
      if (others.length > 0) {
        const destHost = hostOf(destUrl) || 'a non-web page';
        fire(
          'cross-site-typing',
          'confirm',
          'high',
          `Claude read private content on ${describeSources(others)} earlier in this session and is now entering text on ${destHost} — the usual shape of data exfiltration.`,
        );
      }
    }

    const untrusted = untrustedInteractionHosts(req, reads, state.trustedHosts ?? []);
    if (untrusted.length > 0) {
      const where = untrusted.join(' and ');
      fire(
        'first-interaction',
        'confirm',
        'medium',
        `Claude read private content on ${describeSources(reads)} earlier in this session. Scripts on ${where} see every click, key, hover and scroll, so interacting there can leak what was read. Approving lets Claude interact with ${where} for the rest of this session.`,
      );
    }

    const firstDest = untrustedDestinationHosts(req, reads, state.trustedHosts ?? [], lists.openEndpoints);
    if (firstDest.length > 0) {
      const where = firstDest.join(' and ');
      fire(
        'first-destination',
        'confirm',
        'medium',
        `Claude read private content on ${describeSources(reads)} earlier in this session, and this goes to ${where} with a path or sub-domain that could carry a short piece of it (a code, a name). Approving lets Claude visit ${where} for the rest of this session.`,
      );
    }

    for (const c of outboundCandidates(req)) {
      const o = assessOutbound(c.url, lists.openEndpoints, c.form);
      if (!o) continue;
      const host = o.url.host;
      if (o.openEndpoint) {
        fire(
          'cross-site-navigate',
          'confirm',
          'high',
          `Claude read private content on ${describeSources(reads)} earlier in this session, and this ${c.what} goes to ${host} — a redirect / form / data-collection endpoint that forwards whatever the URL carries.`,
        );
        continue;
      }
      const others = taintFromOtherHosts(reads, host);
      if (o.dataReason && others.length > 0) {
        fire(
          'cross-site-navigate',
          'confirm',
          'high',
          `Claude read private content on ${describeSources(others)} earlier in this session, and this ${c.what} to ${host} can carry data: ${o.dataReason}.`,
        );
      }
    }
  }

  // ── reduce
  let verdict: PolicyDecision['verdict'] = 'allow';
  let risk = baseRisk(req);
  for (const f of fired.values()) {
    risk = maxRisk(risk, f.risk);
    if (f.verdict === 'deny') verdict = 'deny';
    else if (verdict === 'allow') verdict = 'confirm';
  }
  const rules = [...fired.keys()];
  const reason =
    verdict === 'allow'
      ? 'No safety rule applies.'
      : [...fired.values()]
          .filter((f) => f.verdict === verdict)
          .flatMap((f) => f.messages)
          .join(' ');
  return { verdict, risk, rules, reason };
}
