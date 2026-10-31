// Regenerates the synthetic test speech in this folder with sherpa-onnx TTS (Piper/VITS voices from
// github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models). Not run by the test suite — the WAVs are committed.
//
//   node test/voice/fixtures/generate.mjs <models dir containing vits-piper-en_US-amy-low and vits-piper-en_GB-alan-low>
//
// Every clip: 16 kHz mono 16-bit, 0.6 s lead-in, 1.5 s tail, deterministic low-level noise (≈ -50 dBFS).
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const here = dirname(fileURLToPath(import.meta.url));
const modelsDir = process.argv[2];
if (!modelsDir) {
  console.error('usage: node generate.mjs <models dir>');
  process.exit(2);
}

const VOICES = [
  { id: 'amy', dir: 'vits-piper-en_US-amy-low', onnx: 'en_US-amy-low.onnx', lengthScale: 1.0 },
  { id: 'alan', dir: 'vits-piper-en_GB-alan-low', onnx: 'en_GB-alan-low.onnx', lengthScale: 1.12 },
];

/** Each clip is a list of parts: strings are spoken, numbers are seconds of silence. */
const CLIPS = {
  'wake-onebreath': ['Hey Stephen open YouTube.'],
  'wake-pause': ['Hey Stephen.', 1.2, 'Open YouTube.'],
  'wake-screen': ["Hey Stephen. What's on my screen?"],
  'neg-steve': ['Hey Steve, open YouTube.'],
  'neg-stephanie': ['Stephanie said open YouTube.'],
  'neg-even': ['Even Stephen agreed to open YouTube.'],
  'neg-step': ['Hey, step in and open YouTube.'],
  'neg-weather': ['The weather is lovely today, let us go for a walk.'],
  'stop': ['Stephen, stop.'],
  // Push-to-talk: the command alone, no wake phrase (and a wake-word negative).
  'ptt-open': ['Open YouTube.'],
};
/** Clips added later get their own noise generator, so regenerating never changes the older clips. */
const OWN_SEED = { 'ptt-open': 4242 };

const RATE = 16000;
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;

function wav16(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

for (const v of VOICES) {
  const d = join(modelsDir, v.dir);
  const tts = new sherpa.OfflineTts({
    model: { vits: { model: join(d, v.onnx), tokens: join(d, 'tokens.txt'), dataDir: join(d, 'espeak-ng-data'), lengthScale: v.lengthScale }, numThreads: 2 },
    maxNumSentences: 1,
  });
  if (tts.sampleRate !== RATE) throw new Error(`${v.id}: sample rate ${tts.sampleRate}`);
  for (const [name, parts] of Object.entries(CLIPS)) {
    const chunks = [new Float32Array(Math.round(0.6 * RATE))];
    for (const p of parts) {
      if (typeof p === 'number') chunks.push(new Float32Array(Math.round(p * RATE)));
      else chunks.push(tts.generate({ text: p, sid: 0, speed: 1.0 }).samples);
    }
    chunks.push(new Float32Array(Math.round(1.5 * RATE)));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    let own = OWN_SEED[name];
    const noise = own === undefined ? rand : () => ((own = (own * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.8 + noise() * 0.003;
    const file = join(here, `${name}.${v.id}.wav`);
    writeFileSync(file, wav16(out));
    console.log(file, (total / RATE).toFixed(2) + ' s');
  }
}
