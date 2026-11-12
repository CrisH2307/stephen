/** `stephen latency [--days 1|7|30] [--json]` (src/telemetry/cli.ts), from the day files in test/fixtures/latency. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SLOWEST, buildReport, parseLatencyArgs, runLatencyCli, spanMs, type LatencyReport } from '../../src/telemetry/cli.js';
import { LatencyMonitor, latencyDir, parseLatencyRecord, type LatencyRecord } from '../../src/telemetry/latency.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'latency');
const tmp = mkdtempSync(join(tmpdir(), 'stephen-latency-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const NOW = Date.parse('2026-11-10T20:00:00Z');

function monitor(withFixtures = true): LatencyMonitor {
  const home = mkdtempSync(join(tmp, 'h'));
  if (withFixtures) cpSync(fixtures, latencyDir(home), { recursive: true });
  return new LatencyMonitor({ home, now: () => NOW });
}

async function run(argv: string[], m = monitor()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runLatencyCli(argv, { monitor: m, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('parseLatencyArgs', () => {
  it('parses --days, --json and help, and refuses the rest', () => {
    expect(parseLatencyArgs([])).toEqual({ days: 7, json: false });
    expect(parseLatencyArgs(['--days', '30', '--json'])).toEqual({ days: 30, json: true });
    expect(parseLatencyArgs(['--days=1'])).toEqual({ days: 1, json: false });
    expect(parseLatencyArgs(['-h'])).toBe('help');
    for (const bad of [['--days'], ['--days', '2'], ['--days', '0'], ['--days=7.5'], ['--days', 'all'], ['clear'], ['--limit', '5']]) {
      expect(parseLatencyArgs(bad), bad.join(' ')).toHaveProperty('error');
    }
  });
});

describe('stephen latency', () => {
  it('--json, 7 days: p50 and p95 per trigger and route, flags, slowest ids', async () => {
    const r = await run(['--json']);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as LatencyReport;
    expect(rep).toMatchObject({ days: 7, triggers: 7, outcomes: { ok: 5, error: 1, no_speech: 1 } });
    expect(rep.groups.map((g) => `${g.trigger}/${g.route} ${g.n}`)).toEqual(['app/model 1', 'ptt/model 3', 'ptt/timer 1', 'wake/memory 1', 'wake/none 1']);
    const g = (k: string) => rep.groups.find((x) => `${x.trigger}/${x.route}` === k)!;
    expect(g('ptt/model').spans).toEqual({
      endpoint: { n: 3, p50: 0, p95: 0 },
      asr: { n: 3, p50: 300, p95: 400 },
      handoff: { n: 3, p50: 10, p95: 20 },
      reply: { n: 3, p50: 4580, p95: 8695 },
      output: { n: 3, p50: 2000, p95: 2000 },
      'speech → reply': { n: 3, p50: 5000, p95: 9000 },
      'speech → done': { n: 3, p50: 7000, p95: 10500 },
    });
    // The model is held to 4 s / 8 s, a local router to 1.5 s / 2.5 s (plan 7.1).
    expect(g('ptt/model').over).toEqual(['p50 5000 ms, target 4000 ms', 'p95 9000 ms, target 8000 ms']);
    expect(g('ptt/timer').over).toEqual(['p50 3200 ms, target 1500 ms', 'p95 3200 ms, target 2500 ms']);
    expect(g('wake/memory')).toMatchObject({ over: [], spans: { endpoint: { n: 1, p50: 800, p95: 800 }, 'speech → reply': { n: 1, p50: 1120, p95: 1120 } } });
    // A typed command has no speech: its trigger is the base. A trigger that never became a command has no steps.
    expect(g('app/model')).toMatchObject({ over: [], spans: { 'speech → reply': { n: 1, p50: 2500, p95: 2500 } } });
    expect(g('wake/none')).toMatchObject({ over: [], spans: {} });
    expect(rep.slowest.map((s) => `${s.id} ${s.ms}`)).toEqual([
      'h_00000000000000a3 9000',
      'h_00000000000000a2 5000',
      'h_00000000000000d1 3200',
      'h_00000000000000a1 3000',
      'h_00000000000000c1 2500',
      'h_00000000000000b1 1120',
    ]);
    expect(rep.slowest[0]).toMatchObject({ trigger: 'ptt', route: 'model', outcome: 'error', ts: '2026-11-10T15:10:00.000Z' });
  });

  it('--days 1 leaves out older records', async () => {
    const rep = JSON.parse((await run(['--days', '1', '--json'])).out) as LatencyReport;
    expect(rep.triggers).toBe(6);
    expect(rep.groups.some((g) => g.route === 'timer')).toBe(false);
  });

  it('text: a table per group, OVER on slow groups, ids in the slowest list, and only what the store holds', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Latency, last 7 days: 7 triggers');
    expect(r.out).toContain('outcomes: ok 5, error 1, no_speech 1');
    expect(r.out).toContain('ptt / model  (n=3)  OVER: p50 5000 ms, target 4000 ms; p95 9000 ms, target 8000 ms');
    expect(r.out).toMatch(/speech → reply\s+3\s+5000 ms\s+9000 ms/);
    expect(r.out).toMatch(/\nwake \/ memory {2}\(n=1\)\n/);
    expect(r.out).toMatch(/Slowest 6 \(speech → reply\):\n {2}h_00000000000000a3 {2}\S+ \S+ {2}ptt \/ model {2}error {2}9000 ms/);
    expect(r.out).not.toContain('secret'); // an unknown field in a line never comes out
  });

  it('no records, a bad option, help', async () => {
    expect(await run(['--days', '1'], monitor(false))).toMatchObject({ code: 0, out: 'No latency records in the last day.' });
    expect(JSON.parse((await run(['--json'], monitor(false))).out)).toEqual({ days: 7, triggers: 0, outcomes: {}, groups: [], slowest: [] });
    const bad = await run(['--days', '3']);
    expect(bad).toMatchObject({ code: 2, out: '' });
    expect(bad.err).toContain('--days must be 1, 7 or 30');
    expect((await run(['--help'])).out).toContain('stephen latency [--days 1|7|30] [--json]');
  });
});

describe('buildReport', () => {
  const rec = (i: number, stages: LatencyRecord['stages'], over: Partial<LatencyRecord> = {}): LatencyRecord =>
    parseLatencyRecord({ v: 1, id: `h_${String(i).padStart(16, '0')}`, ts: new Date(NOW - i * 1000).toISOString(), trigger: 'ptt', route: 'model', outcome: 'ok', stages, ...over })!;

  it(`keeps the ${SLOWEST} slowest`, () => {
    const rep = buildReport(Array.from({ length: 12 }, (_, i) => rec(i, { speechEnd: 0, replyReady: (i + 1) * 100 })), 7);
    expect(rep.slowest).toHaveLength(SLOWEST);
    expect(rep.slowest.map((s) => s.ms)).toEqual([1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300]);
  });

  it('a voice command without end of speech, or with times that run backwards, is not counted in a span', () => {
    expect(spanMs(rec(1, { replyReady: 900 }), 'speech', 'replyReady')).toBeNull();
    expect(spanMs(rec(1, { replyReady: 900 }, { trigger: 'cli' }), 'speech', 'replyReady')).toBe(900);
    expect(spanMs(rec(1, { speechEnd: 1000, captureEnd: 900 }), 'speechEnd', 'captureEnd')).toBeNull();
    expect(buildReport([rec(1, { replyReady: 900 })], 1)).toMatchObject({ triggers: 1, slowest: [], groups: [{ n: 1, spans: {}, over: [] }] });
  });
});
