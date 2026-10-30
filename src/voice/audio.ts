import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { SAMPLE_RATE, decodeWav16k } from './wav.js';

/** Samples per frame everywhere in the pipeline (32 ms at 16 kHz; Silero VAD's window). */
export const FRAME = 512;

/** A stream of 16 kHz mono float frames in [-1, 1]. */
export interface AudioSource {
  readonly label: string;
  start(): Promise<void>;
  /** The next frame, or null once the input has ended (files) or the source was stopped. */
  read(): Promise<Float32Array | null>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * In-memory source (tests, `--wav`). `realtime` paces frames: 1 = real time, 2 = twice as fast,
 * 0 (default) = as fast as the consumer reads.
 */
export class ArrayAudioSource implements AudioSource {
  private pos = 0;
  private stopped = false;
  private next = 0;
  constructor(
    private readonly samples: Float32Array,
    private readonly opts: { label?: string; realtime?: number; frame?: number } = {},
  ) {}
  get label(): string {
    return this.opts.label ?? 'audio buffer';
  }
  async start(): Promise<void> {
    this.next = Date.now();
  }
  async read(): Promise<Float32Array | null> {
    if (this.stopped || this.pos >= this.samples.length) return null;
    const n = this.opts.frame ?? FRAME;
    const out = this.samples.slice(this.pos, this.pos + n);
    this.pos += n;
    const rt = this.opts.realtime ?? 0;
    if (rt > 0) {
      this.next += (n / SAMPLE_RATE) * 1000 / rt;
      const wait = this.next - Date.now();
      if (wait > 0) await sleep(wait);
    } else if ((this.pos / n) % 64 === 0) {
      await new Promise<void>((r) => setImmediate(r)); // let timers / child-process events run
    }
    return out;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/** A WAV file of any rate/channels, converted to 16 kHz mono. */
export async function wavFileSource(path: string, opts: { realtime?: number } = {}): Promise<ArrayAudioSource> {
  const samples = decodeWav16k(await readFile(path));
  return new ArrayAudioSource(samples, { label: path, realtime: opts.realtime });
}

// ───────────────────────────── microphone (PvRecorder) ─────────────────────────────

/** The subset of @picovoice/pvrecorder-node we use (no AccessKey needed — PvRecorder is plain Apache-2.0 audio capture). */
interface PvRecorderLike {
  readonly sampleRate: number;
  start(): void;
  stop(): void;
  read(): Promise<Int16Array>;
  release(): void;
  getSelectedDevice(): string;
}
interface PvRecorderCtor {
  new (frameLength: number, deviceIndex?: number, bufferedFramesCount?: number): PvRecorderLike;
  getAvailableDevices(): string[];
}

function loadPvRecorder(): PvRecorderCtor {
  const require = createRequire(import.meta.url);
  try {
    const mod = require('@picovoice/pvrecorder-node') as { PvRecorder: PvRecorderCtor };
    return mod.PvRecorder;
  } catch (e) {
    throw new Error(
      `Could not load the microphone library (@picovoice/pvrecorder-node): ${(e as Error).message.split('\n')[0]}. Run \`npm install\` in the Stephen folder.`,
    );
  }
}

/** Names of the capture devices, in PvRecorder index order. */
export function listInputDevices(load: () => PvRecorderCtor = loadPvRecorder): string[] {
  return load().getAvailableDevices();
}

/**
 * Turn the configured device (index, name fragment, or null) into a PvRecorder index.
 * Name matching is case-insensitive: exact name first, then the first name containing the text.
 */
export function resolveDeviceIndex(device: number | string | null, devices: readonly string[]): number {
  if (device === null) return -1;
  if (typeof device === 'number') {
    if (device !== -1 && (device < 0 || device >= devices.length)) {
      throw new Error(`No input device #${device}. Run \`stephen listen --list-devices\`.`);
    }
    return device;
  }
  const s = device.trim();
  if (/^-?\d+$/.test(s)) return resolveDeviceIndex(Number(s), devices);
  const lower = s.toLowerCase();
  let i = devices.findIndex((d) => d.toLowerCase() === lower);
  if (i < 0) i = devices.findIndex((d) => d.toLowerCase().includes(lower));
  if (i < 0) throw new Error(`No input device matching "${s}". Run \`stephen listen --list-devices\`.`);
  return i;
}

/**
 * Live microphone via PvRecorder (16 kHz mono, prebuilt for macOS arm64/x64 and Linux).
 * Warns once if the first ~3 s are exact digital silence — on macOS that means the terminal app has no
 * Microphone permission (macOS hands it zeros instead of failing).
 */
export class MicrophoneSource implements AudioSource {
  private rec: PvRecorderLike | null = null;
  private stopped = false;
  private framesSeen = 0;
  private allZero = true;
  private pending: Promise<Int16Array> | null = null;
  constructor(
    private readonly deviceIndex: number,
    private readonly onSilentMic: () => void = () => {},
    private readonly load: () => PvRecorderCtor = loadPvRecorder,
  ) {}
  get label(): string {
    return this.rec?.getSelectedDevice() ?? (this.deviceIndex < 0 ? 'default microphone' : `input device #${this.deviceIndex}`);
  }
  async start(): Promise<void> {
    const Ctor = this.load();
    // 250 frames ≈ 8 s of buffer, so a slow native decode never drops audio.
    this.rec = new Ctor(FRAME, this.deviceIndex, 250);
    if (this.rec.sampleRate !== SAMPLE_RATE) throw new Error(`microphone runs at ${this.rec.sampleRate} Hz, expected ${SAMPLE_RATE}`);
    this.rec.start();
  }
  async read(): Promise<Float32Array | null> {
    if (this.stopped || !this.rec) return null;
    let pcm: Int16Array;
    try {
      this.pending = this.rec.read();
      pcm = await this.pending;
    } catch (e) {
      if (this.stopped) return null;
      throw e;
    } finally {
      this.pending = null;
    }
    if (this.stopped) return null;
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i]!;
      if (v !== 0) this.allZero = false;
      out[i] = v / 32768;
    }
    if (++this.framesSeen === 100 && this.allZero) this.onSilentMic();
    return out;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Never release the native recorder under a read that is still in flight.
    if (this.pending) await Promise.race([this.pending.catch(() => null), sleep(500)]);
    try {
      this.rec?.stop();
      this.rec?.release();
    } catch {
      // already released
    }
  }
}
