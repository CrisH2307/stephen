/** Settings > How Stephen talks: the persona is chosen from fixed sentences; Brief + Casual is the old persona. */
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, personaFor, STEPHEN_PERSONA } from '../../src/voice/claude.js';
import { LENGTHS, LENGTH_LINES, TONES, TONE_LINES, TALK_SAMPLES, EXPLAIN_LINE, checkTalkChanges, DEFAULT_TALK } from '../../src/voice/talk.js';

describe('persona by talk settings', () => {
  // R9-10: pin behaviour, not bytes, so a new persona sentence in another PR keeps this green.
  it('R9-10 the default (Brief, Casual) is the base persona, and settings swap only their own sentences', () => {
    expect(personaFor(null, null, DEFAULT_TALK)).toBe(STEPHEN_PERSONA);
    expect(personaFor(null, null)).toBe(STEPHEN_PERSONA);
    expect(STEPHEN_PERSONA).toContain(`${TONE_LINES.casual} ${LENGTH_LINES.brief}`);
    expect(STEPHEN_PERSONA).not.toContain(EXPLAIN_LINE);
    for (const length of LENGTHS) {
      for (const tone of TONES) {
        const swapped = STEPHEN_PERSONA.replace(TONE_LINES.casual, TONE_LINES[tone]).replace(LENGTH_LINES.brief, LENGTH_LINES[length]);
        expect(personaFor(null, null, { length, tone, explain: false })).toBe(swapped);
      }
    }
    expect(personaFor(null, null, { ...DEFAULT_TALK, explain: true })).toBe(STEPHEN_PERSONA.replace(LENGTH_LINES.brief, `${LENGTH_LINES.brief} ${EXPLAIN_LINE}`));
    expect(personaFor({ name: 'Cris' }, ['a b']).startsWith(`${STEPHEN_PERSONA} `)).toBe(true);
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
