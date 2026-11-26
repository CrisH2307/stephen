/** The incident ladder's pure rules (src/telemetry/incident-ladder.ts): the move-up rule, the caps, the safety list and the flags. */
import { describe, expect, it } from 'vitest';
import type { Findings } from '../../src/telemetry/incident-bot.js';
import {
  ALLOWED_AUTHOR_IDS,
  bodyHash,
  claudeArgs,
  claudeRunsToday,
  codeWords,
  editWindowOk,
  excerpts,
  hasMarker,
  isSafetyPath,
  l1Lines,
  ladderRunsToday,
  markerFor,
  nextLevel,
  parseModelJson,
  opencodeArgs,
  opencodeText,
  OPENCODE_L1B_CONFIG,
  pickL1bModel,
  pickL1Model,
  resolves,
  type IssueComment,
  withHomeDeny,
} from '../../src/telemetry/incident-ladder.js';
import { parseIncidentRecord } from '../../src/telemetry/incidents.js';

const ME = ALLOWED_AUTHOR_IDS[0]!;
const f = (o: Partial<Findings> = {}): Findings => ({ cause: 'socket_closed_early', confidence: 'high', files: ['src/voice/claude.ts'], test: '', summary: 'x', ...o });
const c = (body: string, created_at = '2026-11-25T10:00:00Z', id = ME): IssueComment => ({ body, created_at, user: { id } });
const rec = (o: Record<string, unknown> = {}) =>
  parseIncidentRecord({ v: 1, id: 'cmd-1', ts: '2026-11-25T10:00:00.000Z', stephen: '0.9.1', part: 'serve', code: 'ECONNRESET', stage: 'replyReady', node: '24.20.0', darwin: '25.1.0', ...o })!;

describe('safety list', () => {
  it.each([
    ['src/safety/gate.ts', true],
    ['helper/AppConfirm.swift', true],
    ['src/memory/store.ts', true],
    ['src/timers/store.ts', true],
    ['src/jobs/manager.ts', true],
    ['src/app/protocol.ts', true],
    ['src/lib/fs.ts', true],
    ['src/Safety/Policy.ts', true],
    ['helper/appconfirm.swift', true],
    ['src/safetyx/a.ts', false],
    ['src/memory/intent.ts', false],
    ['src/app/config.ts', false],
    ['src/voice/claude.ts', false],
  ])('%s is safety: %s', (p, want) => {
    expect(isSafetyPath(p)).toBe(want);
  });
});

describe('resolves and nextLevel (the move-up rule)', () => {
  it('L1 never resolves, even with high confidence', () => {
    expect(resolves(1, f())).toBe(false);
  });

  it('L2 to L4 resolve only on a high, known, file-naming, non-safety answer', () => {
    for (const level of [2, 3, 4] as const) {
      expect(resolves(level, f())).toBe(true);
      expect(resolves(level, f({ confidence: 'medium' }))).toBe(false);
      expect(resolves(level, f({ cause: 'unknown' }))).toBe(false);
      expect(resolves(level, f({ files: [] }))).toBe(false);
      expect(resolves(level, f({ files: ['src/safety/gate.ts'] }))).toBe(false);
      expect(resolves(level, null)).toBe(false);
    }
  });

  it('L5 never resolves', () => {
    expect(resolves(5, f())).toBe(false);
  });

  it('moves up one level at a time when nothing resolves', () => {
    expect(nextLevel(1, f({ confidence: 'low' }), false)).toBe(2);
    expect(nextLevel(2, null, false)).toBe(3);
    expect(nextLevel(3, f({ confidence: 'low' }), false)).toBe(4);
    expect(nextLevel(4, f({ confidence: 'low' }), false)).toBe(5);
  });

  it('a safety file goes straight to L4 from any lower level, then always to L5', () => {
    const safety = f({ files: ['src/memory/store.ts'] });
    expect(nextLevel(1, safety, false)).toBe(4);
    expect(nextLevel(2, safety, false)).toBe(4);
    expect(nextLevel(3, safety, false)).toBe(4);
    expect(nextLevel(4, safety, false)).toBe(5);
  });

  it('a cap hit goes to L5 instead of starting a Claude level', () => {
    expect(nextLevel(1, null, true)).toBe(5);
    expect(nextLevel(2, null, true)).toBe(5);
    expect(nextLevel(1, f({ files: ['src/safety/gate.ts'] }), true)).toBe(5);
  });
});

describe('markers and caps', () => {
  const hash = bodyHash('the body');

  it('the marker is per body hash', () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyHash('the body')).toBe(hash);
    expect(bodyHash('another body')).not.toBe(hash);
    expect(markerFor(hash)).toBe(`<!-- ladder:${hash} -->`);
  });

  it('a marker by an allowed author counts; a stranger cannot fake one', () => {
    expect(hasMarker([c(`x\n${markerFor(hash)}`)], hash)).toBe(true);
    expect(hasMarker([c(`x\n${markerFor(hash)}`, '2026-11-25T10:00:00Z', 42)], hash)).toBe(false);
    expect(hasMarker([c('no marker here')], hash)).toBe(false);
  });

  it('counts ladder runs today per issue, only from allowed authors', () => {
    const today = '2026-11-25';
    const comments = [
      c(`${markerFor('a')}`, '2026-11-25T08:00:00Z'),
      c(`${markerFor('b')}`, '2026-11-25T09:00:00Z'),
      c(`${markerFor('c')}`, '2026-11-24T09:00:00Z'),
      c(`${markerFor('d')}`, '2026-11-25T09:00:00Z', 42),
      c('a human comment', '2026-11-25T09:00:00Z'),
    ];
    expect(ladderRunsToday(comments, today)).toBe(2);
  });

  it('counts Claude runs today from the trail line only, on any issue', () => {
    const today = '2026-11-25';
    const comments = [
      c('from: incident-bot\n<!-- ladder:a -->\nTrail: L1 draft, L2 low, L3 high\n\n```text\nL4 high\n```', '2026-11-25T08:00:00Z'),
      c('Trail: L1 none, L2 failed', '2026-11-25T09:00:00Z'),
      c('Trail: L1 draft, L2 high', '2026-11-24T09:00:00Z'),
      c('Trail: L2 high, L3 high, L4 high', '2026-11-25T09:00:00Z', 42),
    ];
    expect(claudeRunsToday(comments, today)).toBe(2 + 1);
  });

  it('the edit window is 10 minutes from the last edit', () => {
    const now = new Date('2026-11-25T10:10:00Z');
    expect(editWindowOk('2026-11-25T10:00:01Z', now)).toBe(false);
    expect(editWindowOk('2026-11-25T10:00:00Z', now)).toBe(true);
    expect(editWindowOk('not a date', now)).toBe(false);
  });
});

describe('what the models get', () => {
  it('l1Lines has no time and no id', () => {
    const text = l1Lines([rec({ stages: { asrDone: 120 }, modelMs: 700 })]);
    expect(text).toBe('- serve  ECONNRESET  at replyReady  (Stephen 0.9.1, Node 24.20.0, Darwin 25.1.0)\n  asrDone 120 ms, modelMs 700 ms');
    expect(text).not.toMatch(/2026|cmd-1/);
  });

  it('codeWords takes the closed codes and stages, minus the common ones', () => {
    expect(codeWords([rec(), rec({ code: 'helper_lost', stage: 'run' })])).toEqual(['ECONNRESET', 'replyReady', 'helper_lost']);
  });

  it('excerpts keeps only src/ lines of QA_REF and escapes angle brackets', () => {
    const out = excerpts(['origin/qa:src/voice/claude.ts:12:  <b>socket</b>', 'origin/qa:docs/x.md:1:nope', 'origin/qa:test/x.ts:1:no', 'other:src/a.ts:1:no'].join('\n'));
    expect(out).toBe('src/voice/claude.ts:12: ‹b›socket‹/b›');
  });

  it('pickL1Model allows only the pinned free model, and only when named', () => {
    expect(pickL1Model(undefined)).toBeNull();
    expect(pickL1Model('')).toBeNull();
    expect(pickL1Model('gpt-oss-120b')).toBe('gpt-oss-120b');
    for (const bad of ['auto', 'fusion', 'free-router', 'kilo-auto', 'claude-haiku-5-5', 'claude-sonnet-4']) expect(pickL1Model(bad)).toBeNull();
  });

  it('pickL1bModel allows only the pinned OpenCode free model, and only when named', () => {
    expect(pickL1bModel(undefined)).toBeNull();
    expect(pickL1bModel('opencode/deepseek-v4.1-flash-free')).toBe('opencode/deepseek-v4.1-flash-free');
    for (const bad of ['auto', 'fusion', 'free-router', 'claude-haiku-5-5', 'opencode/big-pickle', 'freellmapi/gpt-oss-120b', 'opencode/auto-free'])
      expect(pickL1bModel(bad)).toBeNull();
  });

  it('L1b runs opencode without --auto, with every tool denied, and reads the last text part', () => {
    expect(opencodeArgs('m', 'p')).not.toContain('--auto');
    expect(OPENCODE_L1B_CONFIG.mcp).toEqual({});
    expect(OPENCODE_L1B_CONFIG.tools['*']).toBe(false);
    expect(OPENCODE_L1B_CONFIG.permission['*']).toBe('deny');
    const ev = (type: string, text: string) => JSON.stringify({ part: { type, text } });
    expect(opencodeText([ev('text', 'a'), 'noise', ev('reasoning', 'r'), ev('text', 'b')].join('\n'))).toBe('b');
    expect(opencodeText('nothing\n')).toBeNull();
  });

  it('parseModelJson reads a bare object or one inside a code fence, and nothing else', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('no json here')).toBeNull();
    expect(parseModelJson('{broken')).toBeNull();
  });
});

describe('Claude flags and settings', () => {
  it('reads only: Read, Grep and Glob, with no Bash, no edit, no web and no MCP', () => {
    const args = claudeArgs(2, 'prompt', '/tmp/s.json');
    const val = (flag: string) => args[args.indexOf(flag) + 1];
    expect(val('--tools')).toBe('Read,Grep,Glob');
    expect(val('--allowedTools')).toBe('Read,Grep,Glob');
    expect(val('--disallowedTools')).toContain('Bash');
    expect(val('--disallowedTools')).toContain('WebFetch');
    expect(val('--permission-mode')).toBe('dontAsk');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(val('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(val('--settings')).toBe('/tmp/s.json');
    expect(args).toContain('--json-schema');
  });

  it('uses the model and turn budget of each level', () => {
    expect(claudeArgs(2, 'p', 's')[claudeArgs(2, 'p', 's').indexOf('--model') + 1]).toBe('haiku');
    expect(claudeArgs(3, 'p', 's')[claudeArgs(3, 'p', 's').indexOf('--max-turns') + 1]).toBe('25');
    expect(claudeArgs(4, 'p', 's')[claudeArgs(4, 'p', 's').indexOf('--model') + 1]).toBe('opus');
  });

  it('withHomeDeny adds the home-folder deny rules and keeps the existing ones', () => {
    const s = withHomeDeny({ permissions: { deny: ['Bash(git push *)'] } });
    expect(s.permissions.deny).toEqual(['Bash(git push *)', 'Read(~/**)', 'Grep(~/**)', 'Glob(~/**)']);
  });
});
