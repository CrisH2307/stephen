/**
 * Latency monitor (docs/research/PRODUCT-PLAN-2026-11.md A2): one line per trigger in
 * `<home>/telemetry/latency-YYYY-MM-DD.jsonl`, keyed by the command id the listener mints at the trigger (the same id
 * as the history entry).
 *
 * Privacy (plan Q20): a record holds an id, a timestamp, fixed code words and numbers. Nothing here accepts a
 * transcript, an argument, a URL, page text or audio, and parseLatencyRecord drops any field it does not know, so a
 * caller cannot add one by accident. Files are 0600 in a 0700 folder and are deleted after LATENCY_RETENTION_DAYS.
 *
 * Recording never fails a command: every error goes to `log`.
 */
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LATENCY_TRIGGERS = ['wake', 'ptt', 'app', 'phone', 'cli'] as const;
export type LatencyTrigger = (typeof LATENCY_TRIGGERS)[number];

/** Who answered: a local router (0 model turns) or the model. null = the trigger never became a command. */
export const LATENCY_ROUTES = ['memory', 'timer', 'job', 'model'] as const;
export type LatencyRoute = (typeof LATENCY_ROUTES)[number];

/**
 * How the trigger ended. The first three are commands. The rest never reached the assistant, and count as trigger
 * failures in the accuracy baseline (A6):
 * wake_ignored = wake word while sound played or in the cooldown; no_wake = the transcript did not confirm the wake
 * phrase; no_speech = nothing was said; short_press = an F5 tap under the minimum hold; aborted = the helper dropped
 * mid-press; stop_phrase = "Stephen, stop" with nothing running.
 */
export const LATENCY_OUTCOMES = ['ok', 'error', 'cancelled', 'wake_ignored', 'no_wake', 'no_speech', 'short_press', 'aborted', 'stop_phrase'] as const;
export type LatencyOutcome = (typeof LATENCY_OUTCOMES)[number];

/**
 * Stage times in ms after the trigger (wake word heard, or key down).
 * speechEnd = the owner stopped talking (F5: key up); captureEnd = Stephen decided the command ended (so
 * captureEnd - speechEnd is the endpoint wait); asrDone = the transcript is ready; commandStart = handed to the
 * assistant; replyReady = the reply text exists (model or router finished); done = reply spoken or shown.
 */
export const LATENCY_STAGES = ['speechEnd', 'captureEnd', 'asrDone', 'commandStart', 'replyReady', 'done'] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

export interface LatencyRecord {
  v: 1;
  id: string;
  /** ISO time of the trigger. */
  ts: string;
  trigger: LatencyTrigger;
  route: LatencyRoute | null;
  /** Tier 1 or 2 (plan 2.5). null until the command grammar exists (E6). */
  tier: 1 | 2 | null;
  outcome: LatencyOutcome;
  /** The model run continued a conversation (a warm process or --resume). */
  followUp: boolean;
  turns: number;
  stages: Partial<Record<LatencyStage, number>>;
  /** p99 event-loop delay while the command ran, ms (plan 8.1). */
  loopP99Ms?: number;
}

export const LATENCY_RETENTION_DAYS = 30;
/** A day file larger than this takes no more lines (about 20,000 commands). */
export const MAX_LATENCY_DAY_BYTES = 4 * 1024 * 1024;
/** Triggers kept open at once; the oldest is dropped (a trigger whose end was never reported). */
const MAX_OPEN = 16;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^latency-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function latencyDir(home: string): string {
  return join(home, 'telemetry');
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 86_400_000 ? Math.round(v) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

/** A valid record rebuilt field by field from parsed JSON (unknown fields are dropped), or null. */
export function parseLatencyRecord(v: unknown): LatencyRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const trigger = oneOf(LATENCY_TRIGGERS, o.trigger);
  const outcome = oneOf(LATENCY_OUTCOMES, o.outcome);
  if (o.v !== 1 || typeof o.id !== 'string' || !ID_RE.test(o.id) || !trigger || !outcome) return null;
  if (typeof o.ts !== 'string' || o.ts.length > 40 || Number.isNaN(Date.parse(o.ts))) return null;
  const stages: Partial<Record<LatencyStage, number>> = {};
  const src = o.stages && typeof o.stages === 'object' ? (o.stages as Record<string, unknown>) : {};
  for (const s of LATENCY_STAGES) {
    const n = ms(src[s]);
    if (n !== null) stages[s] = n;
  }
  const loop = ms(o.loopP99Ms);
  return {
    v: 1,
    id: o.id,
    ts: new Date(Date.parse(o.ts)).toISOString(),
    trigger,
    route: oneOf(LATENCY_ROUTES, o.route),
    tier: o.tier === 1 || o.tier === 2 ? o.tier : null,
    outcome,
    followUp: o.followUp === true,
    turns: ms(o.turns) ?? 0,
    stages,
    ...(loop !== null ? { loopP99Ms: loop } : {}),
  };
}

/** What the listener and the assistant hooks call. Every method is safe to call with an id that is not open. */
export interface LatencyTrace {
  /** A trigger happened at `at` (epoch ms, default now). A second begin for an open id is ignored. */
  begin(id: string, trigger: LatencyTrigger, at?: number): void;
  /** Stage reached at `at` (epoch ms, default now). A later mark of the same stage replaces the earlier one. */
  mark(id: string, stage: LatencyStage, at?: number): void;
  /** The trigger is over: write its line. A second end for the same id does nothing. */
  end(id: string, outcome: LatencyOutcome, extra?: { route?: LatencyRoute | null; followUp?: boolean; turns?: number }): void;
}

export interface LatencyMonitorOptions {
  home: string;
  /** Epoch ms. ponytail: wall clock, because the helper's key times are wall clock too; a clock step mid-command skews one row. */
  now?: () => number;
  log?: (line: string) => void;
  /** Event-loop delay meter (index.ts passes perf_hooks' histogram); reset at begin, read at end. */
  loop?: { reset(): void; p99Ms(): number } | null;
}

interface Open {
  t0: number;
  trigger: LatencyTrigger;
  stages: Partial<Record<LatencyStage, number>>;
}

export class LatencyMonitor implements LatencyTrace {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly open = new Map<string, Open>();
  constructor(private readonly o: LatencyMonitorOptions) {
    this.dir = latencyDir(o.home);
    this.now = o.now ?? Date.now;
  }

  begin(id: string, trigger: LatencyTrigger, at?: number): void {
    if (!ID_RE.test(id) || this.open.has(id)) return;
    if (this.open.size >= MAX_OPEN) this.open.delete(this.open.keys().next().value!);
    if (this.open.size === 0) this.o.loop?.reset();
    this.open.set(id, { t0: at ?? this.now(), trigger, stages: {} });
  }

  mark(id: string, stage: LatencyStage, at?: number): void {
    const t = this.open.get(id);
    if (t) t.stages[stage] = Math.max(0, Math.round((at ?? this.now()) - t.t0));
  }

  end(id: string, outcome: LatencyOutcome, extra: { route?: LatencyRoute | null; followUp?: boolean; turns?: number } = {}): void {
    const t = this.open.get(id);
    if (!t) return;
    this.open.delete(id);
    const rec = parseLatencyRecord({
      v: 1,
      id,
      ts: new Date(t.t0).toISOString(),
      trigger: t.trigger,
      route: extra.route ?? null,
      tier: null,
      outcome,
      followUp: extra.followUp ?? false,
      turns: extra.turns ?? 0,
      stages: t.stages,
      loopP99Ms: this.o.loop?.p99Ms(),
    });
    if (!rec) return;
    try {
      this.append(rec, new Date(t.t0));
    } catch (e) {
      this.o.log?.(`Note: could not write the latency log (${(e as Error).message}).`);
    }
  }

  private append(rec: LatencyRecord, day: Date): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.dir).isDirectory()) throw new Error(`${this.dir} is not a real folder`);
    const line = `${JSON.stringify(rec)}\n`;
    const fd = openSync(join(this.dir, `latency-${localDate(day)}.jsonl`), fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error('the day file is not a regular file');
      if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
      if (st.size + Buffer.byteLength(line) <= MAX_LATENCY_DAY_BYTES) writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }

  /** Delete day files older than LATENCY_RETENTION_DAYS (call at listener start). Returns how many were deleted. */
  purge(): number {
    const n = new Date(this.now());
    const cutoff = localDate(new Date(n.getFullYear(), n.getMonth(), n.getDate() - LATENCY_RETENTION_DAYS));
    let removed = 0;
    for (const { name, date } of this.files()) {
      if (date >= cutoff) continue;
      try {
        unlinkSync(join(this.dir, name));
        removed++;
      } catch {
        /* best effort */
      }
    }
    return removed;
  }

  /** Records of the last `days` days (1 to LATENCY_RETENTION_DAYS), oldest first. Bad lines are skipped. */
  read(days: number): LatencyRecord[] {
    const since = this.now() - Math.min(LATENCY_RETENTION_DAYS, Math.max(1, days)) * 86_400_000;
    const firstDay = localDate(new Date(since));
    const out: LatencyRecord[] = [];
    for (const { name, date } of this.files().sort((a, b) => a.date.localeCompare(b.date))) {
      if (date < firstDay) continue;
      let text = '';
      try {
        const fd = openSync(join(this.dir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          if (fstatSync(fd).isFile()) text = readFileSync(fd, 'utf8');
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = parseLatencyRecord(JSON.parse(line));
          if (r && Date.parse(r.ts) >= since) out.push(r);
        } catch {
          /* skip */
        }
      }
    }
    return out;
  }

  private files(): { name: string; date: string }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      const m = FILE_RE.exec(name);
      return m ? [{ name, date: m[1]! }] : [];
    });
  }
}
