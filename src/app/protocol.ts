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
 * Additive (ROADMAP P2, src/app/control.ts), the owner's own clicks, so no dialog:
 *   `{id, type:"phone.on"}` / `{id, type:"phone.off"}` → `{id, type:"phone", on, lines}` (what `stephen phone on|off`
 *   printed; same checks and kill switch), `{id, type:"zen.open"}` → `{id, type:"zen", ok, message}`,
 *   `{id, type:"doctor.run"}` → `{id, type:"doctor", checks:[{ok,label,detail?,fix?,blocking?,info?}], problems, blocking}`.
 *   phone.on, zen.open and doctor.run can take up to a minute or more (the lock-down check starts Claude Code).
 * Additive (ROADMAP P2, src/app/usage.ts): `{id, type:"usage.get"}` → `{id, type:"usage", context:{percent, warn, tokens,
 *   window} | null, memory:{percent, warn, bytes, budget}}` (warn at 80%; context null when unknown).
 * Additive (plan A2, src/telemetry/cli.ts): `{id, type:"latency.get", days?}` (days 1, 7 or 30; default 7) →
 *   `{id, type:"latency", days, triggers, text}`: the `stephen latency` report as plain text (ids, code words and
 *   numbers only), for Settings > Speed.
 * Additive to the table in the plan: `{id, type:"window.open"}` → `{id, type:"ok"}`, used by `stephen app` to ask
 * the running listener to forward `{type:"open_window"}` to Stephen Helper.
 * Additive (issue #205): `{id, type:"media.key", action:"play"|"pause"|"toggle"|"next"|"previous"}` → `{id, type:"ok"}`
 * or an error with the reason. media_control (src/desktop/media-key.ts) uses it to press a Mac media key through the
 * listener's Stephen Helper when no browser tab or music app can be controlled. "pause" presses only while sound plays.
 * Additive (Ask box "Needs your OK", UI-PLAN v3.1 section 5; threat model in docs/SYSTEM-DESIGN-STEPHEN.md section 5):
 *  - `hello` may carry `confirms: true` (this client shows questions: the Ask box), and the hello answer carries
 *    `confirms: true` (this listener relays them).
 *  - `{id, type:"confirm.ask", title, body, timeoutMs}` (from the safety gate, src/safety/app-confirm.ts) →
 *    `{id, type:"confirm.result", outcome:"approved"|"declined"|"unavailable"}` once answered, timed out (declined)
 *    or when no Ask box is connected (unavailable, so the gate falls back to the dialog).
 *  - push `{type:"confirm", confirmId, title, body}` to Ask box clients only; push `{type:"confirm.end", confirmId}`
 *    when that question is gone (answered, timed out, or the asker left).
 *  - `{id, type:"confirm.answer", confirmId, approve}` → `{id, type:"ok"}`, or an error when that exact id is not
 *    waiting. It answers only that one question, and never from the connection that asked.
 * Additive (Personal page, UI-PLAN v3.1 section 7, src/app/personal.ts), read-only: `{id, type:"personal.summary"}` →
 *   `{id, type:"personal", about:{name?, school?, work?, notes, timeZone},
 *   routines:[{id, name, uses, say, state:"ready"|"needs_setup"|"off", missing?}],
 *   permissions:{columns:[string], rows:[{action, cells:[{level:"allowed"|"asks"|"never", rule}]}]}}`.
 * Additive (Memory page, UI-PLAN v3.1 section 7a; threat model in docs/SYSTEM-DESIGN-STEPHEN.md "Memory proposals").
 *   The model never writes memory: proposals wait until the owner clicks Keep or Skip here.
 *  - `{id, type:"memory.graph"}` → `{id, type:"graph", nodes:[{id, text, kind, new}], links:[{a, b}]}` (kind people |
 *    school | places | habits | projects | other, by fixed rules in src/app/memory-graph.ts; new = a waiting proposal).
 *  - `{id, type:"memory.suggestions"}` → `{id, type:"suggestions", suggestions:[{id, text, origin, untrusted, createdAt}]}`
 *    (newest first; origin is always you; untrusted is always false).
 *  - `{id, type:"memory.propose", text}` (the Tell Stephen box; origin "you") → `suggestions`, or an error (secret …).
 *  - `{id, type:"memory.keep", propId, text?}` → `{id, type:"memory", items}` (saved through MemoryStore.add with the
 *    proposal's origin; `text` = the owner's edit). A refused keep leaves the proposal waiting.
 *  - `{id, type:"memory.skip", propId}` → `suggestions`.
 *  - `{id, type:"memory.usage"}` → `{id, type:"memory.usage", memory:{percent, warn, bytes, budget}}` (usage.get's memory bar).
 * Additive (replay recorder switch, issue #48 PR 2), sent only by Settings > Privacy and safety, the owner's own clicks:
 *  - `{id, type:"replay.set", enabled}` → `settings` (config.replay.enabled is the saved value). The only message that
 *    writes `voice.replay.enabled`: settings.set and model.set refuse it.
 *  - `{id, type:"replay.delete"}` → `{id, type:"ok"}`: every saved clip, the same code as `stephen replay delete --all`.
 *  - push `{type:"replay", on}` (issue #208): whether the recorder would save an F5 command now. Sent after hello, when
 *    it changes (config.json is re-read every 2 s and on every F5), and after replay.set. Drives the "Recording on"
 *    sign. Read only: nothing the window sends back changes it except replay.set.
 */
import type { ChatStep } from './steps.js';
import { MEDIA_KEY_ACTIONS, type MediaKeyAction } from '../helper/protocol.js';
import type { HistoryEntry } from '../history/store.js';
import type { MemoryItem } from '../memory/store.js';
import { isProposalId, type MemoryProposal } from '../memory/proposals.js';
import type { MemoryGraph } from './memory-graph.js';
import type { AuditEntry } from '../types.js';
import type { AccountRow } from './accounts-status.js';
import type { DoctorCheck } from './control.js';
import type { PersonalSummary } from './personal.js';
import type { UsageReport } from './usage.js';
import { checkTalkChanges, type TalkState } from '../voice/talk.js';
import { checkModelChange, type ModelChanges } from './model.js';
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
/** confirm.ask caps: the same as the macOS dialog (DIALOG_BODY_MAX in src/safety/confirm.ts). */
export const APP_CONFIRM_TITLE_MAX = 200;
export const APP_CONFIRM_BODY_MAX = 4000;
export const APP_CONFIRM_TIMEOUT_MAX_MS = 3600 * 1000;
/** confirmIds are randomUUID() strings. */
const CONFIRM_ID_RE = /^[0-9a-f-]{36}$/;
const MEM_ID_MAX_CHARS = 32;

export type AppRequest =
  | { id: string; type: 'hello'; version: string; confirms?: boolean }
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
  | { id: string; type: 'settings.set'; values: Partial<TalkState> }
  | { id: string; type: 'model.set'; model?: string; effort?: string }
  | { id: string; type: 'audit.recent'; limit?: number }
  | { id: string; type: 'accounts.status' }
  | { id: string; type: 'jobs.list' }
  | { id: string; type: 'jobs.stop'; jobId: string }
  | { id: string; type: 'window.open' }
  | { id: string; type: 'media.key'; action: MediaKeyAction }
  | { id: string; type: 'confirm.ask'; title: string; body: string; timeoutMs: number }
  | { id: string; type: 'confirm.answer'; confirmId: string; approve: boolean }
  | { id: string; type: 'phone.on' }
  | { id: string; type: 'phone.off' }
  | { id: string; type: 'zen.open' }
  | { id: string; type: 'doctor.run' }
  | { id: string; type: 'usage.get' }
  | { id: string; type: 'latency.get'; days?: number }
  | { id: string; type: 'personal.summary' }
  | { id: string; type: 'memory.graph' }
  | { id: string; type: 'memory.suggestions' }
  | { id: string; type: 'memory.propose'; text: string }
  | { id: string; type: 'memory.keep'; propId: string; text?: string }
  | { id: string; type: 'memory.skip'; propId: string }
  | { id: string; type: 'memory.usage' }
  | { id: string; type: 'replay.set'; enabled: boolean }
  | { id: string; type: 'replay.delete' };

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
  'settings.set',
  'model.set',
  'audit.recent',
  'accounts.status',
  'jobs.list',
  'jobs.stop',
  'window.open',
  'media.key',
  'confirm.ask',
  'confirm.answer',
  'phone.on',
  'phone.off',
  'zen.open',
  'doctor.run',
  'usage.get',
  'latency.get',
  'personal.summary',
  'memory.graph',
  'memory.suggestions',
  'memory.propose',
  'memory.keep',
  'memory.skip',
  'memory.usage',
  'replay.set',
  'replay.delete',
];

export type AppState = 'idle' | 'listening' | 'recording' | 'working' | 'speaking';
export type ChatOutcome = 'ok' | 'error' | 'cancelled' | 'memory';
export type ConfirmResult = 'approved' | 'declined' | 'unavailable';

/** node → app: responses (with the request's id) and pushes (no id). */
export type AppMessage =
  | { id: string; type: 'hello'; version: string; listening: boolean; model: string; confirms: true }
  | { id: string; type: 'chat.accepted'; entryId: string }
  | { id: string; type: 'ok' }
  | { id: string; type: 'history'; entries: HistoryEntry[] }
  | { id: string; type: 'memory'; items: MemoryItem[] }
  | { id: string; type: 'settings'; config: Record<string, unknown>; configPath: string }
  | { id: string; type: 'audit'; entries: AuditEntry[] }
  | { id: string; type: 'accounts'; accounts: AccountRow[]; note?: string }
  | { id: string; type: 'jobs'; jobs: JobRow[] }
  | { id: string; type: 'job'; job: JobRow }
  | { id: string; type: 'confirm.result'; outcome: ConfirmResult }
  | { id: string; type: 'phone'; on: boolean; lines: string[] }
  | { id: string; type: 'zen'; ok: boolean; message: string }
  | { id: string; type: 'doctor'; checks: DoctorCheck[]; problems: number; blocking: number }
  | ({ id: string; type: 'usage' } & UsageReport)
  | { id: string; type: 'latency'; days: number; triggers: number; text: string }
  | ({ id: string; type: 'personal' } & PersonalSummary)
  | ({ id: string; type: 'graph' } & MemoryGraph)
  | { id: string; type: 'suggestions'; suggestions: MemoryProposal[] }
  | { id: string; type: 'memory.usage'; memory: UsageReport['memory'] }
  | { id?: string; type: 'error'; message: string }
  | { type: 'confirm'; confirmId: string; title: string; body: string }
  | { type: 'confirm.end'; confirmId: string }
  | { type: 'state'; state: AppState }
  | { type: 'replay'; on: boolean }
  | { type: 'heard'; text: string; source: string }
  /** `steps`: what Stephen did (src/app/steps.ts), only when there is at least one; an older helper ignores it. */
  | { type: 'chat.done'; entryId: string; reply: string; outcome: ChatOutcome; tools: string[]; ms: number; steps?: ChatStep[] };

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

function propId(o: Fields): Check {
  return isProposalId(o.propId) ? ok : bad('propId must be a proposal id like "p3"');
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
  'settings.set': (o) => {
    const c = checkTalkChanges(o.values);
    return c.ok ? ok : bad(c.message);
  },
  'model.set': (o) => {
    const c = checkModelChange(o);
    return c.ok ? ok : bad(c.message);
  },
  'audit.recent': (o) => optionalLimit(o, APP_AUDIT_LIMIT_MAX),
  'accounts.status': () => ok,
  'jobs.list': () => ok,
  'jobs.stop': (o) => (typeof o.jobId === 'string' && APP_JOB_ID_RE.test(o.jobId) ? ok : bad('jobId must be a job folder name like 2026-11-05-write-my-report')),
  'window.open': () => ok,
  'media.key': (o) => (typeof o.action === 'string' && (MEDIA_KEY_ACTIONS as readonly string[]).includes(o.action) ? ok : bad('action must be play, pause, toggle, next or previous')),
  'confirm.ask': (o) => {
    const t = text(o, 'title', APP_CONFIRM_TITLE_MAX, 'title');
    if (!t.ok) return t;
    const b = text(o, 'body', APP_CONFIRM_BODY_MAX, 'body');
    if (!b.ok) return b;
    const ms = o.timeoutMs;
    return typeof ms === 'number' && Number.isInteger(ms) && ms >= 1000 && ms <= APP_CONFIRM_TIMEOUT_MAX_MS
      ? ok
      : bad(`timeoutMs must be a whole number from 1000 to ${APP_CONFIRM_TIMEOUT_MAX_MS}`);
  },
  'confirm.answer': (o) =>
    typeof o.confirmId !== 'string' || !CONFIRM_ID_RE.test(o.confirmId)
      ? bad('confirmId must be the id from a confirm push')
      : typeof o.approve !== 'boolean'
        ? bad('approve must be true or false')
        : ok,
  'phone.on': () => ok,
  'phone.off': () => ok,
  'zen.open': () => ok,
  'doctor.run': () => ok,
  'usage.get': () => ok,
  'latency.get': (o) => (o.days === undefined || o.days === null || o.days === 1 || o.days === 7 || o.days === 30 ? ok : bad('days must be 1, 7 or 30')),
  'personal.summary': () => ok,
  'memory.graph': () => ok,
  'memory.suggestions': () => ok,
  'memory.propose': (o) => text(o, 'text', APP_MEMORY_TEXT_MAX_CHARS, 'text'),
  'memory.keep': (o) => {
    const p = propId(o);
    if (!p.ok || o.text === undefined || o.text === null) return p;
    return text(o, 'text', APP_MEMORY_TEXT_MAX_CHARS, 'text');
  },
  'memory.skip': propId,
  'memory.usage': () => ok,
  'replay.set': (o) => (typeof o.enabled === 'boolean' ? ok : bad('enabled must be true or false')),
  'replay.delete': () => ok,
};

/** The request with only the fields its type uses (nulls dropped). */
function pick(type: AppRequestType, id: string, o: Fields): AppRequest {
  const has = (k: string) => o[k] !== undefined && o[k] !== null;
  switch (type) {
    case 'hello':
      return { id, type, version: o.version as string, ...(o.confirms === true ? { confirms: true } : {}) };
    case 'confirm.ask':
      return { id, type, title: o.title as string, body: o.body as string, timeoutMs: o.timeoutMs as number };
    case 'confirm.answer':
      return { id, type, confirmId: o.confirmId as string, approve: o.approve as boolean };
    case 'chat.send':
    case 'memory.add':
    case 'memory.propose':
      return { id, type, text: o.text as string };
    case 'memory.keep':
      return { id, type, propId: o.propId as string, ...(has('text') ? { text: o.text as string } : {}) };
    case 'memory.skip':
      return { id, type, propId: o.propId as string };
    case 'settings.set':
      return { id, type, values: (checkTalkChanges(o.values) as { changes: Partial<TalkState> }).changes };
    case 'model.set':
      return { id, type, ...(checkModelChange(o) as { changes: ModelChanges }).changes };
    case 'memory.update':
      return { id, type, memId: o.memId as string, text: o.text as string };
    case 'jobs.stop':
      return { id, type, jobId: o.jobId as string };
    case 'media.key':
      return { id, type, action: o.action as MediaKeyAction };
    case 'memory.forget':
      return { id, type, memId: o.memId as string };
    case 'history.list':
      return { id, type, ...(has('before') ? { before: o.before as string } : {}), ...(has('limit') ? { limit: o.limit as number } : {}) };
    case 'audit.recent':
      return { id, type, ...(has('limit') ? { limit: o.limit as number } : {}) };
    case 'latency.get':
      return { id, type, ...(has('days') ? { days: o.days as number } : {}) };
    case 'replay.set':
      return { id, type, enabled: o.enabled as boolean };
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
