import { describe, expect, it } from 'vitest';
import { stripForSpeech } from '../../src/voice/speech.js';
import { cleanTypedCommand, findWakePhrase, normalizeTranscript, plainWords } from '../../src/voice/transcript.js';

describe('normalizeTranscript', () => {
  it.each([
    ['Hey Stephen, open YouTube.', 'open youtube', true],
    ['Hey Steven Open YouTube', 'open youtube', true],
    ['hey stephen. what\'s on my screen?', "what's on my screen", true],
    ['Stephen, open Spotify!', 'open spotify', true], // "hey" dropped by the recognizer
    ['Hi Stefan, open Mail', 'open mail', true],
    ['Stay Stephen Open YouTube.', 'open youtube', true],
    ['so anyway hey stephen open youtube', 'open youtube', true], // pre-roll speech before the wake phrase
    ['Hey Stephen. Hey Stephen, open Notes.', 'open notes', true], // repeated wake phrase
    ['Hey Stephen.', '', true],
    ['Hey Steve, open YouTube.', 'hey steve open youtube', false],
    ['Stephanie said open YouTube.', 'stephanie said open youtube', false],
    ['Hey Stepping and Open YouTube.', 'hey stepping and open youtube', false],
    ['', '', false],
  ])('%j → %j', (raw, text, hadWake) => {
    expect(normalizeTranscript(raw, 'hey stephen')).toEqual({ text, hadWake });
  });

  it('works for custom phrases, including all-short-word phrases', () => {
    expect(normalizeTranscript('Hey Computer, play music', 'hey computer')).toEqual({ text: 'play music', hadWake: true });
    expect(normalizeTranscript('Hey Max, play music', 'hey max')).toEqual({ text: 'play music', hadWake: true });
    expect(normalizeTranscript('Max, play music', 'hey max')).toEqual({ text: 'max play music', hadWake: false });
  });

  it('only looks for the wake phrase near the start', () => {
    expect(findWakePhrase('one two three four five six seven eight hey stephen'.split(' '), 'hey stephen')).toBe(-1);
    expect(findWakePhrase('hey stephen open'.split(' '), 'hey stephen')).toBe(2);
  });

  it('plainWords keeps inner apostrophes only', () => {
    expect(plainWords("  What's   on 'my' screen?! ")).toBe("what's on my screen");
    expect(plainWords('It’s 5 o’clock')).toBe("it's 5 o'clock");
  });

  it('cleanTypedCommand keeps URLs but nothing option-like or multi-line', () => {
    expect(cleanTypedCommand('  open https://example.com/a?b=c  ')).toBe('open https://example.com/a?b=c');
    expect(cleanTypedCommand('--dangerously-skip-permissions open x')).toBe('dangerously-skip-permissions open x');
    expect(cleanTypedCommand('line1\nline2\u0007')).toBe('line1 line2');
  });
});

describe('stripForSpeech', () => {
  it.each([
    ['**Done!** I opened [YouTube](https://www.youtube.com/) for you.', 'Done! I opened YouTube for you.'],
    ['# Heading\n- one\n- two\n1. three', 'Heading one two three'],
    ['Run `ls -la` now', 'Run ls -la now'],
    ['Here:\n```js\nconsole.log(1)\n```\nok', 'Here: ok'],
    ['Opened https://www.youtube.com/watch?v=abc in Zen.', 'Opened youtube.com in Zen.'],
    ['| a | b |\n|---|---|\n| 1 | 2 |', 'a, b, 1, 2'],
    ['_quietly_ and ~~not~~ *really*', 'quietly and not really'],
    ['Done ✅ 🎉', 'Done'],
    ['<b>bold</b> text', 'bold text'],
    ['> quoted reply', 'quoted reply'],
    ['', ''],
  ])('%j → %j', (input, out) => {
    expect(stripForSpeech(input)).toBe(out);
  });

  it('caps long replies at ~300 chars on a sentence or word boundary', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const s = stripForSpeech(long);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s.endsWith('.')).toBe(true);
    const words = 'word '.repeat(200);
    const w = stripForSpeech(words);
    expect(w.length).toBeLessThanOrEqual(301);
    expect(w.endsWith('…')).toBe(true);
    expect(w).not.toMatch(/wor…$/);
  });
});
