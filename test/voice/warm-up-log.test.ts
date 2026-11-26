import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runListen, type ListenEnv } from '../../src/voice/index.js';
import { fakeClaudePath, RecordingChimes } from './helpers.js';

// A TTS voice whose warm-up always fails. speak() succeeds, so a failed warm-up must not stop the reply.
const warmCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/voice/tts/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/voice/tts/index.js')>();
  const createTts = (() => ({
    lastProvider: undefined,
    plan: async () => ({ providers: [] }),
    warm: () => {
      warmCalls.n++;
      return Promise.reject(new Error('warm-up exploded'));
    },
    speak: () => ({ done: Promise.resolve(), cancel: () => undefined }),
  })) as unknown as typeof real.createTts;
  return { ...real, createTts };
});

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-warm-log-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('voice warm-up failure', () => {
  it('logs one short line and the listen run still completes', async () => {
    const home = join(tmp, 'home');
    const out: string[] = [];
    const err: string[] = [];
    const e: ListenEnv = {
      loadConfig: () => ({ home, voice: { claudePath: fakeClaudePath(), speak: true } }),
      configPath: join(tmp, 'config.json'),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      chimes: new RecordingChimes(),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
    };
    expect(await runListen(['--text', 'open youtube'], e)).toBe(0);
    expect(warmCalls.n).toBe(1);
    expect(err.filter((l) => l.includes('warm up'))).toEqual(['Note: the voice could not warm up (warm-up exploded).']);
  });
});
