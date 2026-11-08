/**
 * Page engine: snapshots with refs, find, readable text, and actions on refs.
 *
 * The in-page half (runtime.ts) runs in each frame's isolated world and returns structured data
 * only; every line of output is rendered and escaped here. Input goes through puppeteer's real mouse
 * (at a hit-tested point) and text insertion, so it behaves the same over CDP (Chrome) and WebDriver
 * BiDi (Zen).
 */
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { ElementHandle, Frame, KeyInput, Page } from 'puppeteer-core';
import { HubError, isHubError } from '../errors.js';
import { assertRefInTab, makeRef, parseRef } from '../refs.js';
import type {
  ElementInfo,
  FindMatch,
  PageEngine,
  ReadTextResult,
  Ref,
  ScrollDirection,
  SnapshotOptions,
  SnapshotResult,
  TabId,
} from '../types.js';
import {
  assembleSnapshot,
  cleanText,
  knownRole,
  macEditCommand,
  parseKeyCombo,
  quote,
  rankCandidates,
  renderContext,
  renderNode,
  safeRole,
  truncateText,
  type FindCandidate,
  type OutLine,
  type WalkCut,
} from './format.js';
import {
  DEFAULT_TIMEOUT_MS,
  frameByIndex,
  frameIndex,
  hostLabel,
  isNavError,
  isPaymentFrame,
  issued,
  lookupHandle,
  noteOwner,
  ownerOf,
  realmOf,
  resolveRef,
  rt,
  rtx,
  staleError,
  withDeadline,
  withTimeout,
  type Deadline,
} from './frames.js';
import { PageTextError, pageTextOf } from './page-error.js';
import { MAX_CAPTURE_PIXELS, planCapture, pngSize, scalePng } from './png.js';
import type { RtCover, RtElementInfo, RtFindCand, RtPoint } from './runtime.js';

export { PageTextError, pageTextOf };

/** Max nesting of iframes we descend into. */
const MAX_FRAME_DEPTH = 4;
/** Per-child-frame budget so one hung frame does not sink a whole snapshot. */
const CHILD_FRAME_TIMEOUT_MS = 5_000;
/** Characters inserted per round trip while typing (focus is re-checked between chunks). */
const TYPE_CHUNK = 2_000;
/** A chunk that reaches the page later than this before the deadline is dropped by the page. */
const TYPE_DEADLINE_MARGIN_MS = 250;
/**
 * Total time snapshot / find / read_text spend walking pages (all frames), well inside the 15 s tool
 * timeout. The in-page walker stops itself at its own deadline, so an abandoned walk never keeps the
 * page busy (finding #15).
 */
const WALK_BUDGET_MS = 6_000;
/** Longest single in-page walk (one frame). Below CHILD_FRAME_TIMEOUT_MS so child walks end on their own. */
const WALK_SLICE_MS = 4_000;

/** Shared output / time budget of one read across frames. */
interface ReadBudget {
  /** Characters still available for output lines. */
  chars: number;
  /** Epoch ms after which no more frames are walked. */
  until: number;
  cut: WalkCut;
}

function readBudget(maxChars: number): ReadBudget {
  return { chars: Math.max(0, maxChars), until: Date.now() + WALK_BUDGET_MS, cut: '' };
}

/** ms a walker may run now (≥ 50, ≤ WALK_SLICE_MS), or 0 when the read is out of time. */
function sliceMs(b: ReadBudget): number {
  const left = b.until - Date.now();
  if (left <= 0) {
    if (!b.cut) b.cut = 'time';
    return 0;
  }
  return Math.max(50, Math.min(WALK_SLICE_MS, left));
}

function noteCut(b: ReadBudget, c: unknown): void {
  if (!b.cut && (c === 'chars' || c === 'time' || c === 'nodes')) b.cut = c;
}

function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank' || url === 'about:srcdoc';
}

/** Retry once if the document navigated away mid-read. */
async function retryNav<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isNavError(e)) throw e;
    await new Promise((r) => setTimeout(r, 300));
    return fn();
  }
}

/** Child frame behind iframe element number n of `frame` (null if not loaded / unreachable). */
async function childFrameOf(frame: Frame, n: number): Promise<Frame | null> {
  const h = await lookupHandle(frame, n);
  if (!h) return null;
  try {
    const child = await h.contentFrame();
    if (child) noteOwner(child, frame, n);
    return child;
  } finally {
    await h.dispose().catch(() => undefined);
  }
}

async function frameOfRef(page: Page, ref: Ref): Promise<{ frame: Frame; n: number; k: number }> {
  const p = parseRef(ref);
  const frame = frameByIndex(page, p.frame);
  if (!frame) throw staleError(ref);
  return { frame, n: p.n, k: p.frame };
}

function remapStale(e: unknown, ref: Ref): unknown {
  if (isHubError(e) && e.code === 'STALE_REF') return staleError(ref);
  if (isNavError(e)) return staleError(ref);
  return e;
}

// ───────────────────────────── snapshot ─────────────────────────────

interface Walk {
  title: string;
  url: string;
  lines: OutLine[];
  hidden: number;
}

async function walkFrame(
  page: Page,
  tab: TabId,
  frame: Frame,
  k: number,
  rootN: number,
  filter: SnapshotOptions['filter'],
  depth: number,
  b: ReadBudget,
): Promise<Walk> {
  const timeMs = sliceMs(b);
  if (depth > 0 && (!timeMs || b.chars <= 0)) throw new HubError('TIMEOUT', 'snapshot budget used up');
  const r = await rtx(frame, 'snapshot', {
    filter,
    rootN,
    redactAll: isPaymentFrame(frame.url()),
    maxChars: Math.max(1, b.chars),
    timeMs: timeMs || 50,
  });
  const res = r.value;
  noteCut(b, res.cut);
  const lines: OutLine[] = [];
  let hidden = Number.isSafeInteger(res.hidden) && res.hidden > 0 ? res.hidden : 0;
  const push = (l: OutLine): void => {
    lines.push(l);
    b.chars -= l.text.length + 2 * l.depth + 3;
  };
  for (const nd of Array.isArray(res.nodes) ? res.nodes : []) {
    if (b.chars <= 0) {
      noteCut(b, 'chars');
      break;
    }
    if (!nd || typeof nd !== 'object') continue;
    const d = Number.isSafeInteger(nd.d) && nd.d >= 0 && nd.d <= 1000 ? nd.d : 0;
    // Only numbers this document really issued become refs (finding #9).
    const ok = issued(r, nd.n);
    if (nd.k !== 'iframe') {
      const ref = ok && (nd.k === 'el') ? makeRef(tab, k, nd.n) : null;
      push({ depth: d, text: renderNode(nd, ref), ref: ref !== null });
      continue;
    }
    if (!ok) continue;
    let child: Frame | null = null;
    let sub: Walk | null = null;
    try {
      child = await childFrameOf(frame, nd.n);
      if (child && depth < MAX_FRAME_DEPTH) {
        sub = await withTimeout(
          walkFrame(page, tab, child, frameIndex(page, child), 0, filter, depth + 1, b),
          CHILD_FRAME_TIMEOUT_MS,
          'Reading an iframe',
        );
      }
    } catch {
      sub = null;
    }
    const url = child ? child.url() : '';
    if (sub && isBlank(url) && sub.lines.length === 0) continue;
    const host = child ? hostLabel(url) : 'iframe';
    push({ depth: d, text: `iframe ${quote(host, 80)} [ref=${makeRef(tab, k, nd.n)}]${sub ? '' : ' (unreadable)'}`, ref: true });
    if (sub) {
      hidden += sub.hidden;
      // The child's lines were already charged to the budget.
      for (const l of sub.lines) lines.push({ depth: l.depth + d + 1, text: l.text, ref: l.ref });
    }
  }
  return { title: typeof res.title === 'string' ? res.title : '', url: String(res.url), lines, hidden };
}

async function snapshot(page: Page, tab: TabId, opts: SnapshotOptions): Promise<SnapshotResult> {
  return withTimeout(
    retryNav(async () => {
      let frame = page.mainFrame();
      let k = 0;
      let rootN = 0;
      if (opts.scope) {
        const p = assertRefInTab(opts.scope, tab);
        const f = frameByIndex(page, p.frame);
        if (!f) throw staleError(opts.scope);
        frame = f;
        k = p.frame;
        rootN = p.n;
      }
      const budget = readBudget(opts.maxChars);
      let walk: Walk;
      try {
        walk = await walkFrame(page, tab, frame, k, rootN, opts.filter, 0, budget);
      } catch (e) {
        throw opts.scope ? remapStale(e, opts.scope) : e;
      }
      const title = k === 0 ? walk.title : await page.title().catch(() => '');
      const url = page.url();
      const out = assembleSnapshot({
        title,
        url,
        lines: walk.lines,
        hidden: walk.hidden,
        maxChars: opts.maxChars,
        cut: budget.cut,
        emptyHint:
          opts.filter === 'interactive'
            ? '(no interactive elements visible — try filter "all", scroll, or read_text)'
            : '(nothing visible)',
      });
      return {
        text: out.text,
        url,
        title: cleanText(title, 300),
        refCount: out.refCount,
        hiddenOmitted: walk.hidden,
        truncated: out.truncated,
      };
    }),
    DEFAULT_TIMEOUT_MS,
    'Snapshot',
  );
}

// ───────────────────────────── find ─────────────────────────────

interface FCand extends FindCandidate {
  frame: Frame;
  k: number;
  i: number;
  context: string;
}

async function collectFind(
  page: Page,
  frame: Frame,
  query: string,
  limit: number,
  ctxPrefix: string,
  depth: number,
  out: FCand[],
  order: { n: number },
  b: ReadBudget,
): Promise<void> {
  const timeMs = sliceMs(b);
  if (!timeMs && depth > 0) return;
  const r = await rtx(frame, 'find', { query, limit, timeMs: timeMs || 50 });
  const res = r.value;
  noteCut(b, res.cut);
  const k = frameIndex(page, frame);
  const base = order.n;
  const cands = (Array.isArray(res.cands) ? res.cands : []) as RtFindCand[];
  for (const c of cands) {
    if (!c || !Number.isSafeInteger(c.i)) continue;
    out.push({
      role: safeRole(c.role),
      name: String(c.name ?? ''),
      text: String(c.text ?? ''),
      placeholder: String(c.placeholder ?? ''),
      label: String(c.label ?? ''),
      interactive: c.interactive === true,
      order: base + c.i,
      parent: Number.isSafeInteger(c.p) && c.p >= 0 ? base + c.p : -1,
      frame,
      k,
      i: c.i,
      context: [ctxPrefix, renderContext(c.context)].filter(Boolean).join(' › '),
    });
  }
  order.n += cands.length;
  if (depth >= MAX_FRAME_DEPTH) return;
  for (const n of Array.isArray(res.iframes) ? res.iframes : []) {
    if (!issued(r, n)) continue;
    try {
      const child = await childFrameOf(frame, n);
      if (!child) continue;
      const label = `iframe ${quote(hostLabel(child.url()), 80)}`;
      await withTimeout(
        collectFind(page, child, query, limit, [ctxPrefix, label].filter(Boolean).join(' › '), depth + 1, out, order, b),
        CHILD_FRAME_TIMEOUT_MS,
        'Searching an iframe',
      );
    } catch {
      /* unreadable frame: skip */
    }
  }
}

async function find(page: Page, tab: TabId, query: string, maxResults: number): Promise<FindMatch[]> {
  if (!query.trim()) throw new HubError('INVALID_ARG', 'find needs a non-empty query.');
  const max = Math.max(1, Math.min(200, Math.floor(maxResults) || 15));
  return withTimeout(
    retryNav(async () => {
      const cands: FCand[] = [];
      await collectFind(page, page.mainFrame(), query, max, '', 0, cands, { n: 0 }, readBudget(Infinity));
      const ranked = rankCandidates(query, cands, max);
      // Assign refs per frame for the chosen candidates.
      const byFrame = new Map<Frame, FCand[]>();
      for (const r of ranked) {
        const list = byFrame.get(r.cand.frame) ?? [];
        list.push(r.cand);
        byFrame.set(r.cand.frame, list);
      }
      const refOf = new Map<FCand, number>();
      for (const [frame, list] of byFrame) {
        const r = await rtx(frame, 'findRefs', { idx: list.map((c) => c.i) });
        list.forEach((c, j) => {
          const n = Array.isArray(r.value) ? r.value[j] : 0;
          if (issued(r, n)) refOf.set(c, n);
        });
      }
      const out: FindMatch[] = [];
      for (const r of ranked) {
        const n = refOf.get(r.cand);
        if (!n) continue;
        out.push({ ref: makeRef(tab, r.cand.k, n), role: r.cand.role, name: cleanText(r.cand.name, 200), context: r.cand.context });
      }
      return out;
    }),
    DEFAULT_TIMEOUT_MS,
    'find',
  );
}

// ───────────────────────────── readText ─────────────────────────────

async function frameText(page: Page, frame: Frame, rootN: number, depth: number, b: ReadBudget): Promise<string[]> {
  const timeMs = sliceMs(b);
  if (depth > 0 && (!timeMs || b.chars <= 0)) return [];
  const r = await rtx(frame, 'readText', { rootN, maxChars: Math.max(1, b.chars), timeMs: timeMs || 50 });
  noteCut(b, r.value.cut);
  const lines: string[] = [];
  const push = (t: string): void => {
    lines.push(t);
    b.chars -= t.length + 1;
  };
  for (const it of Array.isArray(r.value.items) ? r.value.items : []) {
    if (b.chars <= 0) {
      noteCut(b, 'chars');
      break;
    }
    if (typeof it === 'string') {
      const t = cleanText(it);
      if (t) push(t);
      continue;
    }
    if (!issued(r, it) || depth >= MAX_FRAME_DEPTH) continue;
    try {
      const child = await childFrameOf(frame, it);
      if (!child) continue;
      const sub = await withTimeout(frameText(page, child, 0, depth + 1, b), CHILD_FRAME_TIMEOUT_MS, 'Reading an iframe');
      if (!sub.length) continue;
      lines.push(`[iframe ${cleanText(hostLabel(child.url()), 80)}]`, ...sub, '[/iframe]');
    } catch {
      push('[iframe (unreadable)]');
    }
  }
  return lines;
}

async function readText(page: Page, opts: { scope?: Ref; maxChars: number }): Promise<ReadTextResult> {
  return withTimeout(
    retryNav(async () => {
      let frame = page.mainFrame();
      let rootN = 0;
      if (opts.scope) {
        const r = await frameOfRef(page, opts.scope);
        frame = r.frame;
        rootN = r.n;
      }
      const budget = readBudget(opts.maxChars + 1);
      let lines: string[];
      try {
        lines = await frameText(page, frame, rootN, 0, budget);
      } catch (e) {
        throw opts.scope ? remapStale(e, opts.scope) : e;
      }
      const full = lines.join('\n');
      const tooBig = budget.cut === 'time' || budget.cut === 'nodes';
      const note = tooBig
        ? '\n[page too large: stopped reading part-way — use read_text with a scope ref, or find]'
        : `\n[truncated at ${opts.maxChars} chars — use read_text with a scope ref, or find]`;
      const t = truncateText(full, Math.max(0, opts.maxChars - note.length));
      const truncated = t.truncated || tooBig;
      return {
        text: truncated ? t.text + note : t.text,
        url: page.url(),
        title: cleanText(await page.title().catch(() => ''), 300),
        truncated,
      };
    }),
    DEFAULT_TIMEOUT_MS,
    'read_text',
  );
}

// ───────────────────────────── describe ─────────────────────────────

const TAG_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * ElementInfo.secretHint values the runtime may report (anything else from the page is dropped):
 * 'text-security' CSS-masked field · 'otp-digit-group' one of ≥ 4 one-character code boxes ·
 * 'otp-like' short numeric field described as a code ("6-digit code", "verification code") ·
 * 'nearby-label' unlabelled field whose preceding text is a secret label ("Password" in a <div>) ·
 * 'card-like' placeholder shaped like a card number.
 */
export const SECRET_HINTS: ReadonlySet<string> = new Set(['text-security', 'otp-digit-group', 'otp-like', 'nearby-label', 'card-like']);

function optText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = cleanText(v, max);
  return t ? t : null;
}

function optUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    return new URL(v).href;
  } catch {
    return null;
  }
}

/** Page facts → ElementInfo with every page-supplied string escaped (findings #9, R1). */
function toInfo(ref: Ref, info: RtElementInfo, frameUrl: string): ElementInfo {
  const tag = typeof info.tag === 'string' && TAG_RE.test(info.tag) ? info.tag : 'unknown';
  const inputType = typeof info.inputType === 'string' && TAG_RE.test(info.inputType) ? info.inputType : null;
  return {
    ref,
    role: safeRole(info.role),
    name: cleanText(info.name, 200),
    tag,
    inputType,
    autocomplete: optText(info.autocomplete, 200),
    nameAttr: optText(info.nameAttr, 200),
    idAttr: optText(info.idAttr, 200),
    placeholder: optText(info.placeholder, 200),
    labelText: optText(info.labelText, 200),
    ariaLabel: optText(info.ariaLabel, 200),
    text: optText(info.text, 200),
    href: optUrl(info.href),
    isEditable: info.isEditable === true,
    isDisabled: info.isDisabled === true,
    isSubmit: info.isSubmit === true,
    inForm: info.inForm === true,
    formAction: optUrl(info.formAction),
    frameUrl,
    formSummary: optText(info.formSummary, 600),
    secretHint: typeof info.secretHint === 'string' && SECRET_HINTS.has(info.secretHint) ? info.secretHint : null,
  };
}

/**
 * Live facts about the element behind `ref`. For button-like controls inside a <form> or a dialog
 * ([role=dialog], <dialog>, aria-modal), `formSummary` lists the visible field values a click would
 * send (labels from accessible names, recipient chips, contenteditable bodies; secret fields and
 * payment frames as [redacted]; ≤ 600 chars).
 */
async function describe(page: Page, ref: Ref): Promise<ElementInfo> {
  return withTimeout(
    (async () => {
      const { frame, n } = await frameOfRef(page, ref);
      let info;
      try {
        info = await rt(frame, 'describe', { n, redactAll: isPaymentFrame(frame.url()) });
      } catch (e) {
        throw remapStale(e, ref);
      }
      if (!info) throw staleError(ref);
      return toInfo(ref, info, frame.url());
    })(),
    DEFAULT_TIMEOUT_MS,
    'describe',
  );
}

// ───────────────────────────── hit-tested pointer (finding #7) ─────────────────────────────

/** A covering element as found by the hit test, with the frame it lives in (for its ref). */
interface Cover {
  c: RtCover;
  frame: Frame;
  /** The cover's element number was issued by that frame's current document. */
  ok: boolean;
}

/** Cover text the model may see only wrapped as page content: its role, name and id. */
function coverPageText(c: RtCover): string {
  const what = knownRole(c.role, typeof c.tag === 'string' && TAG_RE.test(c.tag) ? c.tag : 'element');
  const name = cleanText(c.name, 60);
  const id = cleanText(c.id, 40);
  return `covering element: ${what}${name ? ` ${JSON.stringify(name)}` : ''}${id ? ` (id ${JSON.stringify(id)})` : ''}`;
}

/**
 * OBSCURED, worded without page text (finding #8): the cover is named by role and ref only; its
 * name/id ride in PageTextError.pageText for the server to show wrapped.
 */
function obscuredError(page: Page, ref: Ref, cover: Cover | null): HubError {
  let what = 'another element';
  if (cover) {
    const role = knownRole(cover.c.role, '');
    let coverRef = '';
    if (cover.ok && !cover.frame.detached) {
      try {
        coverRef = makeRef(parseRef(ref).tab, frameIndex(page, cover.frame), cover.c.n);
      } catch {
        coverRef = '';
      }
    }
    what = `${role ? `a ${role}` : 'another element'}${coverRef ? ` [ref=${coverRef}]` : ''}`;
  }
  const msg = `${ref} is covered by ${what} at its click point — nothing was clicked. Close or dismiss that element first (snapshot to find it), or scroll, then retry.`;
  return cover ? new PageTextError('OBSCURED', msg, coverPageText(cover.c)) : new HubError('OBSCURED', msg);
}

function notVisibleError(ref: Ref): HubError {
  return new HubError(
    'OBSCURED',
    `${ref} has no visible area on screen (clipped by a scroll container or outside its frame) — nothing was clicked. Scroll it into view (scroll with target) and retry.`,
  );
}

type Owner = { parent: Frame; n: number; child: Frame };
type Point = { x: number; y: number; obscured: Cover | null; chain: Owner[] };

function coverIn(frame: Frame, r: { base: number; seq: number }, p: RtPoint): Cover | null {
  if (!('obscured' in p) || !p.obscured || typeof p.obscured !== 'object') return null;
  const c = p.obscured;
  return { c, frame, ok: issued(r, c.n) };
}

function finite(p: RtPoint): p is RtPoint & { x: number; y: number } {
  const q = p as { x?: unknown; y?: unknown };
  return typeof q.x === 'number' && typeof q.y === 'number' && Number.isFinite(q.x) && Number.isFinite(q.y);
}

/**
 * Top-level viewport point for element n of `frame`: scrolled into view, the centre of its visible
 * part, hit-tested in its own frame and at every ancestor iframe. `obscured` is set (and the point is
 * where the cover is) when something else would receive the pointer. 'nobox' = no layout box at all.
 */
async function pointFor(frame: Frame, n: number, ref: Ref): Promise<Point | 'nobox'> {
  const chain: Owner[] = [];
  for (let f = frame; f.parentFrame(); ) {
    const o = await ownerOf(f);
    if (!o) throw new HubError('INTERNAL', `Cannot locate the iframe that contains ${ref}; nothing was clicked.`);
    chain.push({ ...o, child: f });
    f = o.parent;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i] as { parent: Frame; n: number };
    await rt(c.parent, 'reveal', c.n);
  }
  const pr = await rtx(frame, 'clickPoint', n);
  const p = pr.value;
  if ('stale' in p) throw staleError(ref);
  if ('nobox' in p) return 'nobox';
  if ('clipped' in p || !finite(p)) throw notVisibleError(ref);
  let cover: Cover | null = coverIn(frame, pr, p);
  let x = p.x;
  let y = p.y;
  for (const c of chain) {
    let qr = await rtx(c.parent, 'frameHit', { n: c.n, x, y });
    if ('stale' in qr.value) {
      const o = await ownerOf(c.child, true);
      if (!o) throw staleError(ref);
      c.n = o.n;
      qr = await rtx(o.parent, 'frameHit', { n: o.n, x, y });
    }
    const q = qr.value;
    if ('offscreen' in q || 'stale' in q || !finite(q)) throw notVisibleError(ref);
    if (!cover) cover = coverIn(c.parent, qr, q);
    x = q.x;
    y = q.y;
  }
  return { x, y, obscured: cover, chain };
}

// ───────────────────────────── actions ─────────────────────────────

/** Resolve a ref to its frame + element number (STALE_REF if gone) and run fn under a deadline. */
async function withTarget<T>(
  page: Page,
  ref: Ref,
  what: string,
  fn: (frame: Frame, n: number, d: Deadline) => Promise<T>,
  ms = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return withDeadline(
    async (d) => {
      const { frame, n } = await frameOfRef(page, ref);
      try {
        return await fn(frame, n, d);
      } catch (e) {
        throw remapStale(e, ref);
      }
    },
    ms,
    what,
  );
}

async function withHandle<T>(
  page: Page,
  ref: Ref,
  what: string,
  fn: (h: ElementHandle<Element>, frame: Frame, n: number) => Promise<T>,
): Promise<T> {
  return withTimeout(
    (async () => {
      const { handle, frame, parsed } = await resolveRef(page, ref);
      try {
        return await fn(handle, frame, parsed.n);
      } catch (e) {
        throw remapStale(e, ref);
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    })(),
    DEFAULT_TIMEOUT_MS,
    what,
  );
}

/** Longest wait for the page to settle before a click (inside the action deadline). */
const SETTLE_MS = 2_000;
/** How long after a click a DOM or URL change still counts as the page reacting. */
const VERIFY_MS = 500;
const POLL_MS = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Before a click: wait (at most SETTLE_MS) until the page finished loading (late handlers), is visible (a
 * background tab is brought to front once: pages and players ignore input while hidden) and the target is not
 * covered (loading veils). Never fails: a page that does not settle is clicked as before, and a cover that stays is
 * reported as OBSCURED by clickTarget.
 */
async function settle(page: Page, frame: Frame, n: number, d: Deadline): Promise<void> {
  const until = Math.min(Date.now() + SETTLE_MS, d.at - 1_000);
  let fronted = false;
  for (;;) {
    const main = await rt(page.mainFrame(), 'pageState', null).catch(() => ({ ready: true, visible: true }));
    const here = frame === page.mainFrame() ? main : await rt(frame, 'pageState', null).catch(() => main);
    if (!main.visible && !fronted) {
      fronted = true;
      await page.bringToFront().catch(() => undefined);
    }
    const p = main.ready && here.ready && main.visible ? await rt(frame, 'clickPoint', n) : null;
    if (p && !('obscured' in p && p.obscured)) return;
    if (Date.now() + POLL_MS > until) return;
    await sleep(POLL_MS);
  }
}

/** After a click: did the target's document change (DOM or URL) within VERIFY_MS? A navigation counts as a change. */
async function reacted(frame: Frame): Promise<boolean> {
  const until = Date.now() + VERIFY_MS;
  for (;;) {
    if (frame.detached) return true;
    const changed = await rt(frame, 'watch', false).catch(() => true);
    if (changed || Date.now() + POLL_MS > until) return changed;
    await sleep(POLL_MS);
  }
}

const NO_CHANGE_NOTE = '(no change on the page after the click: it may still be loading or the click missed; snapshot to check before retrying)';

/** Click element n of frame at its hit-tested point; OBSCURED (and no click) if something covers it. */
async function clickTarget(
  page: Page,
  frame: Frame,
  n: number,
  ref: Ref,
  d: Deadline,
  opts?: { double?: boolean; button?: 'left' | 'right' | 'middle' },
): Promise<void> {
  const button = opts?.button ?? 'left';
  const count = opts?.double ? 2 : 1;
  let pt = await pointFor(frame, n, ref);
  d.check();
  if (pt === 'nobox') {
    // Elements without a box (e.g. hidden file inputs) cannot take a real click.
    if (button === 'left' && count === 1) {
      if (!(await rt(frame, 'domClick', n))) throw staleError(ref);
      return;
    }
    throw new HubError('INVALID_ARG', `Element ${ref} has no clickable area (hidden or zero-size); it cannot be ${button}-clicked.`);
  }
  if (pt.obscured) throw obscuredError(page, ref, pt.obscured);
  if (!pt.chain.length) {
    await page.mouse.click(pt.x, pt.y, { button, count });
    return;
  }
  // Target in a child frame. Chrome may route the very first input to a freshly loaded
  // out-of-process iframe to the parent's <iframe> element instead (its hit-test data is not
  // ready yet): the click is silently lost. Detect exactly that case and retry once.
  for (let attempt = 0; ; attempt++) {
    await rt(frame, 'probe', { n, arm: true });
    for (const c of pt.chain) await rt(c.parent, 'probe', { n: c.n, arm: true });
    await page.mouse.click(pt.x, pt.y, { button, count });
    const reached = await rt(frame, 'probe', { n, arm: false }).catch(() => true);
    let lostInParent = false;
    for (const c of pt.chain) {
      if (await rt(c.parent, 'probe', { n: c.n, arm: false }).catch(() => false)) lostInParent = true;
    }
    if (reached || !lostInParent || attempt >= 1) return;
    await new Promise((r) => setTimeout(r, 150));
    d.check();
    const again = await pointFor(frame, n, ref);
    if (again === 'nobox') return;
    if (again.obscured) throw obscuredError(page, ref, again.obscured);
    pt = again;
  }
}

async function click(page: Page, ref: Ref, opts?: { double?: boolean; button?: 'left' | 'right' | 'middle' }): Promise<string | void> {
  return withTarget(page, ref, 'click', async (frame, n, d) => {
    await settle(page, frame, n, d);
    d.check();
    await rt(frame, 'watch', true).catch(() => undefined);
    await clickTarget(page, frame, n, ref, d, opts);
    return (await reacted(frame)) ? undefined : NO_CHANGE_NOTE;
  });
}

async function refind(page: Page, ref: Ref): Promise<Ref | null> {
  const p = parseRef(ref);
  const frame = frameByIndex(page, p.frame);
  if (!frame) return null;
  const r = await rtx(frame, 'refind', p.n).catch(() => null);
  return r && issued(r, r.value) ? makeRef(p.tab, p.frame, r.value) : null;
}

async function hover(page: Page, ref: Ref): Promise<void> {
  await withTarget(page, ref, 'hover', async (frame, n, d) => {
    const pt = await pointFor(frame, n, ref);
    d.check();
    if (pt === 'nobox') throw new HubError('INVALID_ARG', `Element ${ref} has no visible area to hover.`);
    await page.mouse.move(pt.x, pt.y);
  });
}

/** The field turned secret after the safety check (finding #13): refuse, nothing more is inserted. */
function secretError(ref: Ref, typed: number, total: number): HubError {
  const done = typed === 0 ? 'nothing was typed' : `only the first ${typed} of ${total} characters had been typed`;
  return new HubError(
    'DENIED',
    `Blocked by Stephen's safety policy — ${ref} became a password / one-time-code field when it was focused (or focus moved into one), so typing stopped (${done}). Secrets must be entered by the user: ask them to type it themselves.`,
  );
}

function focusMovedError(ref: Ref, typed: number, total: number): HubError {
  const done = typed === 0 ? 'nothing was typed' : `${typed} of ${total} characters were typed`;
  return new HubError(
    'FOCUS_MOVED',
    `Keyboard focus left ${ref} while typing — typing stopped (${done}). The page may have moved focus (autocomplete, dialog). Snapshot and retry.`,
  );
}

/** Split text into chunks without cutting a surrogate pair. */
function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Types into an editable element by INSERTING text (never key presses, finding #2):
 * - '\n' / '\r' become line breaks inside a textarea or contenteditable; in a single-line field they
 *   are rejected with INVALID_ARG (use submit: true to press Enter).
 * - '\t' is inserted as a tab character in multi-line fields and rejected in single-line fields; it
 *   never moves focus.
 * - Enter is pressed only when opts.submit is true, and only if focus is still on the element.
 * Text is inserted in chunks; between chunks the deadline and focus are re-checked: TIMEOUT or
 * FOCUS_MOVED stops typing with nothing further landing anywhere (finding #11).
 */
async function type(page: Page, ref: Ref, text: string, opts?: { clear?: boolean; submit?: boolean }): Promise<void> {
  await withTarget(page, ref, 'type', async (frame, n, d) => {
    const info = await rt(frame, 'editInfo', n);
    if (!info) throw staleError(ref);
    if (info.kind === 'select') {
      throw new HubError('NOT_EDITABLE', `${ref} is a <select>; use select_option instead of type.`);
    }
    if (!info.editable) {
      throw new HubError(
        'NOT_EDITABLE',
        `${ref} (${knownRole(info.role)}) is not an editable field (or it is disabled/read-only). Pick a textbox, searchbox or contenteditable ref.`,
      );
    }
    const multiline = info.kind === 'textarea' || info.kind === 'ce';
    const body = text.replace(/\r\n?/g, '\n');
    if (!multiline && body.includes('\n')) {
      throw new HubError(
        'INVALID_ARG',
        `${ref} is a single-line field, so the text cannot contain a line break (text is never typed as key presses). Remove the newline; to press Enter after typing, pass submit: true.`,
      );
    }
    if (!multiline && body.includes('\t')) {
      throw new HubError(
        'INVALID_ARG',
        `${ref} is a single-line field and the text contains a tab character. Tabs are never pressed as the Tab key (focus does not move between fields); type each field separately or use fill_form.`,
      );
    }
    // Focus. Child frames need a real (hit-tested) click so keyboard focus moves into the frame.
    let focused = frame === page.mainFrame() ? await rt(frame, 'focusEl', n) : false;
    if (!focused) {
      await clickTarget(page, frame, n, ref, d);
      d.check();
      focused = await rt(frame, 'focusEl', n);
    }
    if (!focused) throw focusMovedError(ref, 0, body.length);
    d.check();
    if (opts?.clear) {
      const c = await rt(frame, 'clearEl', n);
      if (c === 'stale') throw staleError(ref);
      if (c === 'focus') throw focusMovedError(ref, 0, body.length);
      if (c === 'secret') throw secretError(ref, 0, body.length);
    } else {
      await rt(frame, 'caretEnd', n);
    }
    let typed = 0;
    for (const part of chunks(body, TYPE_CHUNK)) {
      d.check();
      const res = await rt(frame, 'insertText', { n, text: part, deadline: d.at - TYPE_DEADLINE_MARGIN_MS });
      if (res === 'stale') throw staleError(ref);
      if (res === 'focus') throw focusMovedError(ref, typed, body.length);
      if (res === 'secret') throw secretError(ref, typed, body.length);
      if (res === 'timeout') d.check();
      if (res !== 'ok') throw new HubError('TIMEOUT', `Typing into ${ref} ran out of time after ${typed} of ${body.length} characters; typing stopped.`);
      typed += part.length;
    }
    if (opts?.submit) {
      d.check();
      if (!(await rt(frame, 'isFocused', n))) throw focusMovedError(ref, typed, body.length);
      d.check();
      await page.keyboard.press('Enter');
    }
  });
}

async function selectOption(page: Page, ref: Ref, values: string[]): Promise<string[]> {
  if (!values.length) throw new HubError('INVALID_ARG', 'select_option needs at least one value.');
  return withTarget(page, ref, 'select_option', async (frame, n) => {
    let out;
    try {
      out = await rt(frame, 'selectValues', { n, values });
    } catch (e) {
      // Option labels are page text: keep them out of the message (finding #8).
      if (e instanceof PageTextError) throw new PageTextError(e.code, `${ref}: ${e.message}`, e.pageText);
      throw e;
    }
    return Array.isArray(out) ? out.filter((v): v is string => typeof v === 'string') : [];
  });
}

async function pressKey(page: Page, key: string): Promise<void> {
  let combo;
  try {
    combo = parseKeyCombo(key);
  } catch (e) {
    throw new HubError('INVALID_ARG', (e as Error).message);
  }
  let mods = combo.modifiers;
  if (mods.includes('ControlOrMeta')) {
    const isMac = await rt(page.mainFrame(), 'platform', null)
      .then((p) => /Mac|iPhone|iPad/.test(p))
      .catch(() => process.platform === 'darwin');
    mods = mods.map((m) => (m === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : m));
  }
  const kb = page.keyboard;
  const pressed: string[] = [];
  await withTimeout(
    (async () => {
      try {
        for (const m of mods) {
          await kb.down(m as KeyInput);
          pressed.push(m);
        }
        const cmd = macEditCommand(mods, combo.key);
        await kb.down(combo.key as KeyInput, cmd ? { commands: [cmd] } : undefined);
        await kb.up(combo.key as KeyInput);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Unknown key/i.test(msg)) {
          throw new HubError('INVALID_ARG', `Unknown key "${combo.key}". Use names like Enter, Tab, Escape, ArrowDown, a, Meta+A.`);
        }
        throw e;
      } finally {
        for (const m of pressed.reverse()) await kb.up(m as KeyInput).catch(() => undefined);
      }
    })(),
    DEFAULT_TIMEOUT_MS,
    'press_key',
  );
}

function delta(direction: ScrollDirection, amount: number): { dx: number; dy: number } {
  const a = Math.abs(amount || 600);
  switch (direction) {
    case 'up':
      return { dx: 0, dy: -a };
    case 'down':
      return { dx: 0, dy: a };
    case 'left':
      return { dx: -a, dy: 0 };
    case 'right':
      return { dx: a, dy: 0 };
  }
}

async function scroll(page: Page, opts: { ref?: Ref; direction: ScrollDirection; amount: number }): Promise<void> {
  const { dx, dy } = delta(opts.direction, opts.amount);
  await withTimeout(
    (async () => {
      if (opts.ref) {
        const ref = opts.ref;
        const { frame, n } = await frameOfRef(page, ref);
        let r;
        try {
          r = await rt(frame, 'scroll', { n, dx, dy });
        } catch (e) {
          throw remapStale(e, ref);
        }
        if (r.target === 'stale') throw staleError(ref);
        return;
      }
      await rt(page.mainFrame(), 'scroll', { n: 0, dx, dy });
    })(),
    DEFAULT_TIMEOUT_MS,
    'scroll',
  );
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function allText(page: Page): Promise<string> {
  const parts = await Promise.all(
    page.frames().map((f) =>
      f.detached
        ? Promise.resolve('')
        : withTimeout(
            realmOf(f).evaluate(() => (document.body ? document.body.innerText : '')),
            2_000,
            'read',
          ).catch(() => ''),
    ),
  );
  return norm(parts.map(String).join('\n'));
}

async function waitFor(page: Page, opts: { text?: string; textGone?: string; timeoutMs: number }): Promise<void> {
  const timeout = Math.max(0, opts.timeoutMs);
  const want = opts.text ? norm(opts.text) : '';
  const gone = opts.textGone ? norm(opts.textGone) : '';
  if (!want && !gone) {
    await new Promise((r) => setTimeout(r, timeout));
    return;
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    const t = await allText(page);
    const okWant = !want || t.includes(want);
    const okGone = !gone || !t.includes(gone);
    if (okWant && okGone) return;
    if (Date.now() >= deadline) {
      const what = [opts.text ? `text "${opts.text}" to appear` : '', opts.textGone ? `text "${opts.textGone}" to disappear` : '']
        .filter(Boolean)
        .join(' and ');
      throw new HubError('TIMEOUT', `Timed out after ${timeout} ms waiting for ${what}.`);
    }
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
}

// ───────────────────────────── screenshot (finding #14) ─────────────────────────────

const screenshotNotes = new WeakMap<Uint8Array, string>();

/**
 * A note to show alongside a screenshot returned by pageEngine.screenshot (e.g. that a very long
 * page was clipped to the output limits), or null. Keyed by the exact Buffer returned.
 */
export function screenshotNote(png: Uint8Array): string | null {
  return screenshotNotes.get(png) ?? null;
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Document-coordinate box of element n in frame (through ancestor iframes). */
async function elementClip(page: Page, frame: Frame, n: number, ref: Ref): Promise<Clip> {
  const chain: Array<{ parent: Frame; n: number }> = [];
  for (let f = frame; f.parentFrame(); ) {
    const o = await ownerOf(f);
    if (!o) throw new HubError('INTERNAL', `Cannot locate the iframe that contains ${ref}.`);
    chain.push(o);
    f = o.parent;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i] as { parent: Frame; n: number };
    await rt(c.parent, 'reveal', c.n);
  }
  if (!(await rt(frame, 'reveal', n))) throw staleError(ref);
  const r = await rt(frame, 'rectOf', n);
  if (!r) throw staleError(ref);
  if (!(r.w >= 1 && r.h >= 1)) throw new HubError('INVALID_ARG', `${ref} has no visible box to screenshot.`);
  let x = r.x;
  let y = r.y;
  for (const c of chain) {
    const o = await rt(c.parent, 'frameOrigin', c.n);
    if (!o) throw staleError(ref);
    x += o.x;
    y += o.y;
  }
  const doc = await rt(page.mainFrame(), 'docInfo', null);
  return { x: Math.max(0, x + doc.px), y: Math.max(0, y + doc.py), width: r.w, height: r.h };
}

async function screenshot(page: Page, opts: { ref?: Ref; fullPage?: boolean; scale: number }): Promise<Buffer> {
  const want = Number.isFinite(opts.scale) ? Math.min(1, Math.max(0.1, opts.scale)) : 0.5;
  return withTimeout(
    (async () => {
      const doc = await rt(page.mainFrame(), 'docInfo', null);
      const dpr = Number.isFinite(doc.dpr) && doc.dpr > 0 ? doc.dpr : 1;
      let clip: Clip | null = null;
      let what = '';
      if (opts.ref) {
        const ref = opts.ref;
        const { frame, n } = await frameOfRef(page, ref);
        try {
          clip = await elementClip(page, frame, n, ref);
        } catch (e) {
          throw remapStale(e, ref);
        }
        what = 'element';
      } else if (opts.fullPage) {
        clip = { x: 0, y: 0, width: doc.w, height: doc.h };
        what = 'page';
      } else if (doc.vw * doc.vh * dpr * dpr > MAX_CAPTURE_PIXELS) {
        clip = { x: doc.px, y: doc.py, width: doc.vw, height: doc.vh };
        what = 'viewport';
      }
      let scale = want;
      let note: string | null = null;
      let png: Uint8Array;
      if (clip) {
        const plan = planCapture(clip.width, clip.height, dpr, want);
        scale = plan.scale;
        if (plan.clipped) {
          note = `The ${what} is ${Math.round(clip.height)} px tall; only the top ${plan.height} px were captured (screenshot limit: 8000 px per side after scaling, ${MAX_CAPTURE_PIXELS / 1e6} MP captured). Scroll and take viewport screenshots, or use read_text, for the rest.`;
        }
        png = await page.screenshot({
          type: 'png',
          clip: { x: clip.x, y: clip.y, width: plan.width, height: plan.height },
          captureBeyondViewport: true,
        });
      } else {
        png = await page.screenshot({ type: 'png' });
      }
      const { width, height } = pngSize(png);
      if (width * height > MAX_CAPTURE_PIXELS * 1.5) {
        throw new HubError('INTERNAL', `The captured screenshot is too large to process (${width}×${height}); try a smaller scale or an element screenshot.`);
      }
      const out = scalePng(png, scale);
      if (note) screenshotNotes.set(out, note);
      return out;
    })(),
    DEFAULT_TIMEOUT_MS * 2,
    'screenshot',
  );
}

async function uploadFile(page: Page, ref: Ref, paths: string[]): Promise<void> {
  if (!paths.length) throw new HubError('INVALID_ARG', 'upload_file needs at least one path.');
  const abs = paths.map((p) => resolvePath(p));
  for (const p of abs) {
    const st = await stat(p).catch(() => null);
    if (!st || !st.isFile()) throw new HubError('INVALID_ARG', `File not found: ${p}`);
  }
  await withHandle(page, ref, 'upload_file', async (h, frame, n) => {
    const info = await rt(frame, 'fileInfo', n);
    if (!info) throw staleError(ref);
    if (!info.isFile) {
      throw new HubError(
        'INVALID_ARG',
        `${ref} is not a file input. Use the ref of the input[type=file] (shown as button … type=file in the snapshot).`,
      );
    }
    if (info.disabled) throw new HubError('NOT_EDITABLE', `${ref} is a disabled file input.`);
    if (abs.length > 1 && !info.multiple) {
      throw new HubError('INVALID_ARG', `${ref} accepts a single file; got ${abs.length}.`);
    }
    await (h as ElementHandle<HTMLInputElement>).uploadFile(...abs);
  });
}

/**
 * Live facts about the element that has keyboard focus, descending through open shadow roots and
 * iframes. Contract for the server's `focus` field (finding #3):
 * - returns ElementInfo        → focus: 'element'
 * - returns null ONLY when focus is genuinely on nothing specific (document.activeElement is
 *   body/html/none in the focused frame)  → focus: 'none'
 * - THROWS (HubError 'INTERNAL', or TIMEOUT/STALE_REF/…) when the focused element cannot be
 *   determined: focus inside a closed shadow root, inside an iframe we cannot read (cross-origin /
 *   unreachable / nested too deep), or the page did not answer → focus: 'unknown' (fail closed).
 */
async function describeFocused(page: Page, tab: TabId): Promise<ElementInfo | null> {
  return withTimeout(
    (async () => {
      let frame = page.mainFrame();
      for (let depth = 0; depth <= MAX_FRAME_DEPTH; depth++) {
        const r = await rtx(frame, 'focused', null);
        const f = r.value;
        if (!f) return null;
        if (!issued(r, f.n)) throw new HubError('INTERNAL', 'The focused element could not be identified.');
        if (!f.iframe) return describe(page, makeRef(tab, frameIndex(page, frame), f.n));
        let child: Frame | null = null;
        try {
          child = await childFrameOf(frame, f.n);
        } catch {
          child = null;
        }
        if (!child) {
          throw new HubError(
            'INTERNAL',
            'Keyboard focus is inside an iframe whose content cannot be read (cross-origin, not loaded or unreachable); the focused field is unknown.',
          );
        }
        frame = child;
      }
      throw new HubError('INTERNAL', 'Keyboard focus is inside too deeply nested iframes; the focused field is unknown.');
    })(),
    DEFAULT_TIMEOUT_MS,
    'describeFocused',
  );
}

/**
 * URLs of every frame whose content a read (snapshot / find / read_text / screenshot) can expose:
 * main frame first, then every attached child frame (same- and cross-origin, any depth), skipping
 * blank ones (about:blank / about:srcdoc / empty, whose content belongs to their parent). Duplicates
 * removed. No page round trip: puppeteer's frame tree only (finding #2).
 */
async function frameUrls(page: Page): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string): void => {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  const main = page.mainFrame();
  add(page.url());
  for (const f of page.frames()) {
    if (f === main || f.detached) continue;
    let u: string;
    try {
      u = f.url();
    } catch {
      continue;
    }
    if (!isBlank(u)) add(u);
  }
  return out;
}

export const pageEngine: PageEngine = {
  snapshot,
  find,
  readText,
  describe,
  describeFocused,
  click,
  refind,
  hover,
  type,
  selectOption,
  pressKey,
  scroll,
  waitFor,
  screenshot,
  uploadFile,
  frameUrls,
};
