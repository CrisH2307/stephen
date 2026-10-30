/**
 * Pure helpers of the page engine (no browser): escaping of page-supplied text, rendering of
 * structured snapshot nodes, snapshot assembly + truncation, text truncation, find ranking,
 * key-combo parsing. Unit-tested in test/page/format.test.ts.
 */
import type { RtCtx, RtNode } from './runtime.js';

// ───────────────────────────── escaping (findings #9, R1) ─────────────────────────────

/**
 * Characters that are invisible on screen but readable by the model, dropped from page text before
 * display (finding #14): C0/C1 controls (except \t \n \r \v \f, which become spaces), soft hyphen,
 * Arabic letter mark, combining grapheme joiner, Hangul fillers, Mongolian vowel separator,
 * zero-width space/joiners and LRM/RLM (U+200B–200F), bidi embeddings/overrides (U+202A–202E),
 * word joiner and invisible operators (U+2060–2064), bidi isolates and deprecated format chars
 * (U+2066–206F), variation selectors (U+FE00–FE0F, U+E0100–E01EF), BOM, interlinear annotation
 * chars (U+FFF9–FFFB) and Unicode TAG characters (U+E0000–E007F: "ASCII smuggling").
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}]/gu;

/** Remove invisible / bidi-control / tag characters (but keep whitespace as is). */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}
/** An opening bracket (incl. full-width / CJK look-alikes) followed by `ref=`: what our ref markers look like. */
const REF_MARK_RE = /[[［【〔〖〘〚⟦⁅]([\s]*ref[\s]*[=＝])/giu;

/** Neutralize anything in page text that looks like the start of a `[ref=…]` marker. */
export function defuseRefs(s: string): string {
  let t = s.replace(REF_MARK_RE, '($1');
  const n = t.normalize('NFKC');
  if (n !== t && /\[\s*ref\s*=/i.test(n)) t = n.replace(REF_MARK_RE, '($1');
  return t;
}

/**
 * Page-supplied text made safe for one line of tool output: invisible/control/bidi characters
 * removed, all whitespace (incl. newlines, U+2028/9) collapsed, `[ref=` defused, clipped to `max`.
 */
export function cleanText(s: unknown, max = 0): string {
  const t = defuseRefs(
    stripInvisible(String(s ?? ''))
      .replace(/[\s\u0085]+/g, ' ')
      .trim(),
  );
  return max > 0 && t.length > max ? `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…` : t;
}

/** Double-quoted, escaped page text (never contains a newline or a usable `[ref=`). */
export function quote(s: unknown, max = 0): string {
  return JSON.stringify(cleanText(s, max));
}

const ROLE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const STATE_RE =
  /^(?:level=[1-9]\d?|options=\d{1,7}|type=file|hidden|mixed|checked|selected|pressed|expanded|collapsed|disabled|required|readonly|invalid|focused)$/;

/** A role token as computed in the page; anything unexpected (page-controlled role attribute) becomes 'generic'. */
export function safeRole(r: unknown): string {
  return typeof r === 'string' && ROLE_RE.test(r) ? r : 'generic';
}

/** WAI-ARIA roles (plus the implicit ones the runtime computes). */
const KNOWN_ROLES = new Set(
  (
    'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox ' +
    'complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid ' +
    'gridcell group heading iframe img insertion link list listbox listitem log main marquee math menu menubar menuitem ' +
    'menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio ' +
    'radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong ' +
    'subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'
  ).split(' '),
);

/**
 * A role for text written by Stephen itself (error messages outside the untrusted wrapper,
 * finding #8): only real ARIA roles pass; a page-invented role attribute becomes `fallback`.
 */
export function knownRole(r: unknown, fallback = 'element'): string {
  return typeof r === 'string' && KNOWN_ROLES.has(r) ? r : fallback;
}

/**
 * Render one structured snapshot node (from the page) as a line body. `ref` is the full ref the
 * caller validated (or null). Only allowlisted state flags pass; all text is escaped here.
 */
export function renderNode(nd: Pick<RtNode, 'k' | 'role' | 'name' | 'st' | 'v' | 'red'>, ref: string | null): string {
  const states = Array.isArray(nd.st) ? nd.st.filter((s): s is string => typeof s === 'string' && STATE_RE.test(s)) : [];
  if (nd.k === 'text') return `text ${quote(nd.name, 200)}`;
  if (nd.k === 'option') {
    return `option ${quote(nd.name, 80)}${states.filter((s) => s === 'selected' || s === 'disabled').map((s) => ` ${s}`).join('')}`;
  }
  let t = nd.k === 'iframe' ? 'iframe' : safeRole(nd.role);
  const name = cleanText(nd.name, 200);
  if (name) t += ` ${JSON.stringify(name)}`;
  if (ref) t += ` [ref=${ref}]`;
  for (const s of states) t += ` ${s}`;
  if (nd.red === true) t += ' value=[redacted]';
  else if (typeof nd.v === 'string' && nd.v) t += ` value=${quote(nd.v, 60)}`;
  return t;
}

/** find context ('main › form "Sign in" › heading "Sign in"') from structured pairs. */
export function renderContext(ctx: unknown): string {
  if (!Array.isArray(ctx)) return '';
  return ctx
    .filter((c): c is RtCtx => Array.isArray(c) && c.length === 2)
    .map(([role, name]) => {
      const n = cleanText(name, 60);
      return n ? `${safeRole(role)} ${JSON.stringify(n)}` : safeRole(role);
    })
    .join(' › ');
}

export interface OutLine {
  /** Nesting depth of emitted nodes (0 = top level). */
  depth: number;
  /** Line body without indent and leading '- ', e.g. 'button "Send" [ref=z1:e4] disabled'. */
  text: string;
  /** True if the line carries a [ref=…]. */
  ref: boolean;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Why a page walk stopped before the end of the page (runtime RtCut). */
export type WalkCut = '' | 'chars' | 'time' | 'nodes';

export function summaryLine(refs: number, hidden: number, truncatedAt: number | null, cut: WalkCut = ''): string {
  const parts = [plural(refs, 'ref', 'refs')];
  if (hidden > 0) parts.push(`${plural(hidden, 'hidden element', 'hidden elements')} omitted`);
  if (cut === 'time' || cut === 'nodes') {
    parts.push('page too large: stopped reading part-way — use find or a scope ref');
  } else if (truncatedAt !== null) parts.push(`truncated at ${truncatedAt} chars — use find or a scope ref`);
  return `[${parts.join(' · ')}]`;
}

export function renderLine(l: OutLine): string {
  return `${'  '.repeat(l.depth)}- ${l.text}`;
}

export interface AssembledSnapshot {
  text: string;
  refCount: number;
  truncated: boolean;
}

/**
 * Render header + tree + summary. The whole text stays within maxChars where possible
 * (the header and the summary line are always kept); cuts happen at line boundaries.
 */
export function assembleSnapshot(a: {
  title: string;
  url: string;
  lines: OutLine[];
  hidden: number;
  maxChars: number;
  emptyHint?: string;
  /** The walk stopped early (output budget, deadline or node budget): the tree is a prefix. */
  cut?: WalkCut;
}): AssembledSnapshot {
  const cut = a.cut ?? '';
  const header = `Page: ${cleanText(a.title, 300)}\nURL: ${defuseRefs(stripInvisible(a.url).replace(/\s+/g, ''))}`;
  const rendered = a.lines.map(renderLine);
  const fullLen = rendered.reduce((s, l) => s + l.length + 1, 0);
  const totalRefs = a.lines.reduce((s, l) => s + (l.ref ? 1 : 0), 0);
  const fullSummary = summaryLine(totalRefs, a.hidden, null);
  if (!cut && header.length + 1 + fullLen + fullSummary.length <= a.maxChars) {
    const body = rendered.length ? rendered.join('\n') + '\n' : a.emptyHint ? a.emptyHint + '\n' : '';
    return { text: `${header}\n${body}${fullSummary}`, refCount: totalRefs, truncated: false };
  }
  // Reserve room for the longest possible summary, then keep whole lines.
  const worstSummary = summaryLine(totalRefs, a.hidden, a.maxChars, cut);
  let budget = a.maxChars - header.length - 1 - worstSummary.length;
  const kept: string[] = [];
  let refs = 0;
  for (let i = 0; i < rendered.length; i++) {
    const l = rendered[i] as string;
    if (l.length + 1 > budget) break;
    budget -= l.length + 1;
    kept.push(l);
    if ((a.lines[i] as OutLine).ref) refs++;
  }
  const body = kept.length ? kept.join('\n') + '\n' : '';
  return { text: `${header}\n${body}${summaryLine(refs, a.hidden, a.maxChars, cut)}`, refCount: refs, truncated: true };
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Cut text to ≤ maxChars at a line boundary (or word boundary for a single long line). */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.lastIndexOf('\n', maxChars);
  if (cut < maxChars * 0.5) {
    const sp = text.lastIndexOf(' ', maxChars);
    cut = sp > maxChars * 0.5 ? sp : maxChars;
  }
  return { text: text.slice(0, cut).trimEnd(), truncated: true };
}

// ───────────────────────────── find ranking ─────────────────────────────

export interface FindCandidate {
  role: string;
  name: string;
  text: string;
  placeholder: string;
  label: string;
  interactive: boolean;
  /** Global document order (frame order, then in-frame order). */
  order: number;
  /** Order of the nearest ancestor candidate, -1 if none. */
  parent: number;
}

/** 3 exact · 2 prefix · 1 contains · 0 no match (case-insensitive, whitespace-collapsed). */
export function matchLevel(query: string, field: string): number {
  const q = oneLine(query).toLowerCase();
  const f = oneLine(field).toLowerCase();
  if (!q || !f) return 0;
  if (f === q) return 3;
  if (f.startsWith(q)) return 2;
  return f.includes(q) ? 1 : 0;
}

export interface Ranked<T extends FindCandidate> {
  cand: T;
  level: number;
  nameLevel: number;
}

/**
 * Rank candidates: exact > prefix > contains; then the name being the matching field; then
 * interactive elements; then document order. Containers whose match comes from a matching
 * descendant are dropped, as are non-interactive matches inside a matching interactive element.
 */
export function rankCandidates<T extends FindCandidate>(query: string, cands: T[], max: number): Array<Ranked<T>> {
  const byOrder = new Map<number, T>();
  for (const c of cands) byOrder.set(c.order, c);
  const hasDesc = new Set<number>();
  for (const c of cands) {
    for (let p = c.parent; p >= 0; p = byOrder.get(p)?.parent ?? -1) hasDesc.add(p);
  }
  const inInteractive = (c: T): boolean => {
    for (let p = c.parent; p >= 0; ) {
      const pc = byOrder.get(p);
      if (!pc) break;
      if (pc.interactive) return true;
      p = pc.parent;
    }
    return false;
  };
  const ranked: Array<Ranked<T>> = [];
  for (const c of cands) {
    if (!c.interactive && (hasDesc.has(c.order) || inInteractive(c))) continue;
    const nameLevel = matchLevel(query, c.name);
    const level = Math.max(
      nameLevel,
      matchLevel(query, c.role),
      matchLevel(query, c.text),
      matchLevel(query, c.placeholder),
      matchLevel(query, c.label),
    );
    if (level === 0) continue;
    ranked.push({ cand: c, level, nameLevel });
  }
  ranked.sort(
    (a, b) =>
      b.level - a.level ||
      Number(b.nameLevel >= b.level) - Number(a.nameLevel >= a.level) ||
      Number(b.cand.interactive) - Number(a.cand.interactive) ||
      a.cand.order - b.cand.order,
  );
  return ranked.slice(0, Math.max(0, max));
}

// ───────────────────────────── keys ─────────────────────────────

const MODIFIER_ALIASES: Record<string, string> = {
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  controlormeta: 'ControlOrMeta',
};

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
  plus: '+',
};

export interface KeyCombo {
  /** Modifiers in press order ('ControlOrMeta' still unresolved). */
  modifiers: string[];
  key: string;
}

/** Parse 'Meta+A', 'Control+Shift+K', 'Enter', 'Control++' (plus key). Throws Error on bad input. */
export function parseKeyCombo(input: string): KeyCombo {
  const s = input.trim();
  if (!s) throw new Error('Empty key.');
  if (s === '+') return { modifiers: [], key: '+' };
  let parts = s.split('+');
  // "Control++" → ['Control', '', ''] : trailing empty pair means the '+' key.
  if (s.endsWith('++')) parts = [...parts.slice(0, -2), '+'];
  if (parts.some((p) => p === '')) throw new Error(`Malformed key combo "${input}".`);
  const keyPart = parts[parts.length - 1] as string;
  const modifiers: string[] = [];
  for (const m of parts.slice(0, -1)) {
    const norm = MODIFIER_ALIASES[m.trim().toLowerCase()];
    if (!norm) throw new Error(`"${m}" is not a modifier (use Control, Meta, Alt, Shift).`);
    if (!modifiers.includes(norm)) modifiers.push(norm);
  }
  let key = keyPart.trim();
  const alias = KEY_ALIASES[key.toLowerCase()];
  if (alias) key = alias;
  else if (MODIFIER_ALIASES[key.toLowerCase()] && parts.length === 1) key = MODIFIER_ALIASES[key.toLowerCase()] as string;
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else if (key.length === 1 && /[a-z]/i.test(key)) {
    // Letters in shortcuts: lower-case unless Shift is held (puppeteer then sends the shifted key).
    key = modifiers.includes('Shift') ? key.toUpperCase() : modifiers.length ? key.toLowerCase() : key;
  }
  return { modifiers, key };
}

/** Chromium editing commands for Meta shortcuts (CDP on macOS does not map them by itself). */
export function macEditCommand(modifiers: string[], key: string): string | null {
  if (modifiers.length !== 1 || modifiers[0] !== 'Meta') return null;
  switch (key.toLowerCase()) {
    case 'a':
      return 'selectAll';
    case 'c':
      return 'copy';
    case 'x':
      return 'cut';
    case 'v':
      return 'paste';
    case 'z':
      return 'undo';
    default:
      return null;
  }
}
