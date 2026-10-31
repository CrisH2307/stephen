/**
 * Push-to-talk and the helper rules end to end: WAV → real Silero VAD + Whisper (+ the keyword spotter for the
 * wake-word cases) → fake claude → recording speaker, with a fake Stephen Helper supplying the key events.
 * Needs the pinned models (see pipeline.int.test.ts); skipped with a reason if they can't be downloaded.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PTT_MIN_HOLD_MS } from '../../src/helper/protocol.js';
import { ArrayAudioSource, FRAME, type AudioSource } from '../../src/voice/audio.js';
import { buildClaudeArgs } from '../../src/voice/claude.js';
import { parseVoiceConfig } from '../../src/voice/config.js';
import { HELPER_HINT } from '../../src/voice/helper-link.js';
import { createEngines, runListen, type Engines, type ListenEnv } from '../../src/voice/index.js';
import { modelPaths } from '../../src/voice/models.js';
import { concatSamples, silence } from '../../src/voice/wav.js';
import { FakeHelper } from './fakes.js';
import { fakeClaudePath, fixture, prepareAllModels, readFakeLog, RecordingChimes, RecordingSpeaker, waitFor } from './helpers.js';

const models = await prepareAllModels('whisper-tiny.en');
const tmp = mkdtempSync(join(tmpdir(), 'stephen-ptt-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MS_PER_FRAME = (FRAME / 16000) * 1000;

/** Runs `hooks[i]` before frame i is read (to press/release keys or wait for the command in flight). */
class HookedSource implements AudioSource {
  readonly label = 'hooked';
  private readonly inner: ArrayAudioSource;
  private frame = 0;
  constructor(
    samples: Float32Array,
    private readonly hooks: Map<number, () => Promise<void> | void>,
  ) {
    this.inner = new ArrayAudioSource(samples);
  }
  start() {
    return this.inner.start();
  }
  async read() {
    await this.hooks.get(this.frame++)?.();
    return this.inner.read();
  }
  stop() {
    return this.inner.stop();
  }
}

describe.skipIf(!models.ok)('push-to-talk pipeline (real models, fake helper, fake claude)', () => {
  const root = models.ok ? models.root : '';
  let engines: Engines;
  beforeAll(async () => {
    engines = await createEngines(modelPaths(root, 'whisper-tiny.en'), parseVoiceConfig({}), tmp);
  }, 120_000);

  function harness(name: string, opts: { voice?: Record<string, unknown>; extraEnv?: Record<string, string>; helper?: FakeHelper | null } = {}) {
    const log = join(tmp, `${name}.log`);
    const speaker = new RecordingSpeaker();
    const chimes = new RecordingChimes();
    const out: string[] = [];
    const transcripts: string[] = [];
    const helper = opts.helper === undefined ? new FakeHelper() : opts.helper;
    let helperCalls = 0;
    const env: ListenEnv = {
      loadConfig: () => ({ home: join(tmp, 'home'), voice: { claudePath: fakeClaudePath(), ...opts.voice } }),
      modelsRoot: root,
      engines: async () => engines,
      speaker,
      chimes,
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      env: { ...process.env, FAKE_CLAUDE_LOG: log, ...opts.extraEnv },
      onTranscript: (raw) => transcripts.push(raw),
      killGraceMs: 500,
      helper: () => {
        helperCalls++;
        return helper;
      },
    };
    return { env, log, speaker, chimes, out, transcripts, helper, helperCalls: () => helperCalls };
  }

  /** Hold the keys over a whole clip: down before its first frame, up after its last. */
  function pttSource(h: { helper: FakeHelper | null }, clip: Float32Array) {
    const audio = concatSamples([silence(0.3), clip, silence(1)]);
    const downAt = Math.floor((0.3 * 16000) / FRAME);
    const upAt = Math.ceil((0.3 * 16000 + clip.length) / FRAME);
    const hooks = new Map<number, () => void>([
      [downAt, () => h.helper!.emit({ type: 'ptt_down', at: Date.now() })],
      [upAt, () => h.helper!.emit({ type: 'ptt_up', at: Date.now(), heldMs: (upAt - downAt) * MS_PER_FRAME })],
    ]);
    return new HookedSource(audio, hooks);
  }

  it.each(['ptt-open.amy.wav', 'ptt-open.alan.wav'])('hold Fn+Option over "%s" → "open youtube" → claude argv', async (file) => {
    const h = harness(file);
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: pttSource(h, fixture(file)) })).toBe(0);
    expect(h.transcripts).toHaveLength(1);
    const runs = readFakeLog(h.log);
    const mcpPath = join(tmp, 'home', 'voice', 'mcp-config.json');
    expect(runs.map((r) => r.argv)).toEqual([buildClaudeArgs('open youtube', { claudePath: 'x', maxTurns: 15, model: 'sonnet', mcpConfigPath: mcpPath })]);
    expect(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.stephen.args).toEqual(['/opt/stephen/dist/cli.js', 'serve', '--confirm', 'dialog', '--voice']);
    expect(h.speaker.said).toEqual(['Done! I opened YouTube for "open youtube".']);
    expect(h.chimes.played).toEqual(['wake', 'done']);
    expect(h.helper!.states).toEqual(['listening', 'recording', 'working', 'speaking', 'listening', 'idle']);
    expect(h.helper!.closed).toBe(true);
    expect(h.out).not.toContain(HELPER_HINT);
  });

  it('a tap under the minimum hold transcribes nothing and starts nothing', async () => {
    const h = harness('tap');
    const audio = concatSamples([silence(0.3), fixture('ptt-open.amy.wav')]);
    const hooks = new Map<number, () => void>([
      [10, () => h.helper!.emit({ type: 'ptt_down', at: Date.now() })],
      [14, () => h.helper!.emit({ type: 'ptt_up', at: Date.now(), heldMs: PTT_MIN_HOLD_MS - 1 })],
    ]);
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: new HookedSource(audio, hooks) })).toBe(0);
    expect(h.transcripts).toEqual([]);
    expect(readFakeLog(h.log)).toEqual([]);
  });

  it('the reply stays quiet while the Mac is playing sound (done chime only, reply printed)', async () => {
    const helper = new FakeHelper();
    helper.playing = true;
    const h = harness('quiet', { helper, extraEnv: { FAKE_CLAUDE_REPLY: 'Playing lo-fi beats.' } });
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: pttSource(h, fixture('ptt-open.amy.wav')) })).toBe(0);
    expect(readFakeLog(h.log)).toHaveLength(1);
    expect(h.speaker.said).toEqual([]);
    expect(h.chimes.played).toEqual(['wake', 'done']);
    expect(h.out).toContain('Stephen: Playing lo-fi beats.');
  });

  // "open youtube", then (1 s after the reply) "Hey Stephen, what's on my screen?"
  const backToBack = (h: { out: string[] }) => {
    const first = concatSamples([fixture('wake-onebreath.amy.wav'), silence(1)]);
    const audio = concatSamples([first, fixture('wake-screen.alan.wav'), silence(1)]);
    const gate = Math.ceil(first.length / FRAME);
    return new HookedSource(audio, new Map([[gate, () => waitFor(() => h.out.some((l) => l.startsWith('Done (')), 20_000, 'first command')]]));
  };

  it('with the helper: no 20 s cooldown — the next "Hey Stephen" in silence is a new command', async () => {
    const h = harness('gating-silent');
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: backToBack(h) })).toBe(0);
    expect(readFakeLog(h.log).map((r) => r.argv[1])).toEqual(['open youtube', "what's on my screen"]);
  });

  it('with the helper: "Hey Stephen" is ignored while sound is playing', async () => {
    const helper = new FakeHelper();
    const h = harness('gating-playing', { helper });
    const first = concatSamples([fixture('wake-onebreath.amy.wav'), silence(1)]);
    const audio = concatSamples([first, fixture('wake-screen.alan.wav'), silence(1)]);
    const gate = Math.ceil(first.length / FRAME);
    const source = new HookedSource(
      audio,
      new Map([
        [
          gate,
          async () => {
            await waitFor(() => h.out.some((l) => l.startsWith('Done (')), 20_000, 'first command');
            helper.emit({ type: 'audio', playing: true, at: Date.now() }); // the video Claude opened is playing
          },
        ],
      ]),
    );
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source })).toBe(0);
    expect(readFakeLog(h.log).map((r) => r.argv[1])).toEqual(['open youtube']);
    expect(h.out.some((l) => l.startsWith('Ignored "hey stephen" — sound is playing'))).toBe(true);
  });

  it('without the helper: the 20 s cooldown remains, and the install hint is printed once', async () => {
    const h = harness('fallback', { helper: null });
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: backToBack(h) })).toBe(0);
    expect(readFakeLog(h.log).map((r) => r.argv[1])).toEqual(['open youtube']);
    expect(h.out.filter((l) => l === HELPER_HINT)).toHaveLength(1);
    expect(h.out.some((l) => l.startsWith('Ignored "hey stephen" — the wake word is paused'))).toBe(true);
  });

  it('--no-helper: never asks for the helper, no hint, cooldown applies', async () => {
    const h = harness('nohelper');
    engines.spotter.restart();
    expect(await runListen(['--no-helper'], { ...h.env, source: backToBack(h) })).toBe(0);
    expect(h.helperCalls()).toBe(0);
    expect(h.out).not.toContain(HELPER_HINT);
    expect(readFakeLog(h.log).map((r) => r.argv[1])).toEqual(['open youtube']);
  });

  it('voice.wakeWord false: "Hey Stephen, open YouTube" never starts a command', async () => {
    const h = harness('nowake', { voice: { wakeWord: false } });
    engines.spotter.restart();
    const audio = concatSamples([fixture('wake-onebreath.amy.wav'), fixture('wake-pause.alan.wav')]);
    expect(await runListen([], { ...h.env, source: new ArrayAudioSource(audio) })).toBe(0);
    expect(h.transcripts).toEqual([]);
    expect(readFakeLog(h.log)).toEqual([]);
    expect(h.out.some((l) => l.startsWith('Ready on '))).toBe(true);
  });
});
