/**
 * Thin adapters over sherpa-onnx-node (keyword spotter, Silero VAD, offline recognizer). The native addon is
 * loaded lazily, so `--text`, `--dry-run` and the unit tests never need it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { AsrModelId } from './config.js';
import { buildKeywordsFile, createEncoder, parseTokens, phraseVariants, readSentencePieceModel, type KeywordSpec } from './keywords.js';
import type { ModelPaths } from './models.js';
import { SAMPLE_RATE } from './wav.js';

// ───────────────────────────── interfaces the listener uses ─────────────────────────────

export interface KeywordHit {
  id: 'WAKE' | 'STOP';
  /** The wake phrase that fired was a single word (bare "Stephen"): the transcript check is stricter. */
  bare?: boolean;
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
  wakePhrases: readonly string[];
  stopPhrase: string;
  threshold: number;
  /** Threshold for one-word wake phrases (bare "stephen"). */
  bareThreshold: number;
  score: number;
  /** Where to write the generated keywords file. */
  workDir: string;
}

/** Audio the spotter keeps, so a bare wake can be re-checked for the stop phrase (seconds). */
const RECENT_SEC = 3;
/** After a bare wake, how long (seconds of audio) a second spotter listens for the whole stop phrase. */
export const STOP_CONFIRM_SEC = 1.2;
/** …starting this long before the bare wake's first token (token times lag the speech; 0.2 s missed some). */
const STOP_CONFIRM_LEAD_SEC = 0.5;

/**
 * Whether the stop phrase starts with a one-word wake phrase ("stephen stop" / "stephen"). The spotter reports
 * the bare wake word as soon as it is said, before "stop" has been heard, so such a stop phrase needs the
 * second look described at SherpaSpotter.
 */
export function stopStartsWithBareWake(wakePhrases: readonly string[], stopPhrase: string): boolean {
  const [first, ...rest] = stopPhrase.trim().toLowerCase().split(/\s+/);
  if (!rest.length || !first) return false;
  return wakePhrases.filter((p) => !p.trim().includes(' ')).some((p) => phraseVariants(p.trim()).includes(first));
}

function keywordSpecs(o: SpotterOptions, stopOnly = false): KeywordSpec[] {
  const stop: KeywordSpec = { id: 'STOP', phrase: o.stopPhrase, threshold: o.threshold, score: o.score };
  if (stopOnly) return [stop];
  return [
    stop,
    ...o.wakePhrases.map((phrase): KeywordSpec => {
      const bare = !phrase.trim().includes(' ');
      return { id: bare ? 'WAKE_BARE' : 'WAKE', phrase, threshold: bare ? o.bareThreshold : o.threshold, score: o.score };
    }),
  ];
}

/** Generate the keywords file for the configured phrases from the model's own sentencepiece model. */
export function writeKeywordsFile(paths: ModelPaths, o: SpotterOptions, stopOnly = false): { file: string; text: string } {
  const encoder = createEncoder(readSentencePieceModel(readFileSync(paths.kws.bpeModel)));
  const tokens = parseTokens(readFileSync(paths.kws.tokens, 'utf8'));
  const text = buildKeywordsFile(keywordSpecs(o, stopOnly), encoder, tokens);
  const file = join(o.workDir, stopOnly ? 'keywords-stop.txt' : 'keywords.txt');
  writeFileSync(file, text, { mode: 0o600 });
  return { file, text };
}

function createKws(sherpa: SherpaModule, paths: ModelPaths, o: SpotterOptions, keywordsFile: string): SherpaKws {
  return new sherpa.KeywordSpotter({
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
    keywordsFile,
  });
}

/**
 * The keyword spotter. "Stephen stop" vs the bare wake word "Stephen": the spotter fires "STEPHEN" the moment it
 * is complete, before "stop" is said. So after a bare wake (reported at once, as usual) a second spotter that
 * knows only the stop phrase re-reads the audio from the start of "Stephen" and listens on for STOP_CONFIRM_SEC;
 * if it hears "stephen stop", a STOP follows. The listener then cancels whatever the wake started (a capture,
 * or the running command it already cancelled), or cuts the spoken reply short.
 */
export class SherpaSpotter implements Spotter {
  private readonly kws: SherpaKws;
  private readonly stopKws: SherpaKws | null;
  private stream: SherpaStream;
  private fed = 0;
  /** This stream's last RECENT_SEC of audio. */
  private recent: Float32Array[] = [];
  private recentLen = 0;
  /** Stop-phrase check running after a bare wake. */
  private confirm: { stream: SherpaStream; leftSec: number } | null = null;
  constructor(paths: ModelPaths, o: SpotterOptions, sherpa: SherpaModule = loadSherpa()) {
    this.kws = createKws(sherpa, paths, o, writeKeywordsFile(paths, o).file);
    this.stopKws = stopStartsWithBareWake(o.wakePhrases, o.stopPhrase) ? createKws(sherpa, paths, o, writeKeywordsFile(paths, o, true).file) : null;
    this.stream = this.kws.createStream();
  }
  accept(samples: Float32Array): KeywordHit | null {
    this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    this.fed += samples.length;
    this.remember(samples);
    const hit = this.drain();
    const stop = this.checkStop(samples);
    return stop ?? hit;
  }
  private checkStop(samples: Float32Array): KeywordHit | null {
    const c = this.confirm;
    if (!c || !this.stopKws) return null;
    c.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    c.leftSec -= samples.length / SAMPLE_RATE;
    let found = false;
    while (this.stopKws.isReady(c.stream)) {
      this.stopKws.decode(c.stream);
      if (this.stopKws.getResult(c.stream).keyword) found = true;
    }
    if (found || c.leftSec <= 0) this.confirm = null;
    return found ? { id: 'STOP', startAgoSec: 0 } : null;
  }
  private remember(samples: Float32Array): void {
    this.recent.push(samples);
    this.recentLen += samples.length;
    while (this.recentLen - this.recent[0]!.length >= RECENT_SEC * SAMPLE_RATE) this.recentLen -= this.recent.shift()!.length;
  }
  /** The last `sec` seconds of this stream's audio. */
  private lastAudio(sec: number): Float32Array {
    const all = new Float32Array(this.recentLen);
    let o = 0;
    for (const c of this.recent) {
      all.set(c, o);
      o += c.length;
    }
    return all.slice(Math.max(0, all.length - Math.round(sec * SAMPLE_RATE)));
  }
  private drain(): KeywordHit | null {
    let hit: KeywordHit | null = null;
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const r = this.kws.getResult(this.stream);
      if (r.keyword && !hit) {
        // Token timestamps are relative to this stream's first sample (a fresh stream is made after every hit).
        const startSec = r.timestamps?.[0] ?? 0;
        const startAgoSec = Math.max(0, this.fed / SAMPLE_RATE - startSec);
        hit = { id: r.keyword === 'STOP' ? 'STOP' : 'WAKE', startAgoSec };
        if (r.keyword === 'WAKE_BARE') {
          hit.bare = true;
          if (this.stopKws) {
            const stream = this.stopKws.createStream();
            stream.acceptWaveform({ samples: this.lastAudio(startAgoSec + STOP_CONFIRM_LEAD_SEC), sampleRate: SAMPLE_RATE });
            this.confirm = { stream, leftSec: STOP_CONFIRM_SEC };
          }
        }
      }
    }
    if (hit) this.restart();
    return hit;
  }
  restart(prime?: Float32Array): KeywordHit | null {
    this.stream = this.kws.createStream();
    this.fed = 0;
    this.recent = [];
    this.recentLen = 0;
    if (!prime || !prime.length) return null;
    this.stream.acceptWaveform({ samples: prime, sampleRate: SAMPLE_RATE });
    this.fed = prime.length;
    this.remember(prime);
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
    case 'whisper-small.en': {
      const p = id.slice('whisper-'.length); // base.en, small.en
      return { whisper: { encoder: get(`${p}-encoder.int8.onnx`), decoder: get(`${p}-decoder.int8.onnx`), language: 'en', task: 'transcribe', tailPaddings: -1 }, tokens: get(`${p}-tokens.txt`) };
    }
    case 'parakeet-tdt-0.6b-v2':
      // NVIDIA NeMo FastConformer-TDT transducer (offline, English-only). Greedy search; see docs/VOICE.md on hotwords.
      return { transducer: { encoder: get('encoder.int8.onnx'), decoder: get('decoder.int8.onnx'), joiner: get('joiner.int8.onnx') }, tokens: get('tokens.txt'), modelType: 'nemo_transducer' };
    case 'moonshine-base-v2':
      return { moonshine: { encoder: get('encoder_model.ort'), mergedDecoder: get('decoder_model_merged.ort') }, tokens: get('tokens.txt') };
    case 'moonshine-tiny':
    case 'moonshine-base':
      return {
        moonshine: { preprocessor: get('preprocess.onnx'), encoder: get('encode.int8.onnx'), uncachedDecoder: get('uncached_decode.int8.onnx'), cachedDecoder: get('cached_decode.int8.onnx') },
        tokens: get('tokens.txt'),
      };
  }
}

/** Half the cores, 2–4: Apple Silicon has 4+ performance cores; the keyword spotter and the mic need the rest. */
export function asrThreads(cores = availableParallelism()): number {
  return Math.max(2, Math.min(4, Math.floor(cores / 2)));
}

export class SherpaTranscriber implements Transcriber {
  private constructor(
    readonly id: string,
    private readonly rec: SherpaOfflineRecognizer,
  ) {}
  static async create(paths: ModelPaths, sherpa: SherpaModule = loadSherpa()): Promise<SherpaTranscriber> {
    const rec = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: { ...asrModelConfig(paths.asr.id, paths.asr.files), numThreads: asrThreads(), provider: 'cpu', debug: 0 },
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
