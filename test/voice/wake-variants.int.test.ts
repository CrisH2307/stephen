/**
 * Phase 1.6: the default speech-to-text model (whisper-small.en) with every wake variant ("hey / yo / ok Stephen",
 * bare "Stephen"), the owner's song request, and the negatives. WAV → KWS → VAD → ASR → fake claude.
 * Needs the pinned models (downloaded once into the test cache); skipped with a reason if they can't be downloaded.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ASR_MODEL, parseVoiceConfig } from '../../src/voice/config.js';
import { createEngines, runListen, type Engines, type ListenEnv } from '../../src/voice/index.js';
import { modelPaths } from '../../src/voice/models.js';
import { FIXTURES, fakeClaudePath, fakePrompts, prepareAllModels, RecordingChimes, RecordingSpeaker } from './helpers.js';

const models = await prepareAllModels(DEFAULT_ASR_MODEL);
const tmp = mkdtempSync(join(tmpdir(), 'stephen-variants-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The command Claude must get (a pattern for names the recognizer may spell either way), or null = nothing. */
const EXPECTED: Record<string, string | RegExp | null> = {
  'wake-onebreath': 'open youtube',
  'wake-pause': 'open youtube',
  'wake-screen': "what's on my screen",
  'wake-yo': 'open spotify',
  // The en_GB "alan" voice (low quality, slowed down) says "lo-fi" so that whisper-small hears "low-fide".
  'wake-ok': /^search youtube for (lo ?fi|low fide) beats$/,
  'wake-bare': 'open youtube',
  // …and its non-rhotic "call" comes out as "core". The name is right with both voices (tiny gave "charlie pool").
  'wake-song': /^can you play one (call|core) away by charlie puth$/,
  'neg-steve': null,
  'neg-steve-mid': null,
  'neg-stephanie': null,
  'neg-even': null, // "Even Stephen agreed…": a bare "Stephen" inside a sentence
  'neg-step': null,
  'neg-weather': null,
  stop: null, // "Stephen, stop.": the bare wake word starts it, the stop phrase ends it
  'ptt-open': null,
};

describe.skipIf(!models.ok)(`wake variants with ${DEFAULT_ASR_MODEL} (real models, fake claude)`, () => {
  const root = models.ok ? models.root : '';
  let engines: Engines;
  beforeAll(async () => {
    engines = await createEngines(modelPaths(root, DEFAULT_ASR_MODEL), parseVoiceConfig({}), tmp);
  }, 120_000);

  const report: string[] = [];
  afterAll(() => process.stderr.write(`\n[wake variants, ${DEFAULT_ASR_MODEL}]\n${report.join('\n')}\n`));
  const clips = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.wav'))
    .sort();

  it.each(clips)('%s', async (file) => {
    const key = file.split('.')[0]!;
    const want = EXPECTED[key];
    expect(want, `no expectation for ${key}`).not.toBeUndefined();
    const log = join(tmp, `${file}.log`);
    const out: string[] = [];
    const transcripts: string[] = [];
    const env: ListenEnv = {
      loadConfig: () => ({ home: join(tmp, 'home'), voice: { claudePath: fakeClaudePath() } }),
      modelsRoot: root,
      engines: async () => engines,
      speaker: new RecordingSpeaker(),
      chimes: new RecordingChimes(),
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      env: { ...process.env, FAKE_CLAUDE_LOG: log },
      onTranscript: (raw) => transcripts.push(raw),
      killGraceMs: 500,
      helper: () => null,
    };
    engines.spotter.restart();
    expect(await runListen(['--wav', join(FIXTURES, file)], env)).toBe(0);
    expect(out.some((l) => /voice-setup/.test(l))).toBe(false); // the default model is installed: no hint
    const sent = fakePrompts(log); // the default warm runner: commands go to the pre-warmed process
    report.push(`${file.padEnd(26)} claude=${JSON.stringify(sent)} transcript=${JSON.stringify(transcripts[0] ?? null)}`);
    if (want === null) {
      expect(sent, `${file} must never reach claude`).toEqual([]);
      return;
    }
    expect(sent).toHaveLength(1);
    if (typeof want === 'string') expect(sent[0]).toBe(want);
    else expect(sent[0]).toMatch(want!);
  });
});
