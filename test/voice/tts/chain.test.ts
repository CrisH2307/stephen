import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVoiceConfig } from '../../../src/voice/config.js';
import { createTts, parseTtsConfig, type TtsConfig } from '../../../src/voice/tts/index.js';
import { KOKORO_MODEL, type KokoroEngineFactory } from '../../../src/voice/tts/kokoro.js';
import { afplayPlayer } from '../../../src/voice/tts/player.js';
import { FAKE_KEY, FakeElevenLabs, fakeBin, sleep } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-tts-chain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A home with (or without) a fake-installed Kokoro model (marker + files; the engine is faked). */
function home(kokoro: boolean): string {
  const h = mkdtempSync(join(tmp, 'home-'));
  if (kokoro) {
    const d = join(h, 'models', KOKORO_MODEL.dir);
    mkdirSync(join(d, 'espeak-ng-data'), { recursive: true });
    for (const f of KOKORO_MODEL.keep) writeFileSync(join(d, f), 'x');
    writeFileSync(join(d, '.stephen-model.json'), JSON.stringify({ sha256: KOKORO_MODEL.sha256 }));
  }
  return h;
}

/** Fake Kokoro engine: 0.1 s of a 440 Hz tone at 24 kHz, records what it was asked. */
function fakeKokoro(calls: { text: string; sid: number; speed: number }[], fail = false): KokoroEngineFactory {
  return async () => ({
    sampleRate: 24_000,
    async generate(text, sid, speed) {
      calls.push({ text, sid, speed });
      if (fail) throw new Error('onnx exploded');
      return Float32Array.from({ length: 2400 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 24_000));
    },
  });
}

let el: FakeElevenLabs;
let afplay: ReturnType<typeof fakeBin>;
let say: ReturnType<typeof fakeBin>;
let logs: string[];
let audioTmp: string;
beforeEach(async () => {
  el = await new FakeElevenLabs().start();
  afplay = fakeBin('afplay');
  say = fakeBin('say');
  logs = [];
  audioTmp = mkdtempSync(join(tmp, 'audio-'));
});
afterEach(async () => {
  await el.stop();
});

function cfg(over: Record<string, unknown> = {}): TtsConfig {
  return parseTtsConfig({ elevenlabs: { timeoutSec: 1 }, ...over });
}

function tts(c: TtsConfig, opts: { key?: string | null; kokoro?: boolean; kokoroCalls?: { text: string; sid: number; speed: number }[]; kokoroFail?: boolean } = {}) {
  return createTts(c, {
    home: home(opts.kokoro ?? false),
    findKey: async () => ({ found: opts.key === null ? null : { key: opts.key ?? FAKE_KEY, source: 'keychain', where: 'macOS Keychain' }, notes: [] }),
    baseUrl: el.baseUrl,
    play: afplayPlayer(afplay.path),
    sayCommand: say.path,
    kokoroEngine: fakeKokoro(opts.kokoroCalls ?? [], opts.kokoroFail),
    log: (l) => logs.push(l),
    tmpRoot: audioTmp,
  });
}

describe('ElevenLabs', () => {
  it('POSTs the text with the key header, plays the mp3 from a 0600 temp file, and deletes it', async () => {
    const t = tts(cfg());
    await t.speak('**Playing** Say So by Doja Cat').done;
    expect(el.requests).toHaveLength(1);
    const r = el.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/v1/text-to-speech/YEBbZ0itqHW31uoXSBns?output_format=mp3_44100_128');
    expect(r.key).toBe(FAKE_KEY);
    expect(r.contentType).toBe('application/json');
    expect(JSON.parse(r.body)).toEqual({ text: 'Playing Say So by Doja Cat', model_id: 'eleven_flash_v2_5' });
    const played = afplay.log();
    expect(played).toHaveLength(1);
    expect(played[0]!.head).toBe('ID3\x04');
    expect(played[0]!.mode).toBe(0o600);
    expect(played[0]!.argv[0]).toMatch(/speech\.mp3$/);
    expect(existsSync(played[0]!.argv[0]!)).toBe(false);
    expect(readdirSync(audioTmp)).toEqual([]);
    expect(t.lastProvider).toBe('elevenlabs');
    expect(say.log()).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('uses the configured voice and model', async () => {
    await tts(cfg({ elevenlabs: { voiceId: 'abcdefghij1234567890', modelId: 'eleven_multilingual_v2' } })).speak('hi there').done;
    expect(el.requests[0]!.url).toMatch(/^\/v1\/text-to-speech\/abcdefghij1234567890\?/);
    expect(JSON.parse(el.requests[0]!.body).model_id).toBe('eleven_multilingual_v2');
  });

  const failures: [string, Parameters<FakeElevenLabs['reply']>[1], RegExp][] = [
    ['401 bad key', { kind: 'error', status: 401, detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, /ElevenLabs rejected the API key sk_…beef \(HTTP 401; run `stephen voice-key set`\)/],
    ['401 quota', { kind: 'error', status: 401, detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }, /ElevenLabs is out of credits/],
    ['402', { kind: 'error', status: 402, detail: { status: 'payment_required', message: 'Upgrade needed' } }, /paid plan or more credits for this \(HTTP 402\)/],
    ['404 voice', { kind: 'error', status: 404, detail: { status: 'voice_not_found', message: 'A voice with that ID was not found.' } }, /voice "YEBbZ0itqHW31uoXSBns" was not found or isn't available on your plan/],
    ['500', { kind: 'error', status: 500 }, /ElevenLabs error HTTP 500/],
  ];
  for (const [name, reply, msg] of failures) {
    it(`${name} → the same text with Kokoro, reason logged once`, async () => {
      el.reply('/v1/text-to-speech', reply);
      const calls: { text: string; sid: number; speed: number }[] = [];
      const t = tts(cfg(), { kokoro: true, kokoroCalls: calls });
      await t.speak('Opened YouTube.').done;
      expect(calls).toEqual([{ text: 'Opened YouTube.', sid: 6, speed: 1 }]);
      expect(afplay.log().map((p) => p.head)).toEqual(['RIFF']);
      expect(t.lastProvider).toBe('kokoro');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(msg);
      expect(logs[0]).toMatch(/— using the local Kokoro voice\.$/);
      await t.speak('Again.').done;
      expect(logs).toHaveLength(1); // once per session
      // Sticky failures (key/credits/voice/4xx) aren't retried; a 5xx is.
      expect(el.requests).toHaveLength(name === '500' ? 2 : 1);
    });
  }

  it('timeout → falls back; network errors are retried on the next reply', async () => {
    el.reply('/v1/text-to-speech', { kind: 'hang' });
    const t = tts(cfg(), { kokoro: false });
    const t0 = Date.now();
    await t.speak('One.').done;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(say.log().map((s) => s.stdin)).toEqual(['One.']);
    expect(logs).toEqual(['Voice output: ElevenLabs did not answer within 1 s — using macOS say.']);
    el.routes = [];
    await t.speak('Two.').done;
    expect(t.lastProvider).toBe('elevenlabs');
  });

  it('onAudio fires when a player starts: once for an ElevenLabs reply, once for say, never without sound', async () => {
    let n = 0;
    const deps = { home: home(false), baseUrl: el.baseUrl, play: afplayPlayer(afplay.path), sayCommand: say.path, log: (l: string) => logs.push(l), tmpRoot: audioTmp, onAudio: () => void n++ };
    const withKey = createTts(cfg(), { ...deps, findKey: async () => ({ found: { key: FAKE_KEY, source: 'keychain' as const, where: 'macOS Keychain' }, notes: [] }) });
    await withKey.speak('Hello.').done;
    expect([withKey.lastProvider, n]).toEqual(['elevenlabs', 1]);
    const noKey = createTts(cfg({ tts: 'say' }), { ...deps, findKey: async () => ({ found: null, notes: [] }), onAudio: () => {
      n++;
      throw new Error('a hook that throws');
    } });
    await noKey.speak('Hello.').done;
    expect([noKey.lastProvider, n]).toEqual(['say', 2]); // and the throwing hook did not break speech
  });

  it('cannot reach the server → network failure → say', async () => {
    const t = createTts(cfg(), {
      home: home(false),
      findKey: async () => ({ found: { key: FAKE_KEY, source: 'env', where: '$ELEVENLABS_API_KEY' }, notes: [] }),
      baseUrl: 'http://127.0.0.1:1',
      play: afplayPlayer(afplay.path),
      sayCommand: say.path,
      log: (l) => logs.push(l),
    });
    await t.speak('Hello.').done;
    expect(logs[0]).toMatch(/^Voice output: could not reach ElevenLabs \(.+\) — using macOS say\.$/);
    expect(t.lastProvider).toBe('say');
  });

  it('never logs the key, even when the server echoes it back', async () => {
    el.reply('/v1/text-to-speech', { kind: 'error', status: 401, detail: { status: 'invalid_api_key', message: `key ${FAKE_KEY} is invalid` } });
    await tts(cfg()).speak('Hi.').done;
    expect(logs.join('\n')).not.toContain(FAKE_KEY);
    expect(logs[0]).toContain('sk_…beef');
  });

  it('cancel during playback kills afplay and cleans up', async () => {
    const slow = fakeBin('afplay', { ms: 5000 });
    const t = createTts(cfg(), {
      home: home(false),
      findKey: async () => ({ found: { key: FAKE_KEY, source: 'keychain', where: 'k' }, notes: [] }),
      baseUrl: el.baseUrl,
      play: afplayPlayer(slow.path),
      sayCommand: say.path,
      log: (l) => logs.push(l),
      tmpRoot: audioTmp,
    });
    const h = t.speak('A long reply.');
    for (let i = 0; i < 100 && slow.log().length === 0; i++) await sleep(20);
    const t0 = Date.now();
    h.cancel();
    await h.done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(say.log()).toEqual([]); // a cancel is not a failure: no fallback
    expect(logs).toEqual([]);
    expect(readdirSync(audioTmp)).toEqual([]);
  });

  it('afplay missing → falls back to say', async () => {
    const t = createTts(cfg(), {
      home: home(false),
      findKey: async () => ({ found: { key: FAKE_KEY, source: 'keychain', where: 'k' }, notes: [] }),
      baseUrl: el.baseUrl,
      play: afplayPlayer(join(tmp, 'no-such-afplay')),
      sayCommand: say.path,
      log: (l) => logs.push(l),
    });
    await t.speak('Hi.').done;
    expect(logs[0]).toMatch(/no-such-afplay is not available \(macOS only\) — using macOS say\./);
    expect(t.lastProvider).toBe('say');
  });
});

describe('provider choice', () => {
  it('auto: ElevenLabs when a key is found, else Kokoro if installed, else say', async () => {
    expect((await tts(cfg(), { kokoro: true }).plan()).providers).toEqual(['elevenlabs', 'kokoro', 'say']);
    expect((await tts(cfg(), { key: null, kokoro: true }).plan()).providers).toEqual(['kokoro', 'say']);
    const t = tts(cfg(), { key: null, kokoro: false });
    expect((await t.plan()).providers).toEqual(['say']);
    await t.speak('Hi.').done;
    expect(say.log()[0]!.stdin).toBe('Hi.');
    expect(logs).toEqual([]); // auto: no complaint about an optional voice
  });

  it('the plan reports where the key came from, redacted', async () => {
    const p = await tts(cfg()).plan();
    expect(p.key).toEqual({ source: 'keychain', where: 'macOS Keychain', redacted: 'sk_…beef' });
    expect(JSON.stringify(p)).not.toContain(FAKE_KEY);
  });

  it('configured provider unavailable → next one, logged once', async () => {
    const t = tts(cfg({ tts: 'elevenlabs' }), { key: null, kokoro: true });
    await t.speak('One.').done;
    await t.speak('Two.').done;
    expect(logs).toEqual(['Voice output: voice.tts is "elevenlabs" but no ElevenLabs API key was found (run `stephen voice-key set`) — using the local Kokoro voice.']);
    const k = tts(cfg({ tts: 'kokoro' }), { kokoro: false });
    expect((await k.plan()).providers).toEqual(['say']);
    expect(logs[1]).toMatch(/voice\.tts is "kokoro" but the Kokoro model is not installed .* — using macOS say\./);
  });

  it('tts "say" never calls ElevenLabs or Kokoro; "kokoro" skips ElevenLabs', async () => {
    const calls: { text: string; sid: number; speed: number }[] = [];
    await tts(cfg({ tts: 'say', voice: 'Daniel', rate: 200 }), { kokoro: true, kokoroCalls: calls }).speak('Hi.').done;
    expect(el.requests).toEqual([]);
    expect(calls).toEqual([]);
    expect(say.log()[0]!.argv).toEqual(['-v', 'Daniel', '-r', '200']);
    await tts(cfg({ tts: 'kokoro', kokoro: { speaker: 'bf_emma', speed: 1.2 } }), { kokoro: true, kokoroCalls: calls }).speak('Hi.').done;
    expect(el.requests).toEqual([]);
    expect(calls).toEqual([{ text: 'Hi.', sid: 7, speed: 1.2 }]);
  });

  it('Kokoro failing → say', async () => {
    const t = tts(cfg({ tts: 'kokoro' }), { kokoro: true, kokoroFail: true });
    await t.speak('Hi.').done;
    expect(logs).toEqual(['Voice output: the local voice failed: onnx exploded — using macOS say.']);
    expect(t.lastProvider).toBe('say');
  });

  it('a failed warm-up rejects (the caller logs it); speaking still works through the fallback', async () => {
    const t = createTts(cfg({ tts: 'kokoro' }), {
      home: home(true),
      findKey: async () => ({ found: null, notes: [] }),
      kokoroEngine: async () => {
        throw new Error('engine missing');
      },
      play: afplayPlayer(afplay.path),
      sayCommand: say.path,
      log: (l) => logs.push(l),
      tmpRoot: audioTmp,
    });
    await expect(t.warm()).rejects.toThrow('the local voice could not start: engine missing');
    await t.speak('Hi.').done;
    expect(t.lastProvider).toBe('say');
  });

  it('everything failing → done still resolves, reason logged', async () => {
    const t = createTts(cfg({ tts: 'say' }), { home: home(false), findKey: async () => ({ found: null, notes: [] }), sayCommand: join(tmp, 'no-say'), log: (l) => logs.push(l) });
    await t.speak('Hi.').done;
    expect(logs).toEqual(['Voice output: `say` is not available (macOS only) — reply not spoken.']);
  });

  it('strips markdown and skips empty text', async () => {
    const t = tts(cfg({ tts: 'say' }));
    await t.speak('```\ncode\n```').done;
    expect(say.log()).toEqual([]);
    await t.speak('Opened [YouTube](https://youtube.com) in *Zen*.').done;
    expect(say.log()[0]!.stdin).toBe('Opened YouTube in Zen.');
  });

  it('accepts the listener VoiceConfig directly', async () => {
    const vc = parseVoiceConfig({ tts: 'say', elevenlabs: { voiceId: 'abcdefghij1234567890' } });
    expect(vc.elevenlabs.voiceId).toBe('abcdefghij1234567890');
    expect(vc.kokoro).toEqual({ speaker: 'am_michael', speed: 1 });
    const t = createTts(vc, { home: home(false), findKey: async () => ({ found: null, notes: [] }), sayCommand: say.path, log: (l) => logs.push(l) });
    expect((await t.plan()).providers).toEqual(['say']);
  });
});

describe('config', () => {
  it('defaults', () => {
    expect(parseTtsConfig({})).toEqual({
      tts: 'auto',
      elevenlabs: { voiceId: 'YEBbZ0itqHW31uoXSBns', modelId: 'eleven_flash_v2_5', timeoutSec: 8 },
      kokoro: { speaker: 'am_michael', speed: 1 },
      voice: null,
      rate: null,
    });
  });
  it('rejects bad values with the key named, and ignores unrelated voice keys', () => {
    expect(() => parseTtsConfig({ tts: 'polly' })).toThrow(/"voice\.tts"/);
    expect(() => parseTtsConfig({ elevenlabs: { voiceId: '../../etc' } })).toThrow(/voice\.elevenlabs\.voiceId/);
    const unknown: string[] = [];
    expect(() => parseTtsConfig({ elevenlabs: { apiKey: 'sk_x' } }, unknown)).not.toThrow();
    expect(unknown).toEqual(['voice.elevenlabs.apiKey']);
    expect(() => parseTtsConfig({ kokoro: { speaker: 11 } })).toThrow(/voice\.kokoro\.speaker/);
    expect(parseTtsConfig({ wakePhrase: 'x', tts: 'say' }).tts).toBe('say');
    expect(() => parseVoiceConfig({ tts: 'polly' })).toThrow(/voice\.tts/);
  });
});
