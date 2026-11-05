/**
 * Deterministic element / action classification. Pure functions over live page facts
 * (ElementInfo is re-resolved from the DOM right before acting), never over model text.
 */
import type { ActionKind, ActionRequest, ElementInfo, Risk } from '../types.js';
import {
  autocompleteIsSecret,
  hintIsSecret,
  PAYMENT_FRAME_DOMAINS,
  SECRET_TEXT_RE,
  textLooksSecret,
  wordsOf,
} from '../lib/secret-fields.js';
import { compilePatterns, hostMatches, parseUrl } from './domains.js';
import { clean, stripUnsafe } from './text.js';

// ───────────────────────────── Secret fields (one definition: src/lib/secret-fields.ts) ─────────────────────────────

export { SECRET_TEXT_RE, wordsOf };

const PAYMENT_FRAMES = compilePatterns(PAYMENT_FRAME_DOMAINS);

/** True when the frame the element lives in belongs to a known payment processor (shared list, hostMatches grammar). */
export function isPaymentFrame(frameUrl: string): boolean {
  const u = parseUrl(frameUrl);
  if (!u || !u.isWeb) return false;
  return PAYMENT_FRAMES.some((p) => hostMatches(u.host, p));
}

/** Which secret signal fired (for messages/tests), or null. */
export function secretFieldReason(el: ElementInfo): string | null {
  // Page-computed evidence (CSS-masked, OTP digit group, became a password field on focus…): any non-empty value.
  if (hintIsSecret(el.secretHint)) return `page evidence: ${clean(el.secretHint, 40) || 'secret'}`;
  if ((el.inputType ?? '').toLowerCase() === 'password') return 'type=password';
  if (autocompleteIsSecret(el.autocomplete)) return `autocomplete=${clean(el.autocomplete, 40)}`;
  const texts: Array<[string, string | null]> = [
    ['name', el.nameAttr],
    ['id', el.idAttr],
    ['label', el.labelText],
    ['placeholder', el.placeholder],
    ['aria-label', el.ariaLabel],
    ['accessible name', el.name],
  ];
  for (const [what, v] of texts) {
    if (textLooksSecret(v)) return `${what} "${clean(v, 40)}"`;
  }
  if (isPaymentFrame(el.frameUrl)) return 'payment-processor frame';
  return null;
}

/** Password / one-time code / payment / bank / national-id field: never typed into by Stephen. */
export function isSecretField(el: ElementInfo): boolean {
  return secretFieldReason(el) !== null;
}

// ───────────────────────────── High-risk controls ─────────────────────────────

/**
 * Words on a control that mean "this commits something": send, delete, pay, publish, share… in
 * English, French, Spanish, Portuguese, Italian, German, Dutch and Russian, plus Gmail/Outlook
 * actions that are destructive or create persistence (filters, spam, block, mute, empty trash).
 * Matched as whole words with Unicode-aware boundaries: "Send now" matches, "Sender name",
 * "Sent", "Postal code" and "Deleted items" do not.
 */
export const HIGH_RISK_WORDS: readonly string[] = [
  // English
  'send', 'send now', 'resend', 'submit', 'pay', 'pay now', 'buy', 'buy now', 'purchase', 'order', 'place order',
  'checkout', 'check out', 'confirm', 'delete', 'delete forever', 'delete permanently', 'remove', 'trash',
  'move to trash', 'empty trash', 'empty bin', 'empty recycle bin', 'discard', 'discard draft', 'discard drafts',
  'archive all', 'unsubscribe', 'post', 'repost', 'retweet', 'tweet', 'publish', 'share', 'invite', 'transfer',
  'withdraw', 'deposit', 'authorize', 'authorise', 'allow', 'accept', 'approve', 'grant', 'sign', 'sign in',
  'sign up', 'subscribe', 'reply all', 'forward', 'save payment', 'donate', 'comment', 'merge', 'revoke', 'erase',
  'wipe', 'deactivate', 'uninstall', 'create filter', 'mark as spam', 'report spam', 'report phishing',
  'block', 'mute',
  // French
  'envoyer', 'supprimer', 'effacer', 'payer', 'acheter', 'commander', 'publier', 'partager', 'transférer',
  'confirmer', 'valider', 'signaler comme spam', 'bloquer', 'vider la corbeille', 'autoriser', 'accepter',
  'transférer', 'répondre à tous',
  // Spanish
  'enviar', 'eliminar', 'borrar', 'pagar', 'comprar', 'publicar', 'compartir', 'transferir', 'confirmar',
  'marcar como spam', 'bloquear', 'vaciar papelera', 'autorizar', 'aceptar', 'responder a todos', 'reenviar',
  // Portuguese
  'excluir', 'apagar', 'compartilhar', 'partilhar', 'confirmar', 'denunciar spam', 'esvaziar lixeira',
  'encaminhar',
  // Italian
  'invia', 'inviare', 'elimina', 'eliminare', 'cancella', 'paga', 'pagare', 'acquista', 'compra', 'ordina',
  'pubblica', 'condividi', 'trasferisci', 'conferma', 'segnala come spam', 'blocca', 'svuota cestino', 'inoltra',
  'autorizza', 'accetta',
  // German
  'senden', 'absenden', 'versenden', 'löschen', 'entfernen', 'bezahlen', 'zahlen', 'kaufen', 'jetzt kaufen',
  'bestellen', 'zahlungspflichtig bestellen', 'veröffentlichen', 'teilen', 'posten', 'überweisen', 'bestätigen',
  'als spam melden', 'blockieren', 'papierkorb leeren', 'weiterleiten', 'autorisieren', 'akzeptieren', 'zulassen',
  // Dutch
  'verzenden', 'versturen', 'verwijderen', 'betalen', 'kopen', 'bestellen', 'delen', 'publiceren', 'bevestigen',
  'doorsturen',
  // Russian
  'отправить', 'удалить', 'оплатить', 'купить', 'опубликовать', 'поделиться', 'подтвердить', 'переслать',
];

/** CJK verbs are matched as substrings (no word spaces): send, delete, pay, purchase, publish. */
export const HIGH_RISK_CJK: readonly string[] = [
  '送信', '削除', '購入', '支払', '注文', '投稿', '公開', '共有', '转发', '发送', '删除', '支付', '购买', '发布', '分享',
  '傳送', '刪除', '購買', '전송', '보내기', '삭제', '결제', '구매', '게시', '공유',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const HIGH_RISK_TEXT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...new Set(HIGH_RISK_WORDS)]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRe(w).replace(/ /g, '\\s+'))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);
const HIGH_RISK_CJK_RE = new RegExp(HIGH_RISK_CJK.map(escapeRe).join('|'), 'u');

/** Matched high-risk word (for prompts/tests), or null. */
export function highRiskReason(el: ElementInfo): string | null {
  for (const v of [el.name, el.text, el.ariaLabel]) {
    if (!v) continue;
    const flat = stripUnsafe(v);
    const m = HIGH_RISK_TEXT_RE.exec(flat) ?? HIGH_RISK_CJK_RE.exec(flat);
    if (m) return m[0].toLowerCase().replace(/\s+/g, ' ');
  }
  if (el.isSubmit) return 'form submit';
  return null;
}

export function isHighRiskControl(el: ElementInfo): boolean {
  return highRiskReason(el) !== null;
}

/** contenteditable / textarea: Enter there usually sends (chat composers) rather than adding a line. */
export function isMultilineEditor(el: ElementInfo): boolean {
  const tag = el.tag.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input' || tag === 'select') return false;
  return el.isEditable;
}

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden',
]);

/** An editable single-line field (text-like <input>): Enter there submits its form or triggers the app's action. */
export function isSingleLineField(el: ElementInfo): boolean {
  if (el.tag.toLowerCase() !== 'input' || !el.isEditable) return false;
  return !NON_TEXT_INPUT_TYPES.has((el.inputType ?? 'text').toLowerCase());
}

const SEARCH_WORD_RE = /(?<![\p{L}\p{N}])(?:search|find|filter|recherche[rz]?|buscar|busca|suche|suchen|cerca|pesquisar|zoeken|поиск|検索|搜索)(?![\p{L}\p{N}])/iu;

/** A search box (Enter runs a search rather than committing anything). */
export function isSearchField(el: ElementInfo): boolean {
  if ((el.inputType ?? '').toLowerCase() === 'search' || el.role === 'searchbox') return true;
  return [el.name, el.placeholder, el.ariaLabel, el.labelText].some((v) => !!v && SEARCH_WORD_RE.test(v));
}

/** A field that takes typed text: single-line <input> or textarea/contenteditable. */
export function isTextEntry(el: ElementInfo): boolean {
  return isSingleLineField(el) || isMultilineEditor(el);
}

/** Element that a click / Enter / Space activates (buttons, links, checkboxes…): not a text field or <select>. */
export function isActivatable(el: ElementInfo): boolean {
  return !isTextEntry(el) && el.tag.toLowerCase() !== 'select';
}

// ───────────────────────────── Keys ─────────────────────────────

const MOD_ALIASES: Record<string, string> = {
  meta: 'meta', cmd: 'meta', command: 'meta', os: 'meta', super: 'meta', metaleft: 'meta', metaright: 'meta',
  control: 'control', ctrl: 'control', controlormeta: 'control', controlleft: 'control', controlright: 'control',
  alt: 'alt', option: 'alt', altleft: 'alt', altright: 'alt', altgraph: 'alt',
  shift: 'shift', shiftleft: 'shift', shiftright: 'shift',
};

export interface ParsedKey {
  modifiers: Set<string>;
  key: string;
}

/** 'Meta+Enter' → {modifiers:{meta}, key:'Enter'}. A bare '+' key is supported ('Shift++'). */
export function parseKey(combo: string): ParsedKey {
  if (combo.length > 0 && combo.trim() === '') return { modifiers: new Set(), key: ' ' }; // the space bar
  const lead = combo.replace(/^\s+/, '');
  const s = /\+\s+$/.test(lead) ? lead.replace(/\s+$/, ' ') : lead.trim(); // 'Shift+ ' = Shift+Space
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const modifiers = new Set<string>();
  let key = '';
  parts.forEach((p, i) => {
    const m = MOD_ALIASES[p.trim().toLowerCase()];
    if (m && i < parts.length - 1) modifiers.add(m);
    else if (p.trim() === '' && i === parts.length - 1) key = p.length > 0 ? ' ' : '+';
    else key = p.trim();
  });
  return { modifiers, key };
}

/** KeyboardEvent.code names (puppeteer KeyInput) that type a character, → the unshifted character. */
const CODE_TEXT: Record<string, string> = {
  space: ' ', semicolon: ';', equal: '=', comma: ',', minus: '-', period: '.', slash: '/', backquote: '`',
  bracketleft: '[', backslash: '\\', bracketright: ']', quote: "'", intlbackslash: '\\', intlro: '/', intlyen: '¥',
  numpadmultiply: '*', numpadadd: '+', numpadsubtract: '-', numpaddivide: '/', numpaddecimal: '.',
  numpadequal: '=', numpadcomma: ',', numpadparenleft: '(', numpadparenright: ')', spacebar: ' ',
};
/** US-layout Shift mapping, so 'Shift+3' / 'Shift+Digit3' are recognized as '#'. */
const SHIFTED: Record<string, string> = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_',
  '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
};

/**
 * The character a key would insert, ignoring Control/Meta (callers decide about those), or null for
 * keys that never insert text (Enter, Tab, arrows, F-keys…). Covers single characters ('a', '#', ' '),
 * KeyA…KeyZ, Digit0–9, Numpad0–9 (NumLock on), Space and the punctuation / numpad code names.
 */
export function producedChar(p: ParsedKey): string | null {
  const k = p.key;
  let ch: string | null = null;
  if ([...k].length === 1) ch = k;
  else if (/^key[a-z]$/i.test(k)) ch = k.slice(3).toLowerCase();
  else if (/^(?:digit|numpad)[0-9]$/i.test(k)) ch = k.slice(-1);
  else ch = CODE_TEXT[k.toLowerCase()] ?? null;
  if (ch === null || /[\u0000-\u001f\u007f]/.test(ch)) return null;
  if (p.modifiers.has('shift')) ch = SHIFTED[ch] ?? ch.toUpperCase();
  return ch;
}

export function isEnterKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === 'enter' || k === 'numpadenter' || k === 'return' || k === '\r' || k === '\n';
}

/** Meta/Ctrl held (shortcuts, not text). */
function hasCommandMod(p: ParsedKey): boolean {
  return p.modifiers.has('meta') || p.modifiers.has('control');
}

/** Meta/Ctrl+V, Shift+Insert, the Paste key: inserts the clipboard. */
export function isPasteKey(combo: string): boolean {
  const p = parseKey(combo);
  const k = p.key.toLowerCase();
  if (k === 'paste') return true;
  if (hasCommandMod(p) && (k === 'v' || k === 'keyv')) return true;
  return p.modifiers.has('shift') && k === 'insert';
}

/**
 * A key press that produces text in a focused field: any character key without Control/Meta
 * (Alt/Option counts as text: on macOS it types characters like "å").
 */
export function isTextProducingKey(combo: string): boolean {
  const p = parseKey(combo);
  return !hasCommandMod(p) && producedChar(p) !== null;
}

/** Text-producing OR paste: the press inserts text into whatever is focused. */
export function isTextInsertingKey(combo: string): boolean {
  return isTextProducingKey(combo) || isPasteKey(combo);
}

/** Backspace / Delete (with any modifiers). */
export function isDeleteKey(combo: string): boolean {
  const k = parseKey(combo).key.toLowerCase();
  return k === 'backspace' || k === 'delete' || k === 'del';
}

export function isTabKey(combo: string): boolean {
  return parseKey(combo).key.toLowerCase() === 'tab';
}

/** Keys that must not be sent when we cannot tell what has focus: they type, submit, move focus or delete. */
export function needsKnownFocus(combo: string): boolean {
  return isTextInsertingKey(combo) || isEnterKey(parseKey(combo).key) || isTabKey(combo) || isDeleteKey(combo);
}

/**
 * Single-key web-app shortcuts that destroy or report something when no text field has focus:
 *   Delete / Backspace (+any modifier) — delete the selected mail/file (Gmail, Outlook, Drive, OneDrive, Dropbox)
 *   '#' (Shift+3) — Gmail delete; '!' (Shift+1) — Gmail report spam.
 * Reversible shortcuts (e archive, Shift+I mark read, j/k, arrows, PageDown, Home/End, Escape, Tab) are not listed.
 * Returns a plain-words description, or null.
 */
export function destructiveShortcut(combo: string): string | null {
  const p = parseKey(combo);
  if (isDeleteKey(combo)) return `${clean(combo, 30)} deletes the selected item in many web apps (mail, files)`;
  if (hasCommandMod(p)) return null;
  const ch = producedChar(p);
  if (ch === '#') return '"#" deletes the selected conversation in Gmail';
  if (ch === '!') return '"!" reports the selected conversation as spam in Gmail';
  return null;
}

/** Meta/Ctrl+Enter (send/submit in most mail & chat apps) → high; everything else → low. */
export function keyRisk(combo: string): Risk {
  const p = parseKey(combo);
  if (isEnterKey(p.key) && hasCommandMod(p)) return 'high';
  if (destructiveShortcut(combo)) return 'medium';
  return 'low';
}

// ───────────────────────────── Action risk ─────────────────────────────

const NON_MUTATING: ReadonlySet<ActionKind> = new Set<ActionKind>(['read', 'scroll', 'hover']);

/** Everything except read/scroll/hover: the sensitive-page rule asks before these. */
export function isMutating(kind: ActionKind): boolean {
  return !NON_MUTATING.has(kind);
}

/**
 * Counted by the rate limit: every mutating action AND hover/scroll (review #2 finding 6 — page scripts see
 * hovers and scroll offsets, so they are a channel too). Only reads are free.
 */
export function countsTowardRateLimit(kind: ActionKind): boolean {
  return kind !== 'read';
}

/**
 * Actions page scripts can observe on the page they happen on (review #2 finding 6: after a private read, the
 * first of these on a host that is neither tainted nor approved asks the user). Navigation counts only when it
 * stays on the page's own host (the cross-host case is the outbound-URL rule).
 */
const INTERACTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'click', 'type', 'select', 'press', 'hover', 'scroll', 'upload', 'dialog', 'navigate',
]);
export function isInteraction(kind: ActionKind): boolean {
  return INTERACTION_KINDS.has(kind);
}

const BASE_RISK: Record<ActionKind, Risk> = {
  read: 'low',
  scroll: 'low',
  hover: 'low',
  tab_close: 'low',
  tab_open: 'low',
  navigate: 'medium',
  click: 'medium',
  type: 'medium',
  select: 'medium',
  press: 'low',
  upload: 'high',
  dialog: 'low',
  evaluate: 'high',
};

/** Risk before any policy rule fires. */
export function baseRisk(req: ActionRequest): Risk {
  if (req.kind === 'press' && req.key) return maxRisk(BASE_RISK.press, keyRisk(req.key));
  if (req.kind === 'dialog' && req.dialog?.accept && req.dialog.type !== 'alert') return 'medium';
  return BASE_RISK[req.kind];
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
