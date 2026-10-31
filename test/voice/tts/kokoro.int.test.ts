/**
 * Real Kokoro synthesis (sherpa-onnx, kokoro-int8-en-v0_19). Downloads the pinned model once into the shared
 * test model cache (~103 MB); skipped with the reason when it can't be downloaded or STEPHEN_VOICE_SKIP_MODELS
 * is set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseWav } from '../../../src/voice/wav.js';
import { ensureKokoro, KokoroSpeaker } from '../../../src/voice/tts/kokoro.js';
import type { PlayFn } from '../../../src/voice/tts/player.js';
import { readFileSync, statSync } from 'node:fs';
import { TEST_MODELS_ROOT } from '../helpers.js';

async function prepare(): Promise<string | null> {
  if (process.env.STEPHEN_VOICE_SKIP_MODELS) return null;
  try {
    await ensureKokoro(TEST_MODELS_ROOT, { log: (l) => process.stderr.write(`[kokoro test model] ${l}\n`) });
    return TEST_MODELS_ROOT;
  } catch (e) {
    process.stderr.write(`[kokoro test model] unavailable (${(e as Error).message}) — skipping\n`);
    return null;
  }
}
const root = await prepare();
const tmp = mkdtempSync(join(tmpdir(), 'stephen-kokoro-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!root)('Kokoro (real model)', () => {
  it('synthesizes a 10-word sentence to a 24 kHz WAV and hands it to the player', async () => {
    const played: { bytes: Buffer; mode: number }[] = [];
    const play: PlayFn = (file) => {
      played.push({ bytes: readFileSync(file), mode: statSync(file).mode & 0o777 });
      return { done: Promise.resolve(), cancel: () => {} };
    };
    const k = new KokoroSpeaker({ modelsRoot: root!, sid: 6, speed: 1, play, tmpRoot: tmp });
    const t0 = Date.now();
    await k.warm();
    const loadMs = Date.now() - t0;
    const sentence = 'Playing Say So by Doja Cat on Spotify for you.'; // 10 words
    const t1 = Date.now();
    await k.speak(sentence).done;
    const genMs = Date.now() - t1;
    expect(played).toHaveLength(1);
    expect(played[0]!.mode).toBe(0o600);
    const wav = parseWav(played[0]!.bytes);
    expect(wav.sampleRate).toBe(24_000);
    const sec = wav.samples.length / wav.sampleRate;
    expect(sec).toBeGreaterThan(1.5);
    expect(sec).toBeLessThan(8);
    const rms = Math.sqrt(wav.samples.reduce((s, v) => s + v * v, 0) / wav.samples.length);
    expect(rms).toBeGreaterThan(0.01);
    process.stderr.write(`[kokoro] load ${loadMs} ms; 10-word sentence → ${sec.toFixed(2)} s audio in ${genMs} ms (RTF ${(genMs / 1000 / sec).toFixed(2)})\n`);
  });

  it('cancel during synthesis stops before playback', async () => {
    const played: string[] = [];
    const k = new KokoroSpeaker({ modelsRoot: root!, sid: 0, speed: 1, play: (f) => (played.push(f), { done: Promise.resolve(), cancel: () => {} }), tmpRoot: tmp });
    await k.warm();
    const h = k.speak('This is a somewhat longer sentence that we will cancel right away.');
    h.cancel();
    await h.done;
    expect(played).toEqual([]);
  });
});
