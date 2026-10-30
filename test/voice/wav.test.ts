import { describe, expect, it } from 'vitest';
import { ArrayAudioSource, FRAME, resolveDeviceIndex } from '../../src/voice/audio.js';
import { concatSamples, decodeWav16k, encodeWav16, parseWav, resample, silence } from '../../src/voice/wav.js';

describe('wav', () => {
  it('round-trips 16-bit mono', () => {
    const s = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = parseWav(encodeWav16(s, 16000));
    expect(pcm.sampleRate).toBe(16000);
    expect(Array.from(pcm.samples).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1]);
  });

  it('downmixes stereo float and resamples to 16 kHz', () => {
    const frames = 4800; // 0.1 s at 48 kHz
    const buf = Buffer.alloc(44 + frames * 2 * 4);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + frames * 8, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(3, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(48000, 24);
    buf.writeUInt32LE(48000 * 8, 28);
    buf.writeUInt16LE(8, 32);
    buf.writeUInt16LE(32, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(frames * 8, 40);
    for (let i = 0; i < frames; i++) {
      buf.writeFloatLE(0.2, 44 + i * 8);
      buf.writeFloatLE(0.4, 48 + i * 8);
    }
    const out = decodeWav16k(buf);
    expect(out.length).toBe(1600);
    expect(out[100]).toBeCloseTo(0.3, 5);
  });

  it('rejects non-WAV data', () => {
    expect(() => parseWav(Buffer.from('hello world, not a wav'))).toThrow(/RIFF/);
  });

  it('resample/concat/silence helpers', () => {
    expect(resample(new Float32Array([1, 1, 1, 1]), 32000, 16000).length).toBe(2);
    expect(concatSamples([new Float32Array([1]), new Float32Array([2, 3])])).toEqual(new Float32Array([1, 2, 3]));
    expect(silence(0.5).length).toBe(8000);
  });
});

describe('audio sources', () => {
  it('ArrayAudioSource yields 512-sample frames then null', async () => {
    const src = new ArrayAudioSource(new Float32Array(FRAME * 2 + 10));
    await src.start();
    const sizes: number[] = [];
    for (let f = await src.read(); f; f = await src.read()) sizes.push(f.length);
    expect(sizes).toEqual([512, 512, 10]);
  });

  it('resolveDeviceIndex: default, index, name fragment', () => {
    const devs = ['MacBook Pro Microphone', 'USB Audio CODEC', 'ZoomAudioDevice'];
    expect(resolveDeviceIndex(null, devs)).toBe(-1);
    expect(resolveDeviceIndex(-1, devs)).toBe(-1);
    expect(resolveDeviceIndex(1, devs)).toBe(1);
    expect(resolveDeviceIndex('2', devs)).toBe(2);
    expect(resolveDeviceIndex('usb', devs)).toBe(1);
    expect(resolveDeviceIndex('zoomaudiodevice', devs)).toBe(2);
    expect(() => resolveDeviceIndex(5, devs)).toThrow(/No input device #5/);
    expect(() => resolveDeviceIndex('AirPods', devs)).toThrow(/No input device matching "AirPods"/);
  });
});
