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
import { lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { appendPrivateLineCapped, readPrivateRegularFile } from '../lib/fs.js';
import { lastStage, recordIncident } from './incidents.js';
import { localDate } from '../history/store.js';
import { ASR_MODELS } from '../voice/config.js';
import type { Reason } from '../voice/grammar/classify.js';
import type { TtsProviderName } from '../voice/tts/types.js';

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
 * assistant; replyReady = the reply text exists (model or router finished); firstAudio = the first sound of the spoken
 * reply started (the player was started; absent when the reply was only shown); done = reply spoken or shown;
 * chime = the wake chime was started (Node sees the call to the player, not the first sample of sound).
 */
export const LATENCY_STAGES = ['speechEnd', 'captureEnd', 'asrDone', 'commandStart', 'replyReady', 'firstAudio', 'done', 'chime'] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

export interface LatencyRecord {
  v: 1;
  id: string;
  /** ISO time of the trigger. */
  ts: string;
  trigger: LatencyTrigger;
  route: LatencyRoute | null;
  /** Tier 1 or 2 (plan 2.5), from the classifier in shadow mode (src/voice/grammar); null = not classified. */
  tier: 1 | 2 | null;
  outcome: LatencyOutcome;
  /** The model run continued a conversation (a warm process or --resume). */
  followUp: boolean;
  turns: number;
  stages: Partial<Record<LatencyStage, number>>;
  /** p99 event-loop delay while the command ran, ms (plan 8.1). */
  loopP99Ms?: number;
  /** Model run only (warm process): time waiting for the model, summed over its turns, ms. */
  modelMs?: number;
  /** Model run only: time the tools took (tool call sent → tool result back), summed, ms. */
  toolMs?: number;
  /** Model run only: prompt sent → first streamed token, ms. Only when Claude Code streams partial messages. */
  firstTokenMs?: number;
  /** Time from the owner's cancel to the spoken reply actually stopping, ms (Esc, "stephen stop", barge-in). */
  silenceMs?: number;
  /** Speech-to-text model that handled the command (a code word). */
  asr?: (typeof LATENCY_ASR)[number];
  /** Text-to-speech engine that spoke the reply (a code word). */
  tts?: (typeof LATENCY_TTS)[number];
  /** Model run only: fresh process or warm. */
  start?: (typeof LATENCY_START)[number];
  /** The classifier's reason when it said Tier 2 (shadow mode). */
  reason?: LatencyReason;
  /** wake_ignored only: why. */
  ignored?: (typeof LATENCY_IGNORED)[number];
  /** Model run only: what the run cost in USD, as Claude Code reports it (0 to 100, 6 decimals). A number, never text. */
  costUsd?: number;
  /** 1 = the replay recorder was on for this F5 command (issue #48). Never anything about the clip itself. */
  replay?: 0 | 1;
  /** Which Stephen tools ran and how long each took, in call order. Names only, never arguments or results. */
  tools?: { name: LatencyToolName; ms: number }[];
}

/**
 * What a caller may add to a record besides stages. The strings are loose on purpose: parseLatencyRecord turns an
 * unknown code word into 'other' (a tool, ASR, TTS, start, ignored) or drops it (a reason), so a caller cannot put text in.
 */
export interface LatencyNote {
  tier?: 1 | 2 | null;
  reason?: string;
  asr?: string;
  tts?: string;
  start?: string;
  ignored?: string;
  replay?: 0 | 1;
  silenceMs?: number;
  tools?: { name: string; ms: number }[];
}

/** The model-run numbers of a record (LatencyRecord's optional fields). */
export const LATENCY_MODEL_FIELDS = ['modelMs', 'toolMs', 'firstTokenMs'] as const;
export type LatencyModelTimes = Partial<Record<(typeof LATENCY_MODEL_FIELDS)[number], number>>;

/**
 * Closed code lists for the fields below. A value that is not in its list is recorded as 'other' (never the value),
 * so no free text can reach a record. ASR and TTS come from the config's own lists.
 */
export const LATENCY_ASR = [...ASR_MODELS, 'other'] as const;
export const LATENCY_TTS = ['elevenlabs', 'kokoro', 'say', 'other'] as const satisfies readonly (TtsProviderName | 'other')[];
/** cold = a fresh model process for this command; warm = a warm process or --resume. */
export const LATENCY_START = ['cold', 'warm', 'other'] as const;
/** Why a wake word was not acted on. */
export const LATENCY_IGNORED = ['sound_playing', 'audio_unknown', 'cooldown', 'other'] as const;
/** The classifier's reason codes (src/voice/grammar/classify.ts, shadow mode). Only these are ever recorded. */
export const LATENCY_REASONS = [
  'empty', 'question', 'compound', 'no_verb', 'leftover_words', 'ambiguous_entity', 'unknown_entity',
  'fuzzy_only', 'bad_arg', 'empty_payload', 'code_like', 'vague_query',
] as const satisfies readonly Reason[];
export type LatencyReason = (typeof LATENCY_REASONS)[number];
// Compile-time check: a reason added to the classifier must be added to the list above.
const reasonsCovered: [Exclude<Reason, LatencyReason>] extends [never] ? true : never = true;
void reasonsCovered;
/** Stephen's own MCP tools (src/server/tools.ts, src/desktop, src/accounts). test/telemetry compares this to the real server. */
export const LATENCY_TOOLS = [
  'browser_status', 'browser_connect', 'tabs_list', 'tab_open', 'tab_focus', 'tab_close', 'navigate', 'history', 'snapshot', 'find',
  'read_text', 'screenshot', 'click', 'hover', 'type', 'fill_form', 'select_option', 'press_key', 'scroll', 'wait_for', 'upload_file',
  'handle_dialog', 'recent_actions', 'evaluate', 'open_app', 'open_url', 'play_media', 'media_control', 'volume', 'desktop_status',
  'canvas_due', 'canvas_announcements', 'canvas_inbox', 'calendar_events', 'notion_todos', 'notion_search', 'gmail_search', 'gmail_read',
  'weather_now', 'announce', 'other',
] as const;
export type LatencyToolName = (typeof LATENCY_TOOLS)[number];
/** Tool calls kept per record. */
export const MAX_LATENCY_TOOLS = 12;

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

const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 86_400_000 ? Math.round(v) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
/** A code from a list that ends with 'other': any other string becomes 'other'; a non-string is absent. */
const code = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' ? (oneOf(list, v) ?? ('other' as T)) : null);

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
  const model: LatencyModelTimes = {};
  for (const f of LATENCY_MODEL_FIELDS) {
    const n = ms(o[f]);
    if (n !== null) model[f] = n;
  }
  const extra: Partial<LatencyRecord> = {};
  const silence = ms(o.silenceMs);
  if (silence !== null) extra.silenceMs = silence;
  const asr = code(LATENCY_ASR, o.asr);
  if (asr) extra.asr = asr;
  const tts = code(LATENCY_TTS, o.tts);
  if (tts) extra.tts = tts;
  const start = code(LATENCY_START, o.start);
  if (start) extra.start = start;
  const ignored = code(LATENCY_IGNORED, o.ignored);
  if (ignored) extra.ignored = ignored;
  if (o.replay === 0 || o.replay === 1) extra.replay = o.replay;
  const reason = oneOf(LATENCY_REASONS, o.reason);
  if (reason) extra.reason = reason;
  if (Array.isArray(o.tools)) {
    const tools: { name: LatencyToolName; ms: number }[] = [];
    for (const t of o.tools.slice(0, MAX_LATENCY_TOOLS)) {
      const t0 = t && typeof t === 'object' ? (t as Record<string, unknown>) : null;
      const n = t0 ? ms(t0.ms) : null;
      if (t0 && n !== null) tools.push({ name: code(LATENCY_TOOLS, t0.name) ?? 'other', ms: n });
    }
    if (tools.length) extra.tools = tools;
  }
  // A number only, 0 to 100 USD: anything else is dropped (the record stays).
  if (typeof o.costUsd === 'number' && Number.isFinite(o.costUsd) && o.costUsd >= 0 && o.costUsd <= 100) extra.costUsd = Math.round(o.costUsd * 1e6) / 1e6;
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
    ...model,
    ...extra,
  };
}

/** What the listener and the assistant hooks call. Every method is safe to call with an id that is not open. */
export interface LatencyTrace {
  /** A trigger happened at `at` (epoch ms, default now). A second begin for an open id is ignored. */
  begin(id: string, trigger: LatencyTrigger, at?: number): void;
  /** Stage reached at `at` (epoch ms, default now). A later mark of the same stage replaces the earlier one. */
  mark(id: string, stage: LatencyStage, at?: number): void;
  /** The trigger is over: write its line. A second end for the same id does nothing. */
  end(id: string, outcome: LatencyOutcome, extra?: LatencyEnd): void;
  /** Add code words and numbers to an open trigger (a later note of the same field replaces the earlier one). */
  note(id: string, note: LatencyNote): void;
}

export type LatencyEnd = { route?: LatencyRoute | null; followUp?: boolean; turns?: number; model?: LatencyModelTimes; costUsd?: number } & LatencyNote;

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
  note: LatencyNote;
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
    this.open.set(id, { t0: at ?? this.now(), trigger, stages: {}, note: {} });
  }

  mark(id: string, stage: LatencyStage, at?: number): void {
    const t = this.open.get(id);
    if (t) t.stages[stage] = Math.max(0, Math.round((at ?? this.now()) - t.t0));
  }

  note(id: string, note: LatencyNote): void {
    const t = this.open.get(id);
    if (t) Object.assign(t.note, note);
  }

  end(id: string, outcome: LatencyOutcome, extra: LatencyEnd = {}): void {
    const t = this.open.get(id);
    if (!t) return;
    this.open.delete(id);
    const rec = parseLatencyRecord({
      ...t.note,
      ...extra,
      v: 1,
      id,
      ts: new Date(t.t0).toISOString(),
      trigger: t.trigger,
      route: extra.route ?? null,
      outcome,
      followUp: extra.followUp ?? false,
      turns: extra.turns ?? 0,
      stages: t.stages,
      loopP99Ms: this.o.loop?.p99Ms(),
      ...extra.model,
    });
    if (!rec) return;
    // A failed command is an incident too (docs/NFR-STEPHEN.md section 9): its id, last stage and numbers, nothing else.
    if (outcome === 'error') {
      const model = Object.fromEntries(LATENCY_MODEL_FIELDS.flatMap((f) => (rec[f] === undefined ? [] : [[f, rec[f]]])));
      recordIncident(this.o.home, { part: 'listen', code: 'command_error', id, stage: lastStage(rec.stages), stages: rec.stages, model }, new Date(this.now()));
    }
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
    appendPrivateLineCapped(join(this.dir, `latency-${localDate(day)}.jsonl`), line, MAX_LATENCY_DAY_BYTES);
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
      const text = readPrivateRegularFile(join(this.dir, name), MAX_LATENCY_DAY_BYTES);
      if (text === null) continue;
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
