/**
 * Node-side bridge to the in-page runtime: per-Page frame indices and element-number high-water
 * marks, runtime installation (in each frame's isolated world), method calls, element-handle lookup,
 * frame ownership (which iframe element hosts a child frame) and timeouts.
 */
import { randomBytes } from 'node:crypto';
import type { ElementHandle, Frame, Page, Realm } from 'puppeteer-core';
import { HubError, type HubErrorCode } from '../errors.js';
import { parseRef, type ParsedRef } from '../refs.js';
import {
  PAYMENT_FRAME_DOMAINS,
  SECRET_AUTOCOMPLETE,
  SECRET_AUTOCOMPLETE_PREFIX,
  SECRET_TEXT_FLAGS,
  SECRET_TEXT_SOURCE,
} from '../lib/secret-fields.js';
import type { Ref } from '../types.js';
import { PageTextError } from './page-error.js';
import { bhRuntime, type RtApi, type RtConfig, type RtErr } from './runtime.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Name of the global holding the runtime (in the isolated world). Random per server process so it
 * cannot collide with anything puppeteer or an extension puts there.
 */
export const RUNTIME_KEY = `__bh_${randomBytes(5).toString('hex')}`;
export const RUNTIME_VERSION = '3';
const RUNTIME_FN_SRC = bhRuntime.toString();

// ───────────────────────────── timeouts ─────────────────────────────

function timeoutError(what: string, ms: number): HubError {
  return new HubError(
    'TIMEOUT',
    `${what} did not finish within ${Math.round(ms / 1000)}s. The page may be busy, navigating, or blocked by a JS dialog (use handle_dialog).`,
  );
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(what, ms)), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cancellation state handed to long-running actions (typing) so they stop once the caller gave up. */
export interface Deadline {
  /** Epoch ms after which nothing more may happen. */
  at: number;
  readonly aborted: boolean;
  /** Throws the TIMEOUT error if the deadline passed / the operation was abandoned. */
  check(): void;
}

/**
 * Like withTimeout, but `fn` receives a Deadline it must check between steps: when the timeout
 * fires, the promise rejects AND the work stops at its next check (finding #11).
 */
export async function withDeadline<T>(fn: (d: Deadline) => Promise<T>, ms: number, what: string): Promise<T> {
  const err = timeoutError(what, ms);
  let aborted = false;
  const d: Deadline = {
    at: Date.now() + ms,
    get aborted() {
      return aborted || Date.now() > this.at;
    },
    check() {
      if (this.aborted) throw err;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborted = true;
      reject(err);
    }, ms);
  });
  const work = fn(d);
  work.catch(() => undefined);
  try {
    return await Promise.race([work, t]);
  } finally {
    aborted = true;
    clearTimeout(timer);
  }
}

// ───────────────────────────── per-page registry ─────────────────────────────

interface FrameReg {
  byFrame: Map<Frame, number>;
  byIndex: Map<number, Frame>;
  /** Next child-frame index (never reused within the tab). */
  next: number;
  /**
   * Highest element number ever issued per frame index. A new document's runtime is seeded with it,
   * so numbering continues across navigations and a ref from an old document never names an element
   * of the new one (finding #8).
   */
  hw: Map<number, number>;
  /** Child frame → its iframe element (element number in the parent frame). */
  owner: WeakMap<Frame, { parent: Frame; n: number }>;
}
const regs = new WeakMap<Page, FrameReg>();

function regOf(page: Page): FrameReg {
  let r = regs.get(page);
  if (!r) {
    r = { byFrame: new Map(), byIndex: new Map(), next: 1, hw: new Map(), owner: new WeakMap() };
    regs.set(page, r);
  }
  return r;
}

/** Stable index for a frame of `page`: main frame = 0, child frames k ≥ 1 (never reused). */
export function frameIndex(page: Page, frame: Frame): number {
  if (frame === page.mainFrame()) return 0;
  const r = regOf(page);
  const k = r.byFrame.get(frame);
  if (k !== undefined) return k;
  for (const [f, i] of r.byFrame) {
    if (f.detached) {
      r.byFrame.delete(f);
      r.byIndex.delete(i);
    }
  }
  const n = r.next++;
  r.byFrame.set(frame, n);
  r.byIndex.set(n, frame);
  return n;
}

export function frameByIndex(page: Page, k: number): Frame | null {
  if (k === 0) return page.mainFrame();
  const f = regOf(page).byIndex.get(k);
  return f && !f.detached ? f : null;
}

function noteSeq(frame: Frame, seq: unknown): void {
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return;
  const page = frame.page();
  const r = regOf(page);
  const k = frameIndex(page, frame);
  if (seq > (r.hw.get(k) ?? 0)) r.hw.set(k, seq);
}

/** Record that child frame `child` lives in iframe element n of `parent`. */
export function noteOwner(child: Frame, parent: Frame, n: number): void {
  regOf(child.page()).owner.set(child, { parent, n });
}

/** The iframe element (number in the parent frame) hosting `frame`, or null for the main frame / unknown. */
export async function ownerOf(frame: Frame, refresh = false): Promise<{ parent: Frame; n: number } | null> {
  const parent = frame.parentFrame();
  if (!parent) return null;
  const r = regOf(frame.page());
  const known = r.owner.get(frame);
  if (!refresh && known && known.parent === parent) return known;
  // Search the parent's iframe elements.
  const ns = await rt(parent, 'iframeRefs', null);
  for (const n of ns) {
    const h = await lookupHandle(parent, n);
    if (!h) continue;
    try {
      if ((await h.contentFrame()) === frame) {
        r.owner.set(frame, { parent, n });
        return { parent, n };
      }
    } catch {
      /* not a frame we can resolve */
    } finally {
      await h.dispose().catch(() => undefined);
    }
  }
  return null;
}

// ───────────────────────────── runtime calls ─────────────────────────────

type Method = Exclude<keyof RtApi, 'v' | 'base'>;
type ArgOf<M extends Method> = Parameters<RtApi[M]>[0];
type RetOf<M extends Method> = Exclude<ReturnType<RtApi[M]>, RtErr>;

function isRtErr(v: unknown): v is RtErr {
  return typeof v === 'object' && v !== null && '__err' in v;
}

/** Messages for errors whose text originates in Node rather than the page. */
export function staleError(ref: Ref): HubError {
  return new HubError('STALE_REF', `Element ${ref} is gone (page changed). Run snapshot again and use a fresh ref.`);
}

/**
 * The realm our runtime lives in: the frame's isolated world (CDP) / sandbox (BiDi). Page scripts
 * cannot reach it or patch the built-ins it uses; the DOM is shared.
 */
export function realmOf(frame: Frame): Realm | Frame {
  const f = frame as Frame & { isolatedRealm?: () => Realm };
  return typeof f.isolatedRealm === 'function' ? f.isolatedRealm() : frame;
}

function runtimeConfig(seed: number): RtConfig {
  return {
    seed,
    secretSource: SECRET_TEXT_SOURCE,
    secretFlags: SECRET_TEXT_FLAGS,
    secretAutocomplete: [...SECRET_AUTOCOMPLETE],
    secretAutocompletePrefix: SECRET_AUTOCOMPLETE_PREFIX,
    paymentDomains: [...PAYMENT_FRAME_DOMAINS],
  };
}

async function install(frame: Frame): Promise<void> {
  const page = frame.page();
  const seed = regOf(page).hw.get(frameIndex(page, frame)) ?? 0;
  const src = `(${RUNTIME_FN_SRC})(${JSON.stringify(RUNTIME_KEY)}, ${JSON.stringify(RUNTIME_VERSION)}, ${JSON.stringify(runtimeConfig(seed))})`;
  // String evaluation in the isolated world: not subject to the page's CSP / Trusted Types.
  await realmOf(frame).evaluate(src);
}

export interface RtResult<T> {
  value: T;
  /** Seed of the document that answered: element numbers it issued are in (base, seq]. */
  base: number;
  seq: number;
}

/**
 * Call a runtime method in `frame`'s isolated world, installing the runtime first if needed; also
 * returns the numbering window of the answering document so callers can validate refs.
 * Page-side `{__err:[code,msg]}` results are thrown as HubError.
 */
export async function rtx<M extends Method>(frame: Frame, method: M, arg: ArgOf<M>): Promise<RtResult<RetOf<M>>> {
  const realm = realmOf(frame);
  const run = (): Promise<unknown> =>
    realm.evaluate(
      (key: string, m: string, a: unknown) => {
        const api = (globalThis as unknown as Record<string, Record<string, unknown> | undefined>)[key];
        if (!api) return { __missing: true };
        const out = (api[m] as (x: unknown) => unknown)(a);
        return { ok: out, base: api['base'], seq: (api['seq'] as () => number)() };
      },
      RUNTIME_KEY,
      method,
      arg as unknown,
    );
  type Raw = { __missing?: true; ok?: unknown; base?: unknown; seq?: unknown };
  let res = (await run()) as Raw;
  if (res.__missing) {
    await install(frame);
    res = (await run()) as Raw;
    if (res.__missing) throw new HubError('INTERNAL', 'Could not install the page runtime in this frame.');
  }
  noteSeq(frame, res.seq);
  const v = res.ok;
  if (isRtErr(v)) {
    const [code, msg, pageText] = v.__err as [string, string, string?];
    // The message part is written by the runtime without page text; page text rides separately.
    if (typeof pageText === 'string' && pageText) throw new PageTextError(code as HubErrorCode, String(msg), pageText);
    throw new HubError(code as HubErrorCode, String(msg));
  }
  const base = typeof res.base === 'number' ? res.base : Number.MAX_SAFE_INTEGER;
  const seq = typeof res.seq === 'number' ? res.seq : 0;
  return { value: v as RetOf<M>, base, seq };
}

export async function rt<M extends Method>(frame: Frame, method: M, arg: ArgOf<M>): Promise<RetOf<M>> {
  return (await rtx(frame, method, arg)).value;
}

/** A ref number the answering document really issued. */
export function issued(r: { base: number; seq: number }, n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > r.base && n <= r.seq;
}

/** Element handle for element number n in frame, or null if unknown/disconnected (or runtime absent). */
export async function lookupHandle(frame: Frame, n: number): Promise<ElementHandle<Element> | null> {
  const h = await realmOf(frame).evaluateHandle(
    (key: string, num: number) => {
      const api = (globalThis as unknown as Record<string, { lookup(n: number): Element | null } | undefined>)[key];
      return api ? api.lookup(num) : null;
    },
    RUNTIME_KEY,
    n,
  );
  const el = h.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await h.dispose().catch(() => undefined);
    return null;
  }
  return el;
}

export interface Resolved {
  parsed: ParsedRef;
  frame: Frame;
  handle: ElementHandle<Element>;
}

/** Parse a ref, find its frame and live element; STALE_REF if any part is gone. Caller disposes handle. */
export async function resolveRef(page: Page, ref: Ref): Promise<Resolved> {
  const parsed = parseRef(ref);
  const frame = frameByIndex(page, parsed.frame);
  if (!frame) throw staleError(ref);
  let handle: ElementHandle<Element> | null;
  try {
    handle = await lookupHandle(frame, parsed.n);
  } catch (e) {
    if (isNavError(e)) throw staleError(ref);
    throw e;
  }
  if (!handle) throw staleError(ref);
  return { parsed, frame, handle };
}

/** Errors puppeteer raises when the document/frame went away under us. */
export function isNavError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Execution context was destroyed|Cannot find context|detached|Target closed|No frame|context.*(not found|destroyed)|Session closed|No target|realm.*(destroyed|not found)/i.test(
    m,
  );
}

export function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
    return url.length > 60 ? url.slice(0, 59) + '…' : url;
  } catch {
    return url || 'about:blank';
  }
}

