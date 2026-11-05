/**
 * Timers and reminders: `<home>/timers.json` (0600, atomic writes, O_NOFOLLOW reads via the src/lib/fs.ts helpers)
 * plus an in-process scheduler that fires the earliest due item. Lives in `stephen listen` only.
 *
 *  - At most MAX_TIMERS items; label/text ≤ MAX_TEXT chars, cleaned like memory text.
 *  - On start, items that came due while Stephen was off are fired once, marked late; items more than LATE_DROP_MS
 *    late are dropped silently (a "10 minute timer" from yesterday is noise).
 *  - One setTimeout for the earliest item (re-armed after every change; long waits are chunked below the 2^31 ms limit).
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { cleanMemoryText } from '../memory/store.js';

export const TIMERS_FILE = 'timers.json';
export const MAX_TIMERS = 20;
export const MAX_TEXT = 200;
export const MAX_WAKE_ITEMS = 5;
export const LATE_DROP_MS = 12 * 3600 * 1000;
const MAX_SET_TIMEOUT = 2 ** 31 - 1;

export interface TimerItem {
  id: string;
  kind: 'timer' | 'reminder';
  /** Timer label or reminder text (owner's words, cleaned). */
  text: string;
  dueAt: number;
  createdAt: number;
  /** Timers: the length asked for (for "10 minute timer done"). */
  durationMs?: number;
  /** Set after the wake word (lower trust: at most MAX_WAKE_ITEMS of these; review 6, R6-4). */
  wake?: true;
}

export interface FiredItem extends TimerItem {
  /** Fired after its time because Stephen wasn't running. */
  late: boolean;
}

export interface TimerStoreOptions {
  home: string;
  now?: () => number;
  /** Called with items that came due (in due order). Never throws into the store. */
  onFire?: (items: FiredItem[]) => void;
  log?: (line: string) => void;
}

export class TimerStore {
  private items: TimerItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private started = false;
  readonly path: string;
  constructor(private readonly o: TimerStoreOptions) {
    this.path = join(o.home, TIMERS_FILE);
    this.load();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private load(): void {
    const r = readPrivateJsonFile(this.path);
    if ('missing' in r) return;
    if ('error' in r) {
      this.o.log?.(`timers file ${this.path} ${r.error} — starting with no timers`);
      return;
    }
    const raw = (r.state as { items?: unknown } | null)?.items;
    if (!Array.isArray(raw)) return;
    for (const x of raw.slice(0, MAX_TIMERS)) {
      const i = x as Partial<TimerItem>;
      if (typeof i?.id !== 'string' || !/^t\d{1,12}$/.test(i.id)) continue;
      if (i.kind !== 'timer' && i.kind !== 'reminder') continue;
      if (typeof i.dueAt !== 'number' || !Number.isSafeInteger(i.dueAt) || typeof i.createdAt !== 'number') continue;
      const text = typeof i.text === 'string' ? cleanMemoryText(i.text).slice(0, MAX_TEXT) : '';
      this.items.push({
        id: i.id,
        kind: i.kind,
        text,
        dueAt: i.dueAt,
        createdAt: i.createdAt,
        ...(typeof i.durationMs === 'number' ? { durationMs: i.durationMs } : {}),
        ...(i.wake === true ? { wake: true as const } : {}),
      });
      this.seq = Math.max(this.seq, Number(i.id.slice(1)));
    }
    this.items.sort((a, b) => a.dueAt - b.dueAt);
  }

  private save(): void {
    try {
      writePrivateJsonFileSync(this.path, { version: 1, items: this.items });
    } catch (e) {
      this.o.log?.(`could not save timers (${(e as Error).message}) — they still run until Stephen quits`);
    }
  }

  list(): readonly TimerItem[] {
    return this.items;
  }

  add(kind: TimerItem['kind'], dueAt: number, text: string, durationMs?: number, wake = false): TimerItem | { error: string } {
    if (this.items.length >= MAX_TIMERS) return { error: `I can only keep ${MAX_TIMERS} timers and reminders. Cancel one first.` };
    if (wake && this.items.filter((i) => i.wake).length >= MAX_WAKE_ITEMS) {
      return { error: `That's ${MAX_WAKE_ITEMS} set by "Hey Stephen" already. Hold F5 to set more.` };
    }
    const item: TimerItem = {
      id: `t${++this.seq}`,
      kind,
      text: cleanMemoryText(text).slice(0, MAX_TEXT),
      dueAt,
      createdAt: this.now(),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(wake ? { wake: true as const } : {}),
    };
    this.items.push(item);
    this.items.sort((a, b) => a.dueAt - b.dueAt);
    this.save();
    this.arm();
    return item;
  }

  remove(ids: readonly string[]): TimerItem[] {
    const gone = this.items.filter((i) => ids.includes(i.id));
    if (!gone.length) return [];
    this.items = this.items.filter((i) => !ids.includes(i.id));
    this.save();
    this.arm();
    return gone;
  }

  /** Start firing (call once the listener is ready). Fires anything already due first. */
  start(): void {
    this.started = true;
    this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || !this.o.onFire || !this.items.length) return;
    const wait = Math.max(0, Math.min(MAX_SET_TIMEOUT, this.items[0]!.dueAt - this.now()));
    this.timer = setTimeout(() => this.tick(), wait);
    this.timer.unref?.();
  }

  /** Fire every due item (the scheduler calls this; tests may too). */
  tick(): void {
    const now = this.now();
    const due = this.items.filter((i) => i.dueAt <= now);
    if (due.length) {
      this.items = this.items.filter((i) => i.dueAt > now);
      this.save();
      const fired = due.filter((i) => now - i.dueAt <= LATE_DROP_MS).map((i) => ({ ...i, late: now - i.dueAt > 60_000 }));
      if (fired.length) {
        try {
          this.o.onFire?.(fired);
        } catch (e) {
          this.o.log?.(`timer alert failed (${(e as Error).message})`);
        }
      }
    }
    this.arm();
  }
}
