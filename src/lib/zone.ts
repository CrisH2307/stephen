/**
 * IANA time-zone arithmetic with only Intl (no library): offset at an instant, wall clock → UTC (DST-safe), UTC →
 * wall clock. Shared by the calendar reader and timers/reminders.
 */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** UTC ms → the offset (ms) of `tz` at that instant. */
export function tzOffset(ms: number, tz: string): number {
  // One formatter per zone (building one costs far more than using it; review 6, R6-2).
  let f = FORMATTERS.get(tz);
  if (!f) {
    if (FORMATTERS.size > 64) FORMATTERS.clear();
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    FORMATTERS.set(tz, f);
  }
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
