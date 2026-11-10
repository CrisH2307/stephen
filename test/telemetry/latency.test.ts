/** Latency monitor store (plan A2): what a line may hold, file safety, retention, and reading back. */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATENCY_RETENTION_DAYS, LatencyMonitor, latencyDir, parseLatencyRecord } from '../../src/telemetry/latency.js';

const T0 = Date.parse('2026-11-10T15:00:00Z');

function setup(start = T0) {
  const home = mkdtempSync(join(tmpdir(), 'stephen-lat-'));
  const clock = { t: start };
  const logs: string[] = [];
  const m = new LatencyMonitor({ home, now: () => clock.t, log: (l) => logs.push(l), loop: { reset: () => undefined, p99Ms: () => 3.4 } });
  const lines = () =>
    readdirSync(latencyDir(home))
      .sort()
      .flatMap((f) => readFileSync(join(latencyDir(home), f), 'utf8').split('\n').filter(Boolean));
  return { home, clock, logs, m, lines };
}

describe('LatencyMonitor', () => {
  it('writes one line per trigger with stage offsets from the trigger', () => {
    const t = setup();
    t.m.begin('h_a', 'ptt', T0 - 1200); // key down, as told by the helper
    t.m.mark('h_a', 'speechEnd', T0 - 100);
    t.m.mark('h_a', 'captureEnd');
    t.clock.t += 400;
    t.m.mark('h_a', 'asrDone');
    t.clock.t += 2000;
    t.m.mark('h_a', 'done');
    t.m.end('h_a', 'ok', { route: 'model', followUp: true, turns: 2 });
    expect(t.lines().map((l) => JSON.parse(l))).toEqual([
      {
        v: 1,
        id: 'h_a',
        ts: new Date(T0 - 1200).toISOString(),
        trigger: 'ptt',
        route: 'model',
        tier: null,
        outcome: 'ok',
        followUp: true,
        turns: 2,
        stages: { speechEnd: 1100, captureEnd: 1200, asrDone: 1600, done: 3600 },
        loopP99Ms: 3,
      },
    ]);
    expect(t.logs).toEqual([]);
  });

  it('a trigger that never became a command still gets a row; a second end and unknown ids do nothing', () => {
    const t = setup();
    t.m.begin('h_w', 'wake');
    t.m.end('h_w', 'no_wake');
    t.m.end('h_w', 'ok');
    t.m.mark('h_none', 'done');
    t.m.end('h_none', 'ok');
    const rows = t.lines().map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'h_w', trigger: 'wake', outcome: 'no_wake', route: null, turns: 0, stages: {} });
  });

  it('a second begin for an open id keeps the first trigger time', () => {
    const t = setup();
    t.m.begin('h_b', 'wake');
    t.clock.t += 900;
    t.m.begin('h_b', 'app');
    t.m.mark('h_b', 'commandStart');
    t.m.end('h_b', 'ok');
    expect(JSON.parse(t.lines()[0]!)).toMatchObject({ trigger: 'wake', stages: { commandStart: 900 } });
  });

  it('privacy: a line holds only known fields, so content cannot ride along', () => {
    const SECRET = 'open my bank at https://bank.example/?token=abc';
    // Even a caller that ignores the types cannot add content: the record is rebuilt field by field.
    const rec = parseLatencyRecord({
      v: 1,
      id: 'h_p',
      ts: new Date(T0).toISOString(),
      trigger: 'wake',
      outcome: 'ok',
      route: SECRET,
      said: SECRET,
      url: SECRET,
      stages: { done: 5, [SECRET]: 1, asrDone: SECRET },
    });
    expect(JSON.stringify(rec)).not.toContain('bank');
    expect(rec).toMatchObject({ route: null, stages: { done: 5 } });
    // Ids, triggers and outcomes outside the fixed sets are refused outright.
    expect(parseLatencyRecord({ v: 1, id: SECRET, ts: new Date(T0).toISOString(), trigger: 'wake', outcome: 'ok' })).toBeNull();
    expect(parseLatencyRecord({ v: 1, id: 'h_p', ts: new Date(T0).toISOString(), trigger: SECRET, outcome: 'ok' })).toBeNull();
    expect(parseLatencyRecord({ v: 1, id: 'h_p', ts: new Date(T0).toISOString(), trigger: 'wake', outcome: SECRET })).toBeNull();
    const t = setup();
    t.m.begin(SECRET, 'wake');
    t.m.end(SECRET, 'ok');
    expect(() => readdirSync(latencyDir(t.home))).toThrow(); // nothing was written, not even the folder
  });

  it('files are private (folder 0700, file 0600)', () => {
    const t = setup();
    t.m.begin('h_f', 'cli');
    t.m.end('h_f', 'ok');
    const dir = latencyDir(t.home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
  });

  it('read returns the last N days oldest first and skips bad lines; purge drops files past retention', () => {
    const t = setup();
    t.m.begin('h_1', 'wake');
    t.m.end('h_1', 'ok');
    const file = join(latencyDir(t.home), readdirSync(latencyDir(t.home))[0]!);
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n{"v":1,"id":"h_x"}\n`);
    t.clock.t += 3 * 86_400_000;
    t.m.begin('h_2', 'ptt');
    t.m.end('h_2', 'error');
    expect(t.m.read(7).map((r) => r.id)).toEqual(['h_1', 'h_2']);
    expect(t.m.read(1).map((r) => r.id)).toEqual(['h_2']);
    expect(t.m.purge()).toBe(0);
    t.clock.t += LATENCY_RETENTION_DAYS * 86_400_000;
    expect(t.m.purge()).toBe(1); // h_1's day; h_2's day is 3 days younger
    expect(t.m.read(30).map((r) => r.id)).toEqual(['h_2']); // exactly 30 days old: still inside the window
  });
});
