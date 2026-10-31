import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_ASR_MODEL } from '../../src/voice/config.js';
import {
  ASR_ARCHIVES,
  ensureModels,
  isInstalled,
  KWS_MODEL,
  modelPaths,
  requiredArchives,
  resolveAsrModel,
  VAD_MODEL,
  type Downloader,
  type ModelArchive,
} from '../../src/voice/models.js';
import { fakeInstall } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-models-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** A tiny real .tar.bz2 with `dir/` containing a.onnx, b.txt and junk. */
function makeArchive(): { file: string; hash: string } {
  const src = mkdtempSync(join(tmp, 'src-'));
  mkdirSync(join(src, 'tiny-model', 'test_wavs'), { recursive: true });
  writeFileSync(join(src, 'tiny-model', 'a.onnx'), 'model');
  writeFileSync(join(src, 'tiny-model', 'b.txt'), 'tokens');
  writeFileSync(join(src, 'tiny-model', 'test_wavs', 'junk.wav'), 'junk');
  const file = join(tmp, `tiny-${Date.now()}.tar.bz2`);
  execFileSync('tar', ['-cjf', file, '-C', src, 'tiny-model']);
  return { file, hash: sha(file) };
}

function fakeDownloader(files: Record<string, string>, calls: string[]): Downloader {
  return async (url, dest) => {
    calls.push(url);
    const f = files[url];
    if (!f) throw new Error(`404 ${url}`);
    copyFileSync(f, dest);
  };
}

describe('ensureModels', () => {
  it('downloads, verifies, extracts, keeps only needed files, and never re-downloads', async () => {
    const { file, hash } = makeArchive();
    const single = join(tmp, 'vad.onnx');
    writeFileSync(single, 'vad');
    const archive: ModelArchive = { id: 'tiny', url: 'https://example.test/tiny.tar.bz2', sha256: hash, bytes: 100, kind: 'tar.bz2', dir: 'tiny-model', keep: ['a.onnx', 'b.txt'], license: 'MIT' };
    const vad: ModelArchive = { id: 'vad', url: 'https://example.test/vad.onnx', sha256: sha(single), bytes: 3, kind: 'file', dir: 'vad', keep: ['vad.onnx'], license: 'MIT' };
    const root = join(tmp, 'models1');
    const calls: string[] = [];
    const dl = fakeDownloader({ [archive.url]: file, [vad.url]: single }, calls);
    const logs: string[] = [];

    expect(await ensureModels(root, [archive, vad], { download: dl, log: (l) => logs.push(l) })).toEqual(['tiny', 'vad']);
    expect(readdirSync(join(root, 'tiny-model')).sort()).toEqual(['.stephen-model.json', 'a.onnx', 'b.txt']);
    expect(readFileSync(join(root, 'vad', 'vad.onnx'), 'utf8')).toBe('vad');
    expect(await isInstalled(root, archive)).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith('.tmp'))).toEqual([]);
    expect(logs.some((l) => /Downloading tiny/.test(l))).toBe(true);

    // second run: nothing downloaded
    expect(await ensureModels(root, [archive, vad], { download: dl })).toEqual([]);
    expect(calls).toHaveLength(2);

    // a missing file re-installs just that archive
    rmSync(join(root, 'tiny-model', 'b.txt'));
    expect(await ensureModels(root, [archive, vad], { download: dl })).toEqual(['tiny']);
    expect(calls).toHaveLength(3);
  });

  it('refuses a download whose sha256 does not match, and leaves nothing behind', async () => {
    const { file } = makeArchive();
    const archive: ModelArchive = { id: 'tiny', url: 'https://example.test/t.tar.bz2', sha256: 'a'.repeat(64), bytes: 1, kind: 'tar.bz2', dir: 'tiny-model', keep: ['a.onnx'], license: 'MIT' };
    const root = join(tmp, 'models2');
    await expect(ensureModels(root, [archive], { download: fakeDownloader({ [archive.url]: file }, []) })).rejects.toThrow(/checksum mismatch/);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(root, 'tiny-model'))).toBe(false);
  });

  it('refuses an archive missing a needed file', async () => {
    const { file, hash } = makeArchive();
    const archive: ModelArchive = { id: 'tiny', url: 'https://example.test/t2.tar.bz2', sha256: hash, bytes: 1, kind: 'tar.bz2', dir: 'tiny-model', keep: ['a.onnx', 'missing.onnx'], license: 'MIT' };
    await expect(ensureModels(join(tmp, 'models3'), [archive], { download: fakeDownloader({ [archive.url]: file }, []) })).rejects.toThrow(/missing missing.onnx/);
  });

  it('pins every archive with a sha256 and an https github.com URL', () => {
    for (const m of [KWS_MODEL, VAD_MODEL, ...Object.values(ASR_ARCHIVES)]) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
    }
    expect(requiredArchives('whisper-tiny.en').map((m) => m.id)).toEqual(['kws-gigaspeech-3.3M', 'silero-vad', 'whisper-tiny.en']);
    const p = modelPaths('/m', 'whisper-tiny.en');
    expect(p.kws.encoder).toBe(`/m/${KWS_MODEL.dir}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`);
    expect(p.vad).toBe('/m/silero-vad/silero_vad.onnx');
    expect(Object.keys(p.asr.files)).toEqual(['tiny.en-encoder.int8.onnx', 'tiny.en-decoder.int8.onnx', 'tiny.en-tokens.txt']);
  });
});

describe('resolveAsrModel (which speech-to-text model `stephen listen` uses)', () => {
  it('the default is whisper-small.en, pinned like the others', () => {
    expect(DEFAULT_ASR_MODEL).toBe('whisper-small.en');
    expect(ASR_ARCHIVES[DEFAULT_ASR_MODEL].keep).toEqual(['small.en-encoder.int8.onnx', 'small.en-decoder.int8.onnx', 'small.en-tokens.txt']);
    expect(Object.keys(modelPaths('/m', 'parakeet-tdt-0.6b-v2').asr.files)).toEqual(['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
    expect(Object.keys(modelPaths('/m', 'moonshine-base-v2').asr.files)).toEqual(['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt', 'LICENSE']);
  });

  it('configured model always wins; unset → default if installed, else the old tiny model with a hint, else the default', async () => {
    const root = mkdtempSync(join(tmp, 'resolve-'));
    expect(await resolveAsrModel(root, 'whisper-base.en')).toEqual({ id: 'whisper-base.en', note: null });
    // fresh install: nothing there → the default (voice-setup / listen download it)
    expect(await resolveAsrModel(root, null)).toEqual({ id: DEFAULT_ASR_MODEL, note: null });
    // an existing user who only has whisper-tiny: keep working, tell them how to upgrade
    fakeInstall(root, ASR_ARCHIVES['whisper-tiny.en']);
    const r = await resolveAsrModel(root, null);
    expect(r.id).toBe('whisper-tiny.en');
    expect(r.note).toMatch(/run `stephen voice-setup` to get the better model \(whisper-small\.en, 636 MB/i);
    fakeInstall(root, ASR_ARCHIVES[DEFAULT_ASR_MODEL]);
    expect(await resolveAsrModel(root, null)).toEqual({ id: DEFAULT_ASR_MODEL, note: null });
    expect(await resolveAsrModel(root, 'whisper-tiny.en')).toEqual({ id: 'whisper-tiny.en', note: null });
  });
});
