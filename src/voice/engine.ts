/**
 * Thin adapters over sherpa-onnx-node (keyword spotter, Silero VAD, offline recognizer). The native addon is
 * loaded lazily, so `--text`, `--dry-run` and the unit tests never need it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AsrModelId } from './config.js';
import { buildKeywordsFile, createEncoder, parseTokens, readSentencePieceModel, type KeywordSpec } from './keywords.js';
import type { ModelPaths } from './models.js';
import { SAMPLE_RATE } from './wav.js';

// ───────────────────────────── interfaces the listener uses ─────────────────────────────

export interface KeywordHit {
  id: 'WAKE' | 'STOP';
  /** Seconds between the start of the keyword and the end of the audio fed so far. */
  startAgoSec: number;
}

export interface Spotter {
  /** Feed audio; returns a hit when a keyword completes in it. */
  accept(samples: Float32Array): KeywordHit | null;
  /**
   * Start a fresh stream, optionally primed with recent audio (so a keyword spanning the restart still counts).
   * Returns a hit if the primed audio completes a keyword the old stream had not decoded yet.
   */
  restart(prime?: Float32Array): KeywordHit | null;
}

/** Voice-activity detector used for endpointing. */
export interface Vad {
  reset(): void;
  accept(samples: Float32Array): void;
  /** True while inside speech (stays true until `silenceSec` of silence has passed). */
  speaking(): boolean;
}

export interface Transcriber {
  readonly id: string;
  transcribe(samples: Float32Array): Promise<string>;
}

// ───────────────────────────── sherpa-onnx-node (subset) ─────────────────────────────

interface SherpaStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
}
interface SherpaKws {
  createStream(): SherpaStream;
  isReady(s: SherpaStream): boolean;
  decode(s: SherpaStream): void;
  getResult(s: SherpaStream): { keyword: string; timestamps?: number[]; start_time?: number };
}
interface NativeVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
  reset(): void;
}
interface SherpaOfflineRecognizer {
  createStream(): SherpaStream;
  decodeAsync(s: SherpaStream): Promise<unknown>;
  getResult(s: SherpaStream): { text: string };
}
interface SherpaModule {
  KeywordSpotter: new (cfg: unknown) => SherpaKws;
  Vad: new (cfg: unknown, bufferSec: number) => NativeVad;
  OfflineRecognizer: { createAsync(cfg: unknown): Promise<SherpaOfflineRecognizer> };
  version?: string;
}

let sherpaCache: SherpaModule | null = null;
export function loadSherpa(): SherpaModule {
  if (sherpaCache) return sherpaCache;
  const require = createRequire(import.meta.url);
  try {
    sherpaCache = require('sherpa-onnx-node') as SherpaModule;
    return sherpaCache;
  } catch (e) {
    throw new Error(
      `Could not load the speech engine (sherpa-onnx-node): ${(e as Error).message.split('\n')[0]}. Run \`npm install\` in the Stephen folder.`,
    );
  }
}

const NUM_THREADS = 1;

// ───────────────────────────── keyword spotter ─────────────────────────────

export interface SpotterOptions {
  wakePhrase: string;
  stopPhrase: string;
  threshold: number;
  score: number;
  /** Where to write the generated keywords file. */
  workDir: string;
}

/** Generate the keywords file for the configured phrases from the model's own sentencepiece model. */
export function writeKeywordsFile(paths: ModelPaths, o: SpotterOptions): { file: string; text: string } {
  const encoder = createEncoder(readSentencePieceModel(readFileSync(paths.kws.bpeModel)));
  const tokens = parseTokens(readFileSync(paths.kws.tokens, 'utf8'));
  const specs: KeywordSpec[] = [
    { id: 'WAKE', phrase: o.wakePhrase, threshold: o.threshold, score: o.score },
    { id: 'STOP', phrase: o.stopPhrase, threshold: o.threshold, score: o.score },
  ];
  const text = buildKeywordsFile(specs, encoder, tokens);
  const file = join(o.workDir, 'keywords.txt');
  writeFileSync(file, text, { mode: 0o600 });
  return { file, text };
}

export class SherpaSpotter implements Spotter {
  private readonly kws: SherpaKws;
  private stream: SherpaStream;
  private fed = 0;
  constructor(paths: ModelPaths, o: SpotterOptions, sherpa: SherpaModule = loadSherpa()) {
    const { file } = writeKeywordsFile(paths, o);
    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: paths.kws.encoder, decoder: paths.kws.decoder, joiner: paths.kws.joiner },
        tokens: paths.kws.tokens,
        numThreads: NUM_THREADS,
        provider: 'cpu',
        debug: 0,
      },
      keywordsScore: o.score,
      keywordsThreshold: o.threshold,
      keywordsFile: file,
    });
    this.stream = this.kws.createStream();
  }
  accept(samples: Float32Array): KeywordHit | null {
    this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    this.fed += samples.length;
    return this.drain();
  }
  private drain(): KeywordHit | null {
    let hit: KeywordHit | null = null;
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const r = this.kws.getResult(this.stream);
      if (r.keyword && !hit) {
        const id = r.keyword === 'STOP' ? 'STOP' : 'WAKE';
        // Token timestamps are relative to this stream's first sample (a fresh stream is made after every hit).
        const startSec = r.timestamps?.[0] ?? 0;
        hit = { id, startAgoSec: Math.max(0, this.fed / SAMPLE_RATE - startSec) };
      }
    }
    if (hit) this.restart();
    return hit;
  }
  restart(prime?: Float32Array): KeywordHit | null {
    this.stream = this.kws.createStream();
    this.fed = 0;
    if (!prime || !prime.length) return null;
    this.stream.acceptWaveform({ samples: prime, sampleRate: SAMPLE_RATE });
    this.fed = prime.length;
    return this.drain();
  }
}

// ───────────────────────────── VAD ─────────────────────────────

export class SherpaVad implements Vad {
  private readonly vad: NativeVad;
  constructor(modelPath: string, silenceSec: number, sherpa: SherpaModule = loadSherpa()) {
    this.vad = new sherpa.Vad(
      {
        sileroVad: { model: modelPath, threshold: 0.5, minSilenceDuration: silenceSec, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 60 },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      30,
    );
  }
  reset(): void {
    this.vad.reset();
  }
  accept(samples: Float32Array): void {
    this.vad.acceptWaveform(samples);
    while (!this.vad.isEmpty()) this.vad.pop(); // we keep our own copy of the audio
  }
  speaking(): boolean {
    return this.vad.isDetected();
  }
}

// ───────────────────────────── ASR ─────────────────────────────

function asrModelConfig(id: AsrModelId, f: Record<string, string>): Record<string, unknown> {
  const get = (k: string) => {
    const v = f[k];
    if (!v) throw new Error(`model file ${k} missing for ${id}`);
    return v;
  };
  switch (id) {
    case 'whisper-tiny.en':
      return { whisper: { encoder: get('tiny.en-encoder.int8.onnx'), decoder: get('tiny.en-decoder.int8.onnx'), language: 'en', task: 'transcribe', tailPaddings: -1 }, tokens: get('tiny.en-tokens.txt') };
    case 'whisper-base.en':
      return { whisper: { encoder: get('base.en-encoder.int8.onnx'), decoder: get('base.en-decoder.int8.onnx'), language: 'en', task: 'transcribe', tailPaddings: -1 }, tokens: get('base.en-tokens.txt') };
    case 'moonshine-tiny':
    case 'moonshine-base':
      return {
        moonshine: { preprocessor: get('preprocess.onnx'), encoder: get('encode.int8.onnx'), uncachedDecoder: get('uncached_decode.int8.onnx'), cachedDecoder: get('cached_decode.int8.onnx') },
        tokens: get('tokens.txt'),
      };
  }
}

export class SherpaTranscriber implements Transcriber {
  private constructor(
    readonly id: string,
    private readonly rec: SherpaOfflineRecognizer,
  ) {}
  static async create(paths: ModelPaths, sherpa: SherpaModule = loadSherpa()): Promise<SherpaTranscriber> {
    const rec = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { ...asrModelConfig(paths.asr.id, paths.asr.files), numThreads: 2, provider: 'cpu', debug: 0 },
    });
    return new SherpaTranscriber(paths.asr.id, rec);
  }
  async transcribe(samples: Float32Array): Promise<string> {
    if (samples.length < SAMPLE_RATE * 0.1) return '';
    const s = this.rec.createStream();
    s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    await this.rec.decodeAsync(s);
    return this.rec.getResult(s).text.trim();
  }
}
