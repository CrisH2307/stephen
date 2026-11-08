/** Settings > How Stephen talks: the persona is chosen from fixed sentences; Brief + Casual is the old persona. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, personaFor, STEPHEN_PERSONA } from '../../src/voice/claude.js';
import { LENGTHS, LENGTH_LINES, TONES, TONE_LINES, TALK_SAMPLES, EXPLAIN_LINE, checkTalkChanges, DEFAULT_TALK } from '../../src/voice/talk.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('persona by talk settings', () => {
  it('the default (Brief, Casual) prompt is byte for byte the persona from before the settings existed', () => {
    expect(STEPHEN_PERSONA).toHaveLength(7029);
    expect(sha(STEPHEN_PERSONA)).toBe('490c467be72ebfe0d5325ffe6e1093b4a9bd839fb4677ab66a0c64e29c9b0d51');
    expect(sha(personaFor({ name: 'Cris' }, ['a b']))).toBe('16c7c5c87988db4f2fb7a532836af2169bb554e5d68ad2ee2c32a9a85ae040ca');
    expect(personaFor(null, null, DEFAULT_TALK)).toBe(STEPHEN_PERSONA);
  });

  it('every length and tone picks its own fixed sentences; the others are absent', () => {
    for (const length of LENGTHS) {
      for (const tone of TONES) {
        const p = personaFor(null, null, { length, tone, explain: false });
        expect(p).toContain(LENGTH_LINES[length]);
        expect(p).toContain(TONE_LINES[tone]);
        for (const other of LENGTHS.filter((l) => l !== length)) expect(p).not.toContain(LENGTH_LINES[other]);
        for (const other of TONES.filter((t) => t !== tone)) expect(p).not.toContain(TONE_LINES[other]);
        expect(p).not.toContain(EXPLAIN_LINE);
        // safety and plain-text rules stay in every variant
        expect(p).toMatch(/say plainly and seriously, without slang/);
        expect(p).toMatch(/no markdown, no lists, no links, no emoji/);
      }
    }
  });

  it('explain asks for a short step line, and only then', () => {
    expect(personaFor(null, null, { ...DEFAULT_TALK, explain: true })).toContain(EXPLAIN_LINE);
    expect(EXPLAIN_LINE).toMatch(/one short plain line/);
  });

  it('reaches the Claude argv through ClaudeSettings.talk, read when the prompt is built', () => {
    let tone: 'casual' | 'formal' = 'casual';
    const s = { claudePath: 'claude', maxTurns: 5, model: null, mcpConfigPath: '/m.json', followUps: false, talk: () => ({ ...DEFAULT_TALK, tone }) };
    const text = (a: string[]) => a[a.indexOf('--append-system-prompt') + 1]!;
    expect(text(buildClaudeArgs('hi', s))).toContain(TONE_LINES.casual);
    tone = 'formal';
    expect(text(buildClaudeArgs('hi', s))).toContain(TONE_LINES.formal);
  });

  it('preview sentences exist for every length and tone', () => {
    for (const l of LENGTHS) for (const t of TONES) expect(TALK_SAMPLES[l][t].length).toBeGreaterThan(5);
  });
});

describe('checkTalkChanges', () => {
  it('accepts only the five keys with enum or boolean values', () => {
    expect(checkTalkChanges({ length: 'detailed', tone: 'friendly', speak: false, explain: true, voice: 'kokoro' })).toEqual({
      ok: true,
      changes: { length: 'detailed', tone: 'friendly', speak: false, explain: true, voice: 'kokoro' },
    });
    for (const bad of [{ length: 'LONG' }, { tone: null }, { speak: 'true' }, { voice: 'auto' }, { constructor: 1 }, {}, null, [], 'x'])
      expect(checkTalkChanges(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});
