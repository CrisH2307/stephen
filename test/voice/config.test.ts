import { describe, expect, it } from 'vitest';
import { BARE_WAKE_THRESHOLD_DEFAULT, DEFAULT_WAKE_PHRASES, parseVoiceConfig, VoiceConfigError } from '../../src/voice/config.js';
import { parseListenArgs } from '../../src/voice/args.js';

describe('parseVoiceConfig', () => {
  it('applies defaults to an empty or missing section', () => {
    for (const raw of [undefined, null, {}]) {
      const c = parseVoiceConfig(raw);
      expect(c).toMatchObject({
        wakePhrase: 'hey stephen',
        wakePhrases: ['hey stephen', 'yo stephen', 'ok stephen', 'stephen'],
        stopPhrase: 'stephen stop',
        device: null,
        asrModel: null, // = the default model, resolved against what is installed (models.ts resolveAsrModel)
        keywordsThreshold: 0.3,
        bareWakeThreshold: BARE_WAKE_THRESHOLD_DEFAULT,
        keywordsScore: 1,
        verifyWake: true,
        claudePath: 'claude',
        claudeModel: 'sonnet',
        maxTurns: 15,
        followUpWindowSec: 180, // follow-ups: commands within 180 s of the last one's end continue its conversation
        cooldownSec: 20,
        wakeWord: true,
        speak: true,
        voice: null,
        rate: null,
        chimes: true,
        silenceSec: 0.8,
        maxCommandSec: 12,
        noSpeechTimeoutSec: 5,
      });
    }
  });

  it('wake phrases: a list (default the four Stephen variants), or the old single wakePhrase', () => {
    expect(DEFAULT_WAKE_PHRASES).toEqual(['hey stephen', 'yo stephen', 'ok stephen', 'stephen']);
    const c = parseVoiceConfig({ wakePhrases: ['  Hey Stephen ', 'STEPHEN', 'hey stephen'], bareWakeThreshold: 0.5 });
    expect(c.wakePhrases).toEqual(['hey stephen', 'stephen']); // normalized, duplicates dropped
    expect(c.wakePhrase).toBe('hey stephen');
    expect(c.bareWakeThreshold).toBe(0.5);
    expect(parseVoiceConfig({ wakePhrase: 'stephen' }).wakePhrases).toEqual(['stephen']); // one word is allowed now
    expect(parseVoiceConfig({ wakePhrase: null }).wakePhrases).toEqual([...DEFAULT_WAKE_PHRASES]);
    expect(parseVoiceConfig({ asrModel: 'parakeet-tdt-0.6b-v2' }).asrModel).toBe('parakeet-tdt-0.6b-v2');
    expect(parseVoiceConfig({ asrModel: 'moonshine-base-v2' }).asrModel).toBe('moonshine-base-v2');
    expect(parseVoiceConfig({ asrModel: 'whisper-tiny.en' }).asrModel).toBe('whisper-tiny.en');
  });

  it('accepts and normalizes valid values; null means default', () => {
    const c = parseVoiceConfig({
      wakePhrase: '  Hey   COMPUTER ',
      stopPhrase: "computer don't",
      device: 'MacBook',
      asrModel: 'moonshine-base',
      keywordsThreshold: 0.45,
      claudePath: '/opt/homebrew/bin/claude',
      claudeModel: 'sonnet',
      maxTurns: 6,
      followUpWindowSec: 0,
      speak: false,
      voice: 'Samantha (Enhanced)',
      rate: 210,
      chimes: false,
      verifyWake: false,
      silenceSec: null,
    });
    expect(c.wakePhrase).toBe('hey computer');
    expect(c.wakePhrases).toEqual(['hey computer']); // the old single value still works
    expect(c.stopPhrase).toBe("computer don't");
    expect(c.device).toBe('MacBook');
    expect(c.asrModel).toBe('moonshine-base');
    expect(c.voice).toBe('Samantha (Enhanced)');
    expect(c.silenceSec).toBe(0.8);
    expect(c.followUpWindowSec).toBe(0); // 0 = every command fresh
    expect(parseVoiceConfig({ followUpWindowSec: 120 }).followUpWindowSec).toBe(120);
    expect(parseVoiceConfig({ followUpWindowSec: 1800 }).followUpWindowSec).toBe(1800);
    expect(parseVoiceConfig({ followUpWindowSec: null }).followUpWindowSec).toBe(180);
    expect(parseVoiceConfig({ cooldownSec: 0 }).cooldownSec).toBe(0);
    expect(parseVoiceConfig({ cooldownSec: 45.5 }).cooldownSec).toBe(45.5);
    expect(parseVoiceConfig({ device: 2 }).device).toBe(2);
    expect(parseVoiceConfig({ device: -1 }).device).toBe(-1);
  });

  it.each([
    [{ wakeword: 'x' }, /unknown key "voice.wakeword"/],
    [{ stopPhrase: 'stop' }, /voice.stopPhrase.*2–4 plain English words/],
    [{ wakePhrases: [] }, /voice.wakePhrases/],
    [{ wakePhrases: ['hey stephen', 'hey 2'] }, /voice.wakePhrases.1/],
    [{ wakePhrases: 'hey stephen' }, /voice.wakePhrases/],
    [{ wakePhrases: ['hey stephen'], wakePhrase: 'yo stephen' }, /not both/],
    [{ wakePhrases: ['stephen stop', 'hey stephen'] }, /stop phrase must differ/],
    [{ wakePhrase: 'hey stephen 2' }, /voice.wakePhrase/],
    [{ wakePhrase: 'hey, stephen!' }, /voice.wakePhrase/],
    [{ wakePhrase: 'one two three four five' }, /voice.wakePhrase/],
    [{ wakePhrase: 'hey stephen', stopPhrase: 'Hey Stephen' }, /must differ/],
    [{ bareWakeThreshold: 0.99 }, /voice.bareWakeThreshold/],
    [{ asrModel: 'whisper-large' }, /voice.asrModel/],
    [{ keywordsThreshold: 0 }, /voice.keywordsThreshold/],
    [{ keywordsThreshold: 1.5 }, /voice.keywordsThreshold/],
    [{ maxTurns: 0 }, /voice.maxTurns/],
    [{ maxTurns: 2.5 }, /voice.maxTurns/],
    [{ followUpWindowSec: -1 }, /voice.followUpWindowSec/],
    [{ followUpWindowSec: 1801 }, /voice.followUpWindowSec/],
    [{ followUpWindowSec: 2.5 }, /voice.followUpWindowSec/],
    [{ cooldownSec: -1 }, /voice.cooldownSec/],
    [{ cooldownSec: 601 }, /voice.cooldownSec/],
    [{ cooldownSec: '20' }, /voice.cooldownSec/],
    [{ speak: 'yes' }, /voice.speak/],
    [{ voice: '-o /tmp/x' }, /voice.voice/],
    [{ voice: 'Alex; rm -rf' }, /voice.voice/],
    [{ claudeModel: '--dangerously-skip-permissions' }, /voice.claudeModel/],
    [{ claudePath: '' }, /voice.claudePath/],
    [{ rate: 5000 }, /voice.rate/],
    [{ device: 1.5 }, /voice.device/],
  ])('rejects %j', (raw, msg) => {
    expect(() => parseVoiceConfig(raw)).toThrow(VoiceConfigError);
    expect(() => parseVoiceConfig(raw)).toThrow(msg);
  });

  it('rejects a non-object section', () => {
    expect(() => parseVoiceConfig('on')).toThrow(/must be an object/);
    expect(() => parseVoiceConfig([1])).toThrow(/must be an object/);
  });
});

describe('parseListenArgs', () => {
  it('parses flags and values', () => {
    expect(parseListenArgs([])).toMatchObject({ once: false, text: null, dryRun: false, device: null, speak: null, chimes: null });
    expect(parseListenArgs(['--once', '--text', 'open youtube', '--dry-run', '--no-speak', '--no-chimes'])).toMatchObject({
      once: true,
      text: 'open youtube',
      dryRun: true,
      speak: false,
      chimes: false,
    });
    expect(parseListenArgs(['--device=2'])).toMatchObject({ device: '2' });
    expect(parseListenArgs(['--device', 'USB Mic', '--list-devices'])).toMatchObject({ device: 'USB Mic', listDevices: true });
    expect(parseListenArgs(['--wav', 'a.wav'])).toMatchObject({ wav: 'a.wav' });
    expect(parseListenArgs(['--setup'])).toMatchObject({ setup: true });
    expect(parseListenArgs(['-h'])).toMatchObject({ help: true });
    expect(parseListenArgs([])).toMatchObject({ pttOnly: false, noHelper: false });
    expect(parseListenArgs(['--ptt-only'])).toMatchObject({ pttOnly: true, noHelper: false });
    expect(parseListenArgs(['--no-helper'])).toMatchObject({ pttOnly: false, noHelper: true });
  });

  it('voice.wakeWord: false is accepted (push-to-talk only); non-booleans are not', () => {
    expect(parseVoiceConfig({ wakeWord: false }).wakeWord).toBe(false);
    expect(() => parseVoiceConfig({ wakeWord: 'no' })).toThrow(/voice.wakeWord/);
  });

  it('reports errors', () => {
    expect(parseListenArgs(['--text'])).toEqual({ error: '--text needs a value' });
    expect(parseListenArgs(['--text', ' '])).toEqual({ error: '--text needs a non-empty value' });
    expect(parseListenArgs(['--bogus'])).toEqual({ error: 'Unknown option "--bogus"' });
    expect(parseListenArgs(['--once=1'])).toEqual({ error: '--once takes no value' });
    expect(parseListenArgs(['--text', 'x', '--wav', 'y.wav'])).toEqual({ error: '--text and --wav cannot be combined' });
    expect(parseListenArgs(['--ptt-only', '--no-helper'])).toEqual({ error: '--ptt-only needs Stephen Helper, so it cannot be combined with --no-helper' });
    expect(parseListenArgs(['--ptt-only', '--wav', 'a.wav'])).toMatchObject({ error: expect.stringMatching(/--ptt-only cannot be combined with --wav/) });
    expect(parseListenArgs(['--no-helper=1'])).toEqual({ error: '--no-helper takes no value' });
  });
});
