/**
 * Plan A2: the listener mints ONE command id at the trigger and the assistant, history hook and latency monitor all
 * see that id. Triggers that never become a command still end with a named outcome.
 */
import { describe, expect, it } from 'vitest';
import type { LatencyOutcome, LatencyStage, LatencyTrace } from '../../src/telemetry/latency.js';
import { Assistant, type CommandReport } from '../../src/voice/assistant.js';
import type { KeywordHit } from '../../src/voice/engine.js';
import { HelperBridge, assistantHooks } from '../../src/voice/helper-link.js';
import { Listener, type ListenerOptions } from '../../src/voice/listener.js';
import { FakeHelper, FakeRunner, FakeTranscriber, FakeVad, FRAME, ScriptedSource, ScriptedSpotter, frames } from './fakes.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const OPTS: ListenerOptions = { wakePhrase: 'hey stephen', silenceSec: 0.8, maxCommandSec: 12, noSpeechTimeoutSec: 5, verifyWake: true, once: false, cooldownSec: 0 };
const MS_PER_FRAME = (FRAME / 16000) * 1000;

class RecordingTrace implements LatencyTrace {
  rows: { id: string; trigger: string; marks: LatencyStage[]; outcome?: LatencyOutcome; notes: Record<string, unknown>; ended?: Record<string, unknown> }[] = [];
  private row(id: string) {
    return this.rows.find((r) => r.id === id && r.outcome === undefined);
  }
  begin(id: string, trigger: string): void {
    if (!this.row(id)) this.rows.push({ id, trigger, marks: [], notes: {} });
  }
  mark(id: string, stage: LatencyStage): void {
    this.row(id)?.marks.push(stage);
  }
  note(id: string, n: object): void {
    const r = this.row(id);
    if (r) Object.assign(r.notes, n);
  }
  end(id: string, outcome: LatencyOutcome, extra?: object): void {
    const r = this.row(id);
    if (r) {
      r.outcome = outcome;
      r.ended = { ...extra };
    }
  }
}

function setup(opts: { pattern: string; hits?: Record<number, KeywordHit['id']>; texts: string[]; gates?: (f: FakeHelper) => [number, () => void][] }) {
  const trace = new RecordingTrace();
  const reports: CommandReport[] = [];
  const started: string[] = [];
  const chimes = new RecordingChimes();
  const fake = new FakeHelper();
  const bridge = new HelperBridge(fake);
  // The same hooks `stephen listen` installs (src/voice/index.ts): the assistant's report ends the row.
  const assistant = new Assistant({
    runner: new FakeRunner(),
    speaker: new RecordingSpeaker(0),
    chimes,
    speak: true,
    status: () => undefined,
    ...assistantHooks(bridge),
    onStart: (c) => started.push(c.id),
    onDone: (r) => {
      reports.push(r);
      trace.mark(r.id, 'done');
      trace.end(r.id, r.result);
    },
  });
  const gates = new Map<number, () => Promise<void>>();
  for (const [i, g] of opts.gates?.(fake) ?? []) gates.set(i, async () => g());
  const listener = new Listener(OPTS, {
    source: new ScriptedSource(frames(opts.pattern), gates),
    spotter: new ScriptedSpotter(opts.hits ?? {}),
    vad: new FakeVad(),
    transcriber: new FakeTranscriber(opts.texts),
    assistant,
    chimes,
    status: () => undefined,
    helper: bridge,
    latency: trace,
  });
  return { listener, trace, reports, started, fake };
}

const down = (f: FakeHelper) => () => f.emit({ type: 'ptt_down', at: Date.now() });
const up = (f: FakeHelper, frames: number) => () => f.emit({ type: 'ptt_up', at: Date.now(), heldMs: frames * MS_PER_FRAME });

describe('command id from the trigger (plan A2)', () => {
  it('push-to-talk: one id from key down to the report, stages in order', async () => {
    const t = setup({
      pattern: '.'.repeat(40) + 's'.repeat(30) + '.'.repeat(60),
      texts: ['Open YouTube.'],
      gates: (f) => [
        [5, down(f)],
        [90, up(f, 85)],
      ],
    });
    await t.listener.run();
    expect(t.trace.rows).toHaveLength(1);
    const row = t.trace.rows[0]!;
    expect(row).toMatchObject({ trigger: 'ptt', outcome: 'ok', marks: ['speechEnd', 'captureEnd', 'asrDone', 'commandStart', 'done'] });
    expect(row.id).toMatch(/^h_[0-9a-f]{16}$/);
    expect(t.started).toEqual([row.id]);
    expect(t.reports.map((r) => r.id)).toEqual([row.id]);
    expect(t.reports[0]).toMatchObject({ route: 'model', source: 'voice-ptt' });
  });

  it('wake word: one id, and the end of speech is marked before the end of the capture', async () => {
    const t = setup({ pattern: '.'.repeat(60) + 's'.repeat(40) + '.'.repeat(80), hits: { 65: 'WAKE' }, texts: ['Hey Stephen, open YouTube.'] });
    await t.listener.run();
    expect(t.trace.rows).toHaveLength(1);
    expect(t.trace.rows[0]).toMatchObject({ trigger: 'wake', outcome: 'ok', marks: ['chime', 'speechEnd', 'captureEnd', 'asrDone', 'commandStart', 'done'], notes: { asr: 'fake' } });
    expect(t.reports.map((r) => r.id)).toEqual([t.trace.rows[0]!.id]);
  });

  it('a wake heard while sound plays ends as wake_ignored with the reason code', async () => {
    const t = setup({
      pattern: '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(60),
      hits: { 12: 'WAKE' },
      texts: ['hey stephen open youtube'],
      gates: (f) => [[5, () => f.emit({ type: 'audio', playing: true, at: Date.now() })]],
    });
    await t.listener.run();
    expect(t.trace.rows.map((r) => r.outcome)).toEqual(['wake_ignored']);
    expect(t.trace.rows[0]!.ended).toMatchObject({ ignored: 'sound_playing' });
  });

  it('a wake the transcript does not confirm ends as no_wake and never reaches the assistant', async () => {
    const t = setup({ pattern: '.'.repeat(60) + 's'.repeat(40) + '.'.repeat(80), hits: { 65: 'WAKE' }, texts: ['The weather is nice today.'] });
    await t.listener.run();
    expect(t.trace.rows.map((r) => r.outcome)).toEqual(['no_wake']);
    expect(t.reports).toEqual([]);
  });

  it('a short tap ends as short_press; a press with no speech ends as no_speech', async () => {
    const tap = setup({ pattern: '.'.repeat(40), texts: [], gates: (f) => [[5, down(f)], [8, up(f, 3)]] });
    await tap.listener.run();
    expect(tap.trace.rows.map((r) => [r.trigger, r.outcome])).toEqual([['ptt', 'short_press']]);
    const quiet = setup({ pattern: '.'.repeat(120), texts: [], gates: (f) => [[5, down(f)], [90, up(f, 85)]] });
    await quiet.listener.run();
    expect(quiet.trace.rows.map((r) => [r.trigger, r.outcome])).toEqual([['ptt', 'no_speech']]);
  });
});
