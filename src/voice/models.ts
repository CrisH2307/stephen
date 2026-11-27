import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DEFAULT_ASR_MODEL, FALLBACK_ASR_MODEL, type AsrModelId } from './config.js';

/**
 * Pinned model archives from github.com/k2-fsa/sherpa-onnx/releases. The sha256 values were computed when
 * these were pinned (2026-10-30; whisper-small.en, parakeet-tdt-0.6b-v2 and moonshine-base-v2 on
 * 2026-10-31); a download that doesn't match is deleted and refused.
 */
export interface ModelArchive {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  /** 'file' = a single file saved as `<dir>/<basename>`; 'tar.bz2' = extracted, top folder must be `dir`. */
  kind: 'file' | 'tar.bz2';
  /** Folder name under <home>/models. */
  dir: string;
  /** Files (relative to `dir`) the listener needs; everything else in the archive is deleted after extraction. */
  keep: readonly string[];
  license: string;
}

const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const KWS_MODEL: ModelArchive = {
  id: 'kws-gigaspeech-3.3M',
  url: `${REL}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
  sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',
  bytes: 17_626_723,
  kind: 'tar.bz2',
  dir: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
  keep: [
    'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    'tokens.txt',
    'bpe.model',
  ],
  license: 'Apache-2.0',
};

export const VAD_MODEL: ModelArchive = {
  id: 'silero-vad',
  url: `${REL}/asr-models/silero_vad.onnx`,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  bytes: 643_854,
  kind: 'file',
  dir: 'silero-vad',
  keep: ['silero_vad.onnx'],
  license: 'MIT',
};

export const ASR_ARCHIVES: Record<AsrModelId, ModelArchive> = {
  'parakeet-tdt-0.6b-v2': {
    id: 'parakeet-tdt-0.6b-v2',
    url: `${REL}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    bytes: 482_468_385,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    keep: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    license: 'CC-BY-4.0',
  },
  'whisper-tiny.en': {
    id: 'whisper-tiny.en',
    url: `${REL}/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2`,
    sha256: '2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd',
    bytes: 118_071_777,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-whisper-tiny.en',
    keep: ['tiny.en-encoder.int8.onnx', 'tiny.en-decoder.int8.onnx', 'tiny.en-tokens.txt'],
    license: 'MIT',
  },
  'whisper-base.en': {
    id: 'whisper-base.en',
    url: `${REL}/asr-models/sherpa-onnx-whisper-base.en.tar.bz2`,
    sha256: '475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542',
    bytes: 208_576_005,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-whisper-base.en',
    keep: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'],
    license: 'MIT',
  },
  'whisper-small.en': {
    id: 'whisper-small.en',
    url: `${REL}/asr-models/sherpa-onnx-whisper-small.en.tar.bz2`,
    sha256: '0cdba2b8aaab69e04847f3427cc9709574112e67913a1a84b7fec3a8729faa9a',
    bytes: 635_693_775,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-whisper-small.en',
    keep: ['small.en-encoder.int8.onnx', 'small.en-decoder.int8.onnx', 'small.en-tokens.txt'],
    license: 'MIT',
  },
  'moonshine-tiny': {
    id: 'moonshine-tiny',
    url: `${REL}/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2`,
    sha256: 'd5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2',
    bytes: 107_600_538,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-moonshine-tiny-en-int8',
    keep: ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt', 'LICENSE'],
    license: 'MIT',
  },
  'moonshine-base': {
    id: 'moonshine-base',
    url: `${REL}/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2`,
    sha256: '21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e',
    bytes: 250_807_309,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-moonshine-base-en-int8',
    keep: ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt', 'LICENSE'],
    license: 'MIT',
  },
  'moonshine-base-v2': {
    id: 'moonshine-base-v2',
    url: `${REL}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    sha256: '43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891',
    bytes: 111_266_225,
    kind: 'tar.bz2',
    dir: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27',
    keep: ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt', 'LICENSE'],
    license: 'MIT',
  },
};

/**
 * Which speech-to-text model `stephen listen` uses. A configured `voice.asrModel` always wins (and is downloaded
 * if missing). Unset means DEFAULT_ASR_MODEL — but an existing user who only has the old default (whisper-tiny.en)
 * keeps using it, with a hint to run `stephen voice-setup`, instead of a surprise 636 MB download at start-up.
 */
export async function resolveAsrModel(root: string, configured: AsrModelId | null): Promise<{ id: AsrModelId; note: string | null }> {
  if (configured) return { id: configured, note: null };
  if (await isInstalled(root, ASR_ARCHIVES[DEFAULT_ASR_MODEL])) return { id: DEFAULT_ASR_MODEL, note: null };
  if (await isInstalled(root, ASR_ARCHIVES[FALLBACK_ASR_MODEL])) {
    const mb = Math.round(ASR_ARCHIVES[DEFAULT_ASR_MODEL].bytes / 1e6);
    return {
      id: FALLBACK_ASR_MODEL,
      note:
        `Speech-to-text: using ${FALLBACK_ASR_MODEL}. Run \`stephen voice-setup\` to get the better model ` +
        `(${DEFAULT_ASR_MODEL}, ${mb} MB download: far fewer misheard names), then restart \`stephen listen\`.`,
    };
  }
  return { id: DEFAULT_ASR_MODEL, note: null };
}

/** The archives `stephen listen` needs for a given ASR model. */
export function requiredArchives(asr: AsrModelId): ModelArchive[] {
  return [KWS_MODEL, VAD_MODEL, ASR_ARCHIVES[asr]];
}

export function modelsDir(home: string): string {
  return join(home, 'models');
}

const MARKER = '.stephen-model.json';

/** True if the archive was already installed (marker with the pinned hash + every needed file present). */
export async function isInstalled(root: string, m: ModelArchive): Promise<boolean> {
  const dir = join(root, m.dir);
  try {
    const marker = JSON.parse(await readFile(join(dir, MARKER), 'utf8')) as { sha256?: string };
    if (marker.sha256 !== m.sha256) return false;
  } catch {
    return false;
  }
  return m.keep.every((f) => existsSync(join(dir, f)));
}

export type Downloader = (url: string, dest: string) => Promise<void>;
export type Extractor = (archive: string, intoDir: string) => Promise<void>;

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} not found` : String(stderr || err.message).trim().split('\n').slice(-1)[0];
        reject(new Error(`${cmd} failed: ${why}`));
      } else resolve();
    });
  });
}

/**
 * Download with curl (ships with macOS; honours the user's proxy settings; https only, also on redirects).
 * Falls back to fetch() when curl is missing.
 */
export const curlDownloader: Downloader = async (url, dest) => {
  try {
    await execFileP(
      'curl',
      ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '20', '--output', dest, '--', url],
      30 * 60_000,
    );
  } catch (e) {
    if (!/curl not found/.test((e as Error).message)) throw e;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
};

/** Extract a .tar.bz2 with the system tar (argv, no shell). */
export const tarExtractor: Extractor = (archive, intoDir) => execFileP('tar', ['-xjf', archive, '-C', intoDir], 10 * 60_000);

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

/** Remove empty sub-folders (left after pruning unneeded files). */
async function pruneEmptyDirs(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    await pruneEmptyDirs(p);
    if ((await readdir(p)).length === 0) await rm(p, { recursive: true, force: true });
  }
}

/** F9b: progress as code words and numbers only (the setup sheet shows its own text for each). */
export type ModelEvent =
  | { event: 'downloading'; index: number; total: number; mb: number }
  | { event: 'extracting'; index: number; total: number }
  | { event: 'installed'; index: number; total: number };

export interface EnsureOptions {
  download?: Downloader;
  extract?: Extractor;
  log?: (line: string) => void;
  onEvent?: (e: ModelEvent) => void;
}

/** Download `m.url` to `file` and check its sha256 (throws on a mismatch; the caller deletes its temp folder). */
export async function downloadVerified(m: ModelArchive, file: string, download: Downloader): Promise<void> {
  await download(m.url, file);
  const got = await sha256File(file);
  if (got !== m.sha256) throw new Error(`${m.id}: checksum mismatch (expected ${m.sha256}, got ${got}). The download was deleted.`);
}

/** Write the install marker into the staged folder, then move it into place at `dest` (replacing an old copy). */
export async function installStaged(m: ModelArchive, staged: string, dest: string): Promise<void> {
  await writeFile(join(staged, MARKER), JSON.stringify({ id: m.id, url: m.url, sha256: m.sha256, installedAt: new Date().toISOString() }, null, 2) + '\n');
  await rm(dest, { recursive: true, force: true });
  await rename(staged, dest);
}

/**
 * Make sure each archive is installed under `root`: download → verify sha256 → extract into a temp folder
 * → keep only the needed files → move into place → write the marker. Already-installed archives are never
 * downloaded again. Returns the ids that were installed now.
 */
export async function ensureModels(root: string, archives: readonly ModelArchive[], opts: EnsureOptions = {}): Promise<string[]> {
  const download = opts.download ?? curlDownloader;
  const extract = opts.extract ?? tarExtractor;
  const log = opts.log ?? (() => {});
  const ev = opts.onEvent ?? (() => {});
  await mkdir(root, { recursive: true, mode: 0o700 });
  const installed: string[] = [];
  const todo: ModelArchive[] = [];
  for (const m of archives) if (!(await isInstalled(root, m))) todo.push(m);
  for (const [i, m] of todo.entries()) {
    const step = { index: i + 1, total: todo.length };
    const mb = (m.bytes / 1e6).toFixed(m.bytes < 1e6 ? 1 : 0);
    log(`Downloading ${m.id} (${mb} MB) from ${new URL(m.url).host}…`);
    ev({ event: 'downloading', ...step, mb: Math.max(1, Math.round(m.bytes / 1e6)) });
    const work = await mkdtemp(join(root, `.tmp-${m.id}-`));
    try {
      const file = join(work, m.kind === 'file' ? m.keep[0]! : 'archive.tar.bz2');
      await downloadVerified(m, file, download);
      const staged = join(work, 'staged');
      if (m.kind === 'file') {
        await mkdir(staged);
        await rename(file, join(staged, m.keep[0]!));
      } else {
        const unpack = join(work, 'unpack');
        await mkdir(unpack);
        log(`Extracting ${m.id}…`);
        ev({ event: 'extracting', ...step });
        await extract(file, unpack);
        await rm(file, { force: true });
        const top = join(unpack, m.dir);
        if (!existsSync(top) || !(await stat(top)).isDirectory()) throw new Error(`${m.id}: archive has no ${m.dir}/ folder`);
        const keep = new Set(m.keep);
        for (const f of await listFiles(top)) {
          const rel = relative(top, f).split(sep).join('/');
          if (!keep.has(rel)) await rm(f, { force: true });
        }
        await pruneEmptyDirs(top);
        for (const k of m.keep) if (!existsSync(join(top, k))) throw new Error(`${m.id}: archive is missing ${k}`);
        await rename(top, staged);
      }
      await installStaged(m, staged, join(root, m.dir));
      installed.push(m.id);
      log(`Installed ${m.id}.`);
      ev({ event: 'installed', ...step });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return installed;
}

// ───────────────────────────── paths for the engines ─────────────────────────────

export interface ModelPaths {
  kws: { encoder: string; decoder: string; joiner: string; tokens: string; bpeModel: string };
  vad: string;
  asr: { id: AsrModelId; files: Record<string, string> };
}

export function modelPaths(root: string, asr: AsrModelId): ModelPaths {
  const k = join(root, KWS_MODEL.dir);
  const a = ASR_ARCHIVES[asr];
  const files: Record<string, string> = {};
  for (const f of a.keep) files[f] = join(root, a.dir, f);
  return {
    kws: {
      encoder: join(k, KWS_MODEL.keep[0]!),
      decoder: join(k, KWS_MODEL.keep[1]!),
      joiner: join(k, KWS_MODEL.keep[2]!),
      tokens: join(k, 'tokens.txt'),
      bpeModel: join(k, 'bpe.model'),
    },
    vad: join(root, VAD_MODEL.dir, 'silero_vad.onnx'),
    asr: { id: asr, files },
  };
}
