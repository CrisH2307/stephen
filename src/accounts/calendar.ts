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

import { tzOffset, validZone, wallParts, zonedToUtc } from '../lib/zone.js';

export { tzOffset, validZone, wallParts, zonedToUtc };
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
export const MAX_EVENTS = 5000;
export const MAX_PROPS = 200;
export const MAX_EXDATES = 1000;

export function parseIcs(text: string, floatingTz: string): CalEvent[] {
  const out: CalEvent[] = [];
  let cur: IcsProp[] | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = [];
    else if (line === 'END:VEVENT') {
      if (cur) {
        const ev = toEvent(cur, floatingTz);
        if (ev) out.push(ev);
        if (out.length >= MAX_EVENTS) break;
      }
      cur = null;
    } else if (cur && cur.length < MAX_PROPS) {
      const p = parseProp(line.slice(0, 8192));
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
    for (const v of p.value.split(',', MAX_EXDATES)) {
      if (exdates.size >= MAX_EXDATES) break;
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

/** Loop iterations per event, however the rule is written (review 6, R6-2: bounded CPU for hostile invites). */
export const MAX_ITER = 5000;

/**
 * Start times (UTC ms) of a recurring event in [from, until), wall-clock based. Without COUNT the expansion jumps
 * straight to the period just before `from` (arithmetic on days / weeks / months / years), so an event that has
 * repeated daily since 2015 still shows up this week (review 6, R6-3). With COUNT it counts from DTSTART, bounded.
 */
export function expandStarts(ev: CalEvent, until: number, floatingTz: string, from: number = ev.start): number[] {
  const r = ev.rrule;
  if (!r) return [ev.start];
  const tz = ev.tz ?? 'UTC';
  const freq = r.FREQ;
  const interval = Math.min(10_000, Math.max(1, Number.parseInt(r.INTERVAL ?? '1', 10) || 1));
  const count = r.COUNT ? Math.max(0, Number.parseInt(r.COUNT, 10) || 0) : Infinity;
  const untilRule = r.UNTIL ? parseIcsTime(r.UNTIL, {}, floatingTz)?.ms ?? Infinity : Infinity;
  const stop = Math.min(until, untilRule === Infinity ? Infinity : untilRule + 1);
  const w0 = wallParts(ev.start, tz);
  const at = (y: number, mo: number, d: number) => zonedToUtc(y, mo, d, w0.h, w0.mi, w0.s, tz);
  // Without COUNT, instances before `from` don't matter: skip whole periods up to it.
  const skipping = count === Infinity && from > ev.start;
  const wf = wallParts(from, tz);
  const dayDiff = Math.floor((Date.UTC(wf.y, wf.mo, wf.d) - Date.UTC(w0.y, w0.mo, w0.d)) / DAY);
  const monthDiff = (wf.y - w0.y) * 12 + (wf.mo - w0.mo);
  const skipPeriods = (units: number) => (skipping ? Math.max(0, Math.floor(units / interval) - 1) * interval : 0);
  const out: number[] = [];
  let iter = 0;
  /** false = stop the loop. */
  const push = (t: number): boolean => {
    if (++iter > MAX_ITER) return false;
    if (t < ev.start) return true;
    if (t >= stop || out.length >= count || out.length >= MAX_INSTANCES) return false;
    out.push(t);
    return true;
  };
  if (freq === 'DAILY') {
    for (let i = skipPeriods(dayDiff); ; i += interval) if (!push(at(w0.y, w0.mo, w0.d + i))) break;
  } else if (freq === 'WEEKLY') {
    const days = [...new Set(r.BYDAY ? r.BYDAY.split(',').map((x) => DOW[x.slice(-2)]).filter((x): x is number => x !== undefined) : [w0.dow])].sort((a, b) => a - b);
    if (!days.length) days.push(w0.dow);
    const weekStart = w0.d - w0.dow; // Sunday of the first week
    outer: for (let wk = skipPeriods(Math.floor(dayDiff / 7)); ; wk += interval) {
      for (const dow of days) if (!push(at(w0.y, w0.mo, weekStart + wk * 7 + dow))) break outer;
    }
  } else if (freq === 'MONTHLY') {
    const day = r.BYMONTHDAY ? Number.parseInt(r.BYMONTHDAY, 10) : w0.d;
    if (!(day >= 1 && day <= 31)) return [ev.start];
    for (let i = skipPeriods(monthDiff); ; i += interval) {
      const dim = new Date(Date.UTC(w0.y, w0.mo + i + 1, 0)).getUTCDate();
      if (day > dim) {
        if (++iter > MAX_ITER) break;
        continue; // no Feb 30
      }
      if (!push(at(w0.y, w0.mo + i, day))) break;
    }
  } else if (freq === 'YEARLY') {
    for (let i = skipPeriods(wf.y - w0.y); ; i += interval) {
      const dim = new Date(Date.UTC(w0.y + i, w0.mo + 1, 0)).getUTCDate();
      if (w0.d > dim) {
        if (++iter > MAX_ITER) break;
        continue;
      }
      if (!push(at(w0.y + i, w0.mo, w0.d))) break;
    }
  } else {
    return [ev.start]; // unsupported FREQ (SECONDLY, HOURLY…): just the first instance
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
    for (const s of expandStarts(e, end, floatingTz, start - len - DAY)) {
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
