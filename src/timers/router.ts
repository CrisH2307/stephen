/**
 * Turns a recognized timer/reminder command into a store change and a short spoken reply, and fired items into the
 * alert line Stephen says. Runs in `stephen listen` before Claude (Assistant `timers` option).
 */
import { memoryTextLooksSecret } from '../memory/store.js';
import type { Confirmer } from '../types.js';
import { wallParts } from '../util/zone.js';
import { parseTimerIntent } from './intent.js';
import type { FiredItem, TimerItem, TimerStore } from './store.js';

/** Same shape as the memory router's result, so the Assistant handles both the same way. */
export interface TimerRoute {
  reply: string;
  changed: false;
  rest?: string;
  said?: string;
}

export interface TimerRouterOptions {
  store: TimerStore;
  timeZone: string;
  now?: () => number;
  /**
   * After the wake word (anyone in the room, or a video): lists give only the count and cancelling asks in this
   * dialog (Deny is the default). Absent = cancelling after the wake word is refused. Review 6, R6-4.
   */
  confirmer?: Confirmer;
}

/** "10 minutes", "1 hour 30 minutes", "45 seconds". */
export function durationText(ms: number): string {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const part = (n: number, u: string) => (n ? `${n} ${u}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), h ? '' : part(s, 'second')].filter(Boolean).join(' ') || '0 seconds';
}

/** "10 minute" (adjective form for "a 10 minute timer"). */
function durationAdj(ms: number): string {
  return durationText(ms).replace(/(\d+) (hour|minute|second)s\b/g, '$1 $2');
}

/** "5:30 pm" today, "tomorrow at 9 am", "Tue at 9 am". */
export function clockText(at: number, now: number, tz: string): string {
  const t = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(new Date(at)).replace(':00', '').toLowerCase().replace(/\s?([ap])\.?m\.?/, ' $1m');
  const a = wallParts(at, tz);
  const n = wallParts(now, tz);
  const dayDiff = Math.round((Date.UTC(a.y, a.mo, a.d) - Date.UTC(n.y, n.mo, n.d)) / 86_400_000);
  if (dayDiff === 0) return t;
  if (dayDiff === 1) return `tomorrow at ${t}`;
  return `${new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date(at))} at ${t}`;
}

/** "at 5:30 pm" today, else "tomorrow at 9 am" / "Tue at 9 am". */
function atText(at: number, now: number, tz: string): string {
  const t = clockText(at, now, tz);
  return /\bat\b/.test(t) ? t : `at ${t}`;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

export class TimerRouter {
  constructor(private readonly o: TimerRouterOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Handle `text` if it is a timer/reminder command; null = not one. Never throws. */
  async route(text: string, opts: { source: string; raw?: string } = { source: 'cli' }): Promise<TimerRoute | null> {
    const now = this.now();
    const wake = opts.source === 'voice-wake';
    const intent = parseTimerIntent(text, now, this.o.timeZone);
    if (!intent) return null;
    const store = this.o.store;
    const withRest = (r: TimerRoute) => ('rest' in intent && intent.rest ? { ...r, rest: intent.rest } : r);
    switch (intent.kind) {
      case 'timer': {
        if (intent.label && memoryTextLooksSecret(intent.label)) return withRest({ reply: "I don't save codes or passwords, even in timer names.", changed: false, said: 'set a timer [refused: looks like a secret]' });
        const r = store.add('timer', now + intent.ms, intent.label ?? '', intent.ms, wake);
        if ('error' in r) return withRest({ reply: r.error, changed: false });
        return withRest({ reply: `Bet, ${durationAdj(intent.ms)} timer${r.text ? ` for ${r.text}` : ''} started.`, changed: false });
      }
      case 'remind': {
        if (memoryTextLooksSecret(intent.text)) return withRest({ reply: "I don't save codes or passwords, even in reminders.", changed: false, said: 'remind me [refused: looks like a secret]' });
        const r = store.add('reminder', intent.dueAt, intent.text, undefined, wake);
        if ('error' in r) return withRest({ reply: r.error, changed: false });
        const inMin = intent.dueAt - now < 3600_000 ? ` (in ${durationText(Math.round((intent.dueAt - now) / 60_000) * 60_000)})` : '';
        return withRest({ reply: `Got it, I'll remind you ${atText(intent.dueAt, now, this.o.timeZone)}${inMin} to ${r.text}.`, changed: false });
      }
      case 'list': {
        const items = store.list();
        if (!items.length) return { reply: 'No timers or reminders running.', changed: false };
        if (wake) return { reply: `You've got ${items.length} timer${items.length === 1 ? '' : 's'} or reminder${items.length === 1 ? '' : 's'}. Hold F5 and ask again to hear them.`, changed: false };
        const shown = items.slice(0, 5).map((i) => this.describe(i, now));
        const more = items.length > 5 ? `, and ${items.length - 5} more` : '';
        return { reply: `You've got ${items.length}: ${shown.join('; ')}${more}.`, changed: false };
      }
      case 'cancel': {
        const items = store.list();
        if (!items.length) return { reply: 'There are no timers or reminders to cancel.', changed: false };
        if (intent.which === 'all') {
          if (wake && !(await this.confirm(`Cancel all ${items.length} timers and reminders?`))) return { reply: 'Okay, kept them.', changed: false };
          store.remove(items.map((i) => i.id));
          return { reply: `Cancelled all ${items.length}.`, changed: false };
        }
        let target: TimerItem | undefined;
        if (intent.which === 'last') {
          target = [...items].sort((a, b) => b.createdAt - a.createdAt)[0];
        } else {
          const q = words(intent.which.query);
          const scored = items.map((i) => ({ i, n: [...words(i.text)].filter((w) => q.has(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
          if (scored.length > 1 && scored[0]!.n === scored[1]!.n) return { reply: `More than one matches "${intent.which.query}". Say it more exactly.`, changed: false };
          target = scored[0]?.i;
          if (!target) return { reply: `I don't have a reminder about ${intent.which.query}.`, changed: false };
        }
        if (wake && !(await this.confirm(`Cancel ${this.describe(target!, now, false)}?`))) return { reply: 'Okay, kept it.', changed: false };
        store.remove([target!.id]);
        return { reply: `Cancelled ${this.describe(target!, now, false)}.`, changed: false };
      }
    }
  }

  /** The wake-word dialog; anything but an explicit Allow keeps things as they are. */
  private async confirm(question: string): Promise<boolean> {
    if (!this.o.confirmer) return false;
    try {
      const a = await this.o.confirmer.confirm({ title: 'Stephen: cancel?', body: `${question}\n\nYou said it after the wake word. Hold F5 to do this without the question.` });
      return a === 'approved';
    } catch {
      return false;
    }
  }

  private describe(i: TimerItem, now: number, left = true): string {
    if (i.kind === 'timer') {
      const base = `the ${durationAdj(i.durationMs ?? i.dueAt - i.createdAt)} timer${i.text ? ` for ${i.text}` : ''}`;
      return left ? `${base} with ${durationText(Math.max(0, Math.ceil((i.dueAt - now) / 60_000) * 60_000))} left` : base;
    }
    return `the reminder ${atText(i.dueAt, now, this.o.timeZone)} to ${i.text}`;
  }

  /** What Stephen says when items fire. */
  alertText(items: readonly FiredItem[]): string {
    const now = this.now();
    return items
      .map((i) => {
        const late = i.late ? `While I was off, ` : '';
        if (i.kind === 'timer') return `${late}${late ? 'your' : 'Your'} ${durationAdj(i.durationMs ?? i.dueAt - i.createdAt)} timer${i.text ? ` for ${i.text}` : ''} is done.`;
        return `${late}${late ? 'a reminder' : 'Reminder'}${late ? ` from ${clockText(i.dueAt, now, this.o.timeZone)}` : ''}: ${i.text}.`;
      })
      .join(' ');
  }
}
