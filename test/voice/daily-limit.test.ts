/** DailyLimit (src/voice/daily-limit.ts): today's spend, 80% and 100%, the day change, fail open. Local times only. */
import { describe, expect, it } from 'vitest';
import type { LatencyRecord } from '../../src/telemetry/latency.js';
import { DailyLimit } from '../../src/voice/daily-limit.js';

/** A local time on 2026-11-<day>. */
const at = (day: number, h: number, m = 0, s = 0) => new Date(2026, 10, day, h, m, s).getTime();
const rec = (id: string, t: number, costUsd?: number): LatencyRecord => ({
  v: 1, id, ts: new Date(t).toISOString(), trigger: 'cli', route: 'model', tier: null, outcome: 'ok', followUp: false, turns: 1, stages: {},
  ...(costUsd !== undefined ? { costUsd } : {}),
});
const boom = (): never => {
  throw new Error('broken');
};

/** A limit whose clock, records, jobs and config the test changes between checks. A null field throws when read. */
function setup(costs: number[] = []) {
  const w = {
    now: at(23, 12),
    records: costs.map((c, i) => rec(`r${i}`, at(23, 9, i), c)) as LatencyRecord[] | null,
    jobs: 0 as number | null,
    limit: { enabled: true, usd: 1 } as { enabled: boolean; usd: number } | null,
    log: [] as string[],
  };
  const lim = new DailyLimit({
    now: () => w.now,
    records: () => w.records ?? boom(),
    jobSpend: (day) => (w.jobs === null ? boom() : day === '2026-11-23' ? w.jobs : 0),
    limit: () => w.limit ?? boom(),
    log: (l) => w.log.push(l),
  });
  return { w, lim };
}

describe('DailyLimit', () => {
  it('no spend: ok and allowed', () => {
    const { lim } = setup();
    expect([lim.state(), lim.allowed(), lim.spentUsd()]).toEqual(['ok', true, 0]);
  });

  it('exactly 80% warns, just under does not; sums are exact (0.1 + 0.7)', () => {
    expect(setup([0.3, 0.5]).lim.state()).toBe('warn');
    expect(setup([0.1, 0.7]).lim.state()).toBe('warn');
    expect(setup([0.3, 0.499999]).lim.state()).toBe('ok');
    expect(setup([0.3, 0.5]).lim.spentUsd()).toBe(0.8);
  });

  it('exactly 100% refuses, just under allows', () => {
    const over = setup([0.5, 0.5]).lim;
    expect([over.state(), over.allowed()]).toEqual(['over', false]);
    const under = setup([0.5, 0.499999]).lim;
    expect([under.state(), under.allowed()]).toEqual(['warn', true]);
    expect(setup([0.7, 0.7]).lim.allowed()).toBe(false);
  });

  it('only today counts: a run at 23:59 yesterday does not', () => {
    const { w, lim } = setup();
    w.records = [rec('y', at(22, 23, 59), 5), rec('t', at(23, 0, 0, 1), 0.2)];
    expect(lim.spentUsd()).toBe(0.2);
  });

  it('the day changes at local midnight on the same object', () => {
    const { w, lim } = setup();
    w.now = at(23, 23, 59);
    w.records = [rec('a', at(23, 23, 0), 1)];
    expect(lim.allowed()).toBe(false);
    w.now = at(24, 0, 0, 1);
    expect([lim.state(), lim.allowed(), lim.spentUsd()]).toEqual(['ok', true, 0]);
  });

  it('a run not on disk yet counts once, and not again when its line is written', () => {
    const { w, lim } = setup();
    lim.add('a', 0.6);
    expect(lim.spentUsd()).toBe(0.6);
    w.records = [rec('a', at(23, 11), 0.6)];
    expect(lim.spentUsd()).toBe(0.6);
    w.records = [];
    expect(lim.spentUsd()).toBe(0); // dropped from memory once seen on disk
  });

  it("a run that started before midnight is matched on yesterday's line (no double count today)", () => {
    const { w, lim } = setup();
    w.now = at(24, 0, 1);
    lim.add('late', 0.6);
    expect(lim.spentUsd()).toBe(0.6);
    w.records = [rec('late', at(23, 23, 59), 0.6)];
    expect(lim.spentUsd()).toBe(0);
  });

  it('pending runs from yesterday drop at midnight', () => {
    const { w, lim } = setup();
    lim.add('a', 0.9);
    expect(lim.spentUsd()).toBe(0.9);
    w.now = at(24, 0, 0, 1);
    expect(lim.spentUsd()).toBe(0);
  });

  it('add ignores a missing, zero, negative or non-finite cost', () => {
    const { lim } = setup();
    for (const c of [undefined, 0, -1, NaN, Infinity]) lim.add(String(c), c);
    expect(lim.spentUsd()).toBe(0);
  });

  it('a missing or broken latency file fails open and is logged', () => {
    const { w, lim } = setup();
    w.records = null;
    expect(lim.allowed()).toBe(true);
    expect(w.log.join('\n')).toContain("could not read today's model cost");
    lim.add('a', 1); // runs of this process still count
    expect(lim.allowed()).toBe(false);
  });

  it('jobs count in the day total; a broken job list counts 0 and is logged', () => {
    const { w, lim } = setup([0.3]);
    w.jobs = 0.5;
    expect(lim.state()).toBe('warn');
    w.jobs = 0.7;
    expect(lim.allowed()).toBe(false);
    w.jobs = null;
    expect(lim.spentUsd()).toBe(0.3);
    expect(w.log.join('\n')).toContain("could not read today's job cost");
  });

  it('config: off, unreadable or a bad number never blocks; read on every check', () => {
    const { w, lim } = setup([5]);
    expect(lim.allowed()).toBe(false);
    w.limit = { enabled: false, usd: 1 };
    expect(lim.allowed()).toBe(true);
    for (const usd of [0, -1, NaN]) {
      w.limit = { enabled: true, usd };
      expect(lim.allowed()).toBe(true);
    }
    w.limit = null;
    expect(lim.allowed()).toBe(true);
    expect(w.log.join('\n')).toContain('could not read the daily limit');
    w.limit = { enabled: true, usd: 10 };
    expect(lim.state()).toBe('ok');
    w.limit = { enabled: true, usd: 6 };
    expect(lim.state()).toBe('warn');
  });

  it('warnNow: once per day at 80% or more, again the next day', () => {
    const { w, lim } = setup();
    const today = [rec('a', at(23, 9), 0.7)];
    w.records = today;
    expect(lim.warnNow()).toBe(false);
    today.push(rec('b', at(23, 10), 0.1));
    expect(lim.warnNow()).toBe(true);
    expect(lim.warnNow()).toBe(false);
    today.push(rec('c', at(23, 11), 0.5)); // now over: already warned today
    expect(lim.warnNow()).toBe(false);
    w.now = at(24, 9);
    w.records = [rec('d', at(24, 8), 1.2)]; // one run jumps straight past 100%
    expect(lim.warnNow()).toBe(true);
    expect(lim.warnNow()).toBe(false);
  });
});
