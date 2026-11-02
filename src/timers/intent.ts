/**
 * Timers and reminders by voice, recognized by a fixed grammar BEFORE Claude (like memory, docs/PLAN-1.9 §4):
 *   "set a timer for 10 minutes", "10 minute timer", "timer for an hour and a half"
 *   "remind me in 20 minutes to take out the laundry", "remind me to call mom in an hour"
 *   "remind me at 5:30 pm to call mom", "remind me to stretch at noon", "remind me tomorrow at 9 to submit lab 4"
 *   "what timers do I have", "how much time is left"
 *   "cancel the timer", "cancel all timers", "cancel the reminder about laundry"
 * Claude can't create reminders, so a web page can't plant something Stephen will later say out loud.
 * Pure functions; times are computed in the owner's zone.
 */
import { COMMAND_VERBS } from '../memory/intent.js';
import { wallParts, zonedToUtc } from '../util/zone.js';

export const MAX_AHEAD_MS = 48 * 3600 * 1000;
export const MIN_TIMER_MS = 1000;

export type TimerIntent =
  | { kind: 'timer'; ms: number; label?: string; rest?: string }
  | { kind: 'remind'; dueAt: number; text: string; rest?: string }
  | { kind: 'list' }
  | { kind: 'cancel'; which: 'all' | 'last' | { query: string } };

/** Lower case, keep letters, digits, ':' and apostrophes; "p.m." → "pm". */
export function timerWords(text: string): string {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\b([ap])\.\s?m\.?/g, '$1m')
    .replace(/[^a-z0-9:'.]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, couple: 2, few: 3,
};
const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

/** One number at w[i] (digits, "1.5", "twenty five", "a", "half"); returns value and words used. */
function numberAt(w: readonly string[], i: number): { n: number; used: number } | null {
  const t = w[i];
  if (t === undefined) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return { n: Number(t), used: 1 };
  if (t === 'half') return { n: 0.5, used: 1 };
  const base = NUMBER_WORDS[t];
  if (base === undefined) return null;
  // "twenty five", "a couple of", "a few"
  if (base >= 20 && base % 10 === 0 && w[i + 1] !== undefined) {
    const unit = NUMBER_WORDS[w[i + 1]!];
    if (unit !== undefined && unit < 10 && w[i + 1] !== 'a' && w[i + 1] !== 'an') return { n: base + unit, used: 2 };
  }
  if ((t === 'a' || t === 'an') && (w[i + 1] === 'couple' || w[i + 1] === 'few')) return { n: NUMBER_WORDS[w[i + 1]!]!, used: w[i + 2] === 'of' ? 3 : 2 };
  return { n: base, used: 1 };
}

/**
 * A duration at the start of `w` ("10 minutes", "an hour and a half", "half an hour", "1 hour 30 minutes",
 * "90 seconds", "5 min"). Returns ms and how many words it used, or null.
 */
export function parseDuration(w: readonly string[]): { ms: number; used: number } | null {
  let i = 0;
  let total = 0;
  let parts = 0;
  // "half an hour"
  if (w[0] === 'half' && (w[1] === 'an' || w[1] === 'a') && UNIT_MS[w[2] ?? '']) return { ms: UNIT_MS[w[2]!]! / 2, used: 3 };
  for (;;) {
    const num = numberAt(w, i);
    if (!num) break;
    let j = i + num.used;
    // "one and a half hours"
    let n = num.n;
    if (w[j] === 'and' && (w[j + 1] === 'a' || w[j + 1] === 'an') && w[j + 2] === 'half' && UNIT_MS[w[j + 3] ?? '']) {
      n += 0.5;
      j += 3;
    }
    const unit = UNIT_MS[w[j] ?? ''];
    if (!unit) break;
    total += n * unit;
    parts += 1;
    i = j + 1;
    // "an hour and a half"
    if (w[i] === 'and' && (w[i + 1] === 'a' || w[i + 1] === 'an') && w[i + 2] === 'half' && !UNIT_MS[w[i + 3] ?? '']) {
      total += unit / 2;
      i += 3;
    }
    if (w[i] === 'and' && numberAt(w, i + 1)) i += 1; // "1 hour and 30 minutes"
  }
  if (!parts || total < MIN_TIMER_MS) return null;
  return { ms: Math.round(total), used: i };
}

/**
 * A clock time at the start of `w` ("5pm", "5 30 pm", "5:30 pm", "17:30", "noon", "midnight", "5 o'clock",
 * optionally after "tomorrow" / "today"), as the next matching moment after `now` in `tz`.
 */
export function parseClock(w: readonly string[], now: number, tz: string): { at: number; used: number } | null {
  let i = 0;
  let dayShift: number | null = null;
  if (w[0] === 'tomorrow') {
    dayShift = 1;
    i = 1;
    if (w[1] === 'at') i = 2;
  } else if (w[0] === 'today' || w[0] === 'tonight') {
    dayShift = 0;
    i = w[1] === 'at' ? 2 : 1;
  }
  let h: number;
  let m = 0;
  let mer: 'am' | 'pm' | null = null;
  const t = w[i];
  if (t === undefined) return null;
  if (t === 'noon') {
    h = 12;
    mer = 'pm';
    i += 1;
  } else if (t === 'midnight') {
    h = 0;
    mer = 'am';
    i += 1;
  } else {
    let mt = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
    if (!mt) return null;
    h = Number(mt[1]);
    if (mt[2]) m = Number(mt[2]);
    if (mt[3]) mer = mt[3] as 'am' | 'pm';
    i += 1;
    if (!mt[2] && !mt[3] && /^\d{2}$/.test(w[i] ?? '')) {
      m = Number(w[i]);
      i += 1;
    }
    if (!mer && (w[i] === 'am' || w[i] === 'pm')) {
      mer = w[i] as 'am' | 'pm';
      i += 1;
    } else if (w[i] === "o'clock" || (w[i] === 'o' && w[i + 1] === 'clock')) i += w[i] === 'o' ? 2 : 1;
    if (!mer && (w[i] === 'in' && w[i + 1] === 'the' && (w[i + 2] === 'morning' || w[i + 2] === 'evening' || w[i + 2] === 'afternoon'))) {
      mer = w[i + 2] === 'morning' ? 'am' : 'pm';
      i += 3;
    }
    mt = null;
  }
  if (t === 'tonight') return null;
  if (w[0] === 'tonight' && !mer) mer = 'pm';
  if (h > 23 || m > 59 || (mer && (h < 1 || h > 12) && !(t === 'midnight'))) return null;
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  const wall = wallParts(now, tz);
  const at = (dayPlus: number, hour: number) => zonedToUtc(wall.y, wall.mo, wall.d + dayPlus, hour, m, 0, tz);
  const candidates: number[] = [];
  const hours = !mer && h >= 1 && h <= 11 ? [h, h + 12] : [h];
  const days = dayShift !== null ? [dayShift] : [0, 1];
  for (const d of days) for (const hh of hours) candidates.push(at(d, hh));
  const future = candidates.filter((c) => c > now).sort((a, b) => a - b);
  if (!future.length) return null;
  return { at: future[0]!, used: i };
}

/** Split "<x> and play lofi" at the first joiner followed by a command verb (same rule as memory). */
function splitTail(w: string[]): { head: string[]; rest?: string } {
  for (let i = 1; i < w.length - 1; i++) {
    let verbAt = -1;
    if (w[i] === 'and' && (w[i + 1] === 'then' || w[i + 1] === 'also')) verbAt = i + 2;
    else if (w[i] === 'and' || w[i] === 'then') verbAt = i + 1;
    if (verbAt > 0 && verbAt < w.length && COMMAND_VERBS.includes(w[verbAt]!)) return { head: w.slice(0, i), rest: w.slice(verbAt).join(' ') };
  }
  return { head: w };
}

const POLITE = new Set(['please', 'thanks', 'thank', 'you']);
const trimPolite = (w: string[]) => {
  const out = [...w];
  while (out.length && POLITE.has(out[out.length - 1]!)) out.pop();
  while (out.length && (out[0] === 'please' || out[0] === 'can' || out[0] === 'could')) out.shift();
  return out;
};

/** Recognize a timer/reminder command; null = not one (it goes to Claude). */
export function parseTimerIntent(command: string, now: number, tz: string): TimerIntent | null {
  let w = trimPolite(timerWords(command).split(' ').filter(Boolean));
  if (w[0] === 'you' && w[1] === 'set') w = w.slice(1); // "can you set a timer…"
  if (w[0] === 'hey' || w[0] === 'yo') w = w.slice(1);
  const s = w.join(' ');
  if (!s) return null;

  if (/^(what|which) (timers|reminders|timer|reminder)( do i have| are (there|set|running)| is (set|running))?$/.test(s) || /^how (much time|long) (is )?left( on (the|my) timer)?$/.test(s) || /^(list|show) (my )?(timers|reminders)$/.test(s)) {
    return { kind: 'list' };
  }
  let m = /^(cancel|stop|delete|remove|clear) (all|all the|all my|every) (timers|reminders|timers and reminders)$/.exec(s);
  if (m) return { kind: 'cancel', which: 'all' };
  m = /^(cancel|stop|delete|remove) (the |my |that )?(timer|reminder)$/.exec(s);
  if (m) return { kind: 'cancel', which: 'last' };
  m = /^(cancel|delete|remove) (the |my )?(timer|reminder) (about|for|to) (.+)$/.exec(s);
  if (m) return { kind: 'cancel', which: { query: m[5]! } };

  const { head, rest } = splitTail(w);
  const withRest = <T extends object>(x: T): T & { rest?: string } => (rest ? { ...x, rest } : x);

  // Timers
  let tw = head;
  if (tw[0] === 'set' || tw[0] === 'start') tw = tw.slice(1);
  if (tw[0] === 'a' || tw[0] === 'an') tw = tw.slice(1);
  if (tw[0] === 'timer') {
    const after = tw[1] === 'for' ? tw.slice(2) : tw.slice(1);
    const d = parseDuration(after);
    if (d && d.ms <= MAX_AHEAD_MS) {
      const label = after.slice(d.used).join(' ').replace(/^(called|named|for) /, '').trim();
      return withRest({ kind: 'timer' as const, ms: d.ms, ...(label ? { label } : {}) });
    }
    return null;
  }
  const d = parseDuration(tw);
  if (d && tw[d.used] === 'timer' && d.ms <= MAX_AHEAD_MS) return withRest({ kind: 'timer' as const, ms: d.ms });
  // "10 minute timer": the unit is singular before "timer"
  {
    const num = /^(\d+(?:\.\d+)?|[a-z]+) (second|minute|hour) timer$/.exec(tw.join(' '));
    if (num) {
      const dd = parseDuration([num[1]!, `${num[2]}s`]);
      if (dd && dd.ms <= MAX_AHEAD_MS) return withRest({ kind: 'timer' as const, ms: dd.ms });
    }
  }

  // Reminders
  if (head[0] !== 'remind' || head[1] !== 'me') return null;
  let r = head.slice(2);
  // remind me in <duration> to <text> / remind me at <time> to <text>
  const lead = (ws: string[]): { dueAt: number; used: number } | null => {
    if (ws[0] === 'in') {
      const dd = parseDuration(ws.slice(1));
      return dd ? { dueAt: now + dd.ms, used: dd.used + 1 } : null;
    }
    if (ws[0] === 'at') {
      const c = parseClock(ws.slice(1), now, tz);
      return c ? { dueAt: c.at, used: c.used + 1 } : null;
    }
    if (ws[0] === 'tomorrow' || ws[0] === 'tonight') {
      const c = parseClock(ws, now, tz);
      return c ? { dueAt: c.at, used: c.used } : null;
    }
    return null;
  };
  let when = lead(r);
  let text: string[] = [];
  if (when) {
    text = r.slice(when.used);
    if (text[0] === 'to' || text[0] === 'about' || text[0] === 'that') text = text.slice(1);
  } else if (r[0] === 'to' || r[0] === 'about' || r[0] === 'that') {
    r = r.slice(1);
    // the time is at the end: find the last " in " / " at " / " tomorrow " that parses to the end
    for (let k = r.length - 1; k >= 1 && !when; k--) {
      if (r[k] !== 'in' && r[k] !== 'at' && r[k] !== 'tomorrow' && r[k] !== 'tonight') continue;
      const c = lead(r.slice(k));
      if (c && c.used === r.length - k) {
        when = c;
        text = r.slice(0, k);
      }
    }
  }
  if (!when || !text.length || when.dueAt - now > MAX_AHEAD_MS || when.dueAt <= now) return null;
  return withRest({ kind: 'remind' as const, dueAt: when.dueAt, text: text.join(' ') });
}
