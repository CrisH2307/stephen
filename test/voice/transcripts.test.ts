/** Review 5, R5-1: Claude Code's own voice-session transcripts are deleted with the conversation and on history purge. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HistoryStore } from '../../src/history/store.js';
import { Conversation } from '../../src/voice/conversation.js';
import { claudeProjectSlug, claudeTranscriptDir, purgeTranscripts, removeSessionTranscript } from '../../src/voice/transcripts.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-transcripts-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(tmp, `p${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const C = 'cccccccc-1111-2222-3333-444444444444';
const touch = (p: string, ageMs = 0) => {
  writeFileSync(p, '{"secret":"page text"}\n');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
};

describe('claudeTranscriptDir', () => {
  it('uses Claude Code\'s slug (every non-alphanumeric → "-") under ~/.claude or CLAUDE_CONFIG_DIR', () => {
    expect(claudeProjectSlug('/Users/cris/.browser-hub/voice/workdir')).toBe('-Users-cris--browser-hub-voice-workdir');
    expect(claudeTranscriptDir('/h/voice/workdir', {}, '/Users/cris')).toBe('/Users/cris/.claude/projects/-h-voice-workdir');
    // CLAUDE_CONFIG_DIR is used only when it is a real folder inside the home (the same check as Claude's env, R23 L1).
    const home = join(tmp, 'home-cfg');
    mkdirSync(join(home, '.claude-alt'), { recursive: true });
    expect(claudeTranscriptDir('/h/voice/workdir', { CLAUDE_CONFIG_DIR: join(home, '.claude-alt') }, home)).toBe(join(home, '.claude-alt', 'projects', '-h-voice-workdir'));
    expect(claudeTranscriptDir('/h/voice/workdir', { CLAUDE_CONFIG_DIR: '/cfg' }, home)).toBe(join(home, '.claude', 'projects', '-h-voice-workdir'));
  });
});

describe('removeSessionTranscript / purgeTranscripts', () => {
  it('removes one session (file + folder) and nothing else', () => {
    const d = fresh();
    touch(join(d, `${A}.jsonl`));
    mkdirSync(join(d, A));
    touch(join(d, A, 'tool-result.txt'));
    touch(join(d, `${B}.jsonl`));
    expect(removeSessionTranscript(d, A)).toBe(2);
    expect(readdirSync(d)).toEqual([`${B}.jsonl`]);
    expect(removeSessionTranscript(d, '../escape')).toBe(0);
  });

  it('purges old sessions, keeps new ones and the live one, ignores other files', () => {
    const d = fresh();
    const day = 24 * 3600 * 1000;
    touch(join(d, `${A}.jsonl`), 3 * day);
    touch(join(d, `${B}.jsonl`), 3 * day);
    touch(join(d, `${C}.jsonl`), 0);
    touch(join(d, 'notes.txt'), 3 * day);
    expect(purgeTranscripts(d, Date.now() - day, B)).toBe(1);
    expect(readdirSync(d).sort()).toEqual([`${B}.jsonl`, `${C}.jsonl`, 'notes.txt'].sort());
    expect(purgeTranscripts(d, null, null)).toBe(2);
    expect(readdirSync(d)).toEqual(['notes.txt']);
  });

  it('refuses a symlinked project folder and skips symlinked entries', () => {
    const real = fresh();
    touch(join(real, `${A}.jsonl`));
    const link = join(tmp, `link${++n}`);
    symlinkSync(real, link);
    expect(purgeTranscripts(link, null)).toBe(0);
    expect(removeSessionTranscript(link, A)).toBe(0);
    expect(existsSync(join(real, `${A}.jsonl`))).toBe(true);
    const d = fresh();
    symlinkSync(join(real, `${A}.jsonl`), join(d, `${B}.jsonl`));
    expect(purgeTranscripts(d, null)).toBe(0);
    expect(existsSync(join(real, `${A}.jsonl`))).toBe(true);
  });

  it('a missing folder is a no-op', () => {
    expect(purgeTranscripts(join(tmp, 'nope'), null)).toBe(0);
    expect(removeSessionTranscript(join(tmp, 'nope'), A)).toBe(0);
  });
});

describe('Conversation drops sessions', () => {
  it('ending, expiring or replacing a session calls onSessionDropped with the old id', () => {
    const dir = fresh();
    const dropped: string[] = [];
    let now = 1_000_000;
    const c = new Conversation({ dir, windowSec: 180, now: () => now, onSessionDropped: (id) => dropped.push(id) });
    c.finish({ kind: 'ok', reply: 'a', sessionId: A } as never);
    expect(c.current()).toBe(A);
    c.finish({ kind: 'ok', reply: 'b', sessionId: B } as never); // resumed run came back with a new id
    expect(dropped).toEqual([A]);
    c.finish({ kind: 'ok', reply: 'c', sessionId: B } as never); // same id: nothing dropped
    expect(dropped).toEqual([A]);
    now += 181_000;
    expect(c.begin()).toBeNull(); // window expired
    expect(dropped).toEqual([A, B]);
    expect(c.current()).toBeNull();
    c.finish({ kind: 'error', message: 'x', sessionId: C });
    expect(dropped).toEqual([A, B, C]);
  });

  it('a throwing hook never breaks the conversation', () => {
    const c = new Conversation({ dir: fresh(), windowSec: 180, onSessionDropped: () => { throw new Error('boom'); } });
    c.finish({ kind: 'ok', reply: 'a', sessionId: A } as never);
    expect(() => c.end()).not.toThrow();
    expect(c.current()).toBeNull();
  });
});

describe('HistoryStore onPurge', () => {
  it('purge passes the cutoff (start of the oldest kept day), clear passes null', () => {
    const calls: (number | null)[] = [];
    const s = new HistoryStore({ home: fresh(), retentionDays: 1, now: () => new Date(2026, 10, 1, 14, 0), onPurge: (t) => calls.push(t) });
    s.purge();
    s.clear();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeNull();
    expect(typeof calls[0]).toBe('number');
  });

  it('a throwing hook never breaks history', () => {
    const s = new HistoryStore({ home: fresh(), retentionDays: 1, onPurge: () => { throw new Error('boom'); } });
    expect(() => s.clear()).not.toThrow();
  });
});
