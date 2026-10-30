/**
 * Human confirmation. Prompts are built from live request facts: computed facts first (origin, action,
 * element role + ref, destination URLs, the exact text/keys/files/code), then the model's `intent` as
 * "Claude says (unverified)", then everything the page supplied under "Page says (unverified)".
 */
import { execFile } from 'node:child_process';
import type { ActionRequest, ConfirmOutcome, ConfirmPrompt, Confirmer, PolicyDecision, ResolvedConfig } from '../types.js';
import { isPasteKey, isSecretField } from './classify.js';
import { parseUrl } from './domains.js';
import { charLength, clean, hasHiddenChars, stripUnsafe, truncate, visible, visibleCode } from './text.js';

export type ElicitResult = 'accept' | 'decline' | 'cancel';
export type ElicitLike = (prompt: ConfirmPrompt) => Promise<ElicitResult>;

// ───────────────────────────── Redaction ─────────────────────────────

/** '[23 chars] "Hello Mar…"' (≤12 chars shown) — secrets become '[redacted, 12 chars]'. */
export function redactValue(value: string, secret: boolean): string {
  const n = charLength(value);
  const unit = n === 1 ? 'char' : 'chars';
  if (secret) return `[redacted, ${n} ${unit}]`;
  const flat = stripUnsafe(value);
  const preview = n <= 12 ? flat : `${[...flat].slice(0, 9).join('')}…`;
  return `[${n} ${unit}] "${preview}"`;
}

// ───────────────────────────── Prompt ─────────────────────────────
//
// A human must be able to decide from the dialog alone, and the page must not be able to dress itself up as
// Stephen (review #2 finding 7). Layout:
//   title:  evil.com — Stephen wants to click a button                    ← computed only, no page text
//   Site: https://evil.com (Chrome, tab c1)                              ┐
//   Action: click · button c1:e2                                         │ computed facts: origin, action,
//   Link goes to / Form is sent to / Destination / Text to type / Key …  │ role, URLs, the exact text/keys/
//   Why you are asked: <plain-words rules>                               ┘ files/code Claude asked for
//   Claude says (unverified): «intent»
//   Page says (unverified):                                              ← ALL page-supplied text, last
//     Element label: «…»   Form contents that would be sent: «…»   Dialog message: «…»
// Every free-text value (page labels, form contents, dialog messages, typed text, intent, file names) is
// quoted with « » after a fixed prefix on its own line: line breaks collapsed, " « » escaped, control / bidi /
// zero-width characters shown as \u{…} escapes, each field capped, and the phrases "Why you are asked",
// "Claude says" and "Page says" bracketed — so no page or model text can start a line or imitate a header.
// Wording: the dialog is Stephen's, so Stephen is the actor ("Stephen wants to …"); the model's own words stay
// labelled "Claude says (unverified)" (the AI behind Stephen is Claude) and page text "Page says (unverified)".

const BROWSER_LABEL: Record<string, string> = { chrome: 'Chrome', zen: 'Zen' };
/** Typed text shown to the human before it is entered (cross-site typing etc.). */
export const PROMPT_TEXT_MAX = 500;
/** Destination URLs shown in full up to this many characters. */
export const PROMPT_URL_MAX = 500;
/** Caps for page-supplied fields in the "Page says (unverified)" section. */
export const PAGE_LABEL_MAX = 80;
export const PAGE_FORM_MAX = 400;
export const PAGE_DIALOG_MAX = 200;
export const INTENT_MAX = 200;

const HEADER_WORDS_RE = /(why\s+you\s+are\s+asked|claude\s+says|page\s+says)/gi;

/**
 * «quoted» single-line rendering of untrusted text (page or model): newlines collapsed to spaces, " « »
 * escaped, hidden characters shown as escapes, header phrases bracketed, capped at `max` code points.
 */
export function quoteUntrusted(s: string | null | undefined, max: number): string {
  const flat = (s ?? '').replace(/[\r\n\u2028\u2029\u0085]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const cut = truncate(flat, max).replace(/\\/g, '\\\\'); // a literal "\u{202E}" must not pass for an escape
  const esc = visible(cut)
    .replace(/"/g, '\\"')
    .replace(/«/g, '\\«')
    .replace(/»/g, '\\»')
    .replace(HEADER_WORDS_RE, '[$1]');
  return `«${esc}»`;
}

function displayHost(url: string | undefined): string {
  if (!url) return 'an unknown page';
  const u = parseUrl(url);
  if (!u) return 'an unknown page';
  if (u.host) return u.host;
  return clean(`${u.protocol}${u.isWeb ? '' : u.pathname.slice(0, 20)}`, 40);
}

/** Origin we computed ('https://mail.google.com'), or a short non-web description. */
function displayOrigin(url: string | undefined): string {
  if (!url) return '(unknown)';
  try {
    const u = new URL(url);
    if (u.origin !== 'null') return u.origin;
    return clean(`${u.protocol}${u.pathname}`, 60);
  } catch {
    return '(unparsable URL)';
  }
}

/** 'button z1:e4' — computed role + ref, never the page's label. */
function elementRef(req: ActionRequest): string {
  const el = req.element;
  if (!el) return 'an element';
  const role = (el.role || el.tag || 'element').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'element';
  const ref = el.ref.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 40);
  return ref ? `${role} ${ref}` : role;
}

/** 'a button' / 'a text box' — computed role only, for titles. */
function roleWords(req: ActionRequest): string {
  const r = (req.element?.role || req.element?.tag || 'element').toLowerCase().replace(/[^a-z0-9 -]/g, '').slice(0, 30) || 'element';
  return `${/^[aeiou]/.test(r) ? 'an' : 'a'} ${r}`;
}

/**
 * Short description of the action for messages returned to the MODEL, e.g. 'click button z1:e4 on
 * mail.google.com'. Contains no page-supplied text (review #2 finding 8): elements are named by role + ref.
 */
export function describeAction(req: ActionRequest): string {
  const where = displayHost(req.pageUrl);
  switch (req.kind) {
    case 'click':
      return `click ${elementRef(req)} on ${where}`;
    case 'type':
      return `type into ${elementRef(req)} on ${where}${req.key ? ` and press ${clean(req.key, 20)}` : ''}`;
    case 'select':
      return `choose an option in ${elementRef(req)} on ${where}`;
    case 'press':
      return req.key && isPasteKey(req.key)
        ? `paste the clipboard (${clean(req.key, 30)}) into ${where}`
        : `press ${clean(req.key, 30) || 'a key'} on ${where}`;
    case 'upload': {
      const n = req.files?.length ?? 0;
      return `upload ${n} file${n === 1 ? '' : 's'} on ${where}`;
    }
    case 'navigate':
    case 'tab_open':
      return req.targetUrl ? `open ${displayHost(req.targetUrl)}` : `navigate on ${where}`;
    case 'dialog':
      return `${req.dialog?.accept === false ? 'dismiss' : 'accept'} a ${clean(req.dialog?.type, 20) || 'page'} dialog on ${where}`;
    case 'evaluate':
      return `run JavaScript on ${where}`;
    case 'tab_close':
      return `close a tab on ${where}`;
    case 'hover':
      return `hover ${elementRef(req)} on ${where}`;
    case 'scroll':
      return `scroll on ${where}`;
    case 'read':
      return `read ${where}`;
  }
}

/** Title verb phrase for the human, computed facts only: 'click a button', 'paste your clipboard into this page'. */
function titleAction(req: ActionRequest): string {
  switch (req.kind) {
    case 'click':
      return `click ${roleWords(req)}`;
    case 'type':
      return `type into ${roleWords(req)}${req.key ? ` and press ${clean(req.key, 20)}` : ''}`;
    case 'select':
      return `choose an option in ${roleWords(req)}`;
    case 'press':
      return req.key && isPasteKey(req.key) ? 'paste your clipboard into this page' : `press ${clean(req.key, 30) || 'a key'}`;
    case 'hover':
      return `hover ${roleWords(req)}`;
    case 'navigate':
    case 'tab_open':
      return req.targetUrl ? `open ${displayHost(req.targetUrl)}` : 'navigate';
    default: {
      const d = describeAction(req);
      const i = d.lastIndexOf(' on ');
      return i > 0 ? d.slice(0, i) : d;
    }
  }
}

/** Extra facts the gate passes for the first-interaction rule. */
export interface PromptContext {
  /** Hosts approval will trust for the rest of the session. */
  trustHosts?: string[];
  /** 'mail.google.com' / 'mail.google.com and 2 other private sites'. */
  readSources?: string;
}

/** Capabilities of JavaScript code worth a warning, in plain words. Detection is a hint; the full code is always shown. */
const CODE_FLAGS: Array<[RegExp, string]> = [
  [/\bfetch\b/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bcookie\b/, 'document.cookie'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/, 'storage'],
  [/\bimport\s*\(/, 'import()'],
  [/\beval\b/, 'eval'],
  [/\bFunction\s*\(|\bconstructor\b/, 'Function()'],
  [/\blocation\b\s*(?:=(?!=)|\.\s*(?:href|assign|replace)\b|\[)/, 'location='],
  [/\bopen\s*\(/, 'window.open'],
  [/\bpostMessage\b/, 'postMessage'],
  [/\bImage\s*\(|\.src\s*=(?!=)|\bsetAttribute\s*\(\s*['"`](?:src|href|action)/, 'loads a URL (src/href)'],
  [/\.submit\s*\(|\brequestSubmit\b/, 'form submit'],
  [/\.click\s*\(|\bdispatchEvent\b/, 'clicks elements'],
  [/\bcredentials\b|\bpassword\b/i, 'credentials'],
  [/\batob\b|\bfromCharCode\b|\bunescape\b|\\x[0-9a-f]{2}|\\u[0-9a-f{]|\[\s*['"`][^\]]*['"`]\s*\+/i, 'obfuscation'],
];

/** Plain-words list of dangerous capabilities found in `code` (hidden characters included). */
export function codeFlags(code: string): string[] {
  const out = CODE_FLAGS.filter(([re]) => re.test(code)).map(([, name]) => name);
  if (hasHiddenChars(code)) out.push('hidden/bidi characters');
  return out;
}

function showUrl(url: string): string {
  const v = visible(url);
  const n = charLength(v);
  return n <= PROMPT_URL_MAX ? v : `${[...v].slice(0, PROMPT_URL_MAX).join('')}… (+${n - PROMPT_URL_MAX} more chars not shown)`;
}

function showText(text: string, secret: boolean): string {
  const n = charLength(text);
  if (secret) return `[redacted, ${n} ${n === 1 ? 'char' : 'chars'}]`;
  // Line breaks are shown as ⏎ (visible), so the text stays on one line; quotes and header phrases escaped.
  const v = visible(text);
  const more = charLength(v) > PROMPT_TEXT_MAX ? ` (+${charLength(v) - PROMPT_TEXT_MAX} more chars not shown)` : '';
  const shown = [...v].slice(0, PROMPT_TEXT_MAX).join('');
  const esc = shown
    .replace(/"/g, '\\"')
    .replace(/«/g, '\\«')
    .replace(/»/g, '\\»')
    .replace(HEADER_WORDS_RE, '[$1]');
  return `(${n} ${n === 1 ? 'char' : 'chars'}) «${esc}${more ? '…' : ''}»${more}`;
}

export function buildPrompt(req: ActionRequest, decision: PolicyDecision, ctx: PromptContext = {}): ConfirmPrompt {
  const where = displayHost(req.kind === 'tab_open' && req.targetUrl ? req.targetUrl : req.pageUrl);
  const flags = req.kind === 'evaluate' && req.text ? codeFlags(req.text) : [];
  const trust = ctx.trustHosts && ctx.trustHosts.length > 0 ? ctx.trustHosts.join(' and ') : null;
  const onlyTrust = !!trust && decision.rules.every((r) => r === 'first-interaction' || r === 'first-destination');
  let title: string;
  if (onlyTrust) {
    const verb = decision.rules.includes('first-interaction') ? 'interact with' : 'visit';
    title = `Stephen has read private content (${ctx.readSources ?? 'a private site'}). Allow it to ${verb} ${trust} for the rest of this session?`;
  } else {
    const on = req.kind === 'navigate' || req.kind === 'tab_open' ? displayHost(req.pageUrl) : where;
    title = `${on} — Stephen wants to ${titleAction(req)}`;
    if (flags.length > 0) title += ` (uses ${flags.join(', ')})`;
  }
  title = clean(title, 200);

  const lines: string[] = [];
  const page: string[] = [];
  lines.push(`Site: ${displayOrigin(req.pageUrl)} (${BROWSER_LABEL[req.browser] ?? clean(req.browser, 20)}, tab ${clean(req.tab, 12)})`);
  lines.push(`Action: ${describeAction(req)}`);
  if (onlyTrust && trust) {
    lines.push(
      `If you allow: pages on ${trust} will see every click, key press, hover and scroll Stephen makes there, and Stephen can open short links on ${trust} without asking again (links carrying data still ask).`,
    );
  }
  const el = req.element;
  const secret = el ? isSecretField(el) : false;
  if (el && (req.kind !== 'press' || req.focus === 'element')) {
    if (req.kind === 'press') lines.push(`Focused element: ${elementRef(req)}`);
    if (el.frameUrl && el.frameUrl !== req.pageUrl) lines.push(`Inside frame: ${displayOrigin(el.frameUrl)}`);
    if (el.href) lines.push(`Link goes to: ${showUrl(el.href)}`);
    if (el.isSubmit && el.formAction) lines.push(`Form is sent to: ${showUrl(el.formAction)}`);
    const name = el.name || el.text || el.ariaLabel || el.placeholder || el.labelText;
    if (name) page.push(`Element label: ${quoteUntrusted(name, PAGE_LABEL_MAX)}`);
    if (el.formSummary && (req.kind === 'click' || req.kind === 'press' || req.kind === 'type')) {
      page.push(`Form contents that would be sent: ${quoteUntrusted(el.formSummary, PAGE_FORM_MAX)}`);
    }
  } else if (req.kind === 'press') {
    lines.push(req.focus === 'none' ? 'Focused element: none (page body)' : 'Focused element: unknown');
  }
  if (req.targetUrl && (req.kind === 'navigate' || req.kind === 'tab_open')) {
    lines.push(`Destination (full URL): ${showUrl(req.targetUrl)}`);
  }
  if (req.kind === 'evaluate' && req.text !== undefined) {
    if (flags.length > 0) lines.push(`Warning: the code uses ${flags.join(', ')}.`);
    lines.push(`Code (all ${req.text.length} chars, each line marked │):`);
    for (const line of visibleCode(req.text).split('\n')) lines.push(`│ ${line}`);
  } else if (req.kind === 'dialog') {
    if (req.dialog) {
      lines.push(`Dialog type: ${clean(req.dialog.type, 20) || 'unknown'}`);
      page.push(`Dialog message: ${quoteUntrusted(req.dialog.message, PAGE_DIALOG_MAX)}`);
    }
    if (req.text !== undefined && req.dialog?.accept !== false) lines.push(`Text Stephen will enter: ${showText(req.text, false)}`);
  } else if (req.kind === 'select' && req.text) {
    lines.push(`Option(s): ${showText(req.text, secret)}`);
  } else if (req.text !== undefined && req.text !== '') {
    lines.push(`Text to type: ${showText(req.text, secret)}${req.kind === 'type' && req.key ? `, then press ${clean(req.key, 20)}` : ''}`);
  }
  if (req.key && req.kind === 'press') {
    lines.push(`Key: ${clean(req.key, 30)}`);
    if (isPasteKey(req.key)) {
      const dest = displayHost(el?.frameUrl && el.frameUrl !== req.pageUrl ? el.frameUrl : req.pageUrl);
      lines.push(`Clipboard: everything on your clipboard will be given to ${dest}.`);
    }
  }
  if (req.files && req.files.length > 0) {
    const shown = req.files.slice(0, 5).map((f) => quoteUntrusted(f, 100));
    const more = req.files.length > 5 ? ` (+${req.files.length - 5} more)` : '';
    lines.push(`Files: ${shown.join(', ')}${more}`);
  }
  lines.push(`Why you are asked: ${clean(decision.reason, 700)}`);
  if (trust && !onlyTrust) lines.push(`Approving also lets Stephen interact with ${trust} for the rest of this session without asking again.`);
  else if (trust) lines.push(`Approving lets Stephen interact with ${trust} for the rest of this session without asking again.`);
  const intent = clean(req.intent, INTENT_MAX);
  lines.push(`Claude says (unverified): ${intent ? quoteUntrusted(intent, INTENT_MAX) : '(no reason given)'}`);
  if (page.length > 0) {
    lines.push('Page says (unverified):');
    for (const l of page) lines.push(`  ${l}`);
  }
  return { title, body: lines.join('\n') };
}

// ───────────────────────────── Confirmers ─────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when killed/timed out. */
  code: number | null;
  /** The program could not be started at all (ENOENT/EACCES). */
  spawnError?: boolean;
}
export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

/** Default exec: child_process.execFile (no shell). Never rejects. */
export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      const spawnError = !!err && typeof err.code === 'string';
      resolve({ stdout: String(stdout), stderr: String(stderr), code, spawnError });
    });
  });

/**
 * Longest body the macOS dialog shows. buildPrompt stays well below it (evaluate code ≤ 2000 chars);
 * a longer body is DECLINED rather than truncated, so the human never approves text they cannot see.
 */
export const DIALOG_BODY_MAX = 4000;

/** argv items never start with '-' (option-parsing hardening on top of '--'). */
function argvSafe(s: string): string {
  return s.startsWith('-') ? `\u2011${s.slice(1)}` : s;
}

/**
 * macOS dialog via osascript. Title and body are passed as argv and read with negative indices,
 * so they are never parsed as AppleScript (and it works whether or not osascript consumes '--').
 */
export class DialogConfirmer implements Confirmer {
  readonly kind = 'dialog';
  private readonly exec: ExecFn;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutSec: number;

  constructor(opts: { timeoutSec: number; platform?: NodeJS.Platform; exec?: ExecFn }) {
    this.exec = opts.exec ?? defaultExec;
    this.platform = opts.platform ?? process.platform;
    const t = Math.floor(opts.timeoutSec);
    this.timeoutSec = Number.isFinite(t) && t >= 1 ? Math.min(t, 3600) : 120;
  }

  /** The exact argv passed to /usr/bin/osascript (exported for tests). */
  argv(prompt: ConfirmPrompt): string[] {
    const title = argvSafe(truncate(prompt.title.replace(/\u0000/g, ''), 200));
    const body = argvSafe(truncate(prompt.body.replace(/\u0000/g, ''), DIALOG_BODY_MAX));
    return [
      '-e', 'on run argv',
      '-e', `display dialog (item -1 of argv) with title (item -2 of argv) buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after ${this.timeoutSec}`,
      '-e', 'end run',
      '--', title, body,
    ];
  }

  async confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome> {
    if (this.platform !== 'darwin') return 'unavailable';
    if (charLength(prompt.body) > DIALOG_BODY_MAX) return 'declined';
    let res: ExecResult;
    try {
      res = await this.exec('/usr/bin/osascript', this.argv(prompt), { timeoutMs: (this.timeoutSec + 15) * 1000 });
    } catch {
      return 'declined';
    }
    if (res.spawnError) return 'unavailable';
    // No GUI session (e.g. over ssh): AppleScript error -1713 "No user interaction allowed".
    if (res.code !== 0 && /-1713|no user interaction allowed/i.test(res.stderr)) return 'unavailable';
    if (res.code !== 0) return 'declined'; // Deny = cancel button → error -128; killed → null
    if (/gave up\s*:\s*true/i.test(res.stdout)) return 'declined';
    return /button returned\s*:\s*Allow\b/.test(res.stdout) ? 'approved' : 'declined';
  }
}

/** MCP elicitation: accept → approved; decline/cancel → declined; transport error → unavailable. */
export class ElicitConfirmer implements Confirmer {
  readonly kind = 'elicit';
  /** @param timeoutMs unanswered for this long → declined (DESIGN: timeout = deny). */
  constructor(
    private readonly elicit: ElicitLike,
    private readonly timeoutMs?: number,
  ) {}

  async confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = this.elicit(prompt).then((r): ConfirmOutcome => (r === 'accept' ? 'approved' : 'declined'));
      if (!this.timeoutMs) return await answer;
      const timeout = new Promise<ConfirmOutcome>((resolve) => {
        timer = setTimeout(() => resolve('declined'), this.timeoutMs);
        timer.unref?.();
      });
      return await Promise.race([answer, timeout]);
    } catch {
      return 'unavailable';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** safety.confirm = 'deny': never ask, always decline. */
export class DenyConfirmer implements Confirmer {
  readonly kind = 'deny';
  async confirm(): Promise<ConfirmOutcome> {
    return 'declined';
  }
}

/** First confirmer whose outcome is not 'unavailable' wins; a throwing confirmer counts as unavailable. */
export class ChainConfirmer implements Confirmer {
  readonly kind = 'chain';
  constructor(readonly confirmers: readonly Confirmer[]) {}

  async confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome> {
    for (const c of this.confirmers) {
      let out: ConfirmOutcome;
      try {
        out = await c.confirm(prompt);
      } catch {
        out = 'unavailable';
      }
      if (out !== 'unavailable') return out;
    }
    return 'unavailable';
  }
}

export interface ConfirmerDeps {
  elicit?: ElicitLike;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
}

/** 'auto' = [elicit if available, dialog]; 'elicit' = [elicit]; 'dialog' = [dialog]; 'deny' = [deny]. */
export function buildConfirmer(safety: Pick<ResolvedConfig['safety'], 'confirm' | 'confirmTimeoutSec'>, deps: ConfirmerDeps = {}): Confirmer {
  const dialog = (): Confirmer =>
    new DialogConfirmer({ timeoutSec: safety.confirmTimeoutSec, platform: deps.platform, exec: deps.exec });
  const elicit = deps.elicit ? [new ElicitConfirmer(deps.elicit, safety.confirmTimeoutSec * 1000)] : [];
  switch (safety.confirm) {
    case 'auto':
      return new ChainConfirmer([...elicit, dialog()]);
    case 'elicit':
      return new ChainConfirmer(elicit);
    case 'dialog':
      return new ChainConfirmer([dialog()]);
    case 'deny':
      return new DenyConfirmer();
  }
}
