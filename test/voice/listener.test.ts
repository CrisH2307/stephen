import { describe, expect, it } from 'vitest';
import { Assistant } from '../../src/voice/assistant.js';
import type { KeywordHit } from '../../src/voice/engine.js';
import { BARE_PREROLL_EXTRA_SEC, Listener, type ListenerOptions } from '../../src/voice/listener.js';
import { FakeRunner, FakeTranscriber, FakeVad, FRAME, ScriptedSource, ScriptedSpotter, frames } from './fakes.js';
import { RecordingChimes, RecordingSpeaker, waitFor } from './helpers.js';

const OPTS: ListenerOptions = { wakePhrase: 'hey stephen', silenceSec: 0.8, maxCommandSec: 12, noSpeechTimeoutSec: 5, verifyWake: true, once: false };

function setup(opts: {
  pattern: string;
  hits: Record<number, KeywordHit['id'] | 'WAKE_BARE'>;
  texts: string[];
  runner?: FakeRunner;
  speakMs?: number;
  gates?: Map<number, () => Promise<void>>;
  o?: Partial<ListenerOptions>;
  names?: string[];
}) {
  const runner = opts.runner ?? new FakeRunner();
  const speaker = new RecordingSpeaker(opts.speakMs ?? 0);
  const chimes = new RecordingChimes();
  const lines: string[] = [];
  const status = (l: string) => lines.push(l);
  const assistant = new Assistant({ runner, speaker, chimes, speak: true, status });
  const transcriber = new FakeTranscriber(opts.texts);
  const spotter = new ScriptedSpotter(opts.hits);
  const listener = new Listener({ ...OPTS, ...opts.o }, { source: new ScriptedSource(frames(opts.pattern), opts.gates), spotter, vad: new FakeVad(), transcriber, assistant, chimes, status, ...(opts.names ? { names: () => opts.names! } : {}) });
  return { listener, runner, speaker, chimes, lines, transcriber, spotter, assistant };
}

describe('Listener: wake variants (phase 1.6)', () => {
  const ALL = { wakePhrases: ['hey stephen', 'yo stephen', 'ok stephen', 'stephen'], stopPhrase: 'stephen stop' };
  const PAT = '.'.repeat(60) + 's'.repeat(30) + '.'.repeat(40);

  it.each([
    ['Yo Stephen, open Spotify.', 'open spotify'],
    ['OK Stephen, search YouTube for lofi beats.', 'search youtube for lofi beats'],
    ['hi steve can you play one call away by charlie puth', 'can you play one call away by charlie puth'],
  ])('accepts every variant: %j', async (text, want) => {
    const t = setup({ pattern: PAT, hits: { 65: 'WAKE' }, texts: [text], o: ALL });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([want]);
  });

  it('a bare "Stephen" must open the transcript and be the name itself', async () => {
    for (const text of ['Even Stephen agreed to open YouTube.', 'Stefan and Stella are coming over tonight.', 'Stephanie said open YouTube.']) {
      const t = setup({ pattern: PAT, hits: { 65: 'WAKE_BARE' }, texts: [text], o: ALL });
      await t.listener.run();
      expect(t.runner.prompts, text).toEqual([]);
      expect(t.lines.some((l) => l.startsWith('Ignored — "hey stephen" wasn\'t in the transcript')), text).toBe(true);
    }
    const ok = setup({ pattern: PAT, hits: { 65: 'WAKE_BARE' }, texts: ['Steven, open YouTube.'], o: ALL });
    await ok.listener.run();
    expect(ok.runner.prompts).toEqual(['open youtube']);
  });

  it('a bare wake keeps more audio from before it (so a word said just before reaches the check)', async () => {
    const greet = setup({ pattern: PAT, hits: { 65: 'WAKE' }, texts: ['Hey Stephen, open YouTube.'], o: ALL });
    const bare = setup({ pattern: PAT, hits: { 65: 'WAKE_BARE' }, texts: ['Stephen, open YouTube.'], o: ALL });
    await greet.listener.run();
    await bare.listener.run();
    const extra = bare.transcriber.heard[0]!.length - greet.transcriber.heard[0]!.length;
    expect(extra).toBeGreaterThanOrEqual(Math.floor((BARE_PREROLL_EXTRA_SEC * 16000) / FRAME) * FRAME);
  });

  it('"Stephen, stop" whose STOP was missed is never sent as a command', async () => {
    const t = setup({ pattern: PAT, hits: { 65: 'WAKE_BARE' }, texts: ['Steven, stop.'], o: ALL });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines).toContain('Heard "stephen stop" — nothing to stop.');
  });

  it('a bare wake then STOP (the spotter\'s second look) cancels the capture', async () => {
    const t = setup({ pattern: PAT, hits: { 65: 'WAKE_BARE', 80: 'STOP' }, texts: ['unused'], o: ALL });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines).toContain('Cancelled (stop phrase).');
  });
});

describe('Listener', () => {
  it('wake → command (with pre-roll) → Claude → spoken reply → chimes', async () => {
    const t = setup({ pattern: '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(40), hits: { 45: 'WAKE' }, texts: ['Hey Stephen, open YouTube.'] });
    expect(await t.listener.run()).toBe(0);
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.speaker.said).toEqual(['Opened open youtube.']);
    expect(t.chimes.played).toEqual(['wake', 'done']);
    expect(t.lines).toEqual(expect.arrayContaining(['Wake word heard — listening…', 'Heard: "open youtube"', 'Working…', 'Stephen: Opened open youtube.']));
    expect(t.lines.some((l) => /^Done \(\d+\.\d s\)$/.test(l))).toBe(true);
    // the audio handed to ASR starts before the wake hit: startAgo 0.5 s + 0.3 s margin = 25 frames before frame 45
    const heard = t.transcriber.heard[0]!;
    expect(heard[1]).toBe(45 - 25 + 1);
    expect(heard.length).toBeGreaterThan(FRAME * 40);
  });

  it('never invokes Claude without the wake word', async () => {
    const t = setup({ pattern: 's'.repeat(100) + '.'.repeat(50), hits: {}, texts: ['open youtube'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.transcriber.heard).toEqual([]);
    expect(t.listener.wakes).toBe(0);
  });

  it('a stop phrase while idle does nothing', async () => {
    const t = setup({ pattern: 's'.repeat(50), hits: { 10: 'STOP' }, texts: [] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.chimes.played).toEqual([]);
  });

  it('drops the command when the transcript does not contain the wake phrase (verifyWake)', async () => {
    const t = setup({ pattern: '.'.repeat(20) + 's'.repeat(30) + '.'.repeat(40), hits: { 25: 'WAKE' }, texts: ['Hey Stepping, open YouTube.'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines.some((l) => l.startsWith('Ignored — "hey stephen" wasn\'t in the transcript'))).toBe(true);
    const off = setup({ pattern: '.'.repeat(20) + 's'.repeat(30) + '.'.repeat(40), hits: { 25: 'WAKE' }, texts: ['Hey Stepping, open YouTube.'], o: { verifyWake: false } });
    await off.listener.run();
    expect(off.runner.prompts).toEqual(['hey stepping open youtube']);
  });

  it('times out when nothing is said after the wake word', async () => {
    const t = setup({ pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(400), hits: { 30: 'WAKE' }, texts: ['Hey Stephen.'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines).toContain("Didn't hear a command.");
    // 5 s timeout = 157 frames of capture (+ pre-roll)
    expect(t.transcriber.heard[0]!.length).toBeLessThan(FRAME * (157 + 30));
  });

  it('caps a command at maxCommandSec', async () => {
    const t = setup({ pattern: '.'.repeat(10) + 's'.repeat(600), hits: { 12: 'WAKE' }, texts: ['hey stephen blah'], o: { maxCommandSec: 3 } });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['blah']);
    expect(t.transcriber.heard[0]!.length).toBeLessThanOrEqual(FRAME * (94 + 30));
  });

  it('ignores the wake word while Stephen is speaking (no second command, reply not cut)', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(60),
      hits: { 12: 'WAKE', 80: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      speakMs: 10_000,
      gates: new Map([[80, () => waitFor(() => t.assistant.phase === 'speaking', 5000, 'speaking')]]),
    });
    const p = t.listener.run();
    await waitFor(() => t.speaker.said.length === 1, 5000, 'reply');
    await new Promise((r) => setTimeout(r, 200));
    expect(t.listener.busy).toBe(true);
    expect(t.speaker.cancelled).toBe(0);
    expect(t.listener.wakes).toBe(1);
    t.assistant.cancel(); // end the 10 s reply early
    await p;
    expect(t.runner.prompts).toEqual(['open youtube']);
  });

  it('the wake word while Claude is running cancels it, but never starts a new command', async () => {
    const runner = new FakeRunner(true);
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(60),
      hits: { 12: 'WAKE', 80: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      runner,
      gates: new Map([[80, () => waitFor(() => runner.pending, 5000, 'claude running')]]),
    });
    await t.listener.run();
    expect(runner.cancels).toBe(1);
    expect(runner.prompts).toEqual(['open youtube']);
    expect(t.lines).toContain('Stopping (wake word)…');
    expect(t.lines).toContain('Cancelled.');
    expect(t.listener.wakes).toBe(1);
  });

  it('"stephen stop" cancels the running command', async () => {
    const runner = new FakeRunner(true);
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100),
      hits: { 12: 'WAKE', 90: 'STOP' },
      texts: ['hey stephen play a long podcast'],
      runner,
      gates: new Map([[90, () => waitFor(() => runner.pending, 5000, 'claude running')]]),
    });
    await t.listener.run();
    expect(runner.cancels).toBe(1);
    expect(t.lines).toContain('Stopping (stop phrase)…');
    expect(t.speaker.said).toEqual([]);
    expect(t.chimes.played).toEqual(['wake', 'done']);
  });

  it('"stephen stop" cuts the spoken reply short', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100),
      hits: { 12: 'WAKE', 90: 'STOP' },
      texts: ['hey stephen open youtube'],
      speakMs: 60_000,
      gates: new Map([[90, () => waitFor(() => t.assistant.phase === 'speaking', 5000, 'speaking')]]),
    });
    await t.listener.run();
    expect(t.speaker.cancelled).toBe(1);
    expect(t.lines).toContain('Stopped.');
  });

  it('a stop phrase during capture abandons the command', async () => {
    const t = setup({ pattern: '.'.repeat(10) + 's'.repeat(40) + '.'.repeat(40), hits: { 12: 'WAKE', 20: 'STOP' }, texts: ['hey stephen x'] });
    await t.listener.run();
    expect(t.transcriber.heard).toEqual([]);
    expect(t.lines).toContain('Cancelled (stop phrase).');
  });

  it('--once exits after one command with its result as the exit code', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40) + 's'.repeat(20) + '.'.repeat(40),
      hits: { 12: 'WAKE', 75: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      o: { once: true },
      gates: new Map([[72, () => waitFor(() => t.runner.prompts.length > 0 && t.assistant.phase === 'idle', 5000, 'first command')]]),
    });
    expect(await t.listener.run()).toBe(0);
    expect(t.runner.prompts).toEqual(['open youtube']);
  });

  describe('cooldown after a command (a video Stephen opened may say "Hey Stephen")', () => {
    // 2 s of cooldown = 63 frames of audio after the listener is back to listening.
    const PATTERN = '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(200) + 's'.repeat(30) + '.'.repeat(60);
    const afterFirst = (t: { runner: FakeRunner; listener: Listener }) => () =>
      waitFor(() => t.runner.prompts.length === 1 && !t.listener.busy, 5000, 'first command done');

    it('ignores the wake word during the cooldown, then listens again', async () => {
      const t: ReturnType<typeof setup> = setup({
        pattern: PATTERN,
        hits: { 12: 'WAKE', 80: 'WAKE', 300: 'WAKE' },
        texts: ['hey stephen open youtube', 'hey stephen open mail'],
        o: { cooldownSec: 2 },
        gates: new Map([[80, () => afterFirst(t)()]]),
      });
      await t.listener.run();
      expect(t.runner.prompts).toEqual(['open youtube', 'open mail']);
      expect(t.listener.wakes).toBe(2);
      expect(t.listener.wakesIgnored).toBe(1);
      expect(t.transcriber.heard).toHaveLength(2); // the ignored wake never even reached speech-to-text
      expect(t.lines).toContain('Listening for "hey stephen" again in 2 s, so a page or video I just opened can\'t command me (press Enter to re-arm now)…');
      expect(t.lines.some((l) => /^Ignored "hey stephen" — the wake word is paused for \d s more after the last command .*Press Enter to talk now\.$/.test(l))).toBe(true);
      expect(t.lines).toContain('Listening for "hey stephen"…'); // the cooldown ran out
    });

    it('Enter (rearm) ends the cooldown early', async () => {
      const t: ReturnType<typeof setup> = setup({
        pattern: PATTERN,
        hits: { 12: 'WAKE', 80: 'WAKE' },
        texts: ['hey stephen open youtube', 'hey stephen open mail'],
        o: { cooldownSec: 20 },
        gates: new Map([
          [
            80,
            async () => {
              await afterFirst(t)();
              expect(t.listener.coolingDown).toBe(true);
              expect(t.listener.rearm()).toBe(true);
              expect(t.listener.rearm()).toBe(false);
            },
          ],
        ]),
      });
      await t.listener.run();
      expect(t.runner.prompts).toEqual(['open youtube', 'open mail']);
      expect(t.listener.wakesIgnored).toBe(0);
      expect(t.lines).toContain('Re-armed — listening for "hey stephen"…');
    });

    it('a cancelled run still starts the cooldown (it may have opened something first)', async () => {
      const runner = new FakeRunner(true);
      const t: ReturnType<typeof setup> = setup({
        pattern: PATTERN,
        hits: { 12: 'WAKE', 60: 'STOP', 80: 'WAKE' },
        texts: ['hey stephen open youtube', 'hey stephen open mail'],
        runner,
        o: { cooldownSec: 20 },
        gates: new Map([
          [60, () => waitFor(() => runner.pending, 5000, 'claude running')],
          [80, () => afterFirst(t)()],
        ]),
      });
      await t.listener.run();
      expect(runner.cancels).toBe(1);
      expect(runner.prompts).toEqual(['open youtube']);
      expect(t.listener.wakesIgnored).toBe(1);
    });

    it('no cooldown when the wake never reached Claude (dropped by verifyWake)', async () => {
      const t: ReturnType<typeof setup> = setup({
        pattern: PATTERN,
        hits: { 12: 'WAKE', 80: 'WAKE' },
        texts: ['hey stepping open youtube', 'hey stephen open mail'],
        o: { cooldownSec: 20 },
        gates: new Map([[80, () => waitFor(() => t.transcriber.heard.length === 1 && !t.listener.busy, 5000, 'first wake dropped')]]),
      });
      await t.listener.run();
      expect(t.runner.prompts).toEqual(['open mail']);
      expect(t.listener.wakesIgnored).toBe(0);
    });

    it('cooldownSec 0: the next wake word right after the reply is a new command (a fresh session; see claude.test.ts)', async () => {
      const t: ReturnType<typeof setup> = setup({
        pattern: PATTERN,
        hits: { 12: 'WAKE', 80: 'WAKE' },
        texts: ['hey stephen open youtube', 'hey stephen open mail'],
        o: { cooldownSec: 0 },
        gates: new Map([[80, () => afterFirst(t)()]]),
      });
      await t.listener.run();
      expect(t.runner.prompts).toEqual(['open youtube', 'open mail']);
      expect(t.listener.rearm()).toBe(false);
    });
  });

  it('requestExit stops the loop; cancel() with nothing running returns false', async () => {
    const t = setup({ pattern: '.'.repeat(1000), hits: {}, texts: [] });
    const p = t.listener.run();
    expect(t.listener.cancel('Ctrl-C')).toBe(false);
    t.listener.requestExit();
    expect(await p).toBe(0);
  });
});

describe('Listener: pre-warm (phase 3)', () => {
  it('the wake word pre-warms Claude once, before the command runs; the wake word while Claude runs only cancels', async () => {
    const runner = new FakeRunner(true);
    const gates = new Map<number, () => Promise<void>>([[85, () => waitFor(() => runner.pending, 5000, 'claude running')]]);
    const t = setup({ pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100), hits: { 12: 'WAKE', 90: 'WAKE' }, texts: ['hey stephen play a long podcast'], runner, gates });
    await t.listener.run();
    expect(runner.calls).toEqual(['prewarm', 'run:play a long podcast', 'cancel']);
  });

  it('a capture that never becomes a command still pre-warmed (the runner kills an unused process itself)', async () => {
    const t = setup({ pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40), hits: { 12: 'WAKE' }, texts: ['some video talking'] });
    await t.listener.run();
    expect(t.runner.calls).toEqual(['prewarm']);
  });
});

describe('Listener: names (P7)', () => {
  const PAT = '.'.repeat(60) + 's'.repeat(30) + '.'.repeat(40);
  it('fixes a close name before Claude sees it', async () => {
    const t = setup({ pattern: PAT, hits: { 65: 'WAKE' }, texts: ['Hey Stephen, email okafer.'], names: ['Okafor'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['email Okafor']);
  });
  it('asks "did you mean" and runs nothing when two names fit', async () => {
    const t = setup({ pattern: PAT, hits: { 65: 'WAKE' }, texts: ['Hey Stephen, call maran.'], names: ['Maren', 'Marin'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.speaker.said).toEqual(['Did you mean Maren or Marin?']);
  });
});
