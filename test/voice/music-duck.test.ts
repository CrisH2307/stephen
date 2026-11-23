/**
 * Issue #205: "Hey Stephen" while sound plays lowers the volume, takes only a media command (decided by the grammar
 * classifier, never the model) and restores the volume on every path. "Stephen stop" with nothing running pauses.
 */
import { describe, expect, it } from 'vitest';
import { encodeCommand, parseHelperLine } from '../../src/helper/framing.js';
import { Assistant } from '../../src/voice/assistant.js';
import type { KeywordHit, Transcriber } from '../../src/voice/engine.js';
import { HelperBridge, assistantHooks } from '../../src/voice/helper-link.js';
import { Listener, type ListenerOptions } from '../../src/voice/listener.js';
import { HOLD_F5, mediaCommand, type MediaCommand, type SoundControl } from '../../src/voice/media-command.js';
import { FakeHelper, FakeRunner, FakeTranscriber, FakeVad, FRAME, ScriptedSource, ScriptedSpotter, frames } from './fakes.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const OPTS: ListenerOptions = { wakePhrase: 'hey stephen', stopPhrase: 'stephen stop', silenceSec: 0.8, maxCommandSec: 12, noSpeechTimeoutSec: 2, verifyWake: true, once: false };
const MS_PER_FRAME = (FRAME / 16000) * 1000;

class FakeSound implements SoundControl {
  volume = 60;
  readonly log: string[] = [];
  mediaError: string | null = null;
  async duck(level: number) {
    this.log.push(`duck:${level}`);
    if (this.volume <= level) return null;
    const saved = this.volume;
    this.volume = level;
    return saved;
  }
  async restore(v: number) {
    this.log.push(`restore:${v}`);
    this.volume = v;
  }
  async media(c: MediaCommand) {
    this.log.push(`media:${c.verb}${'arg' in c ? `:${c.arg}` : ''}`);
    if (this.mediaError) throw new Error(this.mediaError);
    if (c.verb === 'volume' && typeof c.arg === 'number') this.volume = c.arg;
    return 'Done.';
  }
}

type Gate = () => Promise<void> | void;

function setup(opts: {
  pattern: string;
  hits?: Record<number, KeywordHit['id']>;
  texts: string[];
  gates?: (t: { fake: FakeHelper }) => [number, Gate][];
  /** At this frame, write "mark" into the sound log: a restore before it happened right away, not at the loop's end. */
  mark?: number;
  /** Sound playing from the first frame (default true). */
  playing?: boolean | null;
  sound?: boolean;
  transcriber?: Transcriber;
  o?: Partial<ListenerOptions>;
}) {
  const runner = new FakeRunner();
  const speaker = new RecordingSpeaker(0);
  const chimes = new RecordingChimes();
  const lines: string[] = [];
  const status = (l: string) => lines.push(l);
  const fake = new FakeHelper();
  const bridge = new HelperBridge(fake);
  const sound = new FakeSound();
  const audit: { tool: string; args?: Record<string, unknown>; outcome: string; error?: string; cmd?: string }[] = [];
  const assistant = new Assistant({ runner, speaker, chimes, speak: true, status, ...assistantHooks(bridge) });
  const gates = new Map<number, Gate>();
  const playing = opts.playing === undefined ? true : opts.playing;
  gates.set(1, () => {
    fake.playing = playing === true;
    if (playing === null) (bridge as unknown as { playing: boolean | null }).playing = null;
    else fake.emit({ type: 'audio', playing, at: Date.now() });
  });
  for (const [i, g] of opts.gates?.({ fake }) ?? []) gates.set(i, g);
  gates.set(opts.mark ?? 110, () => void sound.log.push('mark'));
  const listener = new Listener(
    { ...OPTS, ...opts.o },
    {
      source: new ScriptedSource(frames(opts.pattern), gates as Map<number, () => Promise<void>>),
      spotter: new ScriptedSpotter(opts.hits ?? {}),
      vad: new FakeVad(),
      transcriber: opts.transcriber ?? new FakeTranscriber(opts.texts),
      assistant,
      chimes,
      status,
      helper: bridge,
      sound: opts.sound === false ? null : sound,
      audit: { append: async (e) => void audit.push(e) },
    },
  );
  return { listener, runner, speaker, lines, sound, fake, audit };
}

/** Wake at frame 12, speech 10–29, then silence. */
const SPOKEN = '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100);

describe('wake word while sound plays (issue #205)', () => {
  it('a media command runs without the model, and the volume goes back after it', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen pause'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.runner.prewarms).toBe(0);
    // Pause first, then restore: the music does not jump up before it stops.
    expect(t.sound.log).toEqual(['duck:20', 'media:pause', 'restore:60', 'mark']);
    expect(t.sound.volume).toBe(60);
    expect(t.lines).toContain('Heard: "pause"');
    // One audit line, verb only (never the transcript), joined to the command id.
    expect(t.audit).toEqual([{ tool: 'voice_media', args: { verb: 'pause' }, outcome: 'ok', intent: 'wake word over playing sound: media commands only', cmd: expect.stringMatching(/^h_/) as unknown as string }]);
  });

  it('a volume command restores first, so it acts on the real volume (and is not undone)', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen volume 30'], o: { duckVolume: 10 } });
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:10', 'restore:60', 'media:volume:30', 'mark']);
    expect(t.audit.map((e) => [e.args, e.outcome])).toEqual([[{ verb: 'volume', arg: 30 }, 'ok']]);
    expect(t.sound.volume).toBe(30);
  });

  it('a non-media command is not run: "Hold F5 for that.", volume restored', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen open my email and delete everything'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
    expect(t.lines.some((l) => l.endsWith(HOLD_F5) && l.startsWith('Heard: "open my email'))).toBe(true);
    // The refusal is audited too, and the spoken words stay out of the log.
    expect(t.audit.map((e) => [e.tool, e.args, e.outcome])).toEqual([['voice_media', { verb: null }, 'denied']]);
    expect(JSON.stringify(t.audit)).not.toContain('email');
  });

  it('"play <something>" is not a media command over sound (it would open things)', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen play lofi on youtube'] });
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
  });

  it('restores when the media command fails', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen next'] });
    t.sound.mediaError = 'no key';
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'media:next', 'restore:60', 'mark']);
    expect(t.lines).toContain("Couldn't do that (no key).");
    expect(t.audit.map((e) => [e.args, e.outcome, e.error])).toEqual([[{ verb: 'next' }, 'error', 'no key']]);
  });

  it('restores on Esc during the capture', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen pause'], gates: ({ fake }) => [[18, () => fake.emit({ type: 'esc', at: Date.now() })]] });
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
    expect(t.lines).toContain('Cancelled (Esc).');
  });

  it('restores on the stop phrase during the capture', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE', 18: 'STOP' }, texts: ['hey stephen pause'] });
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
    expect(t.lines).toContain('Cancelled (stop phrase).');
  });

  it('restores when nothing is said (no-speech timeout)', async () => {
    const t = setup({ pattern: '.'.repeat(150), hits: { 12: 'WAKE' }, texts: ['hey stephen'], mark: 140 });
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
    expect(t.lines).toContain("Didn't hear a command.");
  });

  it('restores when speech-to-text throws', async () => {
    const broken: Transcriber = { id: 'broken', transcribe: async () => Promise.reject(new Error('asr died')) };
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: [], transcriber: broken });
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
    expect(t.lines).toContain('Problem: asr died');
  });

  it('restores when F5 takes over, and F5 keeps full commands (to the model)', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(8) + '.'.repeat(10) + 's'.repeat(30) + '.'.repeat(80),
      hits: { 12: 'WAKE' },
      texts: ['open my email'],
      mark: 130,
      gates: ({ fake }) => [
        [20, () => fake.emit({ type: 'ptt_down', at: Date.now() })],
        [70, () => fake.emit({ type: 'ptt_up', at: Date.now(), heldMs: 50 * MS_PER_FRAME })],
      ],
    });
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'restore:60', 'mark']);
    expect(t.runner.prompts).toEqual(['open my email']);
  });

  it('nothing to restore when the volume was already low', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen pause'] });
    t.sound.volume = 15;
    await t.listener.run();
    expect(t.sound.log).toEqual(['duck:20', 'media:pause', 'mark']);
  });

  it('unknown audio state still ignores the wake word (fail closed)', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen pause'], playing: null });
    await t.listener.run();
    expect(t.sound.log).toEqual(['mark']);
    expect(t.listener.wakesIgnored).toBe(1);
  });

  it('without sound control the wake word over sound is ignored, as before', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen pause'], sound: false });
    await t.listener.run();
    expect(t.listener.wakesIgnored).toBe(1);
    expect(t.runner.prompts).toEqual([]);
  });

  it('with no sound playing, the wake word gives full commands (to the model), no duck', async () => {
    const t = setup({ pattern: SPOKEN, hits: { 12: 'WAKE' }, texts: ['hey stephen open youtube'], playing: false });
    await t.listener.run();
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.sound.log).toEqual(['mark']);
  });
});

describe('"Stephen stop" with nothing running (issue #205)', () => {
  it('pauses while sound plays', async () => {
    const t = setup({ pattern: '.'.repeat(40), hits: { 12: 'STOP' }, texts: [] });
    await t.listener.run();
    expect(t.sound.log).toEqual(['media:pause']);
    expect(t.runner.conversationEnds).toBeGreaterThan(0);
    expect(t.audit.map((e) => [e.args, e.outcome])).toEqual([[{ verb: 'pause', via: 'stop_phrase' }, 'ok']]);
  });

  it('does nothing to the sound when none plays', async () => {
    const t = setup({ pattern: '.'.repeat(40), hits: { 12: 'STOP' }, texts: [], playing: false });
    await t.listener.run();
    expect(t.sound.log).toEqual([]);
    expect(t.audit).toEqual([]);
  });
});

describe('mediaCommand (grammar classifier, Tier 1 media verbs only)', () => {
  it.each([
    ['pause', { verb: 'pause' }],
    ['stop the music', { verb: 'stop' }],
    ['play', { verb: 'play' }],
    ['resume', { verb: 'resume' }],
    ['next song', { verb: 'next' }],
    ['previous track', { verb: 'previous' }],
    ['volume up', { verb: 'volume', arg: 'up' }],
    ['set the volume to 30', { verb: 'volume', arg: 30 }],
    ['mute', { verb: 'mute' }],
    ['unmute', { verb: 'unmute' }],
  ])('%s → media', (text, want) => expect(mediaCommand(text)).toEqual(want));

  it.each(['play lofi', 'play lofi on youtube', 'open youtube', 'set a timer for 5 minutes', 'remember my code is 4', 'pause and open mail', 'what is playing', 'delete my email', ''])(
    '%s → not media',
    (text) => expect(mediaCommand(text)).toBeNull(),
  );
});

describe('helper media_key message (issue #205)', () => {
  it('sends media_key and waits for media_key_done; an old helper that never answers times out', async () => {
    const fake = new FakeHelper();
    const bridge = new HelperBridge(fake);
    expect(await bridge.media('previous')).toEqual({ ok: true });
    expect(fake.sent).toContainEqual({ type: 'media_key', key: 'previous' });
    fake.mediaKeyAnswer = null;
    expect(await bridge.media('toggle', 20)).toEqual({ ok: false, reason: 'Stephen Helper did not answer (update it: stephen install-helper)' });
    fake.setConnected(false);
    expect(await bridge.media('next')).toEqual({ ok: false, reason: "Stephen Helper isn't connected" });
  });

  it('the helper answer line is validated', () => {
    expect(parseHelperLine('{"type":"media_key_done","key":"play_pause","ok":false,"message":"no permission"}')).toEqual({
      kind: 'event',
      event: { type: 'media_key_done', key: 'play_pause', ok: false, message: 'no permission' },
    });
    expect(parseHelperLine('{"type":"media_key_done","key":"eject","ok":true}').kind).toBe('invalid');
    expect(encodeCommand({ type: 'media_key', key: 'next' })).toBe('{"type":"media_key","key":"next"}\n');
  });
});
