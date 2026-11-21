/** ADR-007 point 1: the Assistant puts one conversation id (c_ + 16 hex) on every command of a conversation. */
import { describe, expect, it } from 'vitest';
import { Assistant, type CommandReport, type LocalRouter } from '../../src/voice/assistant.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';
import { FakeRunner } from './fakes.js';

/** followUp() answers `active`; the first command of a conversation turns it on, endConversation() turns it off. */
class ConvRunner extends FakeRunner {
  active = false;
  followUp() {
    const f = this.active;
    this.active = true;
    return f;
  }
  override endConversation() {
    super.endConversation();
    this.active = false;
  }
}

const timers: LocalRouter = { route: async (t) => (t === 'set a timer' ? { reply: 'Timer set.', changed: false } : null) };

function make() {
  const runner = new ConvRunner();
  const reports: CommandReport[] = [];
  const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {}, timers, onDone: (r) => reports.push(r) });
  return { runner, assistant, reports };
}

describe('conversation id (ADR-007)', () => {
  it('is c_ plus 16 hex, shared by every command of one conversation (follow-ups and local routers)', async () => {
    const { assistant, reports } = make();
    await assistant.command('what is on my calendar', { source: 'voice-ptt' });
    await assistant.command('and tomorrow', { source: 'voice-ptt' });
    await assistant.command('set a timer', { source: 'voice-ptt' });
    expect(reports.map((r) => r.followUp)).toEqual([false, true, false]);
    expect(reports[0]!.conv).toMatch(/^c_[0-9a-f]{16}$/);
    expect(new Set(reports.map((r) => r.conv)).size).toBe(1);
  });

  it('a new conversation gets a new id (not a follow-up, or after endConversation)', async () => {
    const { runner, assistant, reports } = make();
    await assistant.command('open youtube', { source: 'voice-ptt' });
    runner.active = false; // the window ran out or the trust changed: the runner starts fresh
    await assistant.command('open gmail', { source: 'voice-ptt' });
    assistant.endConversation();
    await assistant.command('set a timer', { source: 'voice-ptt' });
    const [a, b, c] = reports.map((r) => r.conv);
    expect(b).toMatch(/^c_[0-9a-f]{16}$/);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
