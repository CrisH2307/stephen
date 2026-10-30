import { HubError } from './errors.js';
import type { BrowserName, Ref, TabId } from './types.js';

/** Tab ids: c<n> for Chrome, z<n> for Zen. */
const TAB_RE = /^([cz])([1-9]\d*)$/;
/** Refs: <tab>:e<n>  or  <tab>:f<k>e<n>  (frame k ≥ 1; main frame has no f-part). */
const REF_RE = /^([cz][1-9]\d*):(?:f([1-9]\d*))?e([1-9]\d*)$/;

export interface ParsedRef {
  tab: TabId;
  /** 0 = main frame, k ≥ 1 = child frame index as assigned by the snapshot walker. */
  frame: number;
  /** Element number within that frame. */
  n: number;
  /** The part after the colon, e.g. 'e12' or 'f2e5' — the key stored in the page. */
  local: string;
}

export function tabPrefix(browser: BrowserName): 'c' | 'z' {
  return browser === 'chrome' ? 'c' : 'z';
}

export function makeTabId(browser: BrowserName, n: number): TabId {
  return `${tabPrefix(browser)}${n}`;
}

export function isTabId(s: string): boolean {
  return TAB_RE.test(s);
}

export function browserOfTab(tab: TabId): BrowserName {
  const m = TAB_RE.exec(tab);
  if (!m) throw new HubError('TAB_NOT_FOUND', `"${tab}" is not a tab id (expected c1, z2, …). Use tabs_list.`);
  return m[1] === 'c' ? 'chrome' : 'zen';
}

export function parseRef(ref: Ref): ParsedRef {
  const m = REF_RE.exec(ref.trim());
  if (!m) {
    throw new HubError('BAD_REF', `"${ref}" is not an element ref (expected like z1:e12). Take a snapshot and copy a ref from it.`);
  }
  const frame = m[2] ? Number(m[2]) : 0;
  const n = Number(m[3]);
  return { tab: m[1]!, frame, n, local: frame ? `f${frame}e${n}` : `e${n}` };
}

export function makeRef(tab: TabId, frame: number, n: number): Ref {
  return frame ? `${tab}:f${frame}e${n}` : `${tab}:e${n}`;
}

/** Throws WRONG_TAB if the ref does not belong to `tab`. */
export function assertRefInTab(ref: Ref, tab: TabId): ParsedRef {
  const p = parseRef(ref);
  if (p.tab !== tab) {
    throw new HubError('WRONG_TAB', `Ref ${ref} belongs to tab ${p.tab}, not ${tab}.`);
  }
  return p;
}
