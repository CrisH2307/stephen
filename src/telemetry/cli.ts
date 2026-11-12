/**
 * `stephen latency [--days 1|7|30] [--json]` (plan A2, issue #43): p50 and p95 of the latency log, per trigger and
 * route, plus the 10 slowest commands. It only reads `LatencyMonitor.read()`, so it shows ids, code words and numbers
 * and never a transcript.
 *
 * Times run from end of speech (plan 2.5). A typed command (app, phone, cli) has no speech, so its trigger is the base.
 *
 * Targets (plan 7.1) are proposals. `tier` is null until the command grammar exists (E6), so the check uses the route:
 * a local router (memory, timer, job; 0 model turns) is held to the Tier 1 "action done" target, the model to the
 * Tier 2 "full answer" target (reported, not a gate). Both are checked on speech → reply. Speech → first audio and the
 * model's own numbers (model, tools, first token) are shown without a target. Esc to silence and wake to chime are not
 * in the log.
 */
import { loadConfig } from '../config.js';
import { percentile } from '../lib/step-timer.js';
import { LATENCY_MODEL_FIELDS, LatencyMonitor, type LatencyRecord, type LatencyStage } from './latency.js';

export const LATENCY_HELP = `stephen latency: how long Stephen takes, from the local latency log (ids and numbers only)

  stephen latency [--days 1|7|30] [--json]   default: the last 7 days

Per trigger and route: p50 and p95 of each step, measured from end of speech.
"OVER" marks a group that is slower than the plan's target. Then the 10 slowest commands by id.`;

export const LATENCY_DAYS = [1, 7, 30] as const;
export const SLOWEST = 10;

export type LatencyArgs = { days: number; json: boolean };

export function parseLatencyArgs(argv: string[]): LatencyArgs | { error: string } | 'help' {
  const out: LatencyArgs = { days: 7, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--json') out.json = true;
    else if (a === '--days' || a.startsWith('--days=')) {
      const v = Number(a === '--days' ? argv[++i] : a.slice('--days='.length));
      if (!(LATENCY_DAYS as readonly number[]).includes(v)) return { error: '--days must be 1, 7 or 30' };
      out.days = v;
    } else return { error: `Unknown option "${a}" for latency.` };
  }
  return out;
}

/** `speech` = end of speech, or the trigger itself for a typed command. */
type From = LatencyStage | 'speech';
export const SPANS: readonly { name: string; from: From; to: LatencyStage }[] = [
  { name: 'endpoint', from: 'speechEnd', to: 'captureEnd' },
  { name: 'asr', from: 'captureEnd', to: 'asrDone' },
  { name: 'handoff', from: 'asrDone', to: 'commandStart' },
  { name: 'reply', from: 'commandStart', to: 'replyReady' },
  { name: 'output', from: 'replyReady', to: 'done' },
  { name: 'speech → reply', from: 'speech', to: 'replyReady' },
  { name: 'speech → audio', from: 'speech', to: 'firstAudio' },
  { name: 'speech → done', from: 'speech', to: 'done' },
];
/** Rows from a model run's own numbers (LatencyRecord.modelMs and so on), shown after the spans. */
export const MODEL_ROWS: Record<(typeof LATENCY_MODEL_FIELDS)[number], string> = { modelMs: 'model', toolMs: 'tools', firstTokenMs: 'first token' };
/** The span the targets and the slowest list use. */
export const TOTAL_SPAN = 'speech → reply';

/** Plan 7.1, in ms. Local routers: Tier 1 action done. Model: Tier 2 full answer. */
export const TARGETS = { local: { p50: 1500, p95: 2500 }, model: { p50: 4000, p95: 8000 } } as const;

const typed = (r: LatencyRecord) => r.trigger !== 'wake' && r.trigger !== 'ptt';

/** One span of one record in ms, or null when a stage is missing or the times run backwards. */
export function spanMs(r: LatencyRecord, from: From, to: LatencyStage): number | null {
  const a = from === 'speech' ? (r.stages.speechEnd ?? (typed(r) ? 0 : undefined)) : r.stages[from];
  const b = r.stages[to];
  return a === undefined || b === undefined || b < a ? null : b - a;
}

export interface SpanStats {
  n: number;
  p50: number;
  p95: number;
}
export interface LatencyGroup {
  trigger: string;
  /** 'none' = the trigger never became a command. */
  route: string;
  n: number;
  spans: Record<string, SpanStats>;
  /** e.g. "p95 9100 ms, target 8000 ms". Empty when inside the targets or when there is no target. */
  over: string[];
}
export interface LatencyReport {
  days: number;
  triggers: number;
  outcomes: Record<string, number>;
  groups: LatencyGroup[];
  slowest: { id: string; ts: string; trigger: string; route: string; outcome: string; ms: number }[];
}

export function buildReport(records: readonly LatencyRecord[], days: number): LatencyReport {
  const outcomes: Record<string, number> = {};
  const byGroup = new Map<string, LatencyRecord[]>();
  for (const r of records) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const key = `${r.trigger}/${r.route ?? 'none'}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rs]): LatencyGroup => {
      const [trigger, route] = key.split('/') as [string, string];
      const spans: Record<string, SpanStats> = {};
      for (const s of SPANS) {
        const v = rs.map((r) => spanMs(r, s.from, s.to)).filter((x): x is number => x !== null);
        if (v.length) spans[s.name] = { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) };
      }
      for (const f of LATENCY_MODEL_FIELDS) {
        const v = rs.flatMap((r) => (r[f] === undefined ? [] : [r[f]]));
        if (v.length) spans[MODEL_ROWS[f]] = { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) };
      }
      const target = route === 'none' ? null : route === 'model' ? TARGETS.model : TARGETS.local;
      const total = spans[TOTAL_SPAN];
      const over = target && total ? (['p50', 'p95'] as const).filter((p) => total[p] > target[p]).map((p) => `${p} ${total[p]} ms, target ${target[p]} ms`) : [];
      return { trigger, route, n: rs.length, spans, over };
    });
  const slowest = records
    .flatMap((r) => {
      const ms = spanMs(r, 'speech', 'replyReady');
      return ms === null ? [] : [{ id: r.id, ts: r.ts, trigger: r.trigger, route: r.route ?? 'none', outcome: r.outcome, ms }];
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, SLOWEST);
  return { days, triggers: records.length, outcomes, groups, slowest };
}

const pad = (n: number) => String(n).padStart(2, '0');
const when = (ts: string) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function formatReport(r: LatencyReport): string {
  const period = r.days === 1 ? 'last day' : `last ${r.days} days`;
  if (!r.triggers) return `No latency records in the ${period}.`;
  const lines = [
    `Latency, ${period}: ${r.triggers} trigger${r.triggers === 1 ? '' : 's'}`,
    `outcomes: ${Object.entries(r.outcomes).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  ];
  for (const g of r.groups) {
    lines.push('', `${g.trigger} / ${g.route}  (n=${g.n})${g.over.length ? `  OVER: ${g.over.join('; ')}` : ''}`);
    if (!Object.keys(g.spans).length) continue;
    lines.push(`  ${'step'.padEnd(16)}${'n'.padStart(5)}${'p50'.padStart(10)}${'p95'.padStart(10)}`);
    for (const [name, s] of Object.entries(g.spans)) lines.push(`  ${name.padEnd(16)}${String(s.n).padStart(5)}${`${s.p50} ms`.padStart(10)}${`${s.p95} ms`.padStart(10)}`);
  }
  if (r.slowest.length) {
    lines.push('', `Slowest ${r.slowest.length} (${TOTAL_SPAN}):`);
    for (const s of r.slowest) lines.push(`  ${s.id}  ${when(s.ts)}  ${s.trigger} / ${s.route}  ${s.outcome}  ${s.ms} ms`);
  }
  return lines.join('\n');
}

export interface LatencyEnv {
  monitor?: Pick<LatencyMonitor, 'read'>;
  out?: (l: string) => void;
  err?: (l: string) => void;
}

export async function runLatencyCli(argv: string[], e: LatencyEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  const a = parseLatencyArgs(argv);
  if (a === 'help') {
    out(LATENCY_HELP);
    return 0;
  }
  if ('error' in a) {
    err(`${a.error}\n\n${LATENCY_HELP}`);
    return 2;
  }
  const report = buildReport((e.monitor ?? new LatencyMonitor({ home: loadConfig().home })).read(a.days), a.days);
  out(a.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}
