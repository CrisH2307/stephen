/**
 * Kokoro: a local neural voice (sherpa-onnx OfflineTts, kokoro-int8-en-v0_19, 11 English speakers, 24 kHz).
 * Nothing leaves the Mac. The model (~103 MB download, ~153 MB on disk) is opt-in:
 * `stephen voice-setup --tts kokoro`. The archive is pinned by sha256 like the speech-to-text models.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { SpeakHandle } from '../speech.js';
import { curlDownloader, downloadVerified, installStaged, isInstalled, tarExtractor, type EnsureOptions, type ModelArchive } from '../models.js';
import { encodeWav16 } from '../wav.js';
import { playBuffer, TtsFailure, type PlayFn, type PlayHandle, type TtsProvider } from './player.js';

export const KOKORO_MODEL: ModelArchive = {
  id: 'kokoro-int8-en-v0_19',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2',
  sha256: 'c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd',
  bytes: 103_248_205,
  kind: 'tar.bz2',
  dir: 'kokoro-int8-en-v0_19',
  // The whole archive is kept (espeak-ng-data/ is ~390 small files the phonemizer needs); these must exist.
  keep: ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data/phontab', 'LICENSE'],
  license: 'Apache-2.0',
};

export function kokoroDir(modelsRoot: string): string {
  return join(modelsRoot, KOKORO_MODEL.dir);
}

export function isKokoroInstalled(modelsRoot: string): Promise<boolean> {
  return isInstalled(modelsRoot, KOKORO_MODEL);
}

/**
 * Download → verify sha256 → extract into a temp folder → check the needed files → move into place → marker.
 * Never downloads again once installed. Returns true if it installed now.
 */
export async function ensureKokoro(modelsRoot: string, opts: EnsureOptions = {}): Promise<boolean> {
  const m = KOKORO_MODEL;
  const log = opts.log ?? (() => {});
  if (await isKokoroInstalled(modelsRoot)) return false;
  await mkdir(modelsRoot, { recursive: true, mode: 0o700 });
  log(`Downloading ${m.id} (${Math.round(m.bytes / 1e6)} MB) from ${new URL(m.url).host}…`);
  const work = await mkdtemp(join(modelsRoot, `.tmp-${m.id}-`));
  try {
    const archive = join(work, 'archive.tar.bz2');
    await downloadVerified(m, archive, opts.download ?? curlDownloader);
    const unpack = join(work, 'unpack');
    await mkdir(unpack);
    log(`Extracting ${m.id}…`);
    await (opts.extract ?? tarExtractor)(archive, unpack);
    await rm(archive, { force: true });
    const top = join(unpack, m.dir);
    if (!existsSync(top) || !(await stat(top)).isDirectory()) throw new Error(`${m.id}: archive has no ${m.dir}/ folder`);
    for (const k of m.keep) if (!existsSync(join(top, k))) throw new Error(`${m.id}: archive is missing ${k}`);
    await rm(join(top, 'README.md'), { force: true });
    await installStaged(m, top, kokoroDir(modelsRoot));
    log(`Installed ${m.id} (local voice).`);
    return true;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ───────────────────────────── engine ─────────────────────────────

export interface KokoroEngine {
  readonly sampleRate: number;
  /** Synthesize; stops early (returning what it has) when `stop()` turns true. Runs off the main thread. */
  generate(text: string, sid: number, speed: number, stop: () => boolean): Promise<Float32Array>;
}
export type KokoroEngineFactory = (modelDir: string, numThreads: number) => Promise<KokoroEngine>;

interface SherpaTts {
  sampleRate: number;
  generateAsync(req: { text: string; sid: number; speed: number; onProgress?: (info: unknown) => number }): Promise<{ samples: Float32Array; sampleRate: number }>;
}
interface SherpaTtsModule {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> };
}

/** The real engine: sherpa-onnx-node OfflineTts (Kokoro), created asynchronously so the event loop never blocks. */
export const sherpaKokoroEngine: KokoroEngineFactory = async (dir, numThreads) => {
  let sherpa: SherpaTtsModule;
  try {
    sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as SherpaTtsModule;
  } catch (e) {
    throw new Error(`could not load sherpa-onnx-node: ${(e as Error).message.split('\n')[0]}`);
  }
  const tts = await sherpa.OfflineTts.createAsync({
    model: {
      kokoro: { model: join(dir, 'model.int8.onnx'), voices: join(dir, 'voices.bin'), tokens: join(dir, 'tokens.txt'), dataDir: join(dir, 'espeak-ng-data') },
      numThreads,
      debug: 0,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  });
  return {
    sampleRate: tts.sampleRate,
    async generate(text, sid, speed, stop) {
      const r = await tts.generateAsync({ text, sid, speed, onProgress: () => (stop() ? 0 : 1) });
      return r.samples;
    },
  };
};

export interface KokoroOptions {
  modelsRoot: string;
  sid: number;
  speed: number;
  play: PlayFn;
  engine?: KokoroEngineFactory;
  numThreads?: number;
  tmpRoot?: string;
}

export class KokoroSpeaker implements TtsProvider {
  readonly name = 'kokoro' as const;
  private engine: Promise<KokoroEngine> | null = null;
  constructor(private readonly o: KokoroOptions) {}

  /** Load the model now (≈1–2 s) instead of on the first reply. */
  warm(): Promise<KokoroEngine> {
    if (!this.engine) {
      const threads = this.o.numThreads ?? Math.max(1, Math.min(4, availableParallelism()));
      this.engine = (this.o.engine ?? sherpaKokoroEngine)(kokoroDir(this.o.modelsRoot), threads).catch((e: unknown) => {
        this.engine = null;
        throw new TtsFailure('kokoro', 'engine', `the local voice could not start: ${(e as Error).message}`, true);
      });
    }
    return this.engine;
  }

  speak(text: string): SpeakHandle {
    const state: { cancelled: boolean; player: PlayHandle | null } = { cancelled: false, player: null };
    const done = (async () => {
      if (!(await isKokoroInstalled(this.o.modelsRoot))) {
        throw new TtsFailure('kokoro', 'not-installed', 'the local voice is not installed (run `stephen voice-setup --tts kokoro`)', true);
      }
      const engine = await this.warm();
      if (state.cancelled) return;
      let samples: Float32Array;
      try {
        samples = await engine.generate(text, this.o.sid, this.o.speed, () => state.cancelled);
      } catch (e) {
        throw new TtsFailure('kokoro', 'engine', `the local voice failed: ${(e as Error).message}`);
      }
      if (state.cancelled) return;
      if (!samples.length) throw new TtsFailure('kokoro', 'engine', 'the local voice produced no audio');
      await playBuffer(encodeWav16(samples, engine.sampleRate), 'wav', 'kokoro', this.o.play, state, this.o.tmpRoot);
    })();
    return {
      done,
      cancel: () => {
        state.cancelled = true;
        state.player?.cancel();
      },
    };
  }
}
