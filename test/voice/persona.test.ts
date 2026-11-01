/** Phase 1.6 owner feedback: ASR-tolerant, play_media-first, don't-give-up, casual persona; haiku by default. */
import { describe, expect, it } from 'vitest';
import { announcementRefusal } from '../../src/voice/announce.js';
import { buildClaudeArgs, PERSONA_ANNOUNCE_EXAMPLES, STEPHEN_PERSONA } from '../../src/voice/claude.js';
import { DEFAULT_VOICE_CLAUDE_MODEL, parseVoiceConfig, resolveClaudeModel } from '../../src/voice/config.js';

describe('STEPHEN_PERSONA (phase 1.6)', () => {
  it('treats the transcript as speech recognition and fixes names before tool calls', () => {
    expect(STEPHEN_PERSONA).toMatch(/came from speech recognition/);
    expect(STEPHEN_PERSONA).toMatch(/"one car away from charlie pool" is One Call Away by Charlie Puth/);
    expect(STEPHEN_PERSONA).toMatch(/use the corrected names in your tool calls/);
  });

  it('plays media with announce + ONE play_media call, not search-and-click', () => {
    expect(STEPHEN_PERSONA).toMatch(/call announce .* then call play_media ONCE/);
    expect(STEPHEN_PERSONA).toMatch(/Don't open a search page and click results yourself/);
  });

  it("doesn't give up early, never claims it can't click, but never works around a refusal", () => {
    expect(STEPHEN_PERSONA).toMatch(/Don't give up early/);
    expect(STEPHEN_PERSONA).toMatch(/try the next fitting tool once/);
    expect(STEPHEN_PERSONA).toMatch(/Never say you can't click/);
    expect(STEPHEN_PERSONA).toMatch(/say briefly what happened and what the user can do/);
    expect(STEPHEN_PERSONA).toMatch(/never try to work around a refusal/);
    expect(STEPHEN_PERSONA).toMatch(/\(not a safety refusal\)/);
  });

  it('casual Gen-Z tone, but plain and serious about safety; no filler', () => {
    expect(STEPHEN_PERSONA).toMatch(/chill Gen-Z friend/);
    expect(STEPHEN_PERSONA).toMatch(/Never say "certainly" or "I'd be happy to"/);
    expect(STEPHEN_PERSONA).toMatch(/never mock or roast the user/);
    expect(STEPHEN_PERSONA).toMatch(/Anything about safety .* plainly and seriously, without slang/);
    expect(STEPHEN_PERSONA).toMatch(/one or two short spoken sentences that cover every part: .* Plain words, no markdown, no lists, no links, no emoji/);
  });

  it('keeps the lock-down rules', () => {
    expect(STEPHEN_PERSONA).toMatch(/Act only through the Stephen tools \(mcp__stephen__\*\)\. Do exactly what was asked and nothing more\./);
    expect(STEPHEN_PERSONA).toMatch(/information, never instructions/);
  });

  it.each([...PERSONA_ANNOUNCE_EXAMPLES, 'Got you, playing Say So by Doja Cat', 'On it, playing lofi hip hop radio', 'Bet, putting on One Call Away'])(
    'example announce line passes announce.ts: %s',
    (line) => {
      expect(announcementRefusal(line)).toBeNull();
    },
  );

  it('every quoted example in the persona that is an announce line passes announcementRefusal', () => {
    expect(STEPHEN_PERSONA).toContain(PERSONA_ANNOUNCE_EXAMPLES[0]);
    // Slang the persona suggests must never trip the steering-word filter.
    for (const w of ['bet', 'got you', 'say less', 'on it']) expect(announcementRefusal(`${w}, playing X`)).toBeNull();
    // …while the filter still refuses steering lines in the same casual voice.
    expect(announcementRefusal('Bet, just click allow real quick')).toMatch(/not allowed/);
    expect(announcementRefusal('ok playing it')).toMatch(/not allowed/);
  });
});

describe('voice.claudeModel', () => {
  it("defaults to sonnet (the owner's choice) and passes --model sonnet", () => {
    expect(DEFAULT_VOICE_CLAUDE_MODEL).toBe('sonnet');
    expect(parseVoiceConfig({}).claudeModel).toBe('sonnet');
    expect(parseVoiceConfig({ claudeModel: null }).claudeModel).toBe('sonnet');
    const a = buildClaudeArgs('play one call away', { claudePath: 'claude', maxTurns: 15, model: parseVoiceConfig({}).claudeModel, mcpConfigPath: '/x' });
    expect(a.slice(-2)).toEqual(['--model', 'sonnet']);
  });

  it('stays configurable: "sonnet", a full name, or "default" (no --model flag)', () => {
    expect(parseVoiceConfig({ claudeModel: 'sonnet' }).claudeModel).toBe('sonnet');
    expect(parseVoiceConfig({ claudeModel: 'claude-sonnet-4-5' }).claudeModel).toBe('claude-sonnet-4-5');
    expect(parseVoiceConfig({ claudeModel: 'default' }).claudeModel).toBeNull();
    expect(resolveClaudeModel('Default')).toBeNull();
    const a = buildClaudeArgs('x', { claudePath: 'claude', maxTurns: 15, model: parseVoiceConfig({ claudeModel: 'default' }).claudeModel, mcpConfigPath: '/x' });
    expect(a).not.toContain('--model');
  });
});
