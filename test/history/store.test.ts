/** Local command history (src/history/store.ts, src/history/config.ts). */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HistoryConfigError, parseHistoryConfig } from '../../src/history/config.js';
import {
  HistoryError,
  HistoryStore,
  MAX_DAY_FILE_BYTES,
  MAX_REPLY_CHARS,
  MAX_SAID_CHARS,
  localDate,
  type NewHistoryEntry,
} from '../../src/history/store.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-history-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshHome = () => join(tmp, `home-${++n}`);

/** A settable local-time clock. */
function clock(y: number, m: number, d: number, h = 12) {
  let t = new Date(y, m - 1, d, h);
  return {
    now: () => new Date(t),
    set: (y2: number, m2: number, d2: number, h2 = 12) => {
      t = new Date(y2, m2 - 1, d2, h2);
    },
    tick: (ms: number) => {
      t = new Date(t.getTime() + ms);
    },
  };
}

const entry = (said: string, over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  source: 'voice-ptt',
  said,
  reply: `reply to ${said}`,
  outcome: 'ok',
  tools: [{ tool: 'open_url', isError: false, ms: 120 }],
  followUp: false,
  ms: 4000,
  turns: 2,
  ...over,
});

describe('history config', () => {
  it('defaults to 1 day; 0 to 30 allowed; strict', () => {
    expect(parseHistoryConfig(undefined)).toEqual({ retentionDays: 1 });
    expect(parseHistoryConfig({})).toEqual({ retentionDays: 1 });
    expect(parseHistoryConfig({ retentionDays: null })).toEqual({ retentionDays: 1 });
    expect(parseHistoryConfig({ retentionDays: 0 })).toEqual({ retentionDays: 0 });
    expect(parseHistoryConfig({ retentionDays: 30 })).toEqual({ retentionDays: 30 });
    for (const bad of [{ retentionDays: 31 }, { retentionDays: -1 }, { retentionDays: 1.5 }, { retentionDays: '7' }, { keep: 1 }, [], 'x']) {
      expect(() => parseHistoryConfig(bad), JSON.stringify(bad)).toThrow(HistoryConfigError);
    }
  });

  it('loadConfig passes the raw "history" section through', () => {
    const h = freshHome();
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, 'config.json'), JSON.stringify({ history: { retentionDays: 7 } }));
    const cfg = loadConfig({}, { HOME: tmp, STEPHEN_HOME: h });
    expect(cfg.history).toEqual({ retentionDays: 7 });
    expect(parseHistoryConfig(cfg.history).retentionDays).toBe(7);
    expect(loadConfig({}, { HOME: tmp, STEPHEN_HOME: freshHome() }).history).toEqual({});
  });
});

describe('HistoryStore', () => {
  it('appends to <home>/history/<local date>.jsonl with dir 0700 / file 0600, one line per entry', () => {
    const home = freshHome();
    const c = clock(2026, 11, 1);
    const s = new HistoryStore({ home, retentionDays: 1, now: c.now });
    const e = s.append(entry('open youtube'))!;
    expect(e.id).toMatch(/^h_[0-9a-f]{16}$/);
    expect(e.ts).toBe(c.now().toISOString());
    const dir = join(home, 'history');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, '2026-11-01.jsonl');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    s.append(entry('play lofi', { source: 'voice-wake', outcome: 'memory', tools: [], turns: 0 }));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      id: e.id,
      ts: e.ts,
      source: 'voice-ptt',
      said: 'open youtube',
      reply: 'reply to open youtube',
      outcome: 'ok',
      tools: [{ tool: 'open_url', isError: false, ms: 120 }],
      followUp: false,
      ms: 4000,
      turns: 2,
    });
  });

  it('uses the LOCAL date for the file name (late evening stays on that day)', () => {
    const home = freshHome();
    const c = clock(2026, 11, 1, 23);
    new HistoryStore({ home, retentionDays: 1, now: c.now }).append(entry('late'));
    expect(readdirSync(join(home, 'history'))).toEqual([`${localDate(c.now())}.jsonl`]);
    expect(localDate(c.now())).toBe('2026-11-01');
  });

  it('lists newest first across days, with limit (max 100) and before', () => {
    const home = freshHome();
    const c = clock(2026, 10, 30);
    const s = new HistoryStore({ home, retentionDays: 30, now: c.now });
    const ids: string[] = [];
    for (const day of [30, 31]) {
      c.set(2026, 10, day, 9);
      for (let i = 0; i < 3; i++) {
        ids.push(s.append(entry(`d${day}-${i}`))!.id);
        c.tick(60_000);
      }
    }
    c.set(2026, 11, 1, 9);
    for (let i = 0; i < 3; i++) {
      ids.push(s.append(entry(`d1-${i}`))!.id);
      c.tick(60_000);
    }
    expect(s.list().map((e) => e.said)).toEqual(['d1-2', 'd1-1', 'd1-0', 'd31-2', 'd31-1', 'd31-0', 'd30-2', 'd30-1', 'd30-0']);
    expect(s.list({ limit: 2 }).map((e) => e.said)).toEqual(['d1-2', 'd1-1']);
    const page1 = s.list({ limit: 4 });
    const page2 = s.list({ limit: 4, before: page1.at(-1)!.ts });
    expect(page2.map((e) => e.said)).toEqual(['d31-1', 'd31-0', 'd30-2', 'd30-1']);
    expect(() => s.list({ before: 'yesterday-ish' })).toThrow(HistoryError);
    for (let i = 0; i < 120; i++) s.append(entry(`bulk-${i}`));
    expect(s.list({ limit: 500 })).toHaveLength(100);
    expect(s.list({ limit: 0 })).toHaveLength(20);
  });

  it('truncates said to 2000 and reply to 4000 chars', () => {
    const s = new HistoryStore({ home: freshHome(), retentionDays: 1, now: clock(2026, 11, 1).now });
    const e = s.append(entry('a'.repeat(5000), { reply: 'b'.repeat(9000) }))!;
    expect([...e.said]).toHaveLength(MAX_SAID_CHARS);
    expect([...e.reply]).toHaveLength(MAX_REPLY_CHARS);
    expect(e.reply.endsWith('…')).toBe(true);
    expect(s.list()[0]!.said).toBe(e.said);
  });

  it('skips malformed lines (and bad entries) when reading', () => {
    const home = freshHome();
    const c = clock(2026, 11, 1);
    const s = new HistoryStore({ home, retentionDays: 1, now: c.now });
    s.append(entry('first'));
    const file = join(home, 'history', '2026-11-01.jsonl');
    writeFileSync(
      file,
      [
        'garbage',
        '{"half":',
        JSON.stringify({ ...entry('bad source'), id: 'x1', ts: c.now().toISOString(), source: 'email' }),
        JSON.stringify({ ...entry('bad outcome'), id: 'x2', ts: c.now().toISOString(), outcome: 'great' }),
        JSON.stringify({ ...entry('bad ts'), id: 'x3', ts: 'not a date' }),
        '[]',
        '',
      ].join('\n'),
      { flag: 'a' },
    );
    s.append(entry('second'));
    expect(s.list().map((e) => e.said)).toEqual(['second', 'first']);
  });

  it('purges day files older than retentionDays on append and on demand (fake clock)', () => {
    const home = freshHome();
    const c = clock(2026, 10, 20);
    const s30 = new HistoryStore({ home, retentionDays: 30, now: c.now });
    for (const d of [20, 25, 29, 30, 31]) {
      c.set(2026, 10, d);
      s30.append(entry(`oct ${d}`));
    }
    const files = () => readdirSync(join(home, 'history')).sort();
    expect(files()).toHaveLength(5);
    // 3 days kept: on Nov 1, files dated Oct 29 and later stay.
    c.set(2026, 11, 1);
    const s3 = new HistoryStore({ home, retentionDays: 3, now: c.now });
    expect(s3.list().map((e) => e.said)).toEqual(['oct 31', 'oct 30', 'oct 29']); // list hides expired days
    expect(s3.purge()).toBe(0); // list() already purged them (review 5, R5-6)
    expect(files()).toEqual(['2026-10-29.jsonl', '2026-10-30.jsonl', '2026-10-31.jsonl']);
    // Default 1 day: append on Nov 1 deletes Oct 29 and Oct 30, keeps yesterday and today.
    const s1 = new HistoryStore({ home, retentionDays: 1, now: c.now });
    s1.append(entry('nov 1'));
    expect(files()).toEqual(['2026-10-31.jsonl', '2026-11-01.jsonl']);
    // Unrelated files in the folder are never touched.
    writeFileSync(join(home, 'history', 'notes.txt'), 'x');
    c.set(2026, 12, 1);
    expect(s1.purge()).toBe(2);
    expect(files()).toEqual(['notes.txt']);
  });

  it('retentionDays 0 writes nothing and purge removes every day file', () => {
    const home = freshHome();
    const c = clock(2026, 11, 1);
    new HistoryStore({ home, retentionDays: 1, now: c.now }).append(entry('kept for now'));
    const off = new HistoryStore({ home, retentionDays: 0, now: c.now });
    expect(off.enabled).toBe(false);
    expect(off.append(entry('never written'))).toBeNull();
    expect(readdirSync(join(home, 'history'))).toEqual([]);
    expect(off.list()).toEqual([]);
    const fresh = freshHome();
    expect(new HistoryStore({ home: fresh, retentionDays: 0, now: c.now }).append(entry('x'))).toBeNull();
    expect(existsSync(join(fresh, 'history'))).toBe(false);
  });

  it('clear deletes all day files', () => {
    const home = freshHome();
    const c = clock(2026, 11, 1);
    const s = new HistoryStore({ home, retentionDays: 30, now: c.now });
    s.append(entry('a'));
    c.set(2026, 10, 31);
    s.append(entry('b'));
    expect(s.clear()).toBe(2);
    expect(s.list()).toEqual([]);
    expect(s.clear()).toBe(0);
  });

  it('caps a day file at 5 MB (new entries are dropped, not written)', () => {
    const home = freshHome();
    const c = clock(2026, 11, 1);
    const s = new HistoryStore({ home, retentionDays: 1, now: c.now });
    s.append(entry('first'));
    const file = join(home, 'history', '2026-11-01.jsonl');
    writeFileSync(file, `${'x'.repeat(MAX_DAY_FILE_BYTES - statSync(file).size - 100)}\n`, { flag: 'a' });
    const before = statSync(file).size;
    expect(s.append(entry('too much'))).toBeNull();
    expect(statSync(file).size).toBe(before);
    c.set(2026, 11, 2);
    expect(s.append(entry('next day'))).not.toBeNull();
  });

  it('refuses a symlinked history folder or day file', () => {
    const c = clock(2026, 11, 1);
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    const elsewhere = join(tmp, `elsewhere-${n}`);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, 'history'));
    expect(() => new HistoryStore({ home, retentionDays: 1, now: c.now }).append(entry('x'))).toThrow(HistoryError);
    expect(readdirSync(elsewhere)).toEqual([]);

    const home2 = freshHome();
    mkdirSync(join(home2, 'history'), { recursive: true, mode: 0o700 });
    const target = join(tmp, `target-${n}.txt`);
    writeFileSync(target, 'precious\n');
    symlinkSync(target, join(home2, 'history', '2026-11-01.jsonl'));
    const s = new HistoryStore({ home: home2, retentionDays: 1, now: c.now });
    expect(() => s.append(entry('x'))).toThrow(HistoryError);
    expect(readFileSync(target, 'utf8')).toBe('precious\n');
    expect(s.list()).toEqual([]);
  });

  it('rejects an out-of-range retentionDays and an invalid entry', () => {
    expect(() => new HistoryStore({ home: freshHome(), retentionDays: 31 })).toThrow(HistoryError);
    const s = new HistoryStore({ home: freshHome(), retentionDays: 1 });
    expect(() => s.append({ ...entry('x'), source: 'web' as never })).toThrow(HistoryError);
  });
});
