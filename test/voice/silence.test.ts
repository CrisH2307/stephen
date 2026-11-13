/** Esc to silence (plan A2b): the assistant measures cancel to the end of the spoken reply. */
import { describe, expect, it } from 'vitest';
import { Assistant, type CommandReport } from '../../src/voice/assistant.js';
import { FakeRunner } from './fakes.js';
import { RecordingChimes } from './helpers.js';

describe('silenceMs', () => {
  it('a cancel during speech reports the ms until the speech ended; no cancel, no number', async () => {
    let clock = 1000;
    let finish!: () => void;
    const done = new Promise<void>((r: () => void) => (finish = r));
    let spoke = false;
    const reports: CommandReport[] = [];
    const a = new Assistant({
      runner: new FakeRunner(),
      speaker: { speak: () => ((spoke = true), { done, cancel: () => { clock += 70; finish(); } }) } as never,
      chimes: new RecordingChimes(),
      speak: true,
      status: () => undefined,
      now: () => clock,
      onDone: (r: CommandReport) => reports.push(r),
    } as never);
    const p = a.handle("open youtube", { source: "voice-ptt" } as never);
    for (let i = 0; i < 200 && !spoke; i++) await new Promise<void>((r) => setTimeout(r, 10));
    expect(a.cancel()).toBe(true);
    await p;
    expect(reports[0]!.silenceMs).toBe(70);
  });
});
