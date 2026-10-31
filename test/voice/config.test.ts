import { describe, expect, it } from 'vitest';
import { parseVoiceConfig, VoiceConfigError } from '../../src/voice/config.js';
import { parseListenArgs } from '../../src/voice/args.js';

describe('parseVoiceConfig', () => {
  it('applies defaults to an empty or missing section', () => {
    for (const raw of [undefined, null, {}]) {
      const c = parseVoiceConfig(raw);
      expect(c).toMatchObject({
        wakePhrase: 'hey stephen',
        stopPhrase: 'stephen stop',
        device: null,
        asrModel: 'whisper-tiny.en',
        keywordsThreshold: 0.3,
        keywordsScore: 1,
        verifyWake: true,
        claudePath: 'claude',
        claudeModel: null,
        maxTurns: 15,
        followUpWindowSec: null, // ignored in phase 1: every command is a fresh session
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
    expect(c.stopPhrase).toBe("computer don't");
    expect(c.device).toBe('MacBook');
    expect(c.asrModel).toBe('moonshine-base');
    expect(c.voice).toBe('Samantha (Enhanced)');
    expect(c.silenceSec).toBe(0.8);
    expect(c.followUpWindowSec).toBe(0); // still accepted (old configs keep loading), but ignored
    expect(parseVoiceConfig({ followUpWindowSec: 120 }).followUpWindowSec).toBe(120);
    expect(parseVoiceConfig({ cooldownSec: 0 }).cooldownSec).toBe(0);
    expect(parseVoiceConfig({ cooldownSec: 45.5 }).cooldownSec).toBe(45.5);
    expect(parseVoiceConfig({ device: 2 }).device).toBe(2);
    expect(parseVoiceConfig({ device: -1 }).device).toBe(-1);
  });

  it.each([
    [{ wakeword: 'x' }, /unknown key "voice.wakeword"/],
    [{ wakePhrase: 'stephen' }, /voice.wakePhrase.*2–4 plain English words/],
    [{ wakePhrase: 'hey stephen 2' }, /voice.wakePhrase/],
    [{ wakePhrase: 'hey, stephen!' }, /voice.wakePhrase/],
    [{ wakePhrase: 'one two three four five' }, /voice.wakePhrase/],
    [{ wakePhrase: 'hey stephen', stopPhrase: 'Hey Stephen' }, /must differ/],
    [{ asrModel: 'whisper-large' }, /voice.asrModel/],
    [{ keywordsThreshold: 0 }, /voice.keywordsThreshold/],
    [{ keywordsThreshold: 1.5 }, /voice.keywordsThreshold/],
    [{ maxTurns: 0 }, /voice.maxTurns/],
    [{ maxTurns: 2.5 }, /voice.maxTurns/],
    [{ followUpWindowSec: -1 }, /voice.followUpWindowSec/],
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
