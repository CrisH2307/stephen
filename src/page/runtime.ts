/**
 * The in-page runtime of the page engine.
 *
 * `bhRuntime` is serialized with Function.prototype.toString() and evaluated once per document in
 * each frame's ISOLATED world (puppeteer `frame.isolatedRealm()`: a CDP isolated world / a BiDi
 * sandbox). The page's own scripts cannot see it, call it, or tamper with the built-ins it uses
 * (JSON, String/Array/Map prototypes …); only the DOM is shared (review finding #9).
 *
 * It MUST be self-contained: no imports, no references to module scope, no TS-only runtime helpers.
 * Everything it needs comes in through its three parameters — including the shared secret-field
 * rules of src/lib/secret-fields.ts (finding #13) and the element-number seed that keeps refs unique
 * per tab across documents (finding #8).
 *
 * It returns STRUCTURED data only. Every line the model sees is rendered (and escaped) in Node.
 * Errors meant for the model are returned (not thrown) as `{ __err: [code, message] }`.
 */

// ───────────────────────────── shapes exchanged with Node ─────────────────────────────

/** Install-time configuration. */
export interface RtConfig {
  /** Element numbers issued by this document start at seed + 1 (the tab's high-water mark for this frame). */
  seed: number;
  /** src/lib/secret-fields.ts SECRET_TEXT_SOURCE / SECRET_TEXT_FLAGS. */
  secretSource: string;
  secretFlags: string;
  /** src/lib/secret-fields.ts SECRET_AUTOCOMPLETE / SECRET_AUTOCOMPLETE_PREFIX. */
  secretAutocomplete: string[];
  secretAutocompletePrefix: string;
  /** src/lib/secret-fields.ts PAYMENT_FRAME_DOMAINS ('d' = d + subdomains, '*.d' = subdomains only). */
  paymentDomains: string[];
}

/** One snapshot node, flattened in document order. Node renders it (format.ts renderNode). */
export interface RtNode {
  /** Depth (0 = top level of this frame's output). */
  d: number;
  /** el = element line · text = loose text (filter 'all') · option = <option> · iframe = child-frame placeholder */
  k: 'el' | 'text' | 'option' | 'iframe';
  role: string;
  /** Accessible name (el), the text (text), the option label (option). Raw page text — Node escapes it. */
  name: string;
  /** Element number (0 = no ref). */
  n: number;
  /** State flags, e.g. 'checked', 'level=2'. Node drops anything outside its allowlist. */
  st: string[];
  /** Field value to show (null = none). */
  v: string | null;
  /** The value exists but is secret: render value=[redacted]. */
  red: boolean;
}

export interface RtSnapshotArgs {
  filter: 'interactive' | 'all';
  /** Element number to scope to (0 = whole document). */
  rootN: number;
  /** Redact every value in this frame (payment-processor frames). */
  redactAll: boolean;
  /** Stop walking once the estimated output exceeds this many characters (finding #15). */
  maxChars: number;
  /** Stop walking after this many ms (cooperative deadline: the walk never outlives the call). */
  timeMs: number;
}

/** Why a walk stopped early: '' = it did not · 'chars' = output budget · 'time' = deadline · 'nodes' = node budget. */
export type RtCut = '' | 'chars' | 'time' | 'nodes';

export interface RtSnapshotResult {
  title: string;
  url: string;
  nodes: RtNode[];
  hidden: number;
  cut: RtCut;
}

/** [role, name] pair of a find context entry (landmark or heading). */
export type RtCtx = [string, string];

export interface RtFindCand {
  /** Index into the page-side candidate list (used by findRefs). */
  i: number;
  /** Index of the nearest ancestor candidate, -1 if none. */
  p: number;
  role: string;
  name: string;
  text: string;
  placeholder: string;
  label: string;
  interactive: boolean;
  context: RtCtx[];
}

export interface RtReadResult {
  title: string;
  url: string;
  /** Text lines; a number is an iframe placeholder (element ref number). */
  items: Array<string | number>;
  cut: RtCut;
}

export interface RtElementInfo {
  role: string;
  name: string;
  tag: string;
  inputType: string | null;
  autocomplete: string | null;
  nameAttr: string | null;
  idAttr: string | null;
  placeholder: string | null;
  labelText: string | null;
  ariaLabel: string | null;
  text: string | null;
  href: string | null;
  isEditable: boolean;
  isDisabled: boolean;
  isSubmit: boolean;
  inForm: boolean;
  formAction: string | null;
  formSummary: string | null;
  /** See ElementInfo.secretHint ('' = none). */
  secretHint: string;
}

export interface RtEditInfo {
  kind: 'input' | 'textarea' | 'ce' | 'select' | 'other';
  editable: boolean;
  role: string;
}

/** What covers a click point. */
export interface RtCover {
  role: string;
  name: string;
  tag: string;
  id: string;
  /** Element number of the covering element (0 = none issued: it has no role). */
  n: number;
}

/** A viewport point (CSS px, relative to the frame's viewport) or why there is none. */
export type RtPoint =
  | { x: number; y: number }
  | { obscured: RtCover; x: number; y: number }
  | { nobox: true }
  | { clipped: true }
  | { offscreen: true }
  | { stale: true };

export interface RtDocInfo {
  /** Scrollable document size and viewport size, CSS px. */
  w: number;
  h: number;
  vw: number;
  vh: number;
  /** Scroll offset of the visual viewport (document coords of the viewport's top-left). */
  px: number;
  py: number;
  dpr: number;
}

/** 'secret': the focused field is (or just became) a password / one-time-code / masked field (finding #13). */
export type RtInsertResult = 'ok' | 'focus' | 'timeout' | 'stale' | 'secret';

/** [code, message written without page text, optional page-supplied text (untrusted, shown wrapped)]. */
export type RtErr = { __err: [string, string] | [string, string, string] };

/** Methods exposed on the isolated world's globalThis[KEY]. Each takes one JSON-serializable argument. */
export interface RtApi {
  v: string;
  /** The seed this document's numbering started from. */
  base: number;
  /** Highest element number issued so far by this document. */
  seq(a?: null): number;
  snapshot(a: RtSnapshotArgs): RtSnapshotResult | RtErr;
  find(a: { query: string; limit: number; timeMs: number }): { cands: RtFindCand[]; iframes: number[]; cut: RtCut };
  findRefs(a: { idx: number[] }): number[];
  readText(a: { rootN: number; maxChars: number; timeMs: number }): RtReadResult | RtErr;
  lookup(n: number): Element | null;
  describe(a: { n: number; redactAll: boolean }): RtElementInfo | null;
  editInfo(n: number): RtEditInfo | null;
  focusEl(n: number): boolean;
  isFocused(n: number): boolean;
  clearEl(n: number): RtInsertResult;
  caretEnd(n: number): boolean;
  insertText(a: { n: number; text: string; deadline: number }): RtInsertResult;
  selectValues(a: { n: number; values: string[] }): string[] | RtErr;
  scroll(a: { n: number; dx: number; dy: number }): { moved: boolean; target: string };
  fileInfo(n: number): { isFile: boolean; multiple: boolean; disabled: boolean } | null;
  domClick(n: number): boolean;
  focused(a: null): { n: number; iframe: boolean } | null | RtErr;
  /** Scroll into view if needed, then the hit-tested centre of the element's visible part. */
  clickPoint(n: number): RtPoint;
  /** Map a point inside child frame element n's viewport to this frame's viewport, hit-testing that the iframe is on top there. */
  frameHit(a: { n: number; x: number; y: number }): RtPoint;
  /** Scroll element n into view if it is not fully visible. */
  reveal(n: number): boolean;
  /** Border box of element n relative to this frame's viewport (null if gone / no box). */
  rectOf(n: number): { x: number; y: number; w: number; h: number } | null;
  /** Viewport offset of the content box of iframe element n. */
  frameOrigin(n: number): { x: number; y: number } | null;
  /** Refs of all (rendered) iframe elements of this document. */
  iframeRefs(a: null): number[];
  docInfo(a: null): RtDocInfo;
  /** arm: watch for a mousedown whose target is element n (or inside it); !arm: report and disarm. */
  probe(a: { n: number; arm: boolean }): boolean;
  platform(a: null): string;
}

// ───────────────────────────── the runtime ─────────────────────────────

export function bhRuntime(KEY: string, VERSION: string, CFG: RtConfig): boolean {
  const G = globalThis as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(G, KEY)) return false;

  // ---- private state ----
  const BASE = Math.max(0, Math.floor(Number(CFG.seed) || 0));
  let seq = BASE;
  const byN = new Map<number, Element>();
  const byEl = new WeakMap<Element, { n: number; sig: string }>();
  let findCands: Array<{ el: Element; sig: string }> = [];

  // ---- shared secret rules (src/lib/secret-fields.ts) ----
  const SECRET_RE = new RegExp(CFG.secretSource, (CFG.secretFlags || '').replace(/[gy]/g, ''));
  const SECRET_AC = (CFG.secretAutocomplete || []).map((s) => String(s).toLowerCase());
  const SECRET_AC_PREFIX = String(CFG.secretAutocompletePrefix || '').toLowerCase();
  const PAY_DOMAINS = (CFG.paymentDomains || []).map((s) => String(s).toLowerCase());

  // ---- per-call caches (reset by begin()) ----
  let styles = new Map<Element, CSSStyleDeclaration>();
  let textVis = new Map<Element, boolean>();
  /** Per tree scope: control → its <label>s (el.labels is O(document) per first access: finding #15). */
  let labelMaps = new Map<Node, Map<Element, Element[]>>();
  let docW = 0;
  let docH = 0;
  const gcs = window.getComputedStyle.bind(window);

  function begin(): void {
    styles = new Map();
    textVis = new Map();
    labelMaps = new Map();
    const de = document.documentElement;
    docW = Math.max(de ? de.scrollWidth : 0, de ? de.clientWidth : 0, window.innerWidth);
    docH = Math.max(de ? de.scrollHeight : 0, de ? de.clientHeight : 0, window.innerHeight);
  }

  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'param', 'source', 'track',
    'datalist',
  ]);
  const INTERACTIVE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'spinbutton',
    'slider', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  ]);
  const LANDMARKS = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region', 'dialog', 'alertdialog',
  ]);
  const CONTENT = new Set([
    'heading', 'paragraph', 'list', 'listitem', 'table', 'row', 'cell', 'gridcell', 'columnheader', 'rowheader', 'img',
    'blockquote', 'article', 'figure', 'group',
  ]);
  /** Content roles whose name (in 'all' mode) is their text, up to 200 chars. */
  const TEXTY = new Set(['paragraph', 'listitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'blockquote']);
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'option', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'treeitem', 'checkbox', 'radio', 'switch', 'tooltip', 'row', 'listitem',
    'paragraph', 'blockquote',
  ]);
  const TEXT_INPUTS = new Set([
    'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week', '',
  ]);

  // ---- small helpers ----
  function css(el: Element): CSSStyleDeclaration {
    let s = styles.get(el);
    if (!s) {
      s = gcs(el);
      styles.set(el, s);
    }
    return s;
  }
  function collapse(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }
  function clip(s: string, max: number): string {
    const c = collapse(s);
    return c.length > max ? c.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : c;
  }
  function kids(node: Node): Node[] {
    if (node.nodeType === 1) {
      const el = node as Element;
      const sr = el.shadowRoot;
      if (sr) return Array.from(sr.childNodes);
      if (el.localName === 'slot') {
        const assigned = (el as HTMLSlotElement).assignedNodes();
        if (assigned.length) return assigned;
      }
    }
    return Array.from(node.childNodes);
  }
  function up(el: Element): Element | null {
    if (el.assignedSlot) return el.assignedSlot;
    const p = el.parentNode;
    if (!p) return null;
    if (p.nodeType === 11) return (p as ShadowRoot).host || null;
    return p.nodeType === 1 ? (p as Element) : null;
  }
  function closestUp(el: Element, sel: string): Element | null {
    for (let e: Element | null = el; e; e = up(e)) if (e.matches(sel)) return e;
    return null;
  }
  function parseColor(s: string): number[] | null {
    const t = (s || '').trim();
    if (t === 'transparent') return [0, 0, 0, 0];
    const m = /^rgba?\(([^)]*)\)$/i.exec(t);
    if (!m) return null;
    const parts = (m[1] || '').split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const nums = parts.map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p)));
    if (nums.some((x) => isNaN(x))) return null;
    return [nums[0] as number, nums[1] as number, nums[2] as number, nums.length > 3 ? (nums[3] as number) : 1];
  }
  function effectiveBg(start: Element): number[] | null {
    for (let e: Element | null = start; e; e = up(e)) {
      const cs = css(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parseColor(cs.backgroundColor);
      if (!c) return null;
      const a = c[3] as number;
      if (a >= 0.9) return c;
      if (a > 0.1) return null;
    }
    const scheme = document.documentElement ? css(document.documentElement).colorScheme || '' : '';
    return /dark/.test(scheme) ? null : [255, 255, 255, 1];
  }
  /** Text styled to be invisible (tiny, transparent, same colour as background) — classic injection carrier. */
  function textStyleVisible(el: Element): boolean {
    const cached = textVis.get(el);
    if (cached !== undefined) return cached;
    const cs = css(el);
    let ok = true;
    if (cs.visibility !== 'visible') ok = false;
    else if (parseFloat(cs.fontSize) < 2) ok = false;
    else {
      const c = parseColor(cs.color);
      const fill = parseColor((cs as unknown as Record<string, string>)['webkitTextFillColor'] || '');
      if (c && (c[3] as number) < 0.1) ok = false;
      else if (fill && (fill[3] as number) < 0.1) ok = false;
      else if (c) {
        const bg = effectiveBg(el);
        if (bg) {
          const d =
            Math.abs((c[0] as number) - (bg[0] as number)) +
            Math.abs((c[1] as number) - (bg[1] as number)) +
            Math.abs((c[2] as number) - (bg[2] as number));
          if (d < 24) ok = false;
        }
      }
    }
    textVis.set(el, ok);
    return ok;
  }
  function textNodeVisible(t: Node): boolean {
    let p = t.parentNode;
    if (p && p.nodeType === 11) p = (p as ShadowRoot).host;
    if (!p || p.nodeType !== 1) return true;
    return textStyleVisible(p as Element);
  }
  function overflowClips(cs: CSSStyleDeclaration): boolean {
    return /hidden|clip|scroll|auto/.test(cs.overflowX + ' ' + cs.overflowY);
  }
  /**
   * '' visible · 'subtree' hidden with all descendants · 'self' own box hidden (visibility), kids may show ·
   * 'zero' zero-size box (visible only through visible descendants) · 'contents' display:contents (no box).
   */
  function hiddenState(el: Element, op: number): string {
    const cs = css(el);
    if (cs.display === 'none') return 'subtree';
    if (el.getAttribute('aria-hidden') === 'true') return 'subtree';
    if ((el as HTMLElement).inert) return 'subtree';
    const hid = el.getAttribute('hidden');
    if (hid !== null && hid !== 'until-found') return 'subtree';
    const o = parseFloat(cs.opacity);
    if (!isNaN(o) && o * op < 0.05) return 'subtree';
    if (cs.display === 'contents') return 'contents';
    const cv = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
    if (typeof cv === 'function' && !cv.call(el)) return 'subtree';
    const r = el.getBoundingClientRect();
    const sx = window.scrollX;
    const sy = window.scrollY;
    if (r.right + sx < 0 || r.bottom + sy < 0 || r.left + sx >= docW || r.top + sy >= docH) return 'subtree';
    if (r.width === 0 || r.height === 0) return overflowClips(cs) ? 'subtree' : 'zero';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'self';
    return '';
  }
  /** Cheaper check used inside name computation. */
  function quickHidden(el: Element): boolean {
    const cs = css(el);
    if (cs.display === 'none') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (parseFloat(cs.opacity) < 0.05) return true;
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.right + window.scrollX < 0 || r.bottom + window.scrollY < 0) return true;
      if ((r.width === 0 || r.height === 0) && overflowClips(cs)) return true;
    }
    return false;
  }
  function cumulativeOpacity(el: Element): number {
    let op = 1;
    for (let e = up(el); e; e = up(e)) {
      const o = parseFloat(css(e).opacity);
      if (!isNaN(o)) op *= o;
    }
    return op;
  }
  function meaningful(el: Element): boolean {
    if (/^(input|select|textarea|button|a|iframe|img)$/.test(el.localName)) return true;
    return (el.textContent || '').trim().length > 0;
  }
  function inputType(el: Element): string {
    return el.localName === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
  }
  function isCEHost(el: Element): boolean {
    const h = el as HTMLElement;
    if (!h.isContentEditable) return false;
    const p = up(el) as HTMLElement | null;
    return !p || !p.isContentEditable;
  }
  function headingLevel(el: Element): number {
    const m = /^h([1-6])$/.exec(el.localName);
    if (m) return Number(m[1]);
    const a = Number(el.getAttribute('aria-level'));
    return a > 0 ? a : 2;
  }
  function sectioningAncestor(el: Element): boolean {
    for (let e = up(el); e; e = up(e)) {
      if (/^(article|aside|main|nav|section)$/.test(e.localName)) return true;
      const r = e.getAttribute('role');
      if (r && /^(article|complementary|main|navigation|region)$/.test(r)) return true;
    }
    return false;
  }

  function roleOf(el: Element): string {
    const explicit = ((el.getAttribute('role') || '').trim().split(/\s+/)[0] || '').toLowerCase();
    if (explicit && explicit !== 'none' && explicit !== 'presentation' && explicit !== 'generic') return explicit;
    if (explicit) return '';
    const t = el.localName;
    if (isCEHost(el) && !/^(input|textarea|select|button)$/.test(t)) return 'textbox';
    switch (t) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : '';
      case 'button':
        return 'button';
      case 'input': {
        const ty = inputType(el);
        if (/^(button|submit|reset|image|file)$/.test(ty)) return 'button';
        if (ty === 'checkbox') return el.hasAttribute('switch') ? 'switch' : 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'range') return 'slider';
        if (ty === 'number') return 'spinbutton';
        if (ty === 'hidden') return '';
        if (el.hasAttribute('list')) return 'combobox';
        if (ty === 'search') return 'searchbox';
        return 'textbox';
      }
      case 'select': {
        const s = el as HTMLSelectElement;
        return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
      }
      case 'textarea':
        return 'textbox';
      case 'option':
        return 'option';
      case 'img':
        return el.getAttribute('alt') === '' ? '' : 'img';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return sectioningAncestor(el) ? '' : 'banner';
      case 'footer':
        return sectioningAncestor(el) ? '' : 'contentinfo';
      case 'aside':
        return 'complementary';
      case 'form':
        return 'form';
      case 'search':
        return 'search';
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'dialog':
        return 'dialog';
      case 'article':
        return 'article';
      case 'ul':
      case 'ol':
      case 'menu':
        return 'list';
      case 'li':
        return 'listitem';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th':
        return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
      case 'p':
        return 'paragraph';
      case 'summary':
        return 'button';
      case 'fieldset':
        return 'group';
      case 'figure':
        return 'figure';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      case 'blockquote':
        return 'blockquote';
      case 'iframe':
      case 'frame':
        return 'iframe';
    }
    return '';
  }
  /** Custom JS controls (Gmail-style div buttons) that have no interactive role. */
  function isClickable(el: Element): boolean {
    if (el.hasAttribute('onclick')) return true;
    const cs = css(el);
    if (cs.cursor !== 'pointer') return false;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti.trim() !== '' && Number(ti) >= 0) return true;
    const ja = el.getAttribute('jsaction');
    return !!ja && /click/.test(ja);
  }
  function isInteractive(el: Element, role: string): boolean {
    if (INTERACTIVE.has(role)) return true;
    if (LANDMARKS.has(role) || role === 'iframe' || role === 'heading') return false;
    return isClickable(el);
  }

  // ---- accessible name ----
  function textOf(root: Element, max: number, skipControls: boolean): string {
    const out: string[] = [];
    let len = 0;
    const push = (s: string): void => {
      out.push(s);
      len += s.length;
    };
    const rec = (n: Node): void => {
      if (len > max * 2 + 40) return;
      if (n.nodeType === 3) {
        const v = n.nodeValue || '';
        if (!v.trim()) {
          if (v) push(' '); // keeps "<b>a</b> <b>b</b>" as "a b"
          return;
        }
        if (textNodeVisible(n)) push(v);
        return;
      }
      if (n.nodeType === 11) {
        for (const k of kids(n)) rec(k);
        return;
      }
      if (n.nodeType !== 1) return;
      const e = n as Element;
      const tag = e.localName;
      if (SKIP.has(tag)) return;
      if (e !== root) {
        if (quickHidden(e)) return;
        if (skipControls && /^(input|select|textarea)$/.test(tag)) return;
        const al = e.getAttribute('aria-label');
        if (al && al.trim()) {
          push(' ' + al + ' ');
          return;
        }
        if (tag === 'img') {
          push(' ' + (e.getAttribute('alt') || '') + ' ');
          return;
        }
        if (tag === 'input') {
          const ty = inputType(e);
          if (/^(button|submit|reset)$/.test(ty)) push(' ' + (e as HTMLInputElement).value + ' ');
          return;
        }
        if (tag === 'select' || tag === 'textarea' || tag === 'svg') return;
      }
      const block = !/^inline/.test(css(e).display);
      if (block) push(' ');
      for (const k of kids(e)) rec(k);
      if (block) push(' ');
    };
    rec(root);
    return clip(out.join(''), max);
  }
  const LABELABLE = /^(input|select|textarea|button|meter|output|progress)$/;
  /**
   * The <label> elements of el (same as el.labels). Chrome builds el.labels with a whole-document
   * scan on first access, which made snapshots of big pages quadratic; one querySelectorAll per tree
   * scope per call instead.
   */
  function labelEls(el: Element): Element[] {
    if (!LABELABLE.test(el.localName)) return [];
    if (el.localName === 'input' && inputType(el) === 'hidden') return [];
    const root = el.getRootNode();
    let m = labelMaps.get(root);
    if (!m) {
      m = new Map();
      const q = (root as ParentNode).querySelectorAll;
      const all = typeof q === 'function' ? Array.from((root as ParentNode).querySelectorAll('label')) : [];
      for (const l of all) {
        const c = (l as HTMLLabelElement).control;
        if (!c) continue;
        const list = m.get(c);
        if (list) list.push(l);
        else m.set(c, [l]);
      }
      labelMaps.set(root, m);
    }
    return m.get(el) || [];
  }
  function labelsOf(el: Element): string {
    const labels = labelEls(el);
    if (!labels.length) return '';
    return collapse(labels.map((l) => textOf(l, 200, true)).join(' '));
  }
  function accName(el: Element, role: string, max: number): string {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const parts: string[] = [];
      for (const id of lb.split(/\s+/)) {
        if (!id) continue;
        const r = typeof root.getElementById === 'function' ? root.getElementById(id) : document.getElementById(id);
        if (r) parts.push(r === el ? textOf(r, max, true) : collapse(r.textContent || ''));
      }
      const t = collapse(parts.join(' '));
      if (t) return clip(t, max);
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return clip(al, max);
    const tag = el.localName;
    if (/^(input|select|textarea|button|meter|output|progress)$/.test(tag)) {
      const l = labelsOf(el);
      if (l) return clip(l, max);
    }
    if (tag === 'img' || tag === 'area' || (tag === 'input' && inputType(el) === 'image')) {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return clip(alt, max);
    }
    if (tag === 'input') {
      const ty = inputType(el);
      if (/^(button|submit|reset)$/.test(ty)) {
        const v = (el as HTMLInputElement).value;
        return clip(v || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : ''), max);
      }
    }
    if (tag === 'fieldset') {
      const lg = el.querySelector(':scope > legend');
      if (lg) return textOf(lg, max, false);
    }
    if (tag === 'table') {
      const cap = el.querySelector(':scope > caption');
      if (cap) return textOf(cap, max, false);
    }
    if (tag === 'figure') {
      const fc = el.querySelector(':scope > figcaption');
      if (fc) return textOf(fc, max, false);
    }
    if (NAME_FROM_CONTENT.has(role) || (role === '' && isClickable(el)) || (role === 'button' && tag !== 'input')) {
      const t = textOf(el, max, false);
      if (t) return t;
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return clip(title, max);
    const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder');
    if (ph && ph.trim()) return clip(ph, max);
    if (tag === 'input' && inputType(el) === 'file') return 'Choose file';
    return '';
  }

  // ---- secrets & values (rules: src/lib/secret-fields.ts) ----
  /** Same rules as secrets.ts wordsOf(). */
  function wordsOf(s: string | null | undefined): string {
    if (!s) return '';
    return s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-.[\]:/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  function hostIsPayment(host: string): boolean {
    const h = (host || '').toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    for (const p of PAY_DOMAINS) {
      const sub = p.indexOf('*.') === 0;
      const d = sub ? p.slice(2) : p;
      if (h.length > d.length && h.slice(-(d.length + 1)) === '.' + d) return true;
      if (!sub && h === d) return true;
    }
    return false;
  }
  const PAYMENT_HERE = (() => {
    try {
      return hostIsPayment(location.hostname);
    } catch {
      return false;
    }
  })();
  function secretText(s: string | null | undefined): boolean {
    return !!s && SECRET_RE.test(wordsOf(s));
  }
  /** Password / OTP / payment / bank / national-id field (shared rules, plus the accessible name like the gate). */
  function isSecret(el: Element, name: string): boolean {
    if (inputType(el) === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    for (const tok of ac) {
      if (!tok) continue;
      if (SECRET_AC.indexOf(tok) >= 0 || (SECRET_AC_PREFIX && tok.indexOf(SECRET_AC_PREFIX) === 0)) return true;
    }
    const parts = [el.getAttribute('name'), el.id, labelsOf(el), el.getAttribute('placeholder'), el.getAttribute('aria-label'), name];
    for (const p of parts) if (secretText(p)) return true;
    return secretHintOf(el) !== '';
  }

  // ---- secret evidence beyond attributes (review #2 findings 10/13 → ElementInfo.secretHint) ----
  /** Text inputs / textareas / contenteditable hosts: the things text can be typed into. */
  function isTextField(el: Element): boolean {
    const tag = el.localName;
    if (tag === 'input') return TEXT_INPUTS.has(inputType(el));
    return tag === 'textarea' || (el as HTMLElement).isContentEditable === true;
  }
  function maskedByCss(el: Element): boolean {
    const cs = css(el);
    for (const p of ['-webkit-text-security', 'text-security']) {
      const v = (cs.getPropertyValue(p) || '').trim().toLowerCase();
      if (v && v !== 'none' && v !== 'initial' && v !== 'normal') return true;
    }
    return false;
  }
  /** A one-character box of a split code input (maxlength=1, size=1, or a narrow numeric box). */
  function isDigitBox(e: Element): boolean {
    if (e.localName !== 'input' || !/^(text|tel|number|password|)$/.test(inputType(e))) return false;
    const i = e as HTMLInputElement;
    if (i.maxLength === 1 || e.getAttribute('size') === '1') return true;
    const im = (e.getAttribute('inputmode') || '').toLowerCase();
    const ac = (e.getAttribute('autocomplete') || '').toLowerCase();
    if (im !== 'numeric' && ac.indexOf('one-time-code') < 0 && inputType(e) !== 'tel' && inputType(e) !== 'number') return false;
    const w = e.getBoundingClientRect().width;
    return w > 0 && w <= 64;
  }
  /** el is one of ≥ 4 one-character boxes grouped under a common ancestor (≤ 3 levels up). */
  function inDigitGroup(el: Element): boolean {
    if (!isDigitBox(el)) return false;
    let a: Element | null = el;
    for (let lvl = 0; lvl < 3; lvl++) {
      a = a ? up(a) : null;
      if (!a || a === document.body || a === document.documentElement) break;
      const inputs = a.querySelectorAll('input');
      if (inputs.length > 16) break;
      let boxes = 0;
      for (const i of Array.from(inputs)) if (isDigitBox(i)) boxes++;
      if (boxes >= 4) return true;
      if (a.localName === 'form') break;
    }
    return false;
  }
  function idText(ids: string | null, el: Element): string {
    if (!ids) return '';
    const root = el.getRootNode() as Document | ShadowRoot;
    const out: string[] = [];
    for (const id of ids.split(/\s+/).slice(0, 8)) {
      if (!id) continue;
      const r = typeof root.getElementById === 'function' ? root.getElementById(id) : document.getElementById(id);
      if (r && r !== el) out.push(r.textContent || '');
    }
    return clip(out.join(' '), 200);
  }
  /**
   * The nearest text before el that is not another field's: a preceding sibling's text, else one of
   * the ancestors' (≤ 3 levels, not leaving the form). Catches `<div>Password</div><input>` labels.
   */
  function nearbyText(el: Element): string {
    let e: Element = el;
    for (let lvl = 0; lvl <= 3; lvl++) {
      let k = 0;
      for (let s = e.previousSibling; s && k < 8; s = s.previousSibling, k++) {
        if (s.nodeType === 3) {
          const t = collapse(s.nodeValue || '');
          if (t) return clip(t, 160);
          continue;
        }
        if (s.nodeType !== 1) continue;
        const se = s as Element;
        if (SKIP.has(se.localName)) continue;
        if (/^(input|select|textarea|button)$/.test(se.localName)) return '';
        if (se.querySelector('input:not([type=hidden]), select, textarea, button, [contenteditable]')) return '';
        const t = collapse(se.textContent || '');
        if (t) return clip(t, 160);
      }
      const p = up(e);
      if (!p || p === document.body || p === document.documentElement || p.localName === 'form') break;
      e = p;
    }
    return '';
  }
  /** "6-digit code", "code à 6 chiffres", "the code we texted you": phrases that only describe a one-time code. */
  const OTP_STRONG = new RegExp(
    [
      String.raw`\b[4-8]\s*-?\s*(?:digit|chiffres?|d[ií]gitos?|stellige[nr]?|cijferige?|cifre)\s+(?:\S+\s+){0,2}?(?:code|pin|kod|codice|c[oó]digo|passcode)\b`,
      String.raw`\b(?:code|pin|kod|codice|c[oó]digo)\s+(?:\S+\s+){0,2}?[4-8]\s*(?:chiffres?|d[ií]gitos?|cifre|digits?|stellig)`,
      String.raw`\b(?:code|pin)\b[^.]{0,40}\b(?:sent|texted|emailed|text message|sms)\b`,
    ].join('|'),
    'i',
  );
  /** Weaker OTP words: only count for a short numeric field. */
  const OTP_WEAK = /\b(?:codes?|digits?|pins?|otp|passcode|token|verification|verify|kod|c[oó]digo|codice|chiffres?|ziffern?)\b/i;
  /** Codes that are not secrets (any field). */
  const NOT_SECRET_CODE = /\b(?:zip|postal|postcode|post ?code|area ?code|country ?code|dial(?:ling)? ?code|promo|promotional|coupon|discount|voucher|gift|referral|invite|invitation|tracking|product|sku|order|reference|booking|confirmation number)\b/i;
  /** Short numeric fields that are not secrets. */
  const NOT_OTP = /\b(?:quantity|qty|amount|price|age|year|month|day|phone|telephone|mobile|tel|number of)\b/i;
  const CARD_PLACEHOLDER = /^\s*(?:\d{4}[\s-]?){3}\d{1,7}\s*$/;
  /**
   * Page-computed evidence that a text field holds a secret although its own attributes do not say
   * so. '' = none. Values (stable, machine-readable): 'text-security' · 'otp-digit-group' ·
   * 'otp-like' · 'nearby-label' · 'card-like'.
   */
  function secretHintOf(el: Element): string {
    if (!isTextField(el)) return '';
    if (maskedByCss(el)) return 'text-security';
    if (el.localName !== 'input' && el.localName !== 'textarea' && !isCEHost(el)) return '';
    if (inDigitGroup(el)) return 'otp-digit-group';
    const own = labelsOf(el);
    const aria = el.getAttribute('aria-label') || '';
    const lby = idText(el.getAttribute('aria-labelledby'), el);
    const near = own || aria.trim() || lby ? '' : nearbyText(el);
    if (near && secretText(near)) return 'nearby-label';
    if (el.localName !== 'input') return '';
    const ty = inputType(el);
    if (ty === 'email' || ty === 'url' || ty === 'search') return '';
    const ph = el.getAttribute('placeholder') || '';
    if (CARD_PLACEHOLDER.test(ph)) return 'card-like';
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const ownAttrs = [el.getAttribute('name') || '', el.id || '', ac].join(' ');
    if (/\b(?:tel|tel-\S+|email|postal-code|bday\S*|transaction-amount)\b/.test(ac) || /email|e-mail|phone|mobile|zip|postal/i.test(ownAttrs)) return '';
    const texts = [own, aria, lby, ph, el.getAttribute('title') || '', idText(el.getAttribute('aria-describedby'), el), near || nearbyText(el)]
      .join(' · ');
    if (NOT_SECRET_CODE.test(wordsOf(texts + ' ' + ownAttrs))) return '';
    if (OTP_STRONG.test(texts)) return 'otp-like';
    const im = (el.getAttribute('inputmode') || '').toLowerCase();
    const pat = el.getAttribute('pattern') || '';
    const numeric = im === 'numeric' || ty === 'tel' || ty === 'number' || /^\^?(?:\\d|\[0-9\])/.test(pat);
    const ml = (el as HTMLInputElement).maxLength;
    if (!numeric || !(ml >= 1 && ml <= 8)) return '';
    const words = wordsOf(texts + ' ' + ownAttrs);
    if (NOT_OTP.test(words)) return '';
    return SECRET_RE.test(words) || OTP_WEAK.test(words) ? 'otp-like' : '';
  }
  /** Why the focused / target field must not receive typed text ('' = it may). */
  function secretReason(el: Element): string {
    if (!isTextField(el) && el.localName !== 'input') return '';
    if (inputType(el) === 'password') return 'became-password';
    const role = roleOf(el) || 'textbox';
    if (isSecret(el, accName(el, role, 200))) return secretHintOf(el) || 'secret-field';
    return '';
  }
  function valueOf(el: Element): string | null {
    const tag = el.localName;
    if (tag === 'input') {
      const ty = inputType(el);
      if (/^(button|submit|reset|image|file|checkbox|radio|hidden)$/.test(ty)) return null;
      return (el as HTMLInputElement).value;
    }
    if (tag === 'textarea') return (el as HTMLTextAreaElement).value;
    if (tag === 'select') {
      return Array.from((el as HTMLSelectElement).selectedOptions)
        .map((o) => collapse(o.label || o.text))
        .join(', ');
    }
    if (isCEHost(el)) return collapse((el as HTMLElement).innerText || el.textContent || '');
    return null;
  }
  function deepActive(): Element | null {
    let a: Element | null = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  interface States {
    st: string[];
    v: string | null;
    red: boolean;
  }
  function statesOf(el: Element, role: string, name: string, redact: boolean): States {
    const s: string[] = [];
    const tag = el.localName;
    if (role === 'heading') s.push('level=' + headingLevel(el));
    const ty = inputType(el);
    if (ty === 'file') s.push('type=file');
    if (ty === 'checkbox' || ty === 'radio') {
      const i = el as HTMLInputElement;
      if (i.indeterminate) s.push('mixed');
      else if (i.checked) s.push('checked');
    } else {
      const ac = el.getAttribute('aria-checked');
      if (ac === 'true') s.push('checked');
      else if (ac === 'mixed') s.push('mixed');
    }
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    const ae = el.getAttribute('aria-expanded');
    if (ae === 'true') s.push('expanded');
    else if (ae === 'false') s.push('collapsed');
    else if (tag === 'summary' && el.parentElement && el.parentElement.localName === 'details') {
      s.push((el.parentElement as HTMLDetailsElement).open ? 'expanded' : 'collapsed');
    }
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') s.push('required');
    if ((tag === 'input' || tag === 'textarea') && (el as HTMLInputElement).readOnly) s.push('readonly');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if (deepActive() === el) s.push('focused');
    if (tag === 'select' && (el as HTMLSelectElement).options.length > 20) {
      s.push('options=' + (el as HTMLSelectElement).options.length);
    }
    const v = valueOf(el);
    if (!v) return { st: s, v: null, red: false };
    if (redact || PAYMENT_HERE || isSecret(el, name)) return { st: s, v: null, red: true };
    return { st: s, v: v.length > 60 ? v.slice(0, 59) + '…' : v, red: false };
  }

  // ---- refs ----
  function refFor(el: Element, sig: string): number {
    const cur = byEl.get(el);
    if (cur && cur.sig === sig && byN.get(cur.n) === el) return cur.n;
    if (cur) byN.delete(cur.n);
    const n = ++seq;
    byN.set(n, el);
    byEl.set(el, { n, sig });
    return n;
  }
  function sigOf(role: string, name: string): string {
    return role + '\u0001' + name.replace(/…$/, '').slice(0, 70);
  }
  function lookup(n: number): Element | null {
    const el = byN.get(n);
    return el && el.isConnected ? el : null;
  }
  function prune(): void {
    for (const [n, el] of byN) if (!el.isConnected) byN.delete(n);
  }

  // ---- snapshot ----
  interface ONode {
    k: RtNode['k'];
    role: string;
    name: string;
    n: number;
    st: string[];
    v: string | null;
    red: boolean;
    kids: ONode[];
  }
  type Item = ONode | string;
  /** Walk budget (finding #15): estimated output size, nodes visited, a deadline. */
  interface Budget {
    chars: number;
    maxChars: number;
    nodes: number;
    maxNodes: number;
    until: number;
    cut: RtCut;
  }
  const MAX_WALK_NODES = 300000;
  function budgetOf(maxChars: unknown, timeMs: unknown): Budget {
    const mc = Number(maxChars);
    const tm = Number(timeMs);
    return {
      chars: 0,
      maxChars: mc > 0 ? mc : Infinity,
      nodes: 0,
      maxNodes: MAX_WALK_NODES,
      until: Date.now() + (tm > 0 ? Math.min(tm, 60000) : 10000),
      cut: '',
    };
  }
  /** Count one visited node; true once the walk must stop. Checks the clock every 128 nodes. */
  function spent(b: Budget): boolean {
    if (b.cut) return true;
    b.nodes++;
    if (b.nodes > b.maxNodes) b.cut = 'nodes';
    else if ((b.nodes & 127) === 0 && Date.now() > b.until) b.cut = 'time';
    return b.cut !== '';
  }
  /** Charge estimated output characters (a rendered line ≈ indent + role + name + ref + states). */
  function charge(b: Budget, n: number): void {
    b.chars += n;
    if (!b.cut && b.chars > b.maxChars) b.cut = 'chars';
  }
  interface SnapCtx {
    all: boolean;
    redact: boolean;
    hidden: number;
    root: Element;
    b: Budget;
  }
  function elNode(role: string, name: string, n: number, s: States, b?: Budget): ONode {
    if (b) charge(b, 22 + role.length + name.length + (s.v ? Math.min(s.v.length, 64) + 8 : 0) + (s.red ? 18 : 0) + s.st.length * 8);
    return { k: 'el', role, name, n, st: s.st, v: s.v, red: s.red, kids: [] };
  }
  /** Budget of the snapshot in progress (text lines are charged when they are formed). */
  let snapBudget: Budget | null = null;
  function textNode(t: string): ONode {
    if (snapBudget) charge(snapBudget, t.length + 12);
    return { k: 'text', role: 'text', name: t, n: 0, st: [], v: null, red: false, kids: [] };
  }
  function flush(items: Item[], into: ONode[]): void {
    let buf = '';
    const emit = (): void => {
      const t = collapse(buf);
      buf = '';
      if (t) into.push(textNode(t.length > 200 ? t.slice(0, 199) + '…' : t));
    };
    for (const it of items) {
      if (typeof it === 'string') buf += it;
      else {
        emit();
        into.push(it);
      }
    }
    emit();
  }
  function nodesOf(items: Item[]): ONode[] {
    return items.filter((x): x is ONode => typeof x !== 'string');
  }
  function optionKids(el: Element, c: SnapCtx): ONode[] {
    const opts = Array.from((el as HTMLSelectElement).options);
    if (opts.length > 20 && el !== c.root) return [];
    return opts.slice(0, 200).map((o) => {
      charge(c.b, 16 + Math.min(80, (o.label || o.text).length));
      const st: string[] = [];
      if (o.selected) st.push('selected');
      if (o.disabled) st.push('disabled');
      return { k: 'option' as const, role: 'option', name: clip(o.label || o.text, 80), n: 0, st, v: null, red: false, kids: [] };
    });
  }
  /** Returns true if anything visible was found in the subtree. */
  function visit(n: Node, op: number, out: Item[], c: SnapCtx): boolean {
    if (n.nodeType === 3) {
      const v = n.nodeValue || '';
      if (!v.trim()) return false;
      if (!textNodeVisible(n)) {
        c.hidden++;
        return false;
      }
      if (c.all) out.push(v);
      return true;
    }
    if (n.nodeType === 11) {
      let vis = false;
      for (const k of kids(n)) vis = visit(k, op, out, c) || vis;
      return vis;
    }
    if (n.nodeType !== 1) return false;
    if (spent(c.b)) return false;
    const el = n as Element;
    const tag = el.localName;
    if (SKIP.has(tag)) return false;
    const ty = inputType(el);
    if (ty === 'hidden') return false;
    const h = hiddenState(el, op);
    if (h === 'subtree') {
      if (ty === 'file' && !(el as HTMLInputElement).disabled) {
        // Styled upload widgets hide the real <input type=file>; keep it reachable for upload_file.
        const name = accName(el, 'button', 80);
        const r = refFor(el, sigOf('button', name));
        out.push(elNode('button', name, r, { st: ['type=file', 'hidden'], v: null, red: false }, c.b));
        return true;
      }
      if (meaningful(el)) c.hidden++;
      return false;
    }
    const o = parseFloat(css(el).opacity);
    const nop = isNaN(o) ? op : op * o;
    const selfShown = h === '' || h === 'contents';
    const role = h === 'self' ? '' : roleOf(el);
    const interactive = h !== 'self' && isInteractive(el, role);

    if (role === 'iframe') {
      if (h !== '') return false;
      const r = refFor(el, sigOf('iframe', ''));
      charge(c.b, 40);
      out.push({ k: 'iframe', role: 'iframe', name: '', n: r, st: [], v: null, red: false, kids: [] });
      return true;
    }
    const leaf =
      tag === 'select' || tag === 'textarea' || tag === 'input' || tag === 'svg' || tag === 'img' ||
      tag === 'canvas' || tag === 'video' || tag === 'audio' || tag === 'object' || tag === 'embed' ||
      (role === 'textbox' && isCEHost(el));
    const sub: Item[] = [];
    let vis = h === '';
    if (!leaf) for (const k of kids(el)) vis = visit(k, nop, sub, c) || vis;
    if (!vis && h !== 'contents' && !selfShown) {
      if (h === 'zero' && meaningful(el)) c.hidden++;
      return false;
    }

    if (interactive) {
      const r0 = role || 'button';
      const name = accName(el, r0, 80);
      const r = refFor(el, sigOf(r0, name));
      const node = elNode(r0, name, r, statesOf(el, r0, name, c.redact), c.b);
      node.kids = tag === 'select' ? optionKids(el, c) : nodesOf(sub);
      out.push(node);
      return true;
    }
    const isLandmark = LANDMARKS.has(role);
    const isContent = CONTENT.has(role);
    if (isLandmark || (role === 'heading' && !c.all)) {
      const k = nodesOf(sub);
      if (c.all || k.length) {
        const name = accName(el, role, role === 'heading' ? 120 : 80);
        const r = refFor(el, sigOf(role, name));
        const node = elNode(role, name, r, statesOf(el, role, name, c.redact), c.b);
        if (c.all) flush(sub, node.kids);
        else node.kids = k;
        if (c.all && !node.kids.length && !name && role !== 'heading') {
          for (const x of sub) out.push(x);
          return vis;
        }
        out.push(node);
        return true;
      }
      for (const x of k) out.push(x);
      return vis;
    }
    if (c.all && isContent) {
      const texty = TEXTY.has(role) || role === 'heading';
      const name = texty ? accName(el, role, 200) : accName(el, role, 80);
      if (role === 'img' && !name) return vis;
      const kidsOut: ONode[] = [];
      if (texty) kidsOut.push(...nodesOf(sub));
      else flush(sub, kidsOut);
      if (!name && !kidsOut.length && role !== 'img') return vis;
      const r = refFor(el, sigOf(role, name));
      const node = elNode(role, name, r, statesOf(el, role, name, c.redact), c.b);
      node.kids = kidsOut;
      out.push(node);
      return true;
    }
    // transparent element
    if (c.all) {
      if (tag === 'label' && (el as HTMLLabelElement).control) {
        // Its text is already the labelled control's name.
        for (const x of sub) if (typeof x !== 'string') out.push(x);
      } else if (tag === 'br') {
        out.push(' ');
      } else if (!/^inline/.test(css(el).display)) {
        // Block: its loose text becomes its own line(s).
        const nodes: ONode[] = [];
        flush(sub, nodes);
        for (const x of nodes) out.push(x);
      } else for (const x of sub) out.push(x);
    } else for (const x of sub) if (typeof x !== 'string') out.push(x);
    return vis;
  }
  function flatten(nodes: ONode[], depth: number, out: RtNode[]): void {
    for (const nd of nodes) {
      out.push({ d: depth, k: nd.k, role: nd.role, name: nd.name, n: nd.n, st: nd.st, v: nd.v, red: nd.red });
      flatten(nd.kids, depth + 1, out);
    }
  }
  function snapshot(a: RtSnapshotArgs): RtSnapshotResult | RtErr {
    begin();
    let root: Element | null;
    if (a.rootN) {
      root = lookup(a.rootN);
      if (!root) return { __err: ['STALE_REF', 'scope'] };
    } else {
      prune();
      root = document.body || document.documentElement;
    }
    const c: SnapCtx = {
      all: a.filter === 'all',
      redact: !!a.redactAll || PAYMENT_HERE,
      hidden: 0,
      root: root as Element,
      b: budgetOf(a.maxChars, a.timeMs),
    };
    snapBudget = c.b;
    const items: Item[] = [];
    if (root) visit(root, a.rootN ? cumulativeOpacity(root) : 1, items, c);
    const top: ONode[] = [];
    if (c.all) flush(items, top);
    else top.push(...nodesOf(items));
    snapBudget = null;
    const nodes: RtNode[] = [];
    flatten(top, 0, nodes);
    return { title: document.title || '', url: location.href, nodes, hidden: c.hidden, cut: c.b.cut };
  }

  // ---- find ----
  function ownText(el: Element): string {
    let s = '';
    for (const k of kids(el)) if (k.nodeType === 3 && (k.nodeValue || '').trim() && textNodeVisible(k)) s += k.nodeValue;
    return collapse(s);
  }
  function find(a: { query: string; limit: number; timeMs: number }): { cands: RtFindCand[]; iframes: number[]; cut: RtCut } {
    begin();
    const needle = collapse(a.query).toLowerCase();
    const cands: RtFindCand[] = [];
    const iframes: number[] = [];
    const b = budgetOf(0, a.timeMs);
    findCands = [];
    if (!needle) return { cands, iframes, cut: '' };
    const stack: Array<{ label: RtCtx | null; heading: RtCtx | null }> = [{ label: null, heading: null }];
    const context = (): RtCtx[] => {
      const chain: RtCtx[] = [];
      for (let i = 1; i < stack.length; i++) {
        const l = (stack[i] as { label: RtCtx | null }).label;
        // Fresh tuples: BiDi serialization does not round-trip repeated references to one object.
        if (l) chain.push([l[0], l[1]]);
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        const hd = (stack[i] as { heading: RtCtx | null }).heading;
        if (hd) {
          chain.push([hd[0], hd[1]]);
          break;
        }
      }
      return chain;
    };
    const hit = (s: string): boolean => !!s && s.toLowerCase().includes(needle);
    const rec = (n: Node, op: number, parent: number): void => {
      if (cands.length >= 2000) return;
      if (n.nodeType === 11) {
        for (const k of kids(n)) rec(k, op, parent);
        return;
      }
      if (n.nodeType !== 1) return;
      if (spent(b)) return;
      const el = n as Element;
      const tag = el.localName;
      if (SKIP.has(tag) || inputType(el) === 'hidden') return;
      const h = hiddenState(el, op);
      if (h === 'subtree' && inputType(el) !== 'file') return;
      const o = parseFloat(css(el).opacity);
      const nop = isNaN(o) ? op : op * o;
      let role = h === 'self' ? '' : roleOf(el);
      if (role === 'iframe') {
        if (h === '') iframes.push(refFor(el, sigOf('iframe', '')));
        return;
      }
      const interactive = h !== 'self' && isInteractive(el, role);
      if (interactive && !role) role = 'button';
      let me = parent;
      const nameMax = TEXTY.has(role) ? 200 : 80;
      let name = '';
      if (role || interactive) name = accName(el, role, nameMax);
      if (h !== 'zero' && h !== 'self') {
        let text = '';
        if (!role) text = ownText(el);
        else if (!interactive && !NAME_FROM_CONTENT.has(role)) text = ownText(el);
        const placeholder = el.getAttribute('placeholder') || '';
        const label = /^(input|select|textarea)$/.test(tag) ? labelsOf(el) : '';
        if ((role || interactive || text) && (hit(name) || hit(role) || hit(text) || hit(placeholder) || hit(label))) {
          const r = role || 'text';
          const nm = name || clip(text, 80);
          me = cands.length;
          cands.push({ i: me, p: parent, role: r, name: nm, text: clip(text, 200), placeholder, label, interactive, context: context() });
          findCands.push({ el, sig: sigOf(r, nm) });
        }
      }
      if (role === 'heading') {
        (stack[stack.length - 1] as { heading: RtCtx | null }).heading = ['heading', name || accName(el, role, 80)];
      }
      if (tag === 'select' || tag === 'textarea' || tag === 'input' || tag === 'svg' || (role === 'textbox' && isCEHost(el))) return;
      const pushCtx = LANDMARKS.has(role);
      if (pushCtx) stack.push({ label: [role, accName(el, role, 60)], heading: null });
      for (const k of kids(el)) rec(k, nop, me);
      if (pushCtx) stack.pop();
    };
    const root = document.body || document.documentElement;
    if (root) rec(root, 1, -1);
    return { cands, iframes, cut: b.cut };
  }
  function findRefs(a: { idx: number[] }): number[] {
    return a.idx.map((i) => {
      const c = findCands[i];
      if (!c || !c.el.isConnected) return 0;
      return refFor(c.el, c.sig);
    });
  }

  // ---- readText ----
  const DROP_TAGS = new Set(['nav', 'aside', 'footer', 'input', 'select', 'textarea', 'option', 'svg', 'canvas', 'video', 'audio', 'button']);
  const DROP_ROLES = new Set(['navigation', 'complementary', 'contentinfo']);
  function pickRoot(): Element | null {
    const body = document.body || document.documentElement;
    const cands: Element[] = [];
    const m = document.querySelector('main, [role="main"]');
    if (m) cands.push(m);
    const arts = document.querySelectorAll('article');
    if (arts.length === 1 && arts[0]) cands.push(arts[0]);
    for (const c of cands) {
      if (hiddenState(c, 1) === 'subtree') continue;
      const len = ((c as HTMLElement).innerText || '').trim().length;
      if (len >= 200) return c;
    }
    return body;
  }
  function readText(a: { rootN: number; maxChars: number; timeMs: number }): RtReadResult | RtErr {
    begin();
    const b = budgetOf(a.maxChars, a.timeMs);
    let root: Element | null;
    if (a.rootN) {
      root = lookup(a.rootN);
      if (!root) return { __err: ['STALE_REF', 'scope'] };
    } else root = pickRoot();
    const items: Array<string | number> = [];
    let line = '';
    const nl = (): void => {
      const t = collapse(line);
      if (t && t !== '-') {
        items.push(t);
        charge(b, t.length + 1);
      }
      line = '';
    };
    const add = (t: string): void => {
      items.push(t);
      charge(b, t.length + 1);
    };
    const rec = (n: Node, op: number): void => {
      if (n.nodeType === 3) {
        if (textNodeVisible(n)) line += n.nodeValue || '';
        return;
      }
      if (n.nodeType === 11) {
        for (const k of kids(n)) rec(k, op);
        return;
      }
      if (n.nodeType !== 1) return;
      if (spent(b)) return;
      const el = n as Element;
      const tag = el.localName;
      if (SKIP.has(tag)) return;
      if (el !== root) {
        if (DROP_TAGS.has(tag)) return;
        const r = el.getAttribute('role');
        if (r && DROP_ROLES.has(r)) return;
      }
      const h = hiddenState(el, op);
      if (h === 'subtree') return;
      const o = parseFloat(css(el).opacity);
      const nop = isNaN(o) ? op : op * o;
      if (tag === 'iframe' || tag === 'frame') {
        if (h !== '') return;
        nl();
        items.push(refFor(el, sigOf('iframe', '')));
        return;
      }
      if (tag === 'br') {
        nl();
        return;
      }
      const role = roleOf(el);
      if (role === 'heading' && h === '') {
        nl();
        const t = textOf(el, 300, false);
        if (t) add('#'.repeat(Math.min(6, headingLevel(el))) + ' ' + t);
        return;
      }
      if (tag === 'tr') {
        nl();
        const cells: string[] = [];
        for (const k of kids(el)) {
          if (k.nodeType === 1 && /^(td|th)$/.test((k as Element).localName) && hiddenState(k as Element, nop) !== 'subtree') {
            cells.push(textOf(k as Element, 300, true));
          }
        }
        const t = cells.filter(Boolean).join(' | ');
        if (t) add(t);
        return;
      }
      if (tag === 'li' || role === 'listitem') {
        nl();
        line = '- ';
        for (const k of kids(el)) rec(k, nop);
        nl();
        return;
      }
      const block = !/^inline/.test(css(el).display);
      if (block) nl();
      for (const k of kids(el)) rec(k, nop);
      if (block) nl();
    };
    if (root) rec(root, a.rootN ? cumulativeOpacity(root) : 1);
    nl();
    return { title: document.title || '', url: location.href, items, cut: b.cut };
  }

  // ---- element info ----
  function isEditableEl(el: Element): boolean {
    if (el.matches(':disabled')) return false;
    const tag = el.localName;
    if (tag === 'input') return TEXT_INPUTS.has(inputType(el)) && !(el as HTMLInputElement).readOnly;
    if (tag === 'textarea') return !(el as HTMLTextAreaElement).readOnly;
    if (tag === 'select') return true;
    return (el as HTMLElement).isContentEditable === true;
  }
  function absUrl(u: string | null): string | null {
    if (!u) return null;
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  }

  // ---- form summary (finding #10): what a submit/send button would send ----
  const DIALOG_SEL = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const EMAIL_RE = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/;
  const ANGLE_EMAIL_RE = /<([^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+)>/;
  /** An email address carried in an element's attributes (recipient chips: Gmail, Outlook, …). */
  function chipEmail(e: Element): string | null {
    const attrs = e.attributes;
    for (let i = 0; i < attrs.length && i < 40; i++) {
      const a = attrs[i] as Attr;
      if (a.name === 'href' || a.name === 'value' || a.name === 'placeholder') continue;
      const v = a.value.trim();
      if (!v || v.length > 200) continue;
      if (EMAIL_RE.test(v)) return v;
      const m = ANGLE_EMAIL_RE.exec(v);
      if (m && m[1]) return m[1];
    }
    return null;
  }
  function formSummary(el: Element, role: string, isSubmit: boolean, redactAll: boolean): string | null {
    if (!(role === 'button' || role === 'menuitem' || isSubmit)) return null;
    const container =
      closestUp(el, DIALOG_SEL) || ((el as HTMLButtonElement).form as Element | null) || closestUp(el, 'form');
    if (!container) return null;
    const redact = redactAll || PAYMENT_HERE;
    interface Field {
      el: Element;
      label: string;
      value: string;
      chips: string[];
    }
    const fields: Field[] = [];
    const chips: Array<{ el: Element; email: string }> = [];
    const seen = new Set<string>();
    let budget = 5000;
    const rec = (n: Node, op: number): void => {
      if (--budget < 0) return;
      if (n.nodeType === 11) {
        for (const k of kids(n)) rec(k, op);
        return;
      }
      if (n.nodeType !== 1) return;
      const e = n as Element;
      const tag = e.localName;
      if (SKIP.has(tag)) return;
      const ty = inputType(e);
      if (ty === 'hidden') return;
      if (hiddenState(e, op) === 'subtree') return;
      const o = parseFloat(css(e).opacity);
      const nop = isNaN(o) ? op : op * o;
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || isCEHost(e);
      if (isField) {
        if (e === el || e.matches(':disabled')) return;
        if (tag === 'input' && /^(button|submit|reset|image|file)$/.test(ty)) return;
        const fr = roleOf(e) || 'textbox';
        const label = accName(e, fr, 60) || e.getAttribute('name') || tag;
        let value = '';
        if (ty === 'checkbox' || ty === 'radio') value = (e as HTMLInputElement).checked ? 'checked' : '';
        else value = valueOf(e) || '';
        if (value && (redact || isSecret(e, label))) value = '[redacted]';
        else value = clip(value, 150);
        fields.push({ el: e, label, value, chips: [] });
        return;
      }
      if (e !== el) {
        const em = chipEmail(e);
        if (em && !seen.has(em.toLowerCase())) {
          seen.add(em.toLowerCase());
          chips.push({ el: e, email: em });
        }
      }
      for (const k of kids(e)) rec(k, nop);
    };
    begin();
    rec(container, cumulativeOpacity(container));
    const loose: string[] = [];
    for (const c of chips) {
      let owner: Field | null = null;
      for (let a: Element | null = up(c.el); a && !owner; a = a === container ? null : up(a)) {
        for (const f of fields) {
          if (a.contains(f.el)) {
            owner = f;
            break;
          }
        }
      }
      if (owner) owner.chips.push(c.email);
      else loose.push(c.email);
    }
    const parts: string[] = [];
    if (loose.length) parts.push('Recipients: ' + loose.join(', '));
    for (const f of fields) {
      const vals = f.chips.slice();
      if (f.value) vals.push(f.value);
      if (vals.length) parts.push(f.label + ': ' + vals.join(', '));
    }
    if (!parts.length) return null;
    const s = parts.join(' · ');
    return s.length > 600 ? s.slice(0, 599) + '…' : s;
  }

  function describe(a: { n: number; redactAll: boolean }): RtElementInfo | null {
    const el = lookup(a.n);
    if (!el) return null;
    begin();
    const tag = el.localName;
    let role = roleOf(el);
    if (!role || !INTERACTIVE.has(role)) {
      if (isClickable(el) && !LANDMARKS.has(role)) role = role || 'button';
    }
    if (!role) role = 'generic';
    const ty = tag === 'input' ? inputType(el) : null;
    const form = ((el as HTMLInputElement).form as HTMLFormElement | null) || (closestUp(el, 'form') as HTMLFormElement | null);
    const editable = isEditableEl(el);
    let text: string | null = null;
    if (ty && /^(button|submit|reset)$/.test(ty)) text = (el as HTMLInputElement).value || null;
    else if (!editable && tag !== 'select') text = textOf(el, 200, false) || null;
    const link = closestUp(el, 'a[href], area[href]');
    let href: string | null = null;
    if (link) href = absUrl(link.getAttribute('href'));
    let isSubmit = false;
    if (tag === 'button') isSubmit = (el as HTMLButtonElement).type === 'submit' && !!form;
    else if (ty === 'submit' || ty === 'image') isSubmit = true;
    let formAction: string | null = null;
    if (form) {
      const fa = isSubmit ? el.getAttribute('formaction') : null;
      formAction = absUrl(fa || form.getAttribute('action') || document.URL);
    }
    let summary: string | null = null;
    try {
      summary = editable ? null : formSummary(el, role, isSubmit, a.redactAll);
    } catch {
      summary = null;
    }
    return {
      role,
      name: accName(el, role, 200),
      tag,
      inputType: ty,
      autocomplete: el.getAttribute('autocomplete'),
      nameAttr: el.getAttribute('name'),
      idAttr: el.getAttribute('id'),
      placeholder: el.getAttribute('placeholder'),
      labelText: labelsOf(el) || null,
      ariaLabel: el.getAttribute('aria-label'),
      text,
      href,
      isEditable: editable,
      isDisabled: el.matches(':disabled') || !!closestUp(el, '[aria-disabled="true"]'),
      isSubmit,
      inForm: !!form,
      formAction,
      formSummary: summary,
      secretHint: secretHintOf(el),
    };
  }

  // ---- editing (finding #2/#11: text is INSERTED, never sent as key presses) ----
  function editInfo(n: number): RtEditInfo | null {
    const el = lookup(n);
    if (!el) return null;
    begin();
    const tag = el.localName;
    const kind: RtEditInfo['kind'] =
      tag === 'input' ? 'input' : tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : (el as HTMLElement).isContentEditable ? 'ce' : 'other';
    return { kind, editable: isEditableEl(el) && kind !== 'select', role: roleOf(el) || (isClickable(el) ? 'button' : 'generic') };
  }
  /**
   * The field that would receive inserted text (the focused element) or the target itself is secret
   * now — e.g. it switched to type=password on focus, or focus was redirected into a password input.
   */
  function secretFocus(el: Element): string {
    begin();
    const a = deepActive();
    if (a && (a.localName === 'iframe' || a.localName === 'frame')) return 'focus-in-frame';
    if (a && a !== el) {
      const r = secretReason(a);
      if (r) return r;
    }
    return secretReason(el);
  }
  /** Keyboard focus is in el (el itself, inside it, or el is part of the focused editing host). */
  function focusIn(el: Element): boolean {
    const a = deepActive();
    if (!a) return false;
    if (a === el) return true;
    if (el.contains(a)) return true;
    return (a as HTMLElement).isContentEditable === true && (el as HTMLElement).isContentEditable === true && a.contains(el);
  }
  function focusEl(n: number): boolean {
    const el = lookup(n) as HTMLElement | null;
    if (!el) return false;
    if (!focusIn(el)) el.focus();
    return focusIn(el);
  }
  function isFocused(n: number): boolean {
    const el = lookup(n);
    return !!el && focusIn(el);
  }
  function selectAllIn(el: Element): void {
    if (el.localName === 'input' || el.localName === 'textarea') {
      (el as HTMLInputElement).select();
      return;
    }
    const sel = (el.getRootNode() as Document & { getSelection?: () => Selection | null }).getSelection?.() || window.getSelection();
    if (sel) sel.selectAllChildren(el);
  }
  function emptyEl(el: Element): boolean {
    if (el.localName === 'input' || el.localName === 'textarea') return (el as HTMLInputElement).value === '';
    return collapse(el.textContent || '') === '';
  }
  function setNativeValue(el: Element, v: string): void {
    const proto = el.localName === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v);
    else (el as HTMLInputElement).value = v;
  }
  function forceClear(el: Element): void {
    if (el.localName === 'input' || el.localName === 'textarea') setNativeValue(el, '');
    else el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  /** Select everything in el and delete it with an editing command (no key presses). */
  function clearEl(n: number): RtInsertResult {
    const el = lookup(n);
    if (!el) return 'stale';
    if (!focusIn(el)) return 'focus';
    if (secretFocus(el)) return 'secret';
    if (emptyEl(el)) return 'ok';
    selectAllIn(el);
    try {
      document.execCommand('delete', false);
    } catch {
      /* fall through to forceClear */
    }
    if (!emptyEl(el)) forceClear(el);
    return 'ok';
  }
  function caretEnd(n: number): boolean {
    const el = lookup(n);
    if (!el) return false;
    if (el.localName === 'input' || el.localName === 'textarea') {
      const i = el as HTMLInputElement;
      try {
        const len = i.value.length;
        i.setSelectionRange(len, len);
      } catch {
        /* type=email/number do not support selection ranges */
      }
      return true;
    }
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }
  function fallbackInsert(el: Element, text: string): void {
    if (el.localName === 'input' || el.localName === 'textarea') {
      const i = el as HTMLInputElement;
      let done = false;
      try {
        const s = i.selectionStart;
        const e = i.selectionEnd;
        if (s !== null && e !== null) {
          i.setRangeText(text, s, e, 'end');
          done = true;
        }
      } catch {
        done = false;
      }
      if (!done) setNativeValue(el, i.value + text);
    } else {
      const sel = window.getSelection();
      const t = document.createTextNode(text);
      if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(t);
        r.setStartAfter(t);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else el.appendChild(t);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  /**
   * Insert one chunk of text at the caret as text (execCommand insertText: fires beforeinput/input like
   * typing/IME, but no key events, so '\n' is a line break in the content and '\t' never moves focus).
   * Refuses when focus has left el or when Node's deadline has passed (a call that ran late because the
   * page was busy must not land after Node already reported TIMEOUT).
   */
  function insertText(a: { n: number; text: string; deadline: number }): RtInsertResult {
    if (Date.now() > a.deadline) return 'timeout';
    const el = lookup(a.n);
    if (!el) return 'stale';
    if (!focusIn(el)) return 'focus';
    // Re-checked right before every chunk, in the same task as the insertion: a field that turned
    // into a password field on focus (or moved focus into one) gets nothing (finding #13).
    if (secretFocus(el)) return 'secret';
    let noSelection = false;
    if (el.localName === 'input') {
      try {
        noSelection = (el as HTMLInputElement).selectionStart === null;
      } catch {
        noSelection = true;
      }
    }
    if (noSelection) {
      // email/number/date inputs have no caret API: replace the whole value with value + text.
      const cur = (el as HTMLInputElement).value;
      let done = false;
      try {
        done = document.execCommand('selectAll', false) && document.execCommand('insertText', false, cur + a.text);
      } catch {
        done = false;
      }
      if (!done || (el as HTMLInputElement).value === cur) {
        setNativeValue(el, cur + a.text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: a.text }));
      }
      return 'ok';
    }
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, a.text);
    } catch {
      ok = false;
    }
    if (!ok) fallbackInsert(el, a.text);
    return 'ok';
  }

  function selectValues(a: { n: number; values: string[] }): string[] | RtErr {
    const el = lookup(a.n);
    if (!el) return { __err: ['STALE_REF', ''] };
    begin();
    if (el.localName !== 'select') {
      const role = roleOf(el);
      const known = INTERACTIVE.has(role) || LANDMARKS.has(role) || CONTENT.has(role);
      return {
        __err: [
          'INVALID_ARG',
          `This is a custom ${known ? role : 'control'}, not a native <select>. Click it to open the list, then click the option (use find to locate it).`,
        ],
      };
    }
    const s = el as HTMLSelectElement;
    if (s.disabled) return { __err: ['NOT_EDITABLE', 'This select is disabled.'] };
    const opts = Array.from(s.options);
    const norm = (x: string): string => collapse(x).toLowerCase();
    const chosen: HTMLOptionElement[] = [];
    for (const v of a.values) {
      const o =
        opts.find((op) => op.value === v) ||
        opts.find((op) => collapse(op.label || op.text) === collapse(v)) ||
        opts.find((op) => norm(op.label || op.text) === norm(v)) ||
        opts.find((op) => norm(op.value) === norm(v));
      if (o && !o.disabled && !chosen.includes(o)) chosen.push(o);
    }
    if (!chosen.length) {
      // Option labels are page text: they travel separately so the server can wrap them (finding #8).
      const avail = opts
        .slice(0, 25)
        .map((o) => JSON.stringify(clip(o.label || o.text, 60)))
        .join(', ');
      return {
        __err: [
          'INVALID_ARG',
          `No option matches ${JSON.stringify(a.values)} (${opts.length} option${opts.length === 1 ? '' : 's'} available; their labels are listed separately as page content).`,
          `Options: ${avail}${opts.length > 25 ? ', …' : ''}`,
        ],
      };
    }
    if (s.multiple) {
      for (const o of opts) o.selected = chosen.includes(o);
    } else {
      s.value = (chosen[0] as HTMLOptionElement).value;
      (chosen[0] as HTMLOptionElement).selected = true;
    }
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return Array.from(s.selectedOptions).map((o) => o.value);
  }
  function canScroll(el: Element, dx: number, dy: number): boolean {
    const cs = css(el);
    const se = document.scrollingElement;
    const isDoc = el === se;
    if (dy) {
      const ok = isDoc || /auto|scroll|overlay/.test(cs.overflowY);
      if (ok && el.scrollHeight > el.clientHeight + 1) {
        if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
      }
    }
    if (dx) {
      const ok = isDoc || /auto|scroll|overlay/.test(cs.overflowX);
      if (ok && el.scrollWidth > el.clientWidth + 1) {
        if (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
      }
    }
    return false;
  }
  function scroll(a: { n: number; dx: number; dy: number }): { moved: boolean; target: string } {
    begin();
    let start: Element | null = null;
    if (a.n) {
      start = lookup(a.n);
      if (!start) return { moved: false, target: 'stale' };
    }
    const se = document.scrollingElement || document.documentElement;
    let target: Element | null = null;
    if (start) {
      for (let e: Element | null = start; e; e = up(e)) {
        if (canScroll(e, a.dx, a.dy)) {
          target = e;
          break;
        }
      }
    } else if (se && canScroll(se, a.dx, a.dy)) {
      target = se;
    } else {
      // App layouts (Gmail…) scroll an inner container: use the one under the viewport centre.
      const mid = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      for (let e: Element | null = mid; e; e = up(e)) {
        if (canScroll(e, a.dx, a.dy)) {
          target = e;
          break;
        }
      }
    }
    if (!target) return { moved: false, target: 'none' };
    const bx = target.scrollLeft;
    const by = target.scrollTop;
    if (target === se) window.scrollBy({ left: a.dx, top: a.dy, behavior: 'instant' as ScrollBehavior });
    else target.scrollBy({ left: a.dx, top: a.dy, behavior: 'instant' as ScrollBehavior });
    return { moved: target.scrollLeft !== bx || target.scrollTop !== by, target: target === se ? 'window' : 'element' };
  }
  function fileInfo(n: number): { isFile: boolean; multiple: boolean; disabled: boolean } | null {
    const el = lookup(n);
    if (!el) return null;
    const isFile = el.localName === 'input' && inputType(el) === 'file';
    return { isFile, multiple: isFile && (el as HTMLInputElement).multiple, disabled: isFile && (el as HTMLInputElement).disabled };
  }
  function domClick(n: number): boolean {
    const el = lookup(n) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }
  const SHADOW_HOST_TAGS = /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/;
  /**
   * Ref of the focused element (through open shadow roots). Focus inside an iframe → that iframe's ref,
   * so Node can descend. When focus sits inside a CLOSED shadow root, document.activeElement is only the
   * host: we cannot see the real target (it may be a password field), so this returns an error instead of
   * describing the host (finding #3).
   */
  function focused(): { n: number; iframe: boolean } | null | RtErr {
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.localName === 'iframe' || el.localName === 'frame') return { n: refFor(el, sigOf('iframe', '')), iframe: true };
    begin();
    const tag = el.localName;
    if (!el.shadowRoot && (tag.indexOf('-') > 0 || SHADOW_HOST_TAGS.test(tag))) {
      const selfFocusable = el.hasAttribute('tabindex') || (el as HTMLElement).isContentEditable;
      if (!selfFocusable) {
        return {
          __err: ['INTERNAL', 'Keyboard focus is inside a closed shadow root; the focused field cannot be inspected.'],
        };
      }
    }
    const role = roleOf(el) || 'generic';
    return { n: refFor(el, sigOf(role, accName(el, role, 80))), iframe: false };
  }

  // ---- hit testing (finding #7) ----
  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  function viewportBox(): Box {
    const vv = window.visualViewport;
    return vv ? { x: 0, y: 0, w: vv.width, h: vv.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  }
  function inter(a: Box, b: Box): Box | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const btm = Math.min(a.y + a.h, b.y + b.h);
    return r - x >= 1 && btm - y >= 1 ? { x, y, w: r - x, h: btm - y } : null;
  }
  function rects(el: Element): Box[] {
    return Array.from(el.getClientRects())
      .filter((r) => r.width >= 1 && r.height >= 1)
      .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
  }
  /** Visible part of el: its first box ∩ viewport ∩ clipping ancestors (falls back to viewport only). */
  function visiblePart(el: Element): Box | null {
    const vp = viewportBox();
    let clipBox: Box | null = vp;
    for (let e = up(el); e && clipBox; e = up(e)) {
      if (e === document.documentElement || e === document.body) continue;
      const cs = css(e);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = e.getBoundingClientRect();
        if (e.clientWidth > 0 && e.clientHeight > 0) {
          clipBox = inter(clipBox, { x: r.left + e.clientLeft, y: r.top + e.clientTop, w: e.clientWidth, h: e.clientHeight });
        }
      }
      if (cs.position === 'fixed') break;
    }
    const rs = rects(el);
    if (clipBox) {
      for (const r of rs) {
        const v = inter(r, clipBox);
        if (v) return v;
      }
    }
    for (const r of rs) {
      const v = inter(r, vp);
      if (v) return v;
    }
    return null;
  }
  function deepFromPoint(x: number, y: number): Element | null {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && el.shadowRoot && i < 30; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  /** hit is target, inside it (through slots/shadow roots), or a <label> of it. */
  function within(hit: Element, target: Element): boolean {
    if (target.contains(hit)) return true;
    for (let e: Element | null = hit, i = 0; e && i < 200; e = up(e), i++) {
      if (e === target) return true;
      if (e.localName === 'label' && (e as HTMLLabelElement).control === target) return true;
    }
    return false;
  }
  const COVER_HINT = /cookie|consent|banner|modal|overlay|popup|dialog|gdpr|privacy/i;
  function coverOf(hit: Element | null): RtCover {
    if (!hit) return { role: '', name: '', tag: '', id: '', n: 0 };
    let best: Element = hit;
    for (let e: Element | null = hit, i = 0; e && i < 10; e = up(e), i++) {
      if (e === document.body || e === document.documentElement) break;
      const r = roleOf(e);
      if (LANDMARKS.has(r) || r === 'alert') {
        best = e;
        break;
      }
      if (COVER_HINT.test((e.id || '') + ' ' + (e.getAttribute('class') || ''))) {
        best = e;
        break;
      }
    }
    const role = roleOf(best) || (isClickable(best) ? 'button' : '');
    // Same signature as the snapshot gives it, so an existing ref for the cover stays valid.
    const name = role ? accName(best, role, role === 'heading' ? 120 : 80) : '';
    const n = role ? refFor(best, sigOf(role, name)) : 0;
    return { role, name: clip(name, 60), tag: best.localName, id: (best.id || '').slice(0, 40), n };
  }
  function fullyVisible(el: Element): boolean {
    const rs = rects(el);
    if (!rs.length) return false;
    const r = rs[0] as Box;
    const vp = viewportBox();
    return r.x >= 0 && r.y >= 0 && r.x + r.w <= vp.w && r.y + r.h <= vp.h;
  }
  function reveal(n: number): boolean {
    const el = lookup(n);
    if (!el) return false;
    if (!fullyVisible(el)) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    return true;
  }
  function clickPoint(n: number): RtPoint {
    const el = lookup(n);
    if (!el) return { stale: true };
    begin();
    if (!rects(el).length) return { nobox: true };
    if (!fullyVisible(el)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      begin();
    }
    const v = visiblePart(el);
    if (!v) return { clipped: true };
    const x = v.x + v.w / 2;
    const y = v.y + v.h / 2;
    const hit = deepFromPoint(x, y);
    if (!hit || !within(hit, el)) return { obscured: coverOf(hit), x, y };
    return { x, y };
  }
  function frameOrigin(n: number): { x: number; y: number } | null {
    const fe = lookup(n);
    if (!fe) return null;
    const r = fe.getBoundingClientRect();
    const cs = gcs(fe);
    return {
      x: r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
      y: r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0),
    };
  }
  function frameHit(a: { n: number; x: number; y: number }): RtPoint {
    const fe = lookup(a.n);
    if (!fe) return { stale: true };
    begin();
    const o = frameOrigin(a.n) as { x: number; y: number };
    const x = o.x + a.x;
    const y = o.y + a.y;
    const vp = viewportBox();
    if (x < 0 || y < 0 || x >= vp.w || y >= vp.h) return { offscreen: true };
    const hit = deepFromPoint(x, y);
    if (hit !== fe) return { obscured: coverOf(hit), x, y };
    return { x, y };
  }
  function rectOf(n: number): Box | null {
    const el = lookup(n);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  function iframeRefs(): number[] {
    const out: number[] = [];
    const rec = (root: Document | ShadowRoot): void => {
      for (const f of Array.from(root.querySelectorAll('iframe, frame'))) out.push(refFor(f, sigOf('iframe', '')));
      for (const e of Array.from(root.querySelectorAll('*'))) if (e.shadowRoot) rec(e.shadowRoot);
    };
    rec(document);
    return out;
  }
  function docInfo(): RtDocInfo {
    const de = document.documentElement;
    const vp = viewportBox();
    const vv = window.visualViewport;
    return {
      w: Math.max(de ? de.scrollWidth : 0, 1),
      h: Math.max(de ? de.scrollHeight : 0, 1),
      vw: vp.w,
      vh: vp.h,
      px: vv ? vv.pageLeft : window.scrollX,
      py: vv ? vv.pageTop : window.scrollY,
      dpr: window.devicePixelRatio || 1,
    };
  }
  let probeEl: Element | null = null;
  let probeHit = false;
  let probeOn = false;
  function probe(a: { n: number; arm: boolean }): boolean {
    if (!a.arm) {
      const h = probeHit;
      probeEl = null;
      probeHit = false;
      return h;
    }
    probeEl = lookup(a.n);
    probeHit = false;
    if (!probeOn) {
      probeOn = true;
      window.addEventListener(
        'mousedown',
        (e) => {
          if (probeEl && e.composedPath().indexOf(probeEl) >= 0) probeHit = true;
        },
        true,
      );
    }
    return !!probeEl;
  }
  function platform(): string {
    return String(navigator.platform || '');
  }

  const api: RtApi = Object.freeze({
    v: VERSION,
    base: BASE,
    seq: () => seq,
    snapshot,
    find,
    findRefs,
    readText,
    lookup,
    describe,
    editInfo,
    focusEl,
    isFocused,
    clearEl,
    caretEnd,
    insertText,
    selectValues,
    scroll,
    fileInfo,
    domClick,
    focused,
    clickPoint,
    frameHit,
    reveal,
    rectOf,
    frameOrigin,
    iframeRefs,
    docInfo,
    probe,
    platform,
  });
  Object.defineProperty(G, KEY, { value: api, enumerable: false, configurable: false, writable: false });
  return true;
}
