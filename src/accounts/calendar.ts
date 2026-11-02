/**
 * Google Calendar, read-only, from the calendar's **secret iCal address** (Settings → the calendar → Integrate
 * calendar → "Secret address in iCal format"). One GET of an RFC 5545 feed, parsed here; no OAuth needed.
 *
 * Algorithm (all pure, tested with fixtures):
 *  1. Unfold lines (RFC 5545 §3.1), split VEVENTs, parse properties with parameters, unescape text.
 *  2. Times: DATE (all-day), UTC (`…Z`), TZID-local (wall clock in an IANA zone → UTC by fixed-point offset
 *     iteration, DST-correct), floating (the owner's zone).
 *  3. Recurrence: RRULE FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (weekly), BYMONTHDAY
 *     (monthly). Instances are generated on the WALL CLOCK of the event's zone, then converted, so a 10:00 class stays
 *     at 10:00 across a DST change. EXDATE removes instances; a VEVENT with the same UID + RECURRENCE-ID replaces one;
 *     STATUS:CANCELLED drops it. Expansion is bounded (window end, COUNT, MAX_INSTANCES).
 *  4. Window query: instances overlapping [start, end), sorted.
 */

export const MAX_INSTANCES = 2000;
const DAY = 24 * 3600 * 1000;

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface CalEvent {
  uid: string;
  summary: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  /** IANA zone the times are anchored in (for recurrence); null for UTC / all-day. */
  tz: string | null;
  rrule: Record<string, string> | null;
  exdates: Set<number>;
  recurrenceId: number | null;
  cancelled: boolean;
}

export interface Instance {
  summary: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
}

// ───────────────────────────── parsing ─────────────────────────────

export function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

export function parseProp(line: string): IcsProp | null {
  // NAME;P1=v1;P2="v;2":value  — the first ':' outside quotes ends the parameters.
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts.shift() ?? '').toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? ' ' : c));
}

/** UTC ms → the offset (ms) of `tz` at that instant. */
export function tzOffset(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall clock in `tz` → UTC ms (two fixed-point steps settle DST edges; a skipped hour moves forward). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

/** UTC ms → wall-clock parts in `tz`. */
export function wallParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; dow: number } {
  const w = new Date(ms + tzOffset(ms, tz));
  return { y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), s: w.getUTCSeconds(), dow: w.getUTCDay() };
}

export function validZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An ICS date/time value → { ms, allDay, tz }. Null when it can't be read. */
export function parseIcsTime(value: string, params: Record<string, string>, floatingTz: string): { ms: number; allDay: boolean; tz: string | null } | null {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === 'DATE') {
    m = m ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    // All-day: midnight in the owner's zone (what "today" means to them).
    return { ms: zonedToUtc(+m[1]!, +m[2]! - 1, +m[3]!, 0, 0, 0, floatingTz), allDay: true, tz: floatingTz };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!];
  if (m[7] === 'Z') return { ms: Date.UTC(y, mo, d, h, mi, s), allDay: false, tz: null };
  const tz = validZone(params.TZID) ? params.TZID : floatingTz;
  return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, tz };
}

export function parseRrule(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of v.split(';')) {
    const [k, val] = kv.split('=');
    if (k && val) out[k.toUpperCase()] = val.toUpperCase();
  }
  return out;
}

/** Parse every VEVENT of a feed. Events without a readable start are skipped. */
export function parseIcs(text: string, floatingTz: string): CalEvent[] {
  const out: CalEvent[] = [];
  let cur: IcsProp[] | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = [];
    else if (line === 'END:VEVENT') {
      if (cur) {
        const ev = toEvent(cur, floatingTz);
        if (ev) out.push(ev);
      }
      cur = null;
    } else if (cur) {
      const p = parseProp(line);
      if (p) cur.push(p);
    }
  }
  return out;
}

function toEvent(props: IcsProp[], floatingTz: string): CalEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const ds = get('DTSTART');
  if (!ds) return null;
  const start = parseIcsTime(ds.value, ds.params, floatingTz);
  if (!start) return null;
  const de = get('DTEND');
  const endT = de ? parseIcsTime(de.value, de.params, floatingTz) : null;
  const dur = get('DURATION');
  let end = endT?.ms ?? (dur ? start.ms + parseDuration(dur.value) : start.ms + (start.allDay ? DAY : 0));
  if (end < start.ms) end = start.ms;
  const exdates = new Set<number>();
  for (const p of props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const t = parseIcsTime(v, p.params, floatingTz);
      if (t) exdates.add(t.ms);
    }
  }
  const rid = get('RECURRENCE-ID');
  const ridT = rid ? parseIcsTime(rid.value, rid.params, floatingTz) : null;
  const rr = get('RRULE');
  return {
    uid: get('UID')?.value ?? '',
    summary: unescapeText(get('SUMMARY')?.value ?? '(no title)'),
    location: unescapeText(get('LOCATION')?.value ?? ''),
    start: start.ms,
    end,
    allDay: start.allDay,
    tz: start.tz,
    rrule: rr ? parseRrule(rr.value) : null,
    exdates,
    recurrenceId: ridT?.ms ?? null,
    cancelled: (get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
  };
}

/** ISO 8601 duration (P1DT2H30M, PT50M, P1W) → ms. */
export function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ───────────────────────────── recurrence ─────────────────────────────

const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Start times (UTC ms) of a recurring event up to `until` (exclusive), wall-clock based. */
export function expandStarts(ev: CalEvent, until: number, floatingTz: string): number[] {
  const r = ev.rrule;
  if (!r) return [ev.start];
  const tz = ev.tz ?? 'UTC';
  const freq = r.FREQ;
  const interval = Math.max(1, Number.parseInt(r.INTERVAL ?? '1', 10) || 1);
  const count = r.COUNT ? Math.max(0, Number.parseInt(r.COUNT, 10) || 0) : Infinity;
  const untilRule = r.UNTIL ? parseIcsTime(r.UNTIL, {}, floatingTz)?.ms ?? Infinity : Infinity;
  const stop = Math.min(until, untilRule === Infinity ? Infinity : untilRule + 1);
  const w0 = wallParts(ev.start, tz);
  const at = (y: number, mo: number, d: number) => zonedToUtc(y, mo, d, w0.h, w0.mi, w0.s, tz);
  const out: number[] = [];
  const push = (t: number): boolean => {
    if (t < ev.start) return true;
    if (t >= stop || out.length >= count || out.length >= MAX_INSTANCES) return false;
    out.push(t);
    return true;
  };
  if (freq === 'DAILY') {
    for (let i = 0; ; i += interval) if (!push(at(w0.y, w0.mo, w0.d + i))) break;
  } else if (freq === 'WEEKLY') {
    const days = (r.BYDAY ? r.BYDAY.split(',').map((x) => DOW[x.slice(-2)]).filter((x): x is number => x !== undefined) : [w0.dow]).sort((a, b) => a - b);
    const weekStart = w0.d - w0.dow; // Sunday of the first week
    outer: for (let wk = 0; ; wk += interval) {
      for (const dow of days) {
        if (!push(at(w0.y, w0.mo, weekStart + wk * 7 + dow))) break outer;
      }
      if (wk > 52 * 50) break;
    }
  } else if (freq === 'MONTHLY') {
    const day = r.BYMONTHDAY ? Number.parseInt(r.BYMONTHDAY, 10) : w0.d;
    for (let i = 0; i < 12 * 50; i += interval) {
      const dim = new Date(Date.UTC(w0.y, w0.mo + i + 1, 0)).getUTCDate();
      if (day > dim) continue; // no Feb 30
      if (!push(at(w0.y, w0.mo + i, day))) break;
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; i < 200; i += interval) {
      const dim = new Date(Date.UTC(w0.y + i, w0.mo + 1, 0)).getUTCDate();
      if (w0.d > dim) continue;
      if (!push(at(w0.y + i, w0.mo, w0.d))) break;
    }
  } else {
    return [ev.start]; // unsupported FREQ: just the first instance
  }
  return out;
}

/** Instances overlapping [start, end), cancellations / exceptions applied, sorted by start. */
export function instancesBetween(events: readonly CalEvent[], start: number, end: number, floatingTz: string): Instance[] {
  const overrides = new Map<string, CalEvent>();
  for (const e of events) if (e.recurrenceId !== null) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  const out: Instance[] = [];
  const add = (e: CalEvent, s: number, len: number) => {
    if (!e.cancelled && s < end && s + len > start) out.push({ summary: e.summary, location: e.location, start: s, end: s + len, allDay: e.allDay });
  };
  for (const e of events) {
    if (e.recurrenceId !== null) continue;
    const len = e.end - e.start;
    for (const s of expandStarts(e, end, floatingTz)) {
      if (e.exdates.has(s)) continue;
      const ov = overrides.get(`${e.uid}|${s}`);
      if (ov) {
        overrides.delete(`${e.uid}|${s}`);
        add(ov, ov.start, ov.end - ov.start);
      } else add(e, s, len);
    }
  }
  // Moved instances whose original time was outside the expansion still count where they now are.
  for (const ov of overrides.values()) add(ov, ov.start, ov.end - ov.start);
  return out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
}

// ───────────────────────────── windows and formatting ─────────────────────────────

/** The owner's zone: config, else the Mac's. */
export function ownerZone(cfgZone: string | undefined): string {
  if (validZone(cfgZone)) return cfgZone;
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validZone(sys) ? sys : 'UTC';
}

/** A calendar feed address (https, or webcal → https) split into a pinned origin and its secret path. */
export function calendarFeed(raw: string): { origin: string; path: string } {
  const u = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  return { origin: u.origin, path: `${u.pathname}${u.search}` };
}




export type CalRange = 'today' | 'tomorrow' | 'week';

/** [start, end) of today / tomorrow / the next 7 days in `tz`, from `now`. */
export function rangeWindow(range: CalRange, now: number, tz: string): { start: number; end: number; label: string } {
  const w = wallParts(now, tz);
  const midnight = (plus: number) => zonedToUtc(w.y, w.mo, w.d + plus, 0, 0, 0, tz);
  if (range === 'today') return { start: now, end: midnight(1), label: 'the rest of today' };
  if (range === 'tomorrow') return { start: midnight(1), end: midnight(2), label: 'tomorrow' };
  return { start: now, end: midnight(7), label: 'the next 7 days' };
}

export function formatInstances(list: readonly Instance[], tz: string, field: (s: string, max?: number) => string): string[] {
  const day = new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  const time = new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
  const t = (ms: number) => time.format(new Date(ms)).replace(/\./g, '');
  return list.map((i) => {
    const when = i.allDay ? `${day.format(new Date(i.start))} (all day)` : `${day.format(new Date(i.start))}, ${t(i.start)} – ${t(i.end)}`;
    const loc = i.location ? ` @ ${field(i.location, 100)}` : '';
    return `- ${when.replace(/\./g, '')} · ${field(i.summary, 160)}${loc}`;
  });
}
