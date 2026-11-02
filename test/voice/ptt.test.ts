/**
 * Push-to-talk, Esc, wake-word gating on `audio.playing`, quiet-while-playing replies and menu-bar states,
 * with a fake Stephen Helper and scripted audio frames (no models needed).
 */
import { describe, expect, it } from 'vitest';
import { Assistant } from '../../src/voice/assistant.js';
import type { KeywordHit } from '../../src/voice/engine.js';
import { HelperBridge, assistantHooks } from '../../src/voice/helper-link.js';
import { Listener, type ListenerOptions } from '../../src/voice/listener.js';
import { FakeHelper, FakeRunner, FakeTranscriber, FakeVad, FRAME, ScriptedSource, ScriptedSpotter, frames } from './fakes.js';
import { RecordingChimes, RecordingSpeaker, waitFor } from './helpers.js';

const OPTS: ListenerOptions = { wakePhrase: 'hey stephen', silenceSec: 0.8, maxCommandSec: 12, noSpeechTimeoutSec: 5, verifyWake: true, once: false, cooldownSec: 20 };
const MS_PER_FRAME = (FRAME / 16000) * 1000;

type Gate = () => Promise<void> | void;

function setup(opts: {
  pattern: string;
  hits?: Record<number, KeywordHit['id']>;
  texts: string[];
  runner?: FakeRunner;
  speakMs?: number;
  gates?: (t: Harness) => [number, Gate][];
  o?: Partial<ListenerOptions>;
  /** false = no helper at all. */
  helper?: boolean;
}) {
  const runner = opts.runner ?? new FakeRunner();
  const speaker = new RecordingSpeaker(opts.speakMs ?? 0);
  const chimes = new RecordingChimes();
  const lines: string[] = [];
  const status = (l: string) => lines.push(l);
  const fake = new FakeHelper();
  const bridge = opts.helper === false ? null : new HelperBridge(fake);
  const assistant = new Assistant({ runner, speaker, chimes, speak: true, status, ...assistantHooks(bridge) });
  const transcriber = new FakeTranscriber(opts.texts);
  const spotter = new ScriptedSpotter(opts.hits ?? {});
  const gates = new Map<number, Gate>();
  const source = new ScriptedSource(frames(opts.pattern), gates as Map<number, () => Promise<void>>);
  const listener = new Listener({ ...OPTS, ...opts.o }, { source, spotter, vad: new FakeVad(), transcriber, assistant, chimes, status, helper: bridge });
  const t = { listener, runner, speaker, chimes, lines, transcriber, assistant, fake, bridge };
  for (const [i, g] of opts.gates?.(t) ?? []) gates.set(i, g);
  return t;
}
type Harness = ReturnType<typeof setup>;

const down = (t: Harness) => () => t.fake.emit({ type: 'ptt_down', at: Date.now() });
const up = (t: Harness, heldMs: number) => () => t.fake.emit({ type: 'ptt_up', at: Date.now(), heldMs });
const idleAgain = (t: Harness, n: number) => () => waitFor(() => t.runner.prompts.length === n && !t.listener.busy, 5000, `command ${n} done`);

describe('push-to-talk (Fn+Option)', () => {
  it('press → record → release → transcript → Claude → spoken reply, with menu-bar states in order', async () => {
    // keys down at frame 5, speech 40–69, keys up at frame 90
    const t = setup({
      pattern: '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(60),
      texts: ['Open YouTube.'],
      gates: (t) => [
        [5, down(t)],
        [90, up(t, 85 * MS_PER_FRAME)],
      ],
    });
    expect(await t.listener.run()).toBe(0);
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.listener.ptts).toBe(1);
    expect(t.listener.wakes).toBe(0);
    expect(t.speaker.said).toEqual(['Opened open youtube.']);
    expect(t.chimes.played).toEqual(['wake', 'done']);
    expect(t.lines).toEqual(expect.arrayContaining(['Recording… (release F5 to send)', 'Heard: "open youtube"', 'Working…']));
    expect(t.lines[0]).toBe('Listening for "hey stephen" (or hold F5) on script… (Ctrl-C to quit)');
    // Only the audio from the key press on, minus silence at the edges (VAD-trimmed): less than the 85 frames held,
    // more than the 30 frames of speech.
    const heard = t.transcriber.heard[0]!;
    expect(heard.length).toBeLessThan(85 * FRAME);
    expect(heard.length).toBeGreaterThan(30 * FRAME);
    expect(t.fake.states).toEqual(['listening', 'recording', 'working', 'speaking', 'listening', 'idle']);
    // query_audio on connect, and a fresh one before speaking the reply
    expect(t.fake.sent.filter((c) => c.type === 'query_audio')).toHaveLength(2);
  });

  it('a tap shorter than the minimum hold is ignored', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(5) + '.'.repeat(30),
      texts: ['open youtube'],
      gates: (t) => [
        [8, down(t)],
        [14, up(t, 190)],
      ],
    });
    await t.listener.run();
    expect(t.transcriber.heard).toEqual([]);
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines).toContain('Ignored a 190 ms tap — hold F5 while you speak.');
    expect(t.fake.states).toEqual(['listening', 'recording', 'listening', 'idle']);
  });

  it('review #4 #1: a release synthesized after a helper drop (aborted) discards the recording — no cut-off command', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(40) + '.'.repeat(40),
      texts: ['close all tabs'],
      gates: (t) => [
        [5, down(t)],
        [45, () => t.fake.emit({ type: 'ptt_up', at: Date.now(), heldMs: 900, aborted: true } as never)],
      ],
    });
    await t.listener.run();
    expect(t.transcriber.heard).toEqual([]);
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines).toContain('Push-to-talk was interrupted (the helper disconnected) — nothing was sent. Hold F5 and try again.');
  });

  it('a press with no speech in it sends nothing', async () => {
    const t = setup({ pattern: '.'.repeat(60), texts: ['you'], gates: (t) => [[5, down(t)], [40, up(t, 1100)]] });
    await t.listener.run();
    expect(t.transcriber.heard).toEqual([]);
    expect(t.lines).toContain("Didn't hear a command.");
    expect(t.chimes.played).toEqual(['wake', 'done']);
  });

  it('a press during a running command cancels it, then records the new one', async () => {
    const runner = new FakeRunner(true);
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(50) + 's'.repeat(25) + '.'.repeat(80),
      hits: { 12: 'WAKE' },
      texts: ['hey stephen open youtube', 'open mail'],
      runner,
      gates: (t) => [
        [
          75,
          async () => {
            await waitFor(() => runner.pending, 5000, 'claude running');
            down(t)();
          },
        ],
        [120, up(t, 45 * MS_PER_FRAME)],
        [
          150,
          async () => {
            await waitFor(() => runner.prompts.length === 2, 5000, 'second command');
            runner.finish('Opened Mail.');
          },
        ],
      ],
    });
    await t.listener.run();
    expect(runner.cancels).toBe(1);
    expect(runner.prompts).toEqual(['open youtube', 'open mail']);
    expect(t.lines).toContain('Stopping (push-to-talk)…');
    expect(t.lines).toContain('Cancelled.');
    expect(t.speaker.said).toEqual(['Opened Mail.']);
    // wake chime, done chime of the cancelled run, wake chime of the press, done chime
    expect(t.chimes.played).toEqual(['wake', 'wake', 'done', 'done']);
    expect(t.fake.states).toEqual(['listening', 'recording', 'working', 'recording', 'working', 'speaking', 'listening', 'idle']);
  });

  it('a press while Stephen is speaking cuts the reply short and records', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(50) + 's'.repeat(25) + '.'.repeat(60),
      hits: { 12: 'WAKE' },
      texts: ['hey stephen open youtube', 'open mail'],
      speakMs: 60_000,
      gates: (t) => [
        [
          75,
          async () => {
            await waitFor(() => t.assistant.phase === 'speaking', 5000, 'speaking');
            down(t)();
          },
        ],
        [120, up(t, 45 * MS_PER_FRAME)],
        [
          150,
          async () => {
            await waitFor(() => t.speaker.said.length === 2, 5000, 'second reply');
            t.assistant.cancel();
          },
        ],
      ],
    });
    await t.listener.run();
    expect(t.speaker.cancelled).toBeGreaterThanOrEqual(1);
    expect(t.runner.prompts).toEqual(['open youtube', 'open mail']);
  });

  it('stops recording at the maximum hold and sends what it has; the late release is ignored', async () => {
    const t = setup({
      pattern: '.'.repeat(5) + 's'.repeat(200) + '.'.repeat(20),
      texts: ['open youtube and keep talking'],
      o: { pttMaxHoldMs: 2000 },
      gates: (t) => [
        [3, down(t)],
        [210, up(t, 207 * MS_PER_FRAME)],
      ],
    });
    await t.listener.run();
    expect(t.lines).toContain('Push-to-talk limit reached — sending what I have.');
    expect(t.transcriber.heard).toHaveLength(1);
    expect(t.transcriber.heard[0]!.length).toBeLessThanOrEqual(Math.ceil(2000 / MS_PER_FRAME) * FRAME);
    expect(t.runner.prompts).toEqual(['open youtube and keep talking']);
  });

  it('"Hey Stephen" said while holding the keys is just part of the command (stripped, no wake)', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(30) + '.'.repeat(60),
      hits: { 15: 'WAKE' },
      texts: ['Hey Stephen, open YouTube.'],
      gates: (t) => [
        [5, down(t)],
        [80, up(t, 75 * MS_PER_FRAME)],
      ],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.listener.wakes).toBe(0);
  });
});

describe('Esc (helper)', () => {
  it('cancels a running command, like "stephen stop"', async () => {
    const runner = new FakeRunner(true);
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100),
      hits: { 12: 'WAKE' },
      texts: ['hey stephen play a long podcast'],
      runner,
      gates: (t) => [
        [
          90,
          async () => {
            await waitFor(() => runner.pending, 5000, 'claude running');
            t.fake.emit({ type: 'esc', at: Date.now() });
          },
        ],
      ],
    });
    await t.listener.run();
    expect(runner.cancels).toBe(1);
    expect(t.lines).toContain('Stopping (Esc)…');
    expect(t.speaker.said).toEqual([]);
  });

  it('cuts the spoken reply short', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100),
      hits: { 12: 'WAKE' },
      texts: ['hey stephen open youtube'],
      speakMs: 60_000,
      gates: (t) => [
        [
          90,
          async () => {
            await waitFor(() => t.assistant.phase === 'speaking', 5000, 'speaking');
            t.fake.emit({ type: 'esc', at: Date.now() });
          },
        ],
      ],
    });
    await t.listener.run();
    expect(t.speaker.cancelled).toBe(1);
    expect(t.lines).toContain('Stopping (Esc)…');
    expect(t.lines).toContain('Stopped.');
  });

  it('does nothing when idle', async () => {
    const t = setup({ pattern: '.'.repeat(40), texts: [], gates: (t) => [[10, () => t.fake.emit({ type: 'esc', at: Date.now() })]] });
    await t.listener.run();
    expect(t.lines.filter((l) => /Stopping|Cancel/.test(l))).toEqual([]);
    expect(t.chimes.played).toEqual([]);
  });
});

describe('wake-word gating with the helper', () => {
  const PATTERN = '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(200) + 's'.repeat(30) + '.'.repeat(60);

  it('no fixed cooldown: a wake word right after a command is accepted while the Mac is silent', async () => {
    const t = setup({
      pattern: PATTERN,
      hits: { 12: 'WAKE', 80: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      o: { cooldownSec: 20 },
      gates: (t) => [[80, idleAgain(t, 1)]],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube', 'open mail']);
    expect(t.listener.coolingDown).toBe(false);
    expect(t.listener.wakesIgnored).toBe(0);
    expect(t.lines.some((l) => /again in \d+ s/.test(l))).toBe(false);
  });

  it('ignores "Hey Stephen" while audio is playing, accepts it once playback stops', async () => {
    const t = setup({
      pattern: PATTERN,
      hits: { 12: 'WAKE', 80: 'WAKE', 300: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      gates: (t) => [
        [
          79,
          async () => {
            await idleAgain(t, 1)();
            t.fake.emit({ type: 'audio', playing: true, at: Date.now() });
          },
        ],
        [290, () => t.fake.emit({ type: 'audio', playing: false, at: Date.now() })],
      ],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube', 'open mail']);
    expect(t.listener.wakes).toBe(2);
    expect(t.listener.wakesIgnored).toBe(1);
    expect(t.transcriber.heard).toHaveLength(2);
    expect(t.lines).toContain('Ignored "hey stephen" — sound is playing (it may be a video talking). Hold F5 to talk.');
  });

  it('"Stephen stop" still works while audio is playing', async () => {
    const runner = new FakeRunner(true);
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100),
      hits: { 12: 'WAKE', 90: 'STOP' },
      texts: ['hey stephen play music'],
      runner,
      gates: (t) => [
        [
          90,
          async () => {
            await waitFor(() => runner.pending, 5000, 'claude running');
            t.fake.emit({ type: 'audio', playing: true, at: Date.now() });
          },
        ],
      ],
    });
    await t.listener.run();
    expect(runner.cancels).toBe(1);
    expect(t.lines).toContain('Stopping (stop phrase)…');
  });

  it('falls back to the fixed cooldown while the helper is disconnected', async () => {
    const t = setup({
      pattern: PATTERN,
      hits: { 12: 'WAKE', 80: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      o: { cooldownSec: 20 },
      gates: (t) => [[2, () => t.fake.setConnected(false)], [80, idleAgain(t, 1)]],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.listener.wakesIgnored).toBe(1);
    expect(t.lines.some((l) => l.startsWith('Ignored "hey stephen" — the wake word is paused'))).toBe(true);
  });

  it('review #4 #2: the helper dropping right after a command arms the remaining cooldown (a video it started can\'t wake Stephen)', async () => {
    const t = setup({
      pattern: PATTERN,
      hits: { 12: 'WAKE', 80: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      o: { cooldownSec: 20 },
      gates: (t) => [[70, idleAgain(t, 1)], [72, () => t.fake.setConnected(false)]],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.listener.wakesIgnored).toBe(1);
  });

  it('review #4 #2: with the helper up but no audio event yet (unknown), the wake word is ignored (fail closed)', async () => {
    const t = setup({
      pattern: PATTERN,
      hits: { 12: 'WAKE' },
      texts: ['hey stephen open youtube'],
      gates: (t) => [[1, () => { (t.bridge as unknown as { playing: boolean | null }).playing = null; }]],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.listener.wakesIgnored).toBe(1);
  });

  it('without any helper, the 20 s cooldown applies (fallback)', async () => {
    const t = setup({
      pattern: PATTERN,
      hits: { 12: 'WAKE', 80: 'WAKE' },
      texts: ['hey stephen open youtube', 'hey stephen open mail'],
      helper: false,
      gates: (t) => [[80, idleAgain(t, 1)]],
    });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.listener.coolingDown).toBe(true);
    expect(t.listener.wakesIgnored).toBe(1);
    expect(t.lines[0]).toBe('Listening for "hey stephen" on script… (Ctrl-C to quit)');
  });

  it('wakeWord false: the wake word never triggers; push-to-talk and "stephen stop" still work', async () => {
    const runner = new FakeRunner(true);
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40) + 's'.repeat(25) + '.'.repeat(80),
      hits: { 12: 'WAKE', 160: 'STOP' },
      texts: ['open youtube'],
      runner,
      o: { wakeWord: false },
      gates: (t) => [
        [65, down(t)],
        [110, up(t, 45 * MS_PER_FRAME)],
        [160, () => waitFor(() => runner.pending, 5000, 'claude running')],
      ],
    });
    await t.listener.run();
    expect(t.listener.wakes).toBe(0);
    expect(t.transcriber.heard).toHaveLength(1); // only the push-to-talk recording
    expect(runner.prompts).toEqual(['open youtube']);
    expect(runner.cancels).toBe(1);
    expect(t.lines[0]).toBe('Ready on script — hold F5 to talk… (Ctrl-C to quit)');
    expect(t.lines).toContain('Ready — hold F5 to talk…');
  });
});

describe('quiet while playing', () => {
  const run = (prep: (f: FakeHelper) => void) => {
    const t = setup({
      pattern: '.'.repeat(5) + 's'.repeat(25) + '.'.repeat(60),
      texts: ['play jazz'],
      gates: (t) => [
        [3, down(t)],
        [60, up(t, 57 * MS_PER_FRAME)],
      ],
    });
    prep(t.fake);
    return t;
  };

  it('the reply is not spoken while the Mac plays sound: done chime only, reply printed', async () => {
    const t = run((f) => (f.playing = true));
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['play jazz']);
    expect(t.speaker.said).toEqual([]);
    expect(t.chimes.played).toEqual(['wake', 'done']);
    expect(t.lines).toContain('Stephen: Opened play jazz.');
    expect(t.lines).toContain('Sound is playing — reply shown here instead of spoken.');
    expect(t.fake.states).not.toContain('speaking');
  });

  it('the reply is spoken when the Mac is silent', async () => {
    const t = run((f) => (f.playing = false));
    await t.listener.run();
    expect(t.speaker.said).toEqual(['Opened play jazz.']);
    expect(t.chimes.played).toEqual(['wake', 'done']);
  });

  it('no fresh answer within ~300 ms: the last known audio state decides', async () => {
    const t = run((f) => {
      f.answerQueries = false;
    });
    await new Promise((r) => setTimeout(r, 0)); // let the on-connect query_audio settle first
    t.fake.emit({ type: 'audio', playing: true, at: Date.now() });
    const t0 = Date.now();
    await t.listener.run();
    expect(t.speaker.said).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});

describe('HelperBridge', () => {
  it('dedupes states, tracks audio, and reports not-playing when disconnected', async () => {
    const f = new FakeHelper();
    const b = new HelperBridge(f);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.sent[0]).toEqual({ type: 'query_audio' });
    b.setState('listening');
    b.setState('listening');
    b.setState('recording');
    expect(f.states).toEqual(['listening', 'recording']);
    f.emit({ type: 'audio', playing: true, at: 1 });
    expect(b.audioPlaying).toBe(true);
    f.playing = true;
    expect(await b.queryAudio(300)).toBe(true);
    f.setConnected(false);
    expect(b.audioPlaying).toBeNull();
    expect(await b.queryAudio(300)).toBe(false); // no helper → speak, as before
    f.setConnected(true);
    expect(f.states.at(-1)).toBe('recording'); // re-sent after reconnect
    b.close();
    expect(f.states.at(-1)).toBe('idle');
    expect(f.closed).toBe(true);
  });

  it('connect() reports why the helper is unavailable and never throws', async () => {
    const f = new FakeHelper({ ok: false, reason: 'not installed' });
    expect(await HelperBridge.connect(f)).toEqual({ reason: 'not installed' });
    expect(f.closed).toBe(true);
    const boom = new FakeHelper();
    boom.start = () => Promise.reject(new Error('socket exploded'));
    expect(await HelperBridge.connect(boom)).toEqual({ reason: 'socket exploded' });
    expect('bridge' in (await HelperBridge.connect(new FakeHelper()))).toBe(true);
  });
});
