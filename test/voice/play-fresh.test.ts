/** docs/PLAN-WORK-SPLIT.md §13: "play <something new>" starts a fresh conversation, so a private read earlier in the
 * conversation can't make the YouTube open need a confirmation (which the phone can't answer). */
import { describe, expect, it } from 'vitest';
import { Assistant, freshForPlay } from '../../src/voice/assistant.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';
import { FakeRunner } from './fakes.js';

describe('freshForPlay', () => {
  it.each([
    'play Sarà perché ti amo by Ricchi e Poveri',
    'put on some lofi',
    'Play one call away.',
    'please play MKBHD iPhone review',
    'start playing jazz',
    'Stephen, play Doja Cat',
  ])('fresh: %s', (t) => expect(freshForPlay(t)).toBe(true));

  it.each([
    'play',
    'play it',
    'play that again',
    'play the first one',
    'play the next song',
    'play the song from that email',
    'pause it',
    'what should I play',
    'read me the first one',
    "what's my day",
  ])('not fresh: %s', (t) => expect(freshForPlay(t)).toBe(false));
});

class FollowUpRunner extends FakeRunner {
  active = true;
  followUp() {
    return this.active;
  }
  override endConversation() {
    super.endConversation();
    this.active = false;
  }
}

describe('Assistant: a play request ends the follow-up first', () => {
  const make = () => {
    const runner = new FollowUpRunner();
    const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {} });
    return { runner, assistant };
  };

  it('in a follow-up, "play X" ends the conversation, then runs fresh', async () => {
    const { runner, assistant } = make();
    const r = await assistant.command('play Sarà perché ti amo', { source: 'phone' });
    expect(runner.conversationEnds).toBe(1);
    expect(runner.prompts).toEqual(['play Sarà perché ti amo']);
    expect(r.followUp).toBe(false);
  });

  it('"play the first one" and other commands stay in the follow-up', async () => {
    for (const said of ['play the first one', 'read me the first one']) {
      const { runner, assistant } = make();
      const r = await assistant.command(said, { source: 'voice-ptt' });
      expect(runner.conversationEnds, said).toBe(0);
      expect(r.followUp, said).toBe(true);
    }
  });

  it('no follow-up running: nothing is ended (a pre-warmed process is kept)', async () => {
    const { runner, assistant } = make();
    runner.active = false;
    await assistant.command('play lofi', { source: 'voice-ptt' });
    expect(runner.conversationEnds).toBe(0);
  });
});
