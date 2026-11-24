/**
 * Daily cost limit (docs/NFR-STEPHEN.md section 6, Cris 2026-11-23). Each person runs Stephen on their own Claude
 * account; this limit protects them. It only ever stops a NEW model run: the local routers (memory, timers, jobs) and
 * "stop" never reach it.
 *
 * Today's spend = the model cost in today's latency file (local day) + job costs of today + the cost of model runs
 * that ended in this process but whose latency line is not on disk yet (deduplicated by command id).
 *
 * Fail open: a latency file or job list that cannot be read counts as 0 and is logged. A wrong total must never lock
 * the owner out of Stephen; the jobs keep their own hard budget either way.
 */
import { localDate } from '../history/store.js';
import type { LatencyRecord } from '../telemetry/latency.js';

export const LIMIT_WARNING = "You have used most of today's limit.";
export const LIMIT_REACHED = "Today's limit is used. It resets at midnight.";

export type LimitState = 'ok' | 'warn' | 'over';

export interface DailyLimitOptions {
  /** Read on every check, so a config or Settings change applies at once. */
  limit: () => { enabled: boolean; usd: number };
  /** Latency records of at least the last day (LatencyMonitor.read(1)); filtered to today here. May throw. */
  records: () => readonly LatencyRecord[];
  /** Job cost of a local day (YYYY-MM-DD) in USD. May throw. */
  jobSpend?: (day: string) => number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Costs are summed in millionths of a USD (integers), so 0.3 + 0.5 is exactly 80% of 1. */
const micro = (usd: number) => (Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1e6) : 0);
/** Runs kept in memory until their latency line shows up. ponytail: a run whose line is never written stays counted until midnight. */
const MAX_PENDING = 2000;

export class DailyLimit {
  private readonly now: () => number;
  private pending = new Map<string, { day: string; micro: number }>();
  private warnedDay: string | null = null;
  constructor(private readonly o: DailyLimitOptions) {
    this.now = o.now ?? Date.now;
  }

  /** A model run ended: count its cost now, before its latency line is written. */
  add(id: string, costUsd: number | undefined): void {
    const m = micro(costUsd ?? 0);
    if (!m) return;
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, { day: localDate(new Date(this.now())), micro: m });
  }

  /** Today's spend in USD (6 decimals). */
  spentUsd(): number {
    return this.spentMicro(localDate(new Date(this.now()))) / 1e6;
  }

  /** May a new model run start? false only at or over 100% of an enabled limit. */
  allowed(): boolean {
    return this.state() !== 'over';
  }

  /**
   * After a model run: true once per local day, the first time today's spend is at or over 80% (also when one run
   * jumps past 100%). The caller says LIMIT_WARNING.
   */
  warnNow(): boolean {
    const day = localDate(new Date(this.now()));
    if (this.warnedDay === day || this.state() === 'ok') return false;
    this.warnedDay = day;
    return true;
  }

  state(): LimitState {
    let lim: { enabled: boolean; usd: number };
    try {
      lim = this.o.limit();
    } catch (e) {
      this.o.log?.(`Note: could not read the daily limit, so it is not applied (${(e as Error).message}).`);
      return 'ok';
    }
    const limitMicro = micro(lim.usd);
    if (!lim.enabled || !limitMicro) return 'ok';
    const spent = this.spentMicro(localDate(new Date(this.now())));
    if (spent >= limitMicro) return 'over';
    return spent * 5 >= limitMicro * 4 ? 'warn' : 'ok';
  }

  private spentMicro(day: string): number {
    for (const [id, p] of this.pending) if (p.day !== day) this.pending.delete(id);
    let total = 0;
    const onDisk = new Set<string>();
    try {
      for (const r of this.o.records()) {
        onDisk.add(r.id); // any day: a run that started before midnight is on yesterday's line
        if (localDate(new Date(r.ts)) !== day) continue;
        total += micro(r.costUsd ?? 0);
      }
    } catch (e) {
      this.o.log?.(`Note: could not read today's model cost, so it counts as 0 (${(e as Error).message}).`);
    }
    for (const [id, p] of this.pending) {
      if (onDisk.has(id)) this.pending.delete(id);
      else total += p.micro;
    }
    try {
      total += micro(this.o.jobSpend?.(day) ?? 0);
    } catch (e) {
      this.o.log?.(`Note: could not read today's job cost, so it counts as 0 (${(e as Error).message}).`);
    }
    return total;
  }
}
