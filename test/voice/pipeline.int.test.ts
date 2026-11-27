/**
 * Full pipeline on synthetic speech: WAV → sherpa-onnx KWS → Silero VAD → Whisper/Moonshine → fake claude → fake say.
 * Needs the pinned models (downloaded once into ~/.cache/stephen-voice-test/models); skipped with a reason if
 * they can't be downloaded. Fixtures: test/voice/fixtures/*.wav (Piper voices amy = en_US, alan = en_GB at 0.9×
 * speed; see generate.mjs).
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArrayAudioSource, type AudioSource } from '../../src/voice/audio.js';
import { buildClaudeArgs, buildWarmArgs } from '../../src/voice/claude.js';
import { createEngines, runListen, type Engines, type ListenEnv } from '../../src/voice/index.js';
import { parseVoiceConfig } from '../../src/voice/config.js';
import { modelPaths } from '../../src/voice/models.js';
import { concatSamples, silence } from '../../src/voice/wav.js';
import { FIXTURES, fakeClaudePath, fakeWarmProcesses, fixture, isAlive, prepareAllModels, readFakeLog, readFakeTurns, RecordingChimes, RecordingSpeaker, waitFor } from './helpers.js';

const models = await prepareAllModels('whisper-tiny.en');
const tmp = mkdtempSync(join(tmpdir(), 'stephen-pipeline-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const EXPECTED: Record<string, string | null> = {
  'wake-onebreath': 'open youtube',
  'wake-pause': 'open youtube',
  'wake-screen': "what's on my screen",
  'neg-steve': null,
  'neg-stephanie': null,
  'neg-even': null,
  'neg-step': null,
  'neg-weather': null,
  stop: null, // "Stephen, stop." alone: the stop phrase must not start anything
  'ptt-open': null, // "Open YouTube." without the wake word (the push-to-talk clip) never starts a command
};

/** Source that pauses before frame `at` until `until()` holds (to line audio up with the running command). */
class GatedSource implements AudioSource {
  readonly label = 'gated';
  private readonly inner: ArrayAudioSource;
  private frame = 0;
  constructor(samples: Float32Array, private readonly at: number, private readonly until: () => Promise<void>) {
    this.inner = new ArrayAudioSource(samples);
  }
  start() {
    return this.inner.start();
  }
  async read() {
    if (this.frame++ === this.at) await this.until();
    return this.inner.read();
  }
  stop() {
    return this.inner.stop();
  }
}

describe.skipIf(!models.ok)('voice pipeline (real models, fake claude)', () => {
  const root = models.ok ? models.root : '';
  let engines: Engines;
  // One set of engines for every run: the spotter is restarted per run, the VAD reset per capture.
  const sharedEngines = async (): Promise<Engines> => engines;

  beforeAll(async () => {
    const cfg = parseVoiceConfig({});
    engines = await createEngines(modelPaths(root, 'whisper-tiny.en'), cfg, tmp);
  }, 120_000);

  function harness(name: string, extraEnv: Record<string, string> = {}, voice: Record<string, unknown> = {}) {
    const log = join(tmp, `${name}.log`);
    const home = join(tmp, 'homes', name); // one home per test: follow-ups never cross tests
    const speaker = new RecordingSpeaker();
    const chimes = new RecordingChimes();
    const out: string[] = [];
    const transcripts: { raw: string; command: string; ms: number; at: number }[] = [];
    const env: ListenEnv = {
      // One claude -p per command here (voice.warm false); the warm runner has its own tests at the end.
      loadConfig: () => ({ home, voice: { claudePath: fakeClaudePath(), warm: false, ...voice } }),
      modelsRoot: root,
      engines: sharedEngines,
      speaker,
      chimes,
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      env: { ...process.env, FAKE_CLAUDE_LOG: log, ...extraEnv },
      onTranscript: (raw, command, ms) => transcripts.push({ raw, command, ms, at: Date.now() }),
      killGraceMs: 500,
      helper: () => null, // no Stephen Helper: the wake-word cooldown applies (see ptt.int.test.ts for the helper)
    };
    return { env, log, home, speaker, chimes, out, transcripts };
  }

  // The phase-1 clips (wake-variants.int.test.ts covers the newer ones with the default model).
  const clips = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.wav') && f.split('.')[0]! in EXPECTED)
    .sort();
  const report: string[] = [];
  afterAll(() => process.stderr.write(`\n[voice pipeline results]\n${report.join('\n')}\n`));

  it.each(clips)('%s', async (file) => {
    const key = file.split('.')[0]!;
    const want = EXPECTED[key];
    expect(want, `no expectation for ${key}`).not.toBeUndefined();
    const h = harness(file);
    engines.spotter.restart();
    const code = await runListen(['--wav', join(FIXTURES, file)], h.env);
    expect(code).toBe(0);
    const runs = readFakeLog(h.log);
    const wakes = h.out.filter((l) => l.startsWith('Wake word heard')).length;
    const tr = h.transcripts[0];
    report.push(`${file.padEnd(26)} wakes=${wakes} claude=${runs.length} transcript=${JSON.stringify(tr?.raw ?? null)} asr=${tr?.ms ?? '-'}ms`);
    if (want === null) {
      expect(runs, `${file} must never reach claude`).toEqual([]);
      expect(h.speaker.said).toEqual([]);
      return;
    }
    expect(wakes).toBe(1);
    expect(tr!.command).toBe(want);
    expect(runs).toHaveLength(1);
    const mcpPath = join(h.home, 'voice', 'mcp-config.json');
    expect(runs[0]!.argv).toEqual(buildClaudeArgs(want!, { claudePath: 'x', maxTurns: 25, model: 'sonnet', mcpConfigPath: mcpPath, followUps: true }));
    expect(h.speaker.said).toEqual([`Done! I opened YouTube for "${want}".`]);
    expect(h.chimes.played).toEqual(['wake', 'done']);
    expect(h.out).toContain(`Heard: "${want}"`);
  });

  it('noisy copies (white noise, SNR 10 dB): no false command, the commands still get through', async () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    let falseWakes = 0;
    let falseCommands = 0;
    let hits = 0;
    let positives = 0;
    for (const file of clips) {
      const clean = fixture(file);
      let e = 0;
      let n = 0;
      for (const v of clean) if (Math.abs(v) > 0.01) (e += v * v), n++;
      const amp = (Math.sqrt(e / Math.max(1, n)) / 10 ** (10 / 20)) * Math.sqrt(3); // uniform noise with the target RMS
      const noisy = clean.map((v) => v + rnd() * amp);
      const h = harness(`noisy-${file}`);
      engines.spotter.restart();
      await runListen([], { ...h.env, source: new ArrayAudioSource(noisy) });
      const want = EXPECTED[file.split('.')[0]!];
      const runs = readFakeLog(h.log);
      const wakes = h.out.filter((l) => l.startsWith('Wake word heard')).length;
      report.push(`noisy ${file.padEnd(20)} wakes=${wakes} claude=${JSON.stringify(runs.map((r) => r.argv[1]))} transcript=${JSON.stringify(h.transcripts[0]?.raw ?? null)}`);
      if (want === null) {
        falseWakes += wakes;
        falseCommands += runs.length;
      } else {
        positives++;
        if (runs.length === 1 && runs[0]!.argv[1] === want) hits++;
      }
    }
    report.push(`noisy summary: commands ${hits}/${positives}, false wakes ${falseWakes}, false commands ${falseCommands}`);
    expect(falseCommands).toBe(0);
    expect(hits).toBeGreaterThanOrEqual(positives - 1);
  });

  // Two commands back to back: "open youtube", then (1 s after the reply) "what's on my screen" — the user's
  // follow-up, or a video Stephen just opened saying "Hey Stephen…". The listener can't tell them apart.
  const backToBack = (h: ReturnType<typeof harness>) => {
    const first = concatSamples([fixture('wake-onebreath.amy.wav'), silence(1)]);
    const audio = concatSamples([first, fixture('wake-screen.alan.wav'), silence(1)]);
    // File audio arrives faster than real time: hold the second command until the first one is done.
    return new GatedSource(audio, Math.ceil(first.length / 512), () => waitFor(() => h.out.some((l) => l.startsWith('Done (')), 20_000, 'first command'));
  };

  it('default cooldown: a wake word right after the reply is ignored (no second claude run)', async () => {
    const h = harness('cooldown');
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: backToBack(h) })).toBe(0);
    const runs = readFakeLog(h.log);
    expect(runs.map((r) => r.argv[1])).toEqual(['open youtube']);
    expect(h.out.some((l) => l.startsWith('Ignored "hey stephen" — the wake word is paused'))).toBe(true);
  });

  it('followUpWindowSec 0 (cooldownSec 0): the next command is a FRESH session (never --resume)', async () => {
    const h = harness('fresh', {}, { cooldownSec: 0, followUpWindowSec: 0 });
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: backToBack(h) })).toBe(0);
    const runs = readFakeLog(h.log);
    expect(runs.map((r) => r.argv[1])).toEqual(['open youtube', "what's on my screen"]);
    for (const r of runs) {
      expect(r.argv).not.toContain('--resume');
      expect(r.argv).toContain('--no-session-persistence');
    }
  });

  it('default follow-up window (cooldownSec 0): the next command resumes the first one\'s session', async () => {
    const h = harness('followup', {}, { cooldownSec: 0 });
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: backToBack(h) })).toBe(0);
    const runs = readFakeLog(h.log);
    expect(runs.map((r) => r.argv[1])).toEqual(['open youtube', "what's on my screen"]);
    expect(runs[0]!.argv).not.toContain('--resume');
    expect(runs[1]!.argv.slice(runs[1]!.argv.indexOf('--resume'), runs[1]!.argv.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-1']);
    for (const r of runs) expect(r.argv).not.toContain('--no-session-persistence');
    expect(h.out).toContain('Working… (follow-up)');
  });

  it('"Stephen stop" during a long-running command kills claude and its child process group', async () => {
    const pids = join(tmp, 'stop.pids');
    const h = harness('stop-long', { FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDS: pids });
    engines.spotter.restart();
    const cmd = fixture('wake-onebreath.amy.wav');
    const audio = concatSamples([cmd, silence(0.5), fixture('stop.alan.wav'), silence(0.5)]);
    let started: { claude: number; child: number } | null = null;
    const gate = Math.ceil((cmd.length + 0.5 * 16000) / 512); // first frame of the stop clip
    const source = new GatedSource(audio, gate, async () => {
      await waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('child'), 20_000, 'fake claude to start');
      started = JSON.parse(readFileSync(pids, 'utf8')) as { claude: number; child: number };
      expect(isAlive(started.claude)).toBe(true);
      expect(isAlive(started.child)).toBe(true);
    });
    expect(await runListen([], { ...h.env, source })).toBe(0);
    expect(started).not.toBeNull();
    expect(h.out).toContain('Stopping (stop phrase)…');
    expect(h.out).toContain('Cancelled.');
    await waitFor(() => !isAlive(started!.claude) && !isAlive(started!.child), 5000, 'process group to die');
    expect(h.speaker.said).toEqual([]);
    expect(readFakeLog(h.log)).toHaveLength(1);
  });

  it('"Hey Stephen" while claude runs cancels it and does not start a second command', async () => {
    const pids = join(tmp, 'barge.pids');
    const h = harness('barge', { FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDS: pids });
    engines.spotter.restart();
    const first = fixture('wake-onebreath.amy.wav');
    const audio = concatSamples([first, silence(0.5), fixture('wake-screen.alan.wav'), silence(0.5)]);
    const gate = Math.ceil((first.length + 0.5 * 16000) / 512);
    const source = new GatedSource(audio, gate, () => waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('child'), 20_000, 'fake claude'));
    expect(await runListen([], { ...h.env, source })).toBe(0);
    const { claude, child } = JSON.parse(readFileSync(pids, 'utf8')) as { claude: number; child: number };
    await waitFor(() => !isAlive(claude) && !isAlive(child), 5000, 'process group to die');
    expect(h.out).toContain('Stopping (wake word)…');
    expect(readFakeLog(h.log)).toHaveLength(1);
  });

  // ───────────── the warm runner (voice.warm, the default; docs/ADR-003) ─────────────

  it('warm: the wake word starts Claude before the transcript is ready, and the command goes to that process', async () => {
    const h = harness('warm', {}, { warm: true });
    engines.spotter.restart();
    expect(await runListen(['--wav', join(FIXTURES, 'wake-onebreath.amy.wav')], h.env)).toBe(0);
    const procs = fakeWarmProcesses(h.log);
    expect(procs).toHaveLength(2); // the start-up protocol check, then the pre-warmed process
    const mcpPath = join(h.home, 'voice', 'mcp-config.json');
    expect(procs[1]!.argv).toEqual(buildWarmArgs({ claudePath: 'x', maxTurns: 25, model: 'sonnet', mcpConfigPath: mcpPath, followUps: true }));
    // Spawned while the user was still talking / ASR ran: the listener's own lead (spawn to command start). The fake's
    // start time is not used, because on a loaded machine node can take longer to boot than ASR (#109).
    expect(Number(/spawned (\d+\.\d) s ahead/.exec(h.out.join('\n'))?.[1])).toBeGreaterThan(0);
    expect(readFakeTurns(h.log).map((t) => [t.pid, t.prompt])).toEqual([[procs[1]!.pid, 'open youtube']]);
    expect(h.speaker.said).toEqual(['Done! open youtube']);
    expect(h.out.some((l) => /^claude: \d+\.\d s \(warm, spawned \d+\.\d s ahead; start-up \+ MCP /.test(l))).toBe(true);
    expect(isAlive(procs[1]!.pid)).toBe(false); // listener exit ended the conversation
    expect(existsSync(join(h.home, 'voice', 'conversation.json'))).toBe(false);
  });

  it('warm: if the stream protocol check fails at start, a note, then one claude -p per command (as before)', async () => {
    const h = harness('warm-fallback', { FAKE_CLAUDE_MODE: 'init-error' }, { warm: true });
    engines.spotter.restart();
    expect(await runListen(['--wav', join(FIXTURES, 'wake-onebreath.amy.wav')], h.env)).toBe(0);
    expect(h.out.some((l) => l.startsWith("ERR Note: Claude Code's stream mode didn't answer (Claude Code refused a request from Stephen."))).toBe(true);
    expect(fakeWarmProcesses(h.log)).toHaveLength(1); // only the check
    const oneShot = readFakeLog(h.log).filter((r) => !r.argv.includes('--input-format'));
    expect(oneShot.map((r) => r.argv[1])).toEqual(['open youtube']);
    expect(h.speaker.said).toEqual(['Done! I opened YouTube for "open youtube".']);
  });

  it('voice.warm false: no stream process at all', async () => {
    const h = harness('warm-off', {}, { warm: false });
    engines.spotter.restart();
    expect(await runListen(['--wav', join(FIXTURES, 'wake-onebreath.amy.wav')], h.env)).toBe(0);
    expect(fakeWarmProcesses(h.log)).toEqual([]);
    expect(readFakeLog(h.log)).toHaveLength(1);
  });

  it('warm: a follow-up right after the reply goes to the SAME process', async () => {
    const h = harness('warm-followup', {}, { warm: true, cooldownSec: 0 });
    engines.spotter.restart();
    expect(await runListen([], { ...h.env, source: backToBack(h) })).toBe(0);
    const turns = readFakeTurns(h.log);
    expect(turns.map((t) => t.prompt)).toEqual(['open youtube', "what's on my screen"]);
    expect(turns[1]!.pid).toBe(turns[0]!.pid);
    expect(h.out).toContain('Working… (follow-up)');
    expect(h.out.some((l) => /\(warm, follow-up 2 on this process; /.test(l))).toBe(true);
    expect(fakeWarmProcesses(h.log)).toHaveLength(2); // the check + one process for both commands
  });

  it('warm: "Stephen stop" during a long command kills the warm process group', async () => {
    const pids = join(tmp, 'warm-stop.pids');
    const h = harness('warm-stop', { FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_PIDS: pids }, { warm: true });
    engines.spotter.restart();
    const cmd = fixture('wake-onebreath.amy.wav');
    const audio = concatSamples([cmd, silence(0.5), fixture('stop.alan.wav'), silence(0.5)]);
    const gate = Math.ceil((cmd.length + 0.5 * 16000) / 512);
    const source = new GatedSource(audio, gate, () => waitFor(() => readFakeTurns(h.log).length === 1, 20_000, 'the command to reach claude'));
    expect(await runListen([], { ...h.env, source })).toBe(0);
    const { claude, child } = JSON.parse(readFileSync(pids, 'utf8')) as { claude: number; child: number };
    expect(claude).toBe(readFakeTurns(h.log)[0]!.pid);
    await waitFor(() => !isAlive(claude) && !isAlive(child), 5000, 'process group to die');
    expect(h.out).toContain('Stopping (stop phrase)…');
    expect(h.out).toContain('Cancelled.');
    expect(h.speaker.said).toEqual([]);
  });
});
