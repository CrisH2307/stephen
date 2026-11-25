/**
 * After the wake word, once the conversation read private data, the reply is shown and not spoken (Cris, #274,
 * 2026-11-24). A bystander or a video can say the wake word. F5, typed and the phone are unchanged.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant, ON_SCREEN_MESSAGE, type CommandRunner } from '../../src/voice/assistant.js';
import type { ClaudeOutcome } from '../../src/voice/claude.js';
import { Conversation, ConversationRunner, type ResumableRunner } from '../../src/voice/conversation.js';
import type { CommandSource } from '../../src/voice/memory-router.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const BALANCE = 'Your balance is 1234 dollars.';
const TAINT = '{"version":1,"privateReads":[{"host":"bank.example","scope":"bank.example","at":1}],"trustedHosts":[]}\n';
const CLEAN = '{"version":1,"privateReads":[],"trustedHosts":[]}\n';

function make(runner: CommandRunner, o: { speak?: boolean; soundPlaying?: boolean } = {}) {
  const speaker = new RecordingSpeaker();
  const status: string[] = [];
  const assistant = new Assistant({
    runner, speaker, chimes: new RecordingChimes(), speak: o.speak ?? true, status: (l) => status.push(l),
    ...(o.soundPlaying !== undefined ? { soundPlaying: async () => o.soundPlaying! } : {}),
  });
  return { assistant, speaker, status };
}
const fixed = (out: ClaudeOutcome): CommandRunner => ({ run: async () => out, cancel: () => false });
const ok = (privateRead?: boolean | null): ClaudeOutcome => ({ kind: 'ok', text: BALANCE, sessionId: null, costUsd: 0, turns: 1, ...(privateRead !== undefined ? { privateRead } : {}) });

describe('Assistant: wake word after a private read shows the reply', () => {
  it('wake word + private read: shown, not spoken; the fixed line holds no reply text', async () => {
    const { assistant, speaker, status } = make(fixed(ok(true)));
    const r = await assistant.command('what is my balance', { source: 'voice-wake' });
    expect(speaker.said).toEqual([ON_SCREEN_MESSAGE]);
    expect(ON_SCREEN_MESSAGE).not.toContain('1234');
    expect(status).toContain(`Stephen: ${BALANCE}`); // shown in the window and Ask box as usual
    expect(r.reply).toBe(BALANCE);
  });

  it('wake word without a private read: spoken as today', async () => {
    const { assistant, speaker } = make(fixed(ok(false)));
    await assistant.command('what time is it', { source: 'voice-wake' });
    expect(speaker.said).toEqual([BALANCE]);
  });

  it('wake word, state unknown (unreadable, or a runner that does not report it): fail closed, shown', async () => {
    for (const pr of [null, undefined]) {
      const { assistant, speaker } = make(fixed(ok(pr)));
      await assistant.command('x', { source: 'voice-wake' });
      expect(speaker.said).toEqual([ON_SCREEN_MESSAGE]);
    }
  });

  it('wake word + private read, error outcome: the error is shown, not spoken', async () => {
    const { assistant, speaker } = make(fixed({ kind: 'error', message: BALANCE, sessionId: null, privateRead: true }));
    await assistant.command('x', { source: 'voice-wake' });
    expect(speaker.said).toEqual([ON_SCREEN_MESSAGE]);
  });

  it('F5 and typed + private read: spoken as today', async () => {
    for (const source of ['voice-ptt', 'cli', 'app'] as CommandSource[]) {
      const { assistant, speaker } = make(fixed(ok(true)));
      await assistant.command('x', { source });
      expect(speaker.said, source).toEqual([BALANCE]);
    }
  });

  it('typed app chat (speak: false) is unchanged: nothing is spoken, not even the fixed line', async () => {
    const { assistant, speaker } = make(fixed(ok(true)));
    await assistant.command('x', { source: 'app', speak: false });
    expect(speaker.said).toEqual([]);
  });

  it('Settings speak off is unchanged: nothing is spoken, the reply is shown', async () => {
    const { assistant, speaker, status } = make(fixed(ok(true)), { speak: false });
    await assistant.command('x', { source: 'voice-wake' });
    expect(speaker.said).toEqual([]);
    expect(status).toContain(`Stephen: ${BALANCE}`);
  });

  it('sound playing is unchanged: nothing is spoken', async () => {
    const { assistant, speaker } = make(fixed(ok(true)), { soundPlaying: true });
    await assistant.command('x', { source: 'voice-wake' });
    expect(speaker.said).toEqual([]);
  });
});

describe('Conversation.privateRead and the runner (the real state file)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const conv = (windowSec: number) => {
    dir = mkdtempSync(join(tmpdir(), 'stephen-onscreen-'));
    return new Conversation({ dir, windowSec });
  };
  const put = (c: Conversation, text: string, mode = 0o600) => {
    writeFileSync(c.statePath, text, { mode });
    chmodSync(c.statePath, mode);
  };

  it('missing: false; tainted: true; clean: false; broken JSON, invalid or wrong mode: null', () => {
    const c = conv(0);
    expect(c.privateRead()).toBe(false);
    put(c, TAINT);
    expect(c.privateRead()).toBe(true);
    put(c, CLEAN);
    expect(c.privateRead()).toBe(false);
    put(c, '{not json');
    expect(c.privateRead()).toBeNull();
    put(c, '{"version":2,"privateReads":[],"trustedHosts":[]}');
    expect(c.privateRead()).toBeNull();
    put(c, TAINT, 0o644);
    expect(c.privateRead()).toBeNull();
  });

  /** An inner runner whose serve reads private data when `taint` is set (writes the state file, as the serve does). */
  const inner = (c: Conversation, taint: () => boolean): ResumableRunner => ({
    run: async () => {
      if (taint()) put(c, TAINT);
      return { kind: 'ok', text: BALANCE, sessionId: '11111111-1111-4111-8111-111111111111', costUsd: 0, turns: 1 };
    },
    cancel: () => false,
  });

  it('follow-ups off: the taint is read before the end of the conversation deletes the file', async () => {
    const c = conv(0);
    const { assistant, speaker } = make(new ConversationRunner(inner(c, () => true), c));
    await assistant.command('open my bank page and tell me the balance', { source: 'voice-wake' });
    expect(speaker.said).toEqual([ON_SCREEN_MESSAGE]);
  });

  it('a follow-up wake command in the same tainted conversation is shown too; a fresh clean one is spoken', async () => {
    const c = conv(180);
    let first = true;
    const runner = new ConversationRunner(inner(c, () => first), c);
    const { assistant, speaker } = make(runner);
    await assistant.command('open my bank page', { source: 'voice-wake' });
    first = false;
    await assistant.command('and the savings account?', { source: 'voice-wake' }); // reads nothing new itself
    expect(speaker.said).toEqual([ON_SCREEN_MESSAGE, ON_SCREEN_MESSAGE]);
    assistant.endConversation();
    await assistant.command('what time is it', { source: 'voice-wake' });
    expect(speaker.said.at(-1)).toBe(BALANCE);
  });
});
