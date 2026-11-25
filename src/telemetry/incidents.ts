/**
 * Incident log, phase 1 of the incident loop (docs/NFR-STEPHEN.md section 9): one line per crash or failed command in
 * `<home>/incidents/YYYY-MM-DD.jsonl`. `stephen report` shows them and, only when the person types "y", files them as
 * a GitHub issue. The repo is public, so a record must be safe for anyone to read.
 *
 * Privacy (the telemetry rules in section 9): an id, a time, versions, closed code words and numbers. Never a message,
 * a transcript, a URL, a host, a path, a name or audio. parseIncidentRecord rebuilds a record field by field and
 * drops anything it does not know, and an unknown code word becomes 'other', so a caller cannot add text by accident.
 * Files are 0600 in a 0700 folder and are deleted after INCIDENT_RETENTION_DAYS.
 *
 * Recording never throws: an incident is written while something else is already failing.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { appendPrivateLineCapped, readPrivateRegularFile } from '../lib/fs.js';
// Types only: `stephen serve` loads this file, and latency.ts pulls in history code that serve must never load.
import type { LATENCY_MODEL_FIELDS as LatencyModelFields, LatencyModelTimes, LatencyStage } from './latency.js';

/** The latency stages and model fields (latency.ts), copied so serve stays light. The checks below catch drift. */
const STAGES = ['speechEnd', 'captureEnd', 'asrDone', 'commandStart', 'replyReady', 'firstAudio', 'done', 'chime'] as const satisfies readonly LatencyStage[];
const MODEL_FIELDS = ['modelMs', 'toolMs', 'firstTokenMs'] as const satisfies readonly (typeof LatencyModelFields)[number][];
const stagesCovered: [Exclude<LatencyStage, (typeof STAGES)[number]>] extends [never] ? true : never = true;
const fieldsCovered: [Exclude<(typeof LatencyModelFields)[number], (typeof MODEL_FIELDS)[number]>] extends [never] ? true : never = true;
void stagesCovered;
void fieldsCovered;

/** Which part of Stephen failed. `job` is the `stephen jobs` supervisor. */
export const INCIDENT_PARTS = ['listen', 'serve', 'helper', 'job', 'other'] as const;
export type IncidentPart = (typeof INCIDENT_PARTS)[number];

/**
 * What went wrong, as a code word. uncaught = a crash with no error code; command_error = a command ended with
 * outcome `error`; helper_lost = the helper connection dropped. The E codes are Node's own error codes.
 */
export const INCIDENT_CODES = [
  'uncaught', 'command_error', 'helper_lost',
  'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EADDRINUSE', 'EMFILE', 'ENOMEM',
  'ERR_INVALID_ARG_TYPE', 'ERR_STREAM_DESTROYED', 'ERR_SOCKET_CLOSED',
  'other',
] as const;
export type IncidentCode = (typeof INCIDENT_CODES)[number];

/** Where it failed: the last latency stage a command reached, or the phase of a process (start, run). */
export const INCIDENT_STAGES = [...STAGES, 'trigger', 'start', 'run', 'other'] as const;
export type IncidentStage = (typeof INCIDENT_STAGES)[number];

export interface IncidentRecord {
  v: 1;
  id: string;
  /** ISO time. */
  ts: string;
  /** Stephen's version (package.json). */
  stephen: string;
  part: IncidentPart;
  code: IncidentCode;
  stage: IncidentStage;
  /** Node version, digits and dots. */
  node: string;
  /** Darwin kernel release (macOS 26 is Darwin 25), digits and dots; absent off macOS. */
  darwin?: string;
  /** The command's latency stages, ms after the trigger (a failed command only). */
  stages?: Partial<Record<LatencyStage, number>>;
  /** The command's model numbers, ms (a failed model command only). */
  modelMs?: number;
  toolMs?: number;
  firstTokenMs?: number;
}

/** What a caller passes. Strings are loose on purpose: the parser turns anything unknown into 'other'. */
export interface IncidentInput {
  part: string;
  code?: string;
  stage?: string;
  /** A command id (letters, digits, - and _); a random id when absent or not valid. */
  id?: string;
  stages?: Partial<Record<string, number>>;
  model?: LatencyModelTimes;
}

export const INCIDENT_RETENTION_DAYS = 30;
/** A day file larger than this takes no more lines. */
export const MAX_INCIDENT_DAY_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^\d{1,4}(\.\d{1,6}){0,3}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function incidentDir(home: string): string {
  return join(home, 'incidents');
}

const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 86_400_000 ? Math.round(v) : null);
const code = <T extends string>(list: readonly T[], v: unknown): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : ('other' as T));
const version = (v: unknown): string | null => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A valid record rebuilt field by field from parsed JSON (unknown fields are dropped), or null. */
export function parseIncidentRecord(v: unknown): IncidentRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (typeof o.ts !== 'string' || o.ts.length > 40 || Number.isNaN(Date.parse(o.ts))) return null;
  const rec: IncidentRecord = {
    v: 1,
    id: o.id,
    ts: new Date(Date.parse(o.ts)).toISOString(),
    stephen: version(o.stephen) ?? '0.0.0',
    part: code(INCIDENT_PARTS, o.part),
    code: code(INCIDENT_CODES, o.code),
    stage: code(INCIDENT_STAGES, o.stage),
    node: version(o.node) ?? '0',
  };
  const darwin = version(o.darwin);
  if (darwin) rec.darwin = darwin;
  if (o.stages && typeof o.stages === 'object' && !Array.isArray(o.stages)) {
    const src = o.stages as Record<string, unknown>;
    const stages: Partial<Record<LatencyStage, number>> = {};
    for (const s of STAGES) {
      const n = ms(src[s]);
      if (n !== null) stages[s] = n;
    }
    if (Object.keys(stages).length) rec.stages = stages;
  }
  for (const f of MODEL_FIELDS) {
    const n = ms(o[f]);
    if (n !== null) rec[f] = n;
  }
  return rec;
}

let cachedVersion: string | null = null;
/** package.json version (works from src/ and dist/, both two levels below the root). */
function stephenVersion(): string {
  if (cachedVersion === null) {
    try {
      cachedVersion = String((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version);
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}

/** The latest stage a command reached (by time), or 'trigger' when it reached none. */
export function lastStage(stages: Partial<Record<string, number>> | undefined): string {
  let best: [string, number] | null = null;
  for (const [s, t] of Object.entries(stages ?? {})) if (typeof t === 'number' && (!best || t >= best[1])) best = [s, t];
  return best ? best[0] : 'trigger';
}

/** Write one incident line. Never throws; returns the record written, or null. */
export function recordIncident(home: string, input: IncidentInput, now: Date = new Date()): IncidentRecord | null {
  try {
    const rec = parseIncidentRecord({
      v: 1,
      id: input.id && ID_RE.test(input.id) ? input.id : randomUUID(),
      ts: now.toISOString(),
      stephen: stephenVersion(),
      part: input.part,
      code: input.code ?? 'uncaught',
      stage: input.stage ?? 'run',
      node: process.versions.node,
      ...(process.platform === 'darwin' ? { darwin: release() } : {}),
      stages: input.stages,
      ...input.model,
    });
    if (!rec) return null;
    const dir = incidentDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) return null;
    return appendPrivateLineCapped(join(dir, `${localDate(now)}.jsonl`), `${JSON.stringify(rec)}\n`, MAX_INCIDENT_DAY_BYTES) ? rec : null;
  } catch {
    return null;
  }
}

function dayFiles(home: string): { name: string; date: string }[] {
  let names: string[];
  try {
    names = readdirSync(incidentDir(home));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const m = FILE_RE.exec(name);
    return m ? [{ name, date: m[1]! }] : [];
  });
}

/** Delete the day files in `files` (from `dir`) dated before `days` days ago. Returns how many were deleted. Never throws. */
export function purgeDayFiles(dir: string, files: { name: string; date: string }[], days: number, now: Date): number {
  const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  let removed = 0;
  for (const { name, date } of files) {
    if (date >= cutoff) continue;
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/** Delete day files older than INCIDENT_RETENTION_DAYS. Returns how many were deleted. Never throws. */
export function purgeIncidents(home: string, now: Date = new Date()): number {
  return purgeDayFiles(incidentDir(home), dayFiles(home), INCIDENT_RETENTION_DAYS, now);
}

/** The newest `last` incidents, newest first. Bad lines are skipped. */
export function readIncidents(home: string, last: number): IncidentRecord[] {
  const out: IncidentRecord[] = [];
  for (const { name } of dayFiles(home).sort((a, b) => b.date.localeCompare(a.date))) {
    const text = readPrivateRegularFile(join(incidentDir(home), name), MAX_INCIDENT_DAY_BYTES);
    if (text === null) continue;
    const day: IncidentRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = parseIncidentRecord(JSON.parse(line));
        if (r) day.push(r);
      } catch {
        /* skip */
      }
    }
    out.push(...day.reverse().sort((a, b) => b.ts.localeCompare(a.ts))); // reverse first: a tie keeps the later line first
    if (out.length >= last) break;
  }
  return out.slice(0, last);
}
