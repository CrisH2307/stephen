/**
 * Canvas LMS, read-only (phase 2a). Two questions the owner asks by voice:
 *   - "what's due this week?"      → canvas_due: planner items in a window (assignments, quizzes, discussions…)
 *   - "any Canvas announcements?"  → canvas_announcements: announcements of active courses in the last N days
 *   - "any Canvas messages?"       → canvas_inbox: the newest conversations in the Canvas inbox (who, when, subject)
 * API (Canvas REST v1, personal access token): GET /api/v1/planner/items, /api/v1/courses, /api/v1/announcements,
 * /api/v1/users/self (connection test). Everything is a GET on the one Canvas origin (ApiClient).
 *
 * Fetching (CanvasClient) and formatting (formatDue / formatAnnouncements) are separate, so the formatting is pure and
 * tested with fixtures, and the client is tested against a fake Canvas server.
 */
import { ApiClient, type ApiClientOptions } from './http.js';
import { field } from './result.js';

export const DEFAULT_CANVAS_URL = 'https://learn.ontariotechu.ca';
export const MAX_DAYS = 30;

/** The parts of a planner item Stephen uses (Canvas returns many more). */
export interface PlannerItem {
  context_name?: string | null;
  plannable_type?: string;
  plannable_date?: string | null;
  plannable?: { title?: string | null; name?: string | null; due_at?: string | null; todo_date?: string | null } | null;
  submissions?: false | { submitted?: boolean; missing?: boolean; late?: boolean; graded?: boolean; excused?: boolean } | null;
  planner_override?: { marked_complete?: boolean } | null;
}

export interface Course {
  id: number;
  name?: string | null;
  course_code?: string | null;
}

export interface Conversation {
  id: number;
  subject?: string | null;
  workflow_state?: string | null;
  last_message?: string | null;
  last_message_at?: string | null;
  context_name?: string | null;
  participants?: { id?: number; name?: string | null }[] | null;
}

export interface Announcement {
  title?: string | null;
  message?: string | null;
  posted_at?: string | null;
  context_code?: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  assignment: 'assignment',
  quiz: 'quiz',
  discussion_topic: 'discussion',
  wiki_page: 'page',
  planner_note: 'to-do',
  calendar_event: 'event',
  assessment_request: 'peer review',
};

/** "Mon Nov 3, 11:59 PM" in `timeZone` (default: the Mac's). */
export function whenText(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'no date';
  return new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, ...(timeZone ? { timeZone } : {}) })
    .format(d)
    .replace(/\./g, '');
}

function status(i: PlannerItem): { done: boolean; text: string } {
  if (i.planner_override?.marked_complete) return { done: true, text: 'marked done' };
  const s = i.submissions;
  if (!s) return { done: false, text: '' };
  if (s.excused) return { done: true, text: 'excused' };
  if (s.graded) return { done: true, text: 'graded' };
  if (s.submitted) return { done: true, text: s.late ? 'submitted late' : 'submitted' };
  if (s.missing) return { done: false, text: 'missing' };
  return { done: false, text: 'not submitted' };
}

/** Planner items → sorted lines (announcements are left out; done items only with includeDone). */
export function formatDue(items: readonly PlannerItem[], opts: { includeDone?: boolean; timeZone?: string } = {}): { lines: string[]; done: number } {
  const rows: { t: number; line: string }[] = [];
  let done = 0;
  for (const i of items) {
    const type = i.plannable_type ?? '';
    if (type === 'announcement') continue;
    const date = i.plannable?.due_at ?? i.plannable?.todo_date ?? i.plannable_date ?? null;
    const st = status(i);
    if (st.done) {
      done += 1;
      if (!opts.includeDone) continue;
    }
    const title = field(i.plannable?.title ?? i.plannable?.name ?? '(untitled)', 160);
    const course = field(i.context_name ?? '', 80);
    const what = [TYPE_LABEL[type] ?? 'item', st.text].filter(Boolean).join(', ');
    rows.push({ t: date ? Date.parse(date) : Infinity, line: `- ${date ? whenText(date, opts.timeZone) : 'no date'} · ${course ? `${course}: ` : ''}${title} (${what})` });
  }
  rows.sort((a, b) => a.t - b.t);
  return { lines: rows.map((r) => r.line), done };
}

/** Announcements → newest first lines with a short excerpt. */
export function formatAnnouncements(items: readonly Announcement[], courses: ReadonlyMap<string, string>, opts: { timeZone?: string } = {}): string[] {
  return [...items]
    .sort((a, b) => Date.parse(b.posted_at ?? '') - Date.parse(a.posted_at ?? ''))
    .map((a) => {
      const course = field(courses.get(a.context_code ?? '') ?? '', 80);
      const when = a.posted_at ? whenText(a.posted_at, opts.timeZone) : 'no date';
      const excerpt = field(a.message ?? '', 240);
      return `- ${when} · ${course ? `${course} · ` : ''}"${field(a.title ?? '(untitled)', 160)}"${excerpt ? ` — ${excerpt}` : ''}`;
    });
}

/**
 * Inbox conversations → lines, newest first. `whoOnly` (wake word and phone, like email: docs/REVIEW-7.md R7-2): who
 * and when only, no subject or text. Every page-supplied string goes through `field` (cleaned, codes masked, capped).
 */
export function formatInbox(items: readonly Conversation[], selfId: number | null, opts: { whoOnly?: boolean; timeZone?: string } = {}): string[] {
  return [...items]
    .sort((a, b) => Date.parse(b.last_message_at ?? '') - Date.parse(a.last_message_at ?? ''))
    .map((c) => {
      const when = c.last_message_at ? whenText(c.last_message_at, opts.timeZone) : 'no date';
      const others = (c.participants ?? []).filter((p) => p && p.id !== selfId).map((p) => field(p.name ?? '', 60)).filter(Boolean);
      const who = others.length ? `from ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}` : 'from (unknown)';
      const unread = c.workflow_state === 'unread' ? ' (unread)' : '';
      if (opts.whoOnly) return `- ${when} · ${who}${unread}`;
      const course = field(c.context_name ?? '', 80);
      const excerpt = field(c.last_message ?? '', 240);
      return `- ${when} · ${course ? `${course} · ` : ''}${who} · "${field(c.subject ?? '(no subject)', 160)}"${unread}${excerpt ? ` — ${excerpt}` : ''}`;
    });
}

export class CanvasClient {
  readonly api: ApiClient;
  constructor(o: ApiClientOptions) {
    this.api = new ApiClient({ maxPages: 5, ...o });
  }

  /** Connection test: the account's display name. */
  async whoAmI(): Promise<string> {
    const me = await this.api.getJson<{ name?: string; short_name?: string }>('/api/v1/users/self');
    return field(me.short_name || me.name || 'unknown', 80);
  }

  async plannerItems(start: Date, end: Date): Promise<{ items: PlannerItem[]; truncated: boolean }> {
    const q = new URLSearchParams({ start_date: start.toISOString(), end_date: end.toISOString(), per_page: '100' });
    return this.api.getAllPages<PlannerItem>(`/api/v1/planner/items?${q}`);
  }

  async activeCourses(): Promise<Course[]> {
    const q = new URLSearchParams({ enrollment_state: 'active', per_page: '100' });
    return (await this.api.getAllPages<Course>(`/api/v1/courses?${q}`)).items.filter((c) => Number.isSafeInteger(c?.id));
  }

  /** The account's own user id (to leave the owner out of each conversation's participants). */
  async selfId(): Promise<number | null> {
    const me = await this.api.getJson<{ id?: unknown }>('/api/v1/users/self');
    return Number.isSafeInteger(me.id) ? (me.id as number) : null;
  }

  /** The newest `limit` inbox conversations (one page), or only the unread ones. */
  async conversations(unreadOnly: boolean, limit: number): Promise<Conversation[]> {
    const q = new URLSearchParams({ scope: unreadOnly ? 'unread' : 'inbox', per_page: String(limit) });
    const r = await this.api.getJson<unknown>(`/api/v1/conversations?${q}`);
    return Array.isArray(r) ? (r as Conversation[]).filter((c) => c && Number.isSafeInteger(c.id)).slice(0, limit) : [];
  }

  async announcements(courseIds: readonly number[], start: Date, end: Date): Promise<{ items: Announcement[]; truncated: boolean }> {
    if (!courseIds.length) return { items: [], truncated: false };
    const q = new URLSearchParams({ start_date: start.toISOString(), end_date: end.toISOString(), per_page: '50' });
    for (const id of courseIds.slice(0, 40)) q.append('context_codes[]', `course_${id}`);
    return this.api.getAllPages<Announcement>(`/api/v1/announcements?${q}`);
  }
}

/** A day count from Claude, clamped to 1..MAX_DAYS. */
export function clampDays(n: number | undefined, dflt: number): number {
  const v = Math.floor(n ?? dflt);
  return Number.isFinite(v) ? Math.min(MAX_DAYS, Math.max(1, v)) : dflt;
}
