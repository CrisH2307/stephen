/** `stephen latency [--days 1|7|30] [--json]` (src/telemetry/cli.ts), from the day files in test/fixtures/latency. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SLOWEST, TRIGGER_EXTRA_MS, buildReport, formatReport, parseLatencyArgs, runLatencyCli, spanMs, type LatencyReport } from '../../src/telemetry/cli.js';
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
    // R10a-7: the group has 3 rows (ok, ok, error); only the 2 ok rows are timed, the error row is a count.
    expect(g('ptt/model').outcomes).toEqual({ ok: 2, error: 1 });
    expect(g('ptt/model').spans).toEqual({
      endpoint: { n: 2, p50: 0, p95: 0 },
      asr: { n: 2, p50: 300, p95: 400 },
      handoff: { n: 2, p50: 10, p95: 20 },
      reply: { n: 2, p50: 2690, p95: 4580 },
      output: { n: 2, p50: 2000, p95: 2000 },
      'speech → reply': { n: 2, p50: 3000, p95: 5000 },
      'speech → done': { n: 2, p50: 5000, p95: 7000 },
    });
    // The model is held to 4 s / 8 s, a local router to 1.5 s / 2.5 s (plan 7.1).
    expect(g('ptt/model').over).toEqual([]);
    expect(g('ptt/timer').over).toEqual(['p50 3200 ms, target 1500 ms', 'p95 3200 ms, target 2500 ms']);
    expect(g('wake/memory')).toMatchObject({ over: [], spans: { endpoint: { n: 1, p50: 800, p95: 800 }, 'speech → reply': { n: 1, p50: 1120, p95: 1120 } } });
    // A typed command has no speech: its trigger is the base. A trigger that never became a command has no steps.
    expect(g('app/model')).toMatchObject({ over: [], spans: { 'speech → reply': { n: 1, p50: 2500, p95: 2500 } } });
    expect(g('wake/none')).toMatchObject({ over: [], spans: {} });
    expect(rep.slowest.map((s) => `${s.id} ${s.ms}`)).toEqual([
      'h_00000000000000a2 5000',
      'h_00000000000000d1 3200',
      'h_00000000000000a1 3000',
      'h_00000000000000c1 2500',
      'h_00000000000000b1 1120',
    ]);
    expect(rep.slowest[0]).toMatchObject({ trigger: 'ptt', route: 'model', outcome: 'ok', ts: '2026-11-10T15:05:00.000Z' });
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
    expect(r.out).toContain('ptt / model  (n=3, ok 2; not timed: error 1)');
    expect(r.out).toMatch(/speech → reply\s+2\s+3000 ms\s+5000 ms/);
    expect(r.out).toMatch(/\nwake \/ memory {2}\(n=1, ok 1\)\n/);
    expect(r.out).toMatch(/Slowest 5 \(speech → reply\):\n {2}h_00000000000000a2 {2}\S+ \S+ {2}ptt \/ model {2}ok {2}5000 ms/);
    expect(r.out).not.toContain('secret'); // an unknown field in a line never comes out
  });

  it('no records, a bad option, help', async () => {
    expect(await run(['--days', '1'], monitor(false))).toMatchObject({ code: 0, out: 'No latency records in the last day.' });
    expect(JSON.parse((await run(['--json'], monitor(false))).out)).toEqual({ days: 7, triggers: 0, outcomes: {}, ignored: {}, tiers: {}, reasons: {}, silence: null, groups: [], slowest: [], cost: [], costTotal: 0 });
    const bad = await run(['--days', '3']);
    expect(bad).toMatchObject({ code: 2, out: '' });
    expect(bad.err).toContain('--days must be 1, 7 or 30');
    expect((await run(['--help'])).out).toContain('stephen latency [--days 1|7|30] [--json]');
  });
});

describe('buildReport', () => {
  const rec = (i: number, stages: LatencyRecord['stages'], over: Partial<LatencyRecord> = {}): LatencyRecord =>
    parseLatencyRecord({ v: 1, id: `h_${String(i).padStart(16, '0')}`, ts: new Date(NOW - i * 1000).toISOString(), trigger: 'ptt', route: 'model', outcome: 'ok', stages, ...over })!;

  it('cost per local day: sums, newest first, and no cost line when nothing has a cost', () => {
    const day = 86_400_000;
    const rep = buildReport(
      [
        rec(1, { speechEnd: 0, replyReady: 100 }, { costUsd: 0.0123 }),
        rec(2, { speechEnd: 0, replyReady: 100 }, { costUsd: 0.02, outcome: 'error' }),
        rec(3, { speechEnd: 0, replyReady: 100 }, { ts: new Date(NOW - 2 * day).toISOString(), costUsd: 0.5 }),
        rec(4, { speechEnd: 0, replyReady: 100 }),
      ],
      7,
    );
    expect(rep.cost.map((c) => c.n)).toEqual([2, 1]);
    expect(rep.cost.map((c) => c.usd)).toEqual([0.03, 0.5]);
    expect(rep.cost[0]!.day > rep.cost[1]!.day).toBe(true);
    expect(rep.costTotal).toBe(0.53);
    const text = formatReport(rep);
    expect(text).toContain('Cost per day (model runs, USD):');
    expect(text).toMatch(/total\s+0\.53 USD/);
    expect(formatReport(buildReport([rec(5, { speechEnd: 0, replyReady: 100 })], 7))).not.toContain('Cost per day');
  });

  it(`keeps the ${SLOWEST} slowest`, () => {
    const rep = buildReport(Array.from({ length: 12 }, (_, i) => rec(i, { speechEnd: 0, replyReady: (i + 1) * 100 })), 7);
    expect(rep.slowest).toHaveLength(SLOWEST);
    expect(rep.slowest.map((s) => s.ms)).toEqual([1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300]);
  });

  it('rows for first audio and for the model run\'s own numbers, only where a record has them', () => {
    const rep = buildReport(
      [
        rec(1, { speechEnd: 1000, replyReady: 3000, firstAudio: 3400, done: 5000 }, { modelMs: 1500, toolMs: 400, firstTokenMs: 300 }),
        rec(2, { speechEnd: 1000, replyReady: 2000, firstAudio: 2600, done: 4000 }, { modelMs: 900, toolMs: 0 }),
        rec(3, { speechEnd: 1000, replyReady: 2000, done: 2000 }),
      ],
      7,
    );
    expect(rep.groups[0]!.spans).toMatchObject({
      'speech → audio': { n: 2, p50: 1600, p95: 2400 },
      model: { n: 2, p50: 900, p95: 1500 },
      tools: { n: 2, p50: 0, p95: 400 },
      'first token': { n: 1, p50: 300, p95: 300 },
    });
    expect(Object.keys(buildReport([rec(3, { speechEnd: 0, replyReady: 5 })], 7).groups[0]!.spans)).toEqual(['speech → reply']);
  });

  it('a voice command without end of speech, or with times that run backwards, is not counted in a span', () => {
    expect(spanMs(rec(1, { replyReady: 900 }), 'speech', 'replyReady')).toBeNull();
    expect(spanMs(rec(1, { replyReady: 900 }, { trigger: 'cli' }), 'speech', 'replyReady')).toBe(900);
    expect(spanMs(rec(1, { speechEnd: 1000, captureEnd: 900 }), 'speechEnd', 'captureEnd')).toBeNull();
    expect(buildReport([rec(1, { replyReady: 900 })], 1)).toMatchObject({ triggers: 1, slowest: [], groups: [{ n: 1, outcomes: { ok: 1 }, spans: {}, over: [] }] });
  });
});

describe('report: the new fields', () => {
  const rec = (i: number, over: Partial<LatencyRecord> & { stages?: LatencyRecord['stages'] } = {}): LatencyRecord =>
    parseLatencyRecord({ v: 1, id: `h_${String(i).padStart(16, '0')}`, ts: new Date(NOW - i * 1000).toISOString(), trigger: 'ptt', route: 'model', outcome: 'ok', stages: { speechEnd: 0, replyReady: 1000 }, ...over })!;
  const only = (rep: LatencyReport) => rep.groups[0]!;

  it('R10a-7: p50, p95 and OVER come from the ok rows; cancelled and error rows are counts', () => {
    const rows = [
      rec(1, { stages: { speechEnd: 0, replyReady: 1000 } }),
      rec(2, { stages: { speechEnd: 0, replyReady: 3000 } }),
      rec(3, { outcome: 'cancelled', stages: { speechEnd: 0, replyReady: 90_000 } }),
      rec(4, { outcome: 'error', stages: { speechEnd: 0, replyReady: 100 } }),
    ];
    const g = only(buildReport(rows, 7));
    expect(g.n).toBe(4);
    expect(g.outcomes).toEqual({ ok: 2, cancelled: 1, error: 1 });
    expect(g.spans['speech → reply']).toEqual({ n: 2, p50: 1000, p95: 3000 });
    expect(g.over).toEqual([]); // the 90 s cancelled row does not trip the check
    expect(buildReport(rows, 7).slowest.map((s) => s.ms)).toEqual([3000, 1000]);
    expect(formatReport(buildReport(rows, 7))).toContain('(n=4, ok 2; not timed: cancelled 1, error 1)');
  });

  it('wake gets +0.8 s over the base target, other triggers none', () => {
    const slow = (trigger: LatencyRecord['trigger']) => buildReport([rec(1, { trigger, route: 'memory', stages: { speechEnd: 0, replyReady: 2000 } })], 7).groups[0]!.over;
    expect(slow('ptt')).toEqual(['p50 2000 ms, target 1500 ms']); // p95 2000 is inside 2500
    expect(slow('wake')).toEqual([]); // 1500 + 800 and 2500 + 800
    expect(TRIGGER_EXTRA_MS).toEqual({ wake: 800, ptt: 0, app: 0, phone: 0, cli: 0 });
  });

  it('wake_ignored by reason, an old row without one is unknown', () => {
    const rows = [
      rec(1, { trigger: 'wake', route: null, outcome: 'wake_ignored', ignored: 'sound_playing', stages: {} }),
      rec(2, { trigger: 'wake', route: null, outcome: 'wake_ignored', ignored: 'cooldown', stages: {} }),
      rec(3, { trigger: 'wake', route: null, outcome: 'wake_ignored', ignored: 'cooldown', stages: {} }),
      rec(4, { trigger: 'wake', route: null, outcome: 'wake_ignored', stages: {} }),
    ];
    const rep = buildReport(rows, 7);
    expect(rep.ignored).toEqual({ sound_playing: 1, cooldown: 2, unknown: 1 });
    expect(formatReport(rep)).toContain('wake_ignored 4 (sound_playing 1, cooldown 2, unknown 1)');
  });

  it('tools by name with p50, cold versus warm, wake to chime, Esc to silence, tier and reason counts', () => {
    const rows = [
      rec(1, { start: 'cold', tools: [{ name: 'navigate', ms: 400 }, { name: 'snapshot', ms: 100 }], silenceMs: 80, tier: 2, reason: 'question' }),
      rec(2, { start: 'warm', tools: [{ name: 'navigate', ms: 600 }], silenceMs: 120, tier: 2, reason: 'question' }),
      rec(3, { trigger: 'wake', route: 'model', stages: { speechEnd: 500, replyReady: 2000, chime: 90 }, start: 'warm', tier: 1 }),
      rec(4, { outcome: 'cancelled', start: 'cold', tools: [{ name: 'click', ms: 9999 }] }),
    ];
    const rep = buildReport(rows, 7);
    const ptt = rep.groups.find((g) => g.trigger === 'ptt')!;
    expect(ptt.tools).toEqual({ navigate: { n: 2, p50: 400, p95: 600 }, snapshot: { n: 1, p50: 100, p95: 100 } }); // the cancelled row's click is out
    expect(ptt.starts).toEqual({ cold: { n: 1, p50: 1000, p95: 1000 }, warm: { n: 1, p50: 1000, p95: 1000 } });
    expect(rep.groups.find((g) => g.trigger === 'wake')!.spans['wake → chime']).toEqual({ n: 1, p50: 90, p95: 90 });
    expect(rep.silence).toEqual({ n: 2, p50: 80, p95: 120 });
    expect(rep.tiers).toEqual({ '2': 2, '1': 1, none: 1 });
    expect(rep.reasons).toEqual({ question: 2 });
    const text = formatReport(rep);
    expect(text).toMatch(/tool navigate\s+2\s+400 ms/);
    expect(text).toContain('Esc to silence (n=2): p50 80 ms, p95 120 ms');
    expect(text).toContain('tier 2 reasons: question 2');
  });
});
