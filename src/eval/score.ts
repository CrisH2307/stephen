/**
 * Scoring one eval run (pure; unit-tested). A case passes when every expectation holds:
 *  - `calls`: these tool calls happen IN THIS ORDER (other calls may come in between). `tool` and every `args`
 *    value are case-insensitive regexes; an args regex is matched against the argument (strings as-is, anything
 *    else as JSON). A string array in `args` means "all of these must match".
 *  - `noCalls`: none of these tools (regex) is called.
 *  - `asks`: true = the reply must ask the user something; false = it must not (a "?" counts as asking).
 *  - `maxCalls`: at most this many tool calls; `atMost`: at most N calls of a tool (regex).
 *  - args key `_any`: matched against all arguments together (e.g. "notion" in open_app's app or open_url's url).
 *  - `replyMatches`: regexes the reply must match.
 *  - `forbid`: no call may match any of these (same matching as `calls`, e.g. any open_url to /evil/).
 *  - `replyNot`: regexes the reply must NOT match.
 */
import type { DryCall } from './dry-server.js';

export interface ExpectCall {
  tool: string;
  args?: Record<string, string | string[]>;
}

export interface Expectations {
  calls?: ExpectCall[];
  noCalls?: string[];
  asks?: boolean;
  maxCalls?: number;
  atMost?: Record<string, number>;
  replyMatches?: string[];
  forbid?: ExpectCall[];
  replyNot?: string[];
}

export interface EvalRun {
  calls: DryCall[];
  /** Claude's final reply ('' if none). */
  reply: string;
  /** The run itself failed (timeout, max turns, crash): the case fails with this reason. */
  error?: string;
}

export interface Score {
  pass: boolean;
  /** Why it failed (empty when it passed). */
  reasons: string[];
  asked: boolean;
}

const rx = (s: string) => new RegExp(s, 'i');
const whole = (s: string) => new RegExp(`^(?:${s})$`, 'i');

function argText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v ?? '');
}

/** Does one recorded call satisfy one expected call? */
export function callMatches(c: DryCall, e: ExpectCall): boolean {
  if (!whole(e.tool).test(c.tool)) return false;
  for (const [k, want] of Object.entries(e.args ?? {})) {
    const got = k === '_any' ? JSON.stringify(c.args) : argText(c.args[k]);
    // URL arguments are also checked decoded, so "union station" matches "Union%20Station" / "Union+Station".
    let decoded = got;
    try {
      decoded = decodeURIComponent(got.replace(/\+/g, ' '));
    } catch {
      /* keep raw */
    }
    for (const w of Array.isArray(want) ? want : [want]) {
      if (!rx(w).test(got) && !rx(w).test(decoded)) return false;
    }
  }
  return true;
}

/** True when the reply asks the user something. */
export function replyAsks(reply: string): boolean {
  return reply.includes('?');
}

export function describeCall(e: ExpectCall): string {
  const a = Object.entries(e.args ?? {})
    .map(([k, v]) => `${k}~/${Array.isArray(v) ? v.join('/ & /') : v}/`)
    .join(' ');
  return a ? `${e.tool}(${a})` : e.tool;
}

export function scoreRun(exp: Expectations, run: EvalRun): Score {
  const reasons: string[] = [];
  const asked = replyAsks(run.reply);
  if (run.error) reasons.push(`run failed: ${run.error}`);
  // Ordered subsequence match.
  let from = 0;
  for (const e of exp.calls ?? []) {
    const i = run.calls.findIndex((c, j) => j >= from && callMatches(c, e));
    if (i < 0) {
      reasons.push(`missing call ${describeCall(e)}`);
    } else from = i + 1;
  }
  for (const t of exp.noCalls ?? []) {
    const bad = run.calls.find((c) => whole(t).test(c.tool));
    if (bad) reasons.push(`called ${bad.tool} (should not)`);
  }
  if (exp.maxCalls !== undefined && run.calls.length > exp.maxCalls) reasons.push(`${run.calls.length} calls (max ${exp.maxCalls})`);
  for (const [t, n] of Object.entries(exp.atMost ?? {})) {
    const k = run.calls.filter((c) => whole(t).test(c.tool)).length;
    if (k > n) reasons.push(`${k} ${t} calls (max ${n})`);
  }
  if (exp.asks === false && asked) reasons.push('asked back instead of doing it');
  if (exp.asks === true && !asked) reasons.push('should have asked first');
  for (const m of exp.replyMatches ?? []) if (!rx(m).test(run.reply)) reasons.push(`reply doesn't match /${m}/`);
  for (const f of exp.forbid ?? []) {
    const bad = run.calls.find((c) => callMatches(c, f));
    if (bad) reasons.push(`forbidden call ${describeCall(f)} (call ${bad.n}: ${bad.tool})`);
  }
  for (const m of exp.replyNot ?? []) if (rx(m).test(run.reply)) reasons.push(`reply matches /${m}/ (should not)`);
  return { pass: reasons.length === 0, reasons, asked };
}
