/** Minimal WAV (RIFF) reading/writing for 16 kHz mono float pipelines. */

export const SAMPLE_RATE = 16_000;

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

/** Parse a PCM WAV (8/16/24/32-bit int or 32-bit float, any channel count). Channels are averaged to mono. */
export function parseWav(buf: Uint8Array): Pcm {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { start: number; len: number } | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const rate = dv.getUint32(body + 4, true);
      const bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, rate, bits };
    } else if (id === 'data') {
      data = { start: body, len: Math.min(size, buf.byteLength - body) };
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV has no fmt/data chunk');
  const { format, channels, rate, bits } = fmt;
  if (channels < 1) throw new Error('WAV has no channels');
  const bytes = bits / 8;
  if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && bits === 32))) {
    throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  }
  const frames = Math.floor(data.len / (bytes * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = data.start + (i * channels + c) * bytes;
      let v: number;
      if (format === 3) v = dv.getFloat32(p, true);
      else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) v = ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608);
      else v = dv.getInt32(p, true) / 2147483648;
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate: rate };
}

/** Linear-interpolation resampler (good enough for speech going into 16 kHz models). */
export function resample(samples: Float32Array, from: number, to: number = SAMPLE_RATE): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = x - i0;
    out[i] = (samples[i0] ?? 0) * (1 - t) + (samples[i1] ?? 0) * t;
  }
  return out;
}

/** Decode a WAV buffer to 16 kHz mono float samples. */
export function decodeWav16k(buf: Uint8Array): Float32Array {
  const pcm = parseWav(buf);
  return resample(pcm.samples, pcm.sampleRate, SAMPLE_RATE);
}

/** Encode float samples as a 16-bit PCM mono WAV. */
export function encodeWav16(samples: Float32Array, sampleRate: number = SAMPLE_RATE): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Concatenate float chunks. */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** `sec` seconds of silence at 16 kHz. */
export function silence(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SAMPLE_RATE));
}
