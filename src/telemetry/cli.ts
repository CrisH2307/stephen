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
 * model's own numbers (model, tools, first token) are shown without a target.
 *
 * Only `ok` commands are inside a group's p50, p95 and OVER check (review R10a-7): a cancelled or failed command
 * would be a fast row that hides a slow reply, or a slow one that is not the reply's fault. The other outcomes of a
 * group are shown as counts. Wake triggers get TRIGGER_EXTRA_MS on top of the base target. Also shown: wake_ignored by
 * reason, tool names with p50, cold versus warm, Esc to silence, wake to chime, and the tier labels (shadow mode).
 */
import { localDate } from '../history/store.js';
import { loadConfig } from '../config.js';
import { percentile } from '../lib/step-timer.js';
import { LATENCY_MODEL_FIELDS, LatencyMonitor, type LatencyRecord, type LatencyStage, type LatencyTrigger } from './latency.js';
import { parseVoiceConfig } from '../voice/config.js';

export const LATENCY_HELP = `stephen latency: how long Stephen takes, from the local latency log (ids and numbers only)

  stephen latency [--days 1|7|30] [--json]   default: the last 7 days

Per trigger and route: p50 and p95 of each step, measured from end of speech.
"OVER" marks a group that is slower than the plan's target. Then the 10 slowest commands by id.
Cost per day shows the daily limit (voice.dailyLimit) and the percent used.`;

export const LATENCY_DAYS = [1, 7, 30] as const;
export const SLOWEST = 10;

export type DailyLimit = { enabled: boolean; usd: number };

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
type From = LatencyStage | 'speech' | 'trigger';
export const SPANS: readonly { name: string; from: From; to: LatencyStage }[] = [
  { name: 'endpoint', from: 'speechEnd', to: 'captureEnd' },
  { name: 'asr', from: 'captureEnd', to: 'asrDone' },
  { name: 'handoff', from: 'asrDone', to: 'commandStart' },
  { name: 'reply', from: 'commandStart', to: 'replyReady' },
  { name: 'output', from: 'replyReady', to: 'done' },
  { name: 'speech → reply', from: 'speech', to: 'replyReady' },
  { name: 'speech → audio', from: 'speech', to: 'firstAudio' },
  { name: 'speech → done', from: 'speech', to: 'done' },
  { name: 'wake → chime', from: 'trigger', to: 'chime' },
];
/** Rows from a model run's own numbers (LatencyRecord.modelMs and so on), shown after the spans. */
export const MODEL_ROWS: Record<(typeof LATENCY_MODEL_FIELDS)[number], string> = { modelMs: 'model', toolMs: 'tools', firstTokenMs: 'first token' };
/** The span the targets and the slowest list use. */
export const TOTAL_SPAN = 'speech → reply';

/** Plan 7.1, in ms. Local routers: Tier 1 action done. Model: Tier 2 full answer. */
export const TARGETS = { local: { p50: 1500, p95: 2500 }, model: { p50: 4000, p95: 8000 } } as const;

/**
 * Extra ms on top of the base target, per trigger. The plan allows the wake word +0.8 s until the wake endpoint work
 * lands (then set it to 0). The key triggers and typed commands have no extra.
 */
export const TRIGGER_EXTRA_MS: Record<LatencyTrigger, number> = { wake: 800, ptt: 0, app: 0, phone: 0, cli: 0 };

const typed = (r: LatencyRecord) => r.trigger !== 'wake' && r.trigger !== 'ptt';

/** One span of one record in ms, or null when a stage is missing or the times run backwards. */
export function spanMs(r: LatencyRecord, from: From, to: LatencyStage): number | null {
  const a = from === 'trigger' ? 0 : from === 'speech' ? (r.stages.speechEnd ?? (typed(r) ? 0 : undefined)) : r.stages[from];
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
  /** All rows of the group. `spans` and `over` use only the ok rows (`outcomes.ok`). */
  n: number;
  /** Rows per outcome. */
  outcomes: Record<string, number>;
  spans: Record<string, SpanStats>;
  /** Tool calls of the ok rows, by Stephen tool name (names only). */
  tools: Record<string, SpanStats>;
  /** speech → reply of the ok model rows, by cold or warm start. */
  starts: Record<string, SpanStats>;
  /** e.g. "p95 9100 ms, target 8000 ms". Empty when inside the targets or when there is no target. */
  over: string[];
}
export interface LatencyReport {
  days: number;
  triggers: number;
  outcomes: Record<string, number>;
  /** wake_ignored by reason ('unknown' for a row without one, e.g. written by an older version). */
  ignored: Record<string, number>;
  /** Tier labels from the shadow classifier ('none' = not labelled), and the reason codes of Tier 2. */
  tiers: Record<string, number>;
  reasons: Record<string, number>;
  /** Cancel to the reply going silent (all rows with the number). */
  silence: SpanStats | null;
  groups: LatencyGroup[];
  slowest: { id: string; ts: string; trigger: string; route: string; outcome: string; ms: number }[];
  /** Model cost per local day (USD, 2 decimals), newest first; n = records with a cost. */
  cost: { day: string; n: number; usd: number; pct: number | null }[];
  costTotal: number;
  /** The daily cost limit from config (null when the config could not be read). */
  limit: DailyLimit | null;
}

const stats = (v: number[]): SpanStats => ({ n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) });
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export function buildReport(records: readonly LatencyRecord[], days: number, limit: DailyLimit | null = null): LatencyReport {
  const outcomes: Record<string, number> = {};
  const ignored: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const byGroup = new Map<string, LatencyRecord[]>();
  const costByDay = new Map<string, { n: number; usd: number }>();
  for (const r of records) {
    bump(outcomes, r.outcome);
    if (r.outcome === 'wake_ignored') bump(ignored, r.ignored ?? 'unknown');
    bump(tiers, r.tier === null ? 'none' : String(r.tier));
    if (r.reason) bump(reasons, r.reason);
    const key = `${r.trigger}/${r.route ?? 'none'}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
    if (r.costUsd !== undefined) {
      const day = localDate(new Date(r.ts));
      const c = costByDay.get(day) ?? { n: 0, usd: 0 };
      costByDay.set(day, { n: c.n + 1, usd: c.usd + r.costUsd });
    }
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, all]): LatencyGroup => {
      const [trigger, route] = key.split('/') as [string, string];
      const groupOutcomes: Record<string, number> = {};
      for (const r of all) bump(groupOutcomes, r.outcome);
      const rs = all.filter((r) => r.outcome === 'ok'); // R10a-7: only ok commands are timed
      const spans: Record<string, SpanStats> = {};
      for (const s of SPANS) {
        const v = rs.map((r) => spanMs(r, s.from, s.to)).filter((x): x is number => x !== null);
        if (v.length) spans[s.name] = stats(v);
      }
      for (const f of LATENCY_MODEL_FIELDS) {
        const v = rs.flatMap((r) => (r[f] === undefined ? [] : [r[f]]));
        if (v.length) spans[MODEL_ROWS[f]] = stats(v);
      }
      const byTool = new Map<string, number[]>();
      const byStart = new Map<string, number[]>();
      for (const r of rs) {
        for (const t of r.tools ?? []) byTool.set(t.name, [...(byTool.get(t.name) ?? []), t.ms]);
        const total = spanMs(r, 'speech', 'replyReady');
        if (r.start && total !== null) byStart.set(r.start, [...(byStart.get(r.start) ?? []), total]);
      }
      const tools = Object.fromEntries([...byTool].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stats(v)]));
      const starts = Object.fromEntries([...byStart].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stats(v)]));
      const base = route === 'none' ? null : route === 'model' ? TARGETS.model : TARGETS.local;
      const extra = TRIGGER_EXTRA_MS[trigger as LatencyTrigger] ?? 0;
      const target = base && { p50: base.p50 + extra, p95: base.p95 + extra };
      const total = spans[TOTAL_SPAN];
      const over = target && total ? (['p50', 'p95'] as const).filter((p) => total[p] > target[p]).map((p) => `${p} ${total[p]} ms, target ${target[p]} ms`) : [];
      return { trigger, route, n: all.length, outcomes: groupOutcomes, spans, tools, starts, over };
    });
  const silenceMs = records.flatMap((r) => (r.silenceMs === undefined ? [] : [r.silenceMs]));
  const slowest = records
    .flatMap((r) => {
      if (r.outcome !== 'ok') return [];
      const ms = spanMs(r, 'speech', 'replyReady');
      return ms === null ? [] : [{ id: r.id, ts: r.ts, trigger: r.trigger, route: r.route ?? 'none', outcome: r.outcome, ms }];
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, SLOWEST);
  const usd = (n: number) => Math.round(n * 100) / 100;
  const byDay = [...costByDay.entries()].sort(([a], [b]) => b.localeCompare(a));
  const cost = byDay.map(([day, c]) => {
    const unroundedUsd = c.usd;
    const usdRounded = usd(c.usd);
    const pct = limit?.enabled ? Math.round(unroundedUsd / limit.usd * 100) : null;
    return { day, n: c.n, usd: usdRounded, pct };
  });
  const costTotal = usd(byDay.reduce((sum, [, c]) => sum + c.usd, 0));
  return { days, triggers: records.length, outcomes, ignored, tiers, reasons, silence: silenceMs.length ? stats(silenceMs) : null, groups, slowest, cost, costTotal, limit };
}

const pad = (n: number) => String(n).padStart(2, '0');
const when = (ts: string) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "a 2, b 1". */
const counts = (m: Record<string, number>): string =>
  Object.entries(m)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');

export function formatReport(r: LatencyReport): string {
  const period = r.days === 1 ? 'last day' : `last ${r.days} days`;
  if (!r.triggers) return `No latency records in the ${period}.`;
  const lines = [
    `Latency, ${period}: ${r.triggers} trigger${r.triggers === 1 ? '' : 's'}`,
    `outcomes: ${Object.entries(r.outcomes).map(([k, n]) => `${k} ${n}${k === 'wake_ignored' && Object.keys(r.ignored).length ? ` (${counts(r.ignored)})` : ''}`).join(', ')}`,
    `tier (shadow): ${counts(r.tiers)}${Object.keys(r.reasons).length ? `; tier 2 reasons: ${counts(r.reasons)}` : ''}`,
  ];
  if (r.silence) lines.push(`Esc to silence (n=${r.silence.n}): p50 ${r.silence.p50} ms, p95 ${r.silence.p95} ms`);
  for (const g of r.groups) {
    const other = Object.entries(g.outcomes).filter(([k]) => k !== 'ok');
    lines.push('', `${g.trigger} / ${g.route}  (n=${g.n}, ok ${g.outcomes.ok ?? 0}${other.length ? `; not timed: ${other.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''})${g.over.length ? `  OVER: ${g.over.join('; ')}` : ''}`);
    if (!Object.keys(g.spans).length) continue;
    lines.push(`  ${'step'.padEnd(16)}${'n'.padStart(5)}${'p50'.padStart(10)}${'p95'.padStart(10)}`);
    const row = (name: string, s: SpanStats) => `  ${name.padEnd(16)}${String(s.n).padStart(5)}${`${s.p50} ms`.padStart(10)}${`${s.p95} ms`.padStart(10)}`;
    for (const [name, s] of Object.entries(g.spans)) lines.push(row(name, s));
    for (const [name, s] of Object.entries(g.tools)) lines.push(row(`tool ${name}`.slice(0, 15), s));
    for (const [name, s] of Object.entries(g.starts)) lines.push(row(`${name} start`, s));
  }
  if (r.cost.length) {
    lines.push('', 'Cost per day (model runs, USD):');
    const limitLine = r.limit === null ? '  daily limit unknown (config could not be read)' : r.limit.enabled ? `  daily limit ${r.limit.usd.toFixed(2)} USD` : '  daily limit off';
    for (const c of r.cost) {
      const pctSuffix = c.pct !== null ? `  ${c.pct}% of limit` : '';
      lines.push(`  ${c.day}  ${String(c.n).padStart(4)} runs  ${c.usd.toFixed(2).padStart(8)} USD${pctSuffix}`);
    }
    lines.push(`  ${'total'.padEnd(10)}  ${''.padStart(9)}  ${r.costTotal.toFixed(2).padStart(8)} USD`);
    lines.push(limitLine);
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
  limit?: DailyLimit | null;
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
  let limit: DailyLimit | null;
  if (e.limit !== undefined) {
    limit = e.limit;
  } else {
    try {
      limit = parseVoiceConfig(loadConfig().voice).dailyLimit;
    } catch {
      limit = null;
    }
  }
  const report = buildReport((e.monitor ?? new LatencyMonitor({ home: loadConfig().home })).read(a.days), a.days, limit);
  out(a.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}

// ───────────── stephen report --week (F13) ─────────────

/**
 * `stephen report --week` (F13): a weekly summary a friend can paste to Cris. Content-free on purpose: it is built only
 * from parsed latency and incident records, so every value is a number, a code word, a version or a date. No command
 * text, page, host, name or path can reach it (the parsers drop every free-text field).
 */
export const WEEK_DAYS = 7;
const VERSION_RE = /^\d{1,4}(\.\d{1,6}){0,3}$/;
/** Trigger outcomes that were not a command (nothing was asked). */
const NOT_A_COMMAND = new Set(['wake_ignored', 'no_wake', 'no_speech', 'short_press']);

export interface WeeklySummary {
  from: string;
  to: string;
  /** Oldest day first, every one of the 7 local days, zeros included. */
  days: { day: string; commands: number; failed: number; jobs: number; usd: number; jobUsd: number }[];
  incidents: Record<string, number>;
  /** speech → reply of ok commands, split local routers and the model. */
  local: SpanStats | null;
  model: SpanStats | null;
  commands: number;
  failed: number;
  jobs: number;
  usd: number;
  /** Background jobs' own model cost (job state costUsd), by the day each job ended or started. */
  jobUsd: number;
  stephen: string;
  claude: string;
}

const safeVersion = (v: string | null | undefined): string => (v && VERSION_RE.test(v) ? v : 'unknown');

export function buildWeekly(
  latency: readonly LatencyRecord[],
  incidents: readonly { ts: string; code: string }[],
  now: Date,
  versions: { stephen?: string | null; claude?: string | null },
  jobCosts: readonly { at: number; usd: number }[] = [],
): WeeklySummary {
  const dayList = Array.from({ length: WEEK_DAYS }, (_, i) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (WEEK_DAYS - 1 - i))));
  const days = new Map(dayList.map((day) => [day, { day, commands: 0, failed: 0, jobs: 0, usd: 0, jobUsd: 0 }]));
  const local: number[] = [];
  const model: number[] = [];
  for (const r of latency) {
    const d = days.get(localDate(new Date(r.ts)));
    if (!d || NOT_A_COMMAND.has(r.outcome)) continue;
    d.commands++;
    if (r.outcome === 'error') d.failed++;
    if (r.route === 'job') d.jobs++;
    if (r.costUsd !== undefined) d.usd += r.costUsd;
    const ms = r.outcome === 'ok' ? spanMs(r, 'speech', 'replyReady') : null;
    if (ms !== null) (r.route === 'model' ? model : local).push(ms);
  }
  for (const j of jobCosts) {
    const d = Number.isFinite(j.at) && Number.isFinite(j.usd) && j.usd >= 0 ? days.get(localDate(new Date(j.at))) : undefined;
    if (d) d.jobUsd += j.usd;
  }
  const inc: Record<string, number> = {};
  for (const i of incidents) if (days.has(localDate(new Date(i.ts)))) bump(inc, i.code);
  const rows = [...days.values()].map((d) => ({ ...d, usd: Math.round(d.usd * 100) / 100, jobUsd: Math.round(d.jobUsd * 100) / 100 }));
  const sum = (k: 'commands' | 'failed' | 'jobs') => rows.reduce((n, d) => n + d[k], 0);
  return {
    from: dayList[0]!,
    to: dayList[WEEK_DAYS - 1]!,
    days: rows,
    incidents: inc,
    local: local.length ? stats(local) : null,
    model: model.length ? stats(model) : null,
    commands: sum('commands'),
    failed: sum('failed'),
    jobs: sum('jobs'),
    usd: Math.round(rows.reduce((n, d) => n + d.usd, 0) * 100) / 100,
    jobUsd: Math.round(rows.reduce((n, d) => n + d.jobUsd, 0) * 100) / 100,
    stephen: safeVersion(versions.stephen),
    claude: safeVersion(versions.claude),
  };
}

export function formatWeekly(s: WeeklySummary): string {
  const time = (name: string, t: SpanStats | null) => `${name}: ${t ? `median ${t.p50} ms, p95 ${t.p95} ms (n=${t.n})` : 'no timed commands'}`;
  return [
    `Stephen week ${s.from} to ${s.to}`,
    `Stephen ${s.stephen}, Claude Code ${s.claude}`,
    `Commands ${s.commands}, failed ${s.failed}, jobs started ${s.jobs}, model cost ${s.usd.toFixed(2)} USD, job cost ${s.jobUsd.toFixed(2)} USD`,
    time('Local commands, speech to reply', s.local),
    time('Model commands, speech to reply', s.model),
    `Incidents: ${Object.keys(s.incidents).length ? counts(Object.fromEntries(Object.entries(s.incidents).sort(([a], [b]) => a.localeCompare(b)))) : 'none'}`,
    'Per day:',
    ...s.days.map((d) => `  ${d.day}: commands ${d.commands}, failed ${d.failed}, jobs ${d.jobs}, model ${d.usd.toFixed(2)} USD, job ${d.jobUsd.toFixed(2)} USD`),
  ].join('\n');
}

export interface WeeklyEnv {
  monitor?: Pick<LatencyMonitor, 'read'>;
  incidents?: { ts: string; code: string }[];
  now?: Date;
  stephen?: string | null;
  claude?: string | null;
  /** Each job's cost and when it ended (or started): numbers only. cli.ts reads them (src/telemetry may not load src/jobs). */
  jobCosts?: { at: number; usd: number }[];
  out?: (l: string) => void;
}

/** Prints the summary. Reads only the local logs; sends nothing. */
export async function runWeeklyCli(e: WeeklyEnv = {}): Promise<number> {
  const now = e.now ?? new Date();
  let home: string | null = null;
  const homeOf = () => (home ??= loadConfig().home);
  const latency = (e.monitor ?? new LatencyMonitor({ home: homeOf() })).read(WEEK_DAYS + 1);
  const incidents = e.incidents ?? (await import('./incidents.js')).readIncidents(homeOf(), 10_000);
  (e.out ?? ((l: string) => console.log(l)))(formatWeekly(buildWeekly(latency, incidents, now, { stephen: e.stephen, claude: e.claude }, e.jobCosts ?? [])));
  return 0;
}
