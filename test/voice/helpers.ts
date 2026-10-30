import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AsrModelId } from '../../src/voice/config.js';
import { ensureModels, KWS_MODEL, requiredArchives, type ModelArchive } from '../../src/voice/models.js';
import type { Chime, Chimes, Speaker } from '../../src/voice/speech.js';
import { decodeWav16k } from '../../src/voice/wav.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');

/** The fake `claude` executable (made executable here, in case git/checkout dropped the bit). */
export function fakeClaudePath(): string {
  const p = join(HERE, 'fake-claude.mjs');
  chmodSync(p, 0o755);
  return p;
}

export function fixture(name: string): Float32Array {
  return decodeWav16k(readFileSync(join(FIXTURES, name)));
}

export interface FakeRun {
  argv: string[];
  cwd: string;
  pid: number;
}

export function readFakeLog(path: string): FakeRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeRun);
}

/** A process is gone if signal 0 fails, or (Linux) it is a zombie nobody reaped yet. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return true;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export class RecordingSpeaker implements Speaker {
  readonly said: string[] = [];
  cancelled = 0;
  constructor(private readonly ms = 0) {}
  speak(text: string) {
    this.said.push(text);
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const t = setTimeout(finish, this.ms);
    return {
      done,
      cancel: () => {
        this.cancelled++;
        clearTimeout(t);
        finish();
      },
    };
  }
}

export class RecordingChimes implements Chimes {
  readonly played: Chime[] = [];
  play(c: Chime): void {
    this.played.push(c);
  }
}

/** Shared model cache for tests (outside the repo; reused across runs). */
export const TEST_MODELS_ROOT = process.env.STEPHEN_VOICE_TEST_MODELS ?? join(homedir(), '.cache', 'stephen-voice-test', 'models');

export type ModelsReady = { ok: true; root: string } | { ok: false; reason: string };

/**
 * Download (once) the models a test needs. Never throws: if github.com is unreachable the model-dependent
 * tests are skipped with the reason, so CI without network isn't flaky.
 */
export async function prepareModels(archives: readonly ModelArchive[]): Promise<ModelsReady> {
  if (process.env.STEPHEN_VOICE_SKIP_MODELS) return { ok: false, reason: 'STEPHEN_VOICE_SKIP_MODELS is set' };
  try {
    await ensureModels(TEST_MODELS_ROOT, archives, { log: (l) => process.stderr.write(`[voice test models] ${l}\n`) });
    return { ok: true, root: TEST_MODELS_ROOT };
  } catch (e) {
    const reason = `speech models unavailable (${(e as Error).message}) — skipping model-dependent voice tests`;
    process.stderr.write(`[voice test models] ${reason}\n`);
    return { ok: false, reason };
  }
}

export const prepareKwsModel = () => prepareModels([KWS_MODEL]);
export const prepareAllModels = (asr: AsrModelId = 'whisper-tiny.en') => prepareModels(requiredArchives(asr));
