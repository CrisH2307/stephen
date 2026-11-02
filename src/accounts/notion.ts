/**
 * Notion, read-only (phase 2a). Two questions the owner asks by voice:
 *   - "what's on my to-do list?"   → notion_todos: open items of the owner's to-do database
 *   - "find my Notion page about…" → notion_search: titles only (no page content)
 * API (internal integration token, Notion-Version pinned below): POST /v1/search, GET /v1/databases/{id} (the
 * schema, to find the "done" property), POST /v1/databases/{id}/query. All on https://api.notion.com (ApiClient).
 * The database id comes from config or from a title search, never from Claude. Only `plain_text` fields are read;
 * page/database URLs are never returned.
 *
 * "Open" is decided by one rule picked from the database schema (table-driven, first match wins):
 *   status property (any name)                      → open unless its option is Done/Complete/Closed/Cancelled/Archived (or in such a group)
 *   checkbox named like Done/Complete               → open while unchecked
 *   select named like Status/State/Progress/Stage   → open unless Done/Complete/Archived
 *   none of these                                   → every item counts as open
 * The rule becomes a server-side filter (so old done items don't use up the page cap) and is checked again here.
 */
import { AccountHttpError, ApiClient, type ApiClientOptions } from './http.js';
import { field } from './result.js';
import { whenText } from './canvas.js';

export const NOTION_ORIGIN = 'https://api.notion.com';
/** The one Notion API version Stephen speaks (databases endpoints; newer versions moved to "data sources"). */
export const NOTION_VERSION = '2022-06-28';
/** Query pages (100 items each) read per call at most. */
export const NOTION_MAX_PAGES = 3;
export const MAX_TODOS = 30;
export const MAX_QUERY_CHARS = 80;
export const NO_TODO_DATABASE =
  'Stephen can see no Notion database named like a to-do list. The user should share their to-do database with Stephen\'s Notion integration (database ⋯ menu → Connections), or put its id in config.json as accounts.notion.todoDatabase.';
/** Database titles that look like a to-do list (auto-pick when no id is configured). */
export const TODO_TITLE = /to.?do|task/i;

// ───────────── API shapes (only the parts Stephen reads) ─────────────

interface RichText {
  plain_text?: string;
}
interface SchemaOption {
  id?: string;
  name?: string;
}
export interface SchemaProp {
  type?: string;
  status?: { options?: SchemaOption[]; groups?: { name?: string; option_ids?: string[] }[] };
  select?: { options?: SchemaOption[] };
}
export interface PropValue {
  type?: string;
  title?: RichText[];
  checkbox?: boolean;
  status?: { name?: string } | null;
  select?: { name?: string } | null;
  date?: { start?: string | null } | null;
}
export interface NotionPage {
  object?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, PropValue>;
  /** databases only */
  title?: RichText[];
}
interface ListBody<T> {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// ───────────── pure helpers ─────────────

/** A 32-hex Notion id (dashes optional) → the dashed form, else null. */
export function normalizeNotionId(raw: string): string | null {
  const hex = raw.trim().replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const plain = (rt: RichText[] | undefined): string => (Array.isArray(rt) ? rt.map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : '')).join('') : '');

/** A page's title (its `title`-type property) or a database's title. */
export function titleOf(p: NotionPage): string {
  if (Array.isArray(p.title)) return plain(p.title);
  for (const v of Object.values(p.properties ?? {})) if (v?.type === 'title') return plain(v.title);
  return '';
}

const CLOSED = /^(done|complete|completed|archived|close|closed|cancel+ed|won'?t do)$/i;

export interface DoneRule {
  property: string;
  type: 'status' | 'checkbox' | 'select';
  /** status/select: option names that mean "not open". */
  closed: string[];
}

const RULES: readonly { type: DoneRule['type']; name: RegExp }[] = [
  { type: 'status', name: /./ },
  { type: 'checkbox', name: /done|complete|finished/i },
  { type: 'select', name: /status|state|progress|stage/i },
];

/** The property that says whether an item is done (see the table at the top), or null. */
export function doneRule(schema: Record<string, SchemaProp>): DoneRule | null {
  for (const r of RULES) {
    for (const [name, p] of Object.entries(schema)) {
      if (p?.type !== r.type || !r.name.test(name)) continue;
      if (r.type === 'checkbox') return { property: name, type: 'checkbox', closed: [] };
      const opts = (r.type === 'status' ? p.status?.options : p.select?.options) ?? [];
      const closedIds = new Set((p.status?.groups ?? []).filter((g) => CLOSED.test(g?.name ?? '')).flatMap((g) => g.option_ids ?? []));
      const closed = opts.filter((o) => CLOSED.test(o?.name ?? '') || (o?.id && closedIds.has(o.id))).map((o) => o.name ?? '');
      return { property: name, type: r.type, closed: closed.filter(Boolean).slice(0, 20) };
    }
  }
  return null;
}

/** The query filter for open items, or undefined (no rule / nothing closed). */
export function openFilter(rule: DoneRule | null): unknown {
  if (!rule) return undefined;
  if (rule.type === 'checkbox') return { property: rule.property, checkbox: { equals: false } };
  const parts = rule.closed.map((n) => ({ property: rule.property, [rule.type]: { does_not_equal: n } }));
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : { and: parts };
}

/** Is this item open, and its status words. */
export function itemState(page: NotionPage, rule: DoneRule | null): { open: boolean; status: string } {
  if (page.archived || page.in_trash) return { open: false, status: 'archived' };
  if (!rule) return { open: true, status: '' };
  const v = page.properties?.[rule.property];
  if (rule.type === 'checkbox') return { open: v?.checkbox !== true, status: v?.checkbox === true ? 'done' : '' };
  const name = (rule.type === 'status' ? v?.status?.name : v?.select?.name) ?? '';
  return { open: !rule.closed.includes(name) && !CLOSED.test(name), status: name };
}

/** The due date of an item: the first date property, preferring one named like Due/Deadline. */
function dueOf(page: NotionPage): string | null {
  const dates = Object.entries(page.properties ?? {}).filter(([, v]) => v?.type === 'date' && typeof v.date?.start === 'string');
  const pick = dates.find(([k]) => /due|deadline/i.test(k)) ?? dates[0];
  return pick ? (pick[1].date!.start as string) : null;
}

/** "Tue, Nov 3" for a date-only value (no time-zone shift), else the date and time in `timeZone`. */
export function dueText(start: string, timeZone?: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const d = new Date(`${start}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return 'no date';
    return new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d).replace(/\./g, '');
  }
  return whenText(start, timeZone);
}

/** Query results → open items as sorted lines (earliest due first, undated last). */
export function formatTodos(pages: readonly NotionPage[], rule: DoneRule | null, opts: { timeZone?: string } = {}): string[] {
  const rows: { t: number; line: string }[] = [];
  for (const p of pages) {
    const st = itemState(p, rule);
    if (!st.open) continue;
    const due = dueOf(p);
    const title = field(titleOf(p) || '(untitled)', 160);
    const status = field(st.status, 40);
    rows.push({ t: due ? Date.parse(due.length === 10 ? `${due}T12:00:00Z` : due) || Infinity : Infinity, line: `- ${title}${due ? ` · due ${dueText(due, opts.timeZone)}` : ''}${status ? ` (${status})` : ''}` });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.map((r) => r.line);
}

/** Search results → "title · page|database · edited <date>" lines. */
export function formatSearch(results: readonly NotionPage[], opts: { timeZone?: string } = {}): string[] {
  return results
    .filter((r) => (r.object === 'page' || r.object === 'database') && !r.archived && !r.in_trash)
    .map((r) => {
      const edited = r.last_edited_time && !Number.isNaN(Date.parse(r.last_edited_time)) ? new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) }).format(new Date(r.last_edited_time)).replace(/\./g, '') : '';
      return `- ${field(titleOf(r) || '(untitled)', 160)} · ${r.object}${edited ? ` · edited ${edited}` : ''}`;
    });
}

// ───────────── client ─────────────

export class NotionClient {
  readonly api: ApiClient;
  constructor(o: Omit<ApiClientOptions, 'origin'> & { origin?: string }) {
    this.api = new ApiClient({ ...o, origin: o.origin ?? NOTION_ORIGIN, headers: { 'Notion-Version': NOTION_VERSION, ...(o.headers ?? {}) } });
  }

  /** POST a list endpoint, following has_more/next_cursor (in the body) up to NOTION_MAX_PAGES. */
  async listAll<T>(path: string, body: Record<string, unknown>, maxPages = NOTION_MAX_PAGES): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const r: ListBody<T> = await this.api.postJson<ListBody<T>>(path, { ...body, ...(cursor ? { start_cursor: cursor } : {}) });
      if (!Array.isArray(r?.results)) throw new AccountHttpError(`${new URL(this.api.origin).host} did not return a list`);
      items.push(...r.results);
      cursor = r.has_more === true && typeof r.next_cursor === 'string' && r.next_cursor ? r.next_cursor : null;
      if (!cursor) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  /** The first database shared with the integration whose title looks like a to-do list, or null. */
  async findTodoDatabase(): Promise<{ id: string; title: string } | null> {
    const { items } = await this.listAll<NotionPage & { id?: string }>('/v1/search', { filter: { property: 'object', value: 'database' }, page_size: 100 });
    for (const db of items) {
      const id = typeof db.id === 'string' ? normalizeNotionId(db.id) : null;
      const title = titleOf(db);
      if (id && TODO_TITLE.test(title)) return { id, title };
    }
    return null;
  }

  /** Open items of a database: its schema (title + the done rule), then the filtered query. */
  async openTodos(id: string): Promise<{ title: string; pages: NotionPage[]; rule: DoneRule | null; truncated: boolean }> {
    const clean = normalizeNotionId(id);
    if (!clean) throw new AccountHttpError('the Notion database id is not valid');
    const db = await this.api.getJson<{ title?: RichText[]; properties?: Record<string, SchemaProp> }>(`/v1/databases/${clean}`);
    const rule = doneRule(db.properties ?? {});
    const filter = openFilter(rule);
    const { items, truncated } = await this.listAll<NotionPage>(`/v1/databases/${clean}/query`, { page_size: 100, ...(filter ? { filter } : {}) });
    return { title: plain(db.title), pages: items, rule, truncated };
  }

  /** The to-do database (configured id, else auto-picked by title) and its open items as lines; null = none found. */
  async todos(configuredId: string | undefined, opts: { timeZone?: string } = {}): Promise<{ title: string; picked: boolean; lines: string[]; truncated: boolean } | null> {
    const db = configuredId ? { id: configuredId, title: '' } : await this.findTodoDatabase();
    if (!db) return null;
    const r = await this.openTodos(db.id);
    return { title: r.title || db.title, picked: !configuredId, lines: formatTodos(r.pages, r.rule, opts), truncated: r.truncated };
  }

  /** Title search (one page of results). */
  async search(query: string, pageSize = 20): Promise<NotionPage[]> {
    return (await this.listAll<NotionPage>('/v1/search', { query, page_size: pageSize }, 1)).items;
  }
}
