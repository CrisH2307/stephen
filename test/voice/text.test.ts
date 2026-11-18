import { describe, expect, it } from 'vitest';
import { stripForSpeech } from '../../src/voice/speech.js';
import { cleanTypedCommand, collapseRepeats, normalizeTranscript, plainWords } from '../../src/voice/transcript.js';

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
    ['Hey Steve, open YouTube.', 'open youtube', true], // "hey stephen" misheard (the keyword spotter already said Stephen)
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

  const ALL = ['hey stephen', 'yo stephen', 'ok stephen', 'stephen'];
  it.each([
    ['Hey Stephen, open YouTube.', 'open youtube'],
    ['Yo Stephen, open Spotify.', 'open spotify'],
    ['Yeah Stephen open Spotify', 'open spotify'],
    ['OK Stephen, search YouTube for lofi beats.', 'search youtube for lofi beats'],
    ['Okay, Steven. Search YouTube for lo-fi beats.', 'search youtube for lo fi beats'],
    ['Stephen, pause the music.', 'pause the music'],
    // The owner's real transcript (whisper-tiny): the misheard "hi steve" prefix is the wake phrase.
    ['hi steve can you oh can you play one car away from charlie pool', 'can you oh can you play one car away from charlie pool'],
    ['Hey Steve, play Say So by Doja Cat.', 'play say so by doja cat'],
    ['Um, hey Steve, open Mail.', 'open mail'],
    // …but a Steve in the command stays.
    ['Hey Stephen, tell Steve I am late.', 'tell steve i am late'],
    ['Hey Stephen, text hi Steve from me.', 'text hi steve from me'],
    ['Hey Stephen, play Stephen Sanchez.', 'play stephen sanchez'],
  ])('all variants: %j → %j', (raw, text) => {
    expect(normalizeTranscript(raw, ALL)).toEqual({ text, hadWake: true });
  });

  it('a bare Steve is never the wake word', () => {
    expect(normalizeTranscript('Steve, open YouTube.', ALL)).toEqual({ text: 'steve open youtube', hadWake: false });
    expect(normalizeTranscript('Tell Steve hi', ALL)).toEqual({ text: 'tell steve hi', hadWake: false });
  });

  it('anchored (bare-"Stephen" wake, push-to-talk): the phrase must open the transcript', () => {
    const a = { anchored: true };
    expect(normalizeTranscript('Even Stephen agreed to open YouTube.', ALL, a)).toEqual({ text: 'even stephen agreed to open youtube', hadWake: false });
    expect(normalizeTranscript('Play songs by Stephen Sanchez', ALL, a)).toEqual({ text: 'play songs by stephen sanchez', hadWake: false });
    expect(normalizeTranscript('Um, Stephen, open Notes.', ALL, a)).toEqual({ text: 'open notes', hadWake: true });
    expect(normalizeTranscript('Hey Stephen open Notes', ALL, a)).toEqual({ text: 'open notes', hadWake: true });
    expect(normalizeTranscript('so anyway hey stephen open youtube', ALL, a).hadWake).toBe(false);
    // not anchored (a wake with a greeting): pre-roll words before the phrase are fine
    expect(normalizeTranscript('so anyway hey stephen open youtube', ALL)).toEqual({ text: 'open youtube', hadWake: true });
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

describe('collapseRepeats (Whisper repetition loops on short push-to-talk clips)', () => {
  const c = (t: string) => collapseRepeats(t.split(' ')).join(' ');
  it('keeps one copy of a looped phrase and drops a dangling partial copy', () => {
    expect(c('open youtube open youtube open youtube open youtube')).toBe('open youtube');
    expect(c('open youtube open youtube open youtube open')).toBe('open youtube');
    expect(c('search for cats search for cats')).toBe('search for cats');
    expect(c('ha ha ha ha')).toBe('ha');
  });
  it('leaves normal speech alone', () => {
    expect(c('open youtube')).toBe('open youtube');
    expect(c('turn the volume very very low')).toBe('turn the volume very very low');
    expect(c('play bora bora by the beach')).toBe('play bora bora by the beach');
    expect(c('open mail and open notes')).toBe('open mail and open notes');
  });
  it('is applied by normalizeTranscript', () => {
    expect(normalizeTranscript('Open YouTube Open YouTube Open YouTube Open', 'hey stephen')).toEqual({ text: 'open youtube', hadWake: false });
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
