/** `stephen history [--limit N] | clear` (src/history/cli.ts). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatEntry, parseHistoryArgs, runHistoryCli } from '../../src/history/cli.js';
import { HistoryStore, type NewHistoryEntry } from '../../src/history/store.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-history-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const now = () => new Date(2026, 10, 1, 14, 3);
const store = (retentionDays = 1) => new HistoryStore({ home: join(tmp, `h${++n}`), retentionDays, now });
const entry = (said: string, over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  source: 'voice-ptt',
  said,
  reply: 'Bet.',
  outcome: 'ok',
  tools: [],
  followUp: false,
  ms: 1000,
  turns: 1,
  ...over,
});

async function run(argv: string[], s: HistoryStore) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHistoryCli(argv, { store: s, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('parseHistoryArgs', () => {
  it('parses list / clear / help and refuses the rest', () => {
    expect(parseHistoryArgs([])).toEqual({ cmd: 'list', limit: 20 });
    expect(parseHistoryArgs(['--limit', '5'])).toEqual({ cmd: 'list', limit: 5 });
    expect(parseHistoryArgs(['--limit=100'])).toEqual({ cmd: 'list', limit: 100 });
    expect(parseHistoryArgs(['clear'])).toEqual({ cmd: 'clear' });
    expect(parseHistoryArgs(['--help'])).toBe('help');
    for (const bad of [['--limit'], ['--limit', '0'], ['--limit', '101'], ['--limit', '2.5'], ['clear', '--all'], ['--json'], ['list']]) {
      expect('error' in (parseHistoryArgs(bad) as object), bad.join(' ')).toBe(true);
    }
  });
});

describe('runHistoryCli', () => {
  it('lists newest first with tools, follow-up mark and the limit', async () => {
    const s = store();
    s.append(entry('open youtube'));
    s.append(entry('play lofi', { source: 'voice-wake', followUp: true, tools: [{ tool: 'play_media', isError: false, ms: 900 }, { tool: 'click', isError: true, ms: 10 }] }));
    const r = await run([], s);
    expect(r.code).toBe(0);
    expect(r.out.indexOf('play lofi')).toBeLessThan(r.out.indexOf('open youtube'));
    expect(r.out).toContain('2026-11-01 14:03  voice-wake  ok  follow-up');
    expect(r.out).toContain('tools: play_media, click (error)');
    const one = await run(['--limit', '1'], s);
    expect(one.out).toContain('play lofi');
    expect(one.out).not.toContain('open youtube');
  });

  it('cleans terminal escapes and newlines out of page text in replies', () => {
    const e = new HistoryStore({ home: join(tmp, 'x'), retentionDays: 1, now }).append(entry('hi\u001b[2J', { reply: 'line1\nline2\u001b]0;pwned\u0007 ‮evil' }))!;
    const text = formatEntry(e);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f‮]/);
    expect(text).toContain('line1 line2');
  });

  it('clear deletes everything; empty and off states have clear messages', async () => {
    const s = store();
    expect((await run([], s)).out).toBe('No history yet.');
    s.append(entry('a'));
    expect((await run(['clear'], s)).out).toBe('Deleted 1 day of history.');
    expect((await run(['clear'], s)).out).toBe('No history to delete.');
    expect((await run([], store(0))).out).toMatch(/History is off/);
  });

  it('bad args: exit 2 with help', async () => {
    const r = await run(['--nope'], store());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Unknown option "--nope"[\s\S]*stephen history/);
    expect((await run(['-h'], store())).out).toMatch(/retentionDays/);
  });
});
