/**
 * app.sock protocol v1: `stephen listen` (server) ⇄ the Stephen window in Stephen Helper.app (client, see
 * helper/AppClient.swift). Design: docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13; example lines shared with the Swift
 * side in test/fixtures/app-protocol-v1.jsonl.
 *
 * Newline-delimited JSON, UTF-8, one object per line, at most APP_MAX_LINE_BYTES per line in both directions.
 * Every request carries a client `id` (echoed in its response); pushes carry none. Unknown request types are ignored
 * (no response); a malformed request gets `{id?, type:"error", message}`. Extra fields are ignored.
 *
 * Additive: `{id, type:"accounts.status"}` → `{id, type:"accounts", accounts:[{id,name,state,source,detail?,hint}], note?}`
 * (which accounts are connected; never a secret value).
 * Additive: `{id, type:"jobs.list"}` → `{id, type:"jobs", jobs:[JobRow]}` (newest first, summaries cleaned and capped) and
 * `{id, type:"jobs.stop", jobId}` → `{id, type:"job", job:JobRow}` or an error (unknown job, jobs are off). Stopping
 * from the window is the owner's own click, so it needs no dialog.
 * Additive to the table in the plan: `{id, type:"window.open"}` → `{id, type:"ok"}`, used by `stephen app` to ask
 * the running listener to forward `{type:"open_window"}` to Stephen Helper.
 */
import type { HistoryEntry } from '../history/store.js';
import type { MemoryItem } from '../memory/store.js';
import type { AuditEntry } from '../types.js';
import type { AccountRow } from './accounts-status.js';
import { APP_JOB_ID_RE, type JobRow } from './jobs-status.js';

export const APP_PROTOCOL_VERSION = '1';
/** Longest line in bytes, without its newline (both directions; AppClient.swift APP_MAX_LINE_BYTES). */
export const APP_MAX_LINE_BYTES = 256 * 1024;
/** chat.send text limit in characters (grapheme clusters, like Swift's String.count; APP_CHAT_MAX_CHARS). */
export const APP_CHAT_MAX_CHARS = 2000;
/** memory.add / memory.update text sent on to the store (which allows 200 and explains a refusal). */
export const APP_MEMORY_TEXT_MAX_CHARS = 2000;
export const APP_HISTORY_LIMIT_MAX = 100;
export const APP_AUDIT_LIMIT_MAX = 200;
export const APP_AUDIT_LIMIT_DEFAULT = 100;
/** Client ids: short strings ("a12"). */
export const APP_ID_MAX_CHARS = 64;
const MEM_ID_MAX_CHARS = 32;

export type AppRequest =
  | { id: string; type: 'hello'; version: string }
  | { id: string; type: 'chat.send'; text: string }
  | { id: string; type: 'chat.stop' }
  | { id: string; type: 'history.list'; before?: string; limit?: number }
  | { id: string; type: 'history.clear' }
  | { id: string; type: 'memory.list' }
  | { id: string; type: 'memory.add'; text: string }
  | { id: string; type: 'memory.update'; memId: string; text: string }
  | { id: string; type: 'memory.forget'; memId: string }
  | { id: string; type: 'memory.clear' }
  | { id: string; type: 'settings.get' }
  | { id: string; type: 'audit.recent'; limit?: number }
  | { id: string; type: 'accounts.status' }
  | { id: string; type: 'jobs.list' }
  | { id: string; type: 'jobs.stop'; jobId: string }
  | { id: string; type: 'window.open' };

export type AppRequestType = AppRequest['type'];

export const APP_REQUEST_TYPES: readonly AppRequestType[] = [
  'hello',
  'chat.send',
  'chat.stop',
  'history.list',
  'history.clear',
  'memory.list',
  'memory.add',
  'memory.update',
  'memory.forget',
  'memory.clear',
  'settings.get',
  'audit.recent',
  'accounts.status',
  'jobs.list',
  'jobs.stop',
  'window.open',
];

export type AppState = 'idle' | 'listening' | 'recording' | 'working' | 'speaking';
export type ChatOutcome = 'ok' | 'error' | 'cancelled' | 'memory';

/** node → app: responses (with the request's id) and pushes (no id). */
export type AppMessage =
  | { id: string; type: 'hello'; version: string; listening: boolean; model: string }
  | { id: string; type: 'chat.accepted'; entryId: string }
  | { id: string; type: 'ok' }
  | { id: string; type: 'history'; entries: HistoryEntry[] }
  | { id: string; type: 'memory'; items: MemoryItem[] }
  | { id: string; type: 'settings'; config: Record<string, unknown>; configPath: string }
  | { id: string; type: 'audit'; entries: AuditEntry[] }
  | { id: string; type: 'accounts'; accounts: AccountRow[]; note?: string }
  | { id: string; type: 'jobs'; jobs: JobRow[] }
  | { id: string; type: 'job'; job: JobRow }
  | { id?: string; type: 'error'; message: string }
  | { type: 'state'; state: AppState }
  | { type: 'heard'; text: string; source: string }
  | { type: 'chat.done'; entryId: string; reply: string; outcome: ChatOutcome; tools: string[]; ms: number };

export type ParsedRequest =
  | { kind: 'request'; req: AppRequest }
  /** A JSON object with a `type` this server does not know: ignored. */
  | { kind: 'unknown'; type: string }
  /** Answer with `{id?, type:"error", message}`. */
  | { kind: 'invalid'; id?: string; message: string };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as the user sees them (grapheme clusters), counting no further than `max + 1`. */
export function userCharCount(s: string, max = Number.MAX_SAFE_INTEGER): number {
  if (s.length <= max) return [...segmenter.segment(s)].length; // ≤ s.length, so within the cap already
  let n = 0;
  for (const _ of segmenter.segment(s)) if (++n > max) break;
  return n;
}

type Fields = Record<string, unknown>;
type Check = { ok: true } | { ok: false; message: string };

const ok: Check = { ok: true };
const bad = (message: string): Check => ({ ok: false, message });

function text(o: Fields, key: string, max: number, what: string): Check {
  const v = o[key];
  if (typeof v !== 'string') return bad(`${what} must be a string`);
  if (userCharCount(v, max) > max) return bad(`${what} is too long (${max} characters at most)`);
  return ok;
}

function optionalLimit(o: Fields, max: number): Check {
  const v = o.limit;
  if (v === undefined || v === null) return ok;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) return bad(`limit must be a whole number from 1 to ${max}`);
  return ok;
}

function memId(o: Fields): Check {
  const v = o.memId;
  if (typeof v !== 'string' || !v || v.length > MEM_ID_MAX_CHARS) return bad('memId must be a memory id like "m7"');
  return ok;
}

const CHECKS: Record<AppRequestType, (o: Fields) => Check> = {
  hello: (o) => (typeof o.version === 'string' && o.version.length <= 16 ? ok : bad('version must be a string')),
  'chat.send': (o) => text(o, 'text', APP_CHAT_MAX_CHARS, 'text'),
  'chat.stop': () => ok,
  'history.list': (o) => {
    if (o.before !== undefined && o.before !== null && (typeof o.before !== 'string' || o.before.length > 40 || Number.isNaN(Date.parse(o.before)))) {
      return bad('before must be an ISO date/time');
    }
    return optionalLimit(o, APP_HISTORY_LIMIT_MAX);
  },
  'history.clear': () => ok,
  'memory.list': () => ok,
  'memory.add': (o) => text(o, 'text', APP_MEMORY_TEXT_MAX_CHARS, 'text'),
  'memory.update': (o) => {
    const m = memId(o);
    return m.ok ? text(o, 'text', APP_MEMORY_TEXT_MAX_CHARS, 'text') : m;
  },
  'memory.forget': memId,
  'memory.clear': () => ok,
  'settings.get': () => ok,
  'audit.recent': (o) => optionalLimit(o, APP_AUDIT_LIMIT_MAX),
  'accounts.status': () => ok,
  'jobs.list': () => ok,
  'jobs.stop': (o) => (typeof o.jobId === 'string' && APP_JOB_ID_RE.test(o.jobId) ? ok : bad('jobId must be a job folder name like 2026-11-05-write-my-report')),
  'window.open': () => ok,
};

/** The request with only the fields its type uses (nulls dropped). */
function pick(type: AppRequestType, id: string, o: Fields): AppRequest {
  const has = (k: string) => o[k] !== undefined && o[k] !== null;
  switch (type) {
    case 'hello':
      return { id, type, version: o.version as string };
    case 'chat.send':
    case 'memory.add':
      return { id, type, text: o.text as string };
    case 'memory.update':
      return { id, type, memId: o.memId as string, text: o.text as string };
    case 'jobs.stop':
      return { id, type, jobId: o.jobId as string };
    case 'memory.forget':
      return { id, type, memId: o.memId as string };
    case 'history.list':
      return { id, type, ...(has('before') ? { before: o.before as string } : {}), ...(has('limit') ? { limit: o.limit as number } : {}) };
    case 'audit.recent':
      return { id, type, ...(has('limit') ? { limit: o.limit as number } : {}) };
    default:
      return { id, type } as AppRequest;
  }
}

/** Parse and validate one line from a client. */
export function parseAppRequest(line: string): ParsedRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'invalid', message: 'not JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', message: 'not a JSON object' };
  const o = raw as Fields;
  const id = typeof o.id === 'string' && o.id.length > 0 && o.id.length <= APP_ID_MAX_CHARS ? o.id : undefined;
  if (typeof o.type !== 'string') return { kind: 'invalid', ...(id ? { id } : {}), message: 'missing "type"' };
  if (!(APP_REQUEST_TYPES as readonly string[]).includes(o.type)) return { kind: 'unknown', type: o.type.slice(0, 64) };
  const type = o.type as AppRequestType;
  if (!id) return { kind: 'invalid', message: `"${type}" needs an "id" (a string of 1 to ${APP_ID_MAX_CHARS} characters)` };
  const c = CHECKS[type](o);
  if (!c.ok) return { kind: 'invalid', id, message: c.message };
  return { kind: 'request', req: pick(type, id, o) };
}

/** One message as a protocol line (JSON + "\n"). */
export function encodeAppMessage(msg: AppMessage): string {
  return `${JSON.stringify(msg)}\n`;
}
