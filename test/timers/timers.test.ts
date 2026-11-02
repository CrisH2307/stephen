/**
 * Timers and reminders: the grammar (many spoken phrasings), times in the owner's zone, the 0600 store, firing
 * (on time, late, dropped), router replies, and `stephen listen --text` handling them with zero Claude runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseClock, parseDuration, parseTimerIntent, timerWords } from '../../src/timers/intent.js';
import { clockText, durationText, TimerRouter } from '../../src/timers/router.js';
import { TimerStore, type FiredItem } from '../../src/timers/store.js';
import { runListen, type ListenEnv } from '../../src/voice/index.js';
import { fakeClaudePath, readFakeLog, RecordingChimes, RecordingSpeaker } from '../voice/helpers.js';

const TZ = 'America/Toronto';
const tmp = mkdtempSync(join(tmpdir(), 'stephen-timers-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(tmp, `h${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
// Mon Nov 2 2026, 2:00 pm Toronto (EST, UTC-5).
const NOW = Date.parse('2026-11-02T19:00:00Z');
const MIN = 60_000;
const p = (s: string) => parseTimerIntent(s, NOW, TZ);

describe('durations and clock times', () => {
  it.each([
    ['10 minutes', 10 * MIN],
    ['an hour and a half', 90 * MIN],
    ['half an hour', 30 * MIN],
    ['one and a half hours', 90 * MIN],
    ['1 hour and 30 minutes', 90 * MIN],
    ['1 hour 30 minutes', 90 * MIN],
    ['90 seconds', 90_000],
    ['twenty five minutes', 25 * MIN],
    ['a couple of minutes', 2 * MIN],
    ['5 min', 5 * MIN],
    ['1.5 hours', 90 * MIN],
  ])('%s', (s, ms) => {
    expect(parseDuration(timerWords(s).split(' '))?.ms).toBe(ms);
  });

  it('clock: next future match, am/pm guessing, tomorrow, noon', () => {
    const at = (s: string) => {
      const c = parseClock(timerWords(s).split(' '), NOW, TZ);
      return c ? new Date(c.at).toISOString() : null;
    };
    expect(at('5:30 pm')).toBe('2026-11-02T22:30:00.000Z');
    expect(at('5 30 p.m.')).toBe('2026-11-02T22:30:00.000Z');
    expect(at('5')).toBe('2026-11-02T22:00:00.000Z'); // 5 → 5 pm today (5 am already passed)
    expect(at('9')).toBe('2026-11-03T02:00:00.000Z'); // 9 → 9 pm today
    expect(at('1')).toBe('2026-11-03T06:00:00.000Z'); // 1 pm passed → 1 am tomorrow
    expect(at('17:30')).toBe('2026-11-02T22:30:00.000Z');
    expect(at('noon')).toBe('2026-11-03T17:00:00.000Z');
    expect(at('tomorrow at 9 am')).toBe('2026-11-03T14:00:00.000Z');
    expect(at("5 o'clock")).toBe('2026-11-02T22:00:00.000Z');
    expect(at('25:00')).toBeNull();
  });
});

describe('parseTimerIntent', () => {
  it('timers', () => {
    expect(p('set a timer for 10 minutes')).toEqual({ kind: 'timer', ms: 10 * MIN });
    expect(p('Set a timer for 10 minutes.')).toEqual({ kind: 'timer', ms: 10 * MIN });
    expect(p('can you set a timer for 5 minutes please')).toEqual({ kind: 'timer', ms: 5 * MIN });
    expect(p('timer for an hour')).toEqual({ kind: 'timer', ms: 60 * MIN });
    expect(p('10 minute timer')).toEqual({ kind: 'timer', ms: 10 * MIN });
    expect(p('start a 25 minute timer')).toEqual({ kind: 'timer', ms: 25 * MIN });
    expect(p('set a timer for 12 minutes for pasta')).toEqual({ kind: 'timer', ms: 12 * MIN, label: 'pasta' });
    expect(p('set a timer for 10 minutes and play some lofi')).toEqual({ kind: 'timer', ms: 10 * MIN, rest: 'play some lofi' });
  });

  it('reminders, time first or last', () => {
    expect(p('remind me in 20 minutes to take out the laundry')).toEqual({ kind: 'remind', dueAt: NOW + 20 * MIN, text: 'take out the laundry' });
    expect(p('remind me to call mom in an hour')).toEqual({ kind: 'remind', dueAt: NOW + 60 * MIN, text: 'call mom' });
    expect(p('remind me at 5:30 pm to call mom')).toEqual({ kind: 'remind', dueAt: Date.parse('2026-11-02T22:30:00Z'), text: 'call mom' });
    expect(p('remind me to stretch at noon')).toEqual({ kind: 'remind', dueAt: Date.parse('2026-11-03T17:00:00Z'), text: 'stretch' });
    expect(p('remind me tomorrow at 9 to submit lab 4')).toEqual({ kind: 'remind', dueAt: Date.parse('2026-11-03T14:00:00Z'), text: 'submit lab 4' });
    expect(p('remind me to meet sam at the library in 30 minutes')?.kind).toBe('remind');
    expect((p('remind me to meet sam at the library in 30 minutes') as { text: string }).text).toBe('meet sam at the library');
  });

  it('list and cancel', () => {
    expect(p('what timers do i have')).toEqual({ kind: 'list' });
    expect(p('how much time is left')).toEqual({ kind: 'list' });
    expect(p('cancel the timer')).toEqual({ kind: 'cancel', which: 'last' });
    expect(p('cancel all timers')).toEqual({ kind: 'cancel', which: 'all' });
    expect(p('cancel the reminder about laundry')).toEqual({ kind: 'cancel', which: { query: 'laundry' } });
  });

  it('everything else goes to Claude', () => {
    for (const s of ['remind me to study', 'remind me about the exam', 'set an alarm', 'open youtube', 'play timer by nero', 'remember my gym is goodlife', 'set a timer', 'remind me in 3 days to pay rent']) {
      expect(p(s), s).toBeNull();
    }
  });
});

describe('store and router', () => {
  const setup = (home = fresh(), clock = { t: NOW }) => {
    const fired: FiredItem[][] = [];
    const store = new TimerStore({ home, now: () => clock.t, onFire: (x) => fired.push(x) });
    const router = new TimerRouter({ store, timeZone: TZ, now: () => clock.t });
    return { home, store, router, fired, clock };
  };

  it('replies, list, cancel; file is 0600 and survives a restart', async () => {
    const h = setup();
    expect((await h.router.route('set a timer for 10 minutes'))!.reply).toBe('Bet, 10 minute timer started.');
    expect((await h.router.route('remind me at 5:30 pm to call mom'))!.reply).toBe("Got it, I'll remind you at 5:30 pm to call mom.");
    expect((await h.router.route('remind me in 20 minutes to take out the laundry'))!.reply).toBe("Got it, I'll remind you at 2:20 pm (in 20 minutes) to take out the laundry.");
    expect((await h.router.route('what timers do i have'))!.reply).toBe(
      "You've got 3: the 10 minute timer with 10 minutes left; the reminder at 2:20 pm to take out the laundry; the reminder at 5:30 pm to call mom.",
    );
    const file = join(h.home, 'timers.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = setup(h.home);
    expect(again.store.list()).toHaveLength(3);
    expect((await again.router.route('cancel the reminder about laundry'))!.reply).toBe('Cancelled the reminder at 2:20 pm to take out the laundry.');
    expect((await again.router.route('cancel all timers'))!.reply).toBe('Cancelled all 2.');
    expect(JSON.parse(readFileSync(file, 'utf8')).items).toEqual([]);
  });

  it('refuses secrets in reminders; caps the number of items', async () => {
    const h = setup();
    const r = await h.router.route('remind me in 5 minutes that the door code is 4 4 1 7 2 9');
    expect(r!.reply).toMatch(/don't save codes/);
    expect(h.store.list()).toHaveLength(0);
    for (let i = 0; i < 20; i++) await h.router.route('set a timer for 10 minutes');
    expect((await h.router.route('set a timer for 10 minutes'))!.reply).toMatch(/only keep 20/);
  });

  it('fires due items once (on time / late), drops very old ones, says the right thing', async () => {
    const h = setup();
    await h.router.route('set a timer for 10 minutes for pasta');
    await h.router.route('remind me in 20 minutes to take out the laundry');
    h.store.start();
    h.clock.t = NOW + 10 * MIN;
    h.store.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.router.alertText(h.fired[0]!)).toBe('Your 10 minute timer for pasta is done.');
    h.store.stop();
    // Stephen was off for 3 hours: the laundry reminder fires late, once.
    h.clock.t = NOW + 3 * 60 * MIN;
    const back = setup(h.home, h.clock);
    back.store.start();
    expect(back.fired).toHaveLength(1);
    expect(back.router.alertText(back.fired[0]!)).toBe('While I was off, a reminder from 2:20 pm: take out the laundry.');
    back.store.stop();
    // A day later: dropped silently.
    const old = setup();
    await old.router.route('set a timer for 1 minute');
    old.clock.t = NOW + 24 * 60 * MIN;
    old.store.start();
    expect(old.fired).toHaveLength(0);
    expect(old.store.list()).toHaveLength(0);
    old.store.stop();
  });

  it('text helpers', () => {
    expect(durationText(90 * MIN)).toBe('1 hour 30 minutes');
    expect(durationText(45_000)).toBe('45 seconds');
    expect(clockText(Date.parse('2026-11-03T14:00:00Z'), NOW, TZ)).toBe('tomorrow at 9 am');
  });
});

describe('stephen listen --text', () => {
  it('"set a timer for 10 minutes and play lofi": timer saved without Claude, then "play lofi" goes to Claude', async () => {
    const home = fresh();
    const log = join(home, 'fake.log');
    const speaker = new RecordingSpeaker();
    const out: string[] = [];
    const e: ListenEnv = {
      loadConfig: () => ({ home, voice: { claudePath: fakeClaudePath() }, accounts: { timeZone: TZ } }),
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      speaker,
      chimes: new RecordingChimes(),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      env: { ...process.env, FAKE_CLAUDE_LOG: log },
      now: () => NOW,
    };
    expect(await runListen(['--text', 'what timers do i have'], e)).toBe(0);
    expect(readFakeLog(log)).toHaveLength(0);
    expect(speaker.said.at(-1)).toBe('No timers or reminders running.');
    expect(await runListen(['--text', 'set a timer for 10 minutes and play lofi'], e)).toBe(0);
    const runs = readFakeLog(log);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv[runs[0]!.argv.indexOf('-p') + 1]).toBe('play lofi');
    expect(existsSync(join(home, 'timers.json'))).toBe(true);
    expect(speaker.said.at(-1)).toMatch(/^Bet, 10 minute timer started\./);
  });
});
