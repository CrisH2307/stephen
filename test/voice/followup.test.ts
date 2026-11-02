/**
 * Follow-up conversations (src/voice/conversation.ts): the window logic, resets on error / cancel / Esc /
 * "Stephen stop", the state file being deleted whenever a conversation ends, and window 0 = every command fresh.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Assistant } from '../../src/voice/assistant.js';
import type { ClaudeOutcome, RunOptions } from '../../src/voice/claude.js';
import { CONVERSATION_FILE, Conversation, ConversationRunner, type ResumableRunner } from '../../src/voice/conversation.js';
import { HelperBridge, assistantHooks } from '../../src/voice/helper-link.js';
import { Listener, type ListenerOptions } from '../../src/voice/listener.js';
import { FakeHelper, FakeRunner, FakeTranscriber, FakeVad, ScriptedSource, ScriptedSpotter, frames } from './fakes.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-followup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(tmp, `voice-${++n}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

const OK = (sessionId: string | null = 'sess-1'): ClaudeOutcome => ({ kind: 'ok', text: 'ok', sessionId, costUsd: 0, turns: 1 });

/** Records the RunOptions of every run and answers with a scripted outcome. */
class ScriptRunner implements ResumableRunner {
  readonly calls: { prompt: string; run: RunOptions }[] = [];
  next: ClaudeOutcome | (() => ClaudeOutcome) | Error = OK();
  async run(prompt: string, run: RunOptions = {}): Promise<ClaudeOutcome> {
    this.calls.push({ prompt, run });
    const n = this.next;
    if (n instanceof Error) throw n;
    return typeof n === 'function' ? n() : n;
  }
  cancel() {
    return true;
  }
  resumes() {
    return this.calls.map((c) => c.run.resume ?? null);
  }
}

function harness(windowSec = 180) {
  const dir = freshDir();
  let clock = 1_700_000_000_000;
  const logs: string[] = [];
  const conv = new Conversation({ dir, windowSec, now: () => clock, log: (l) => logs.push(l) });
  const inner = new ScriptRunner();
  const runner = new ConversationRunner(inner, conv);
  const plantState = () => writeFileSync(conv.statePath, '{"version":1,"privateReads":[{"host":"mail.google.com","scope":"mail.google.com","at":1}],"trustedHosts":[]}\n', { mode: 0o600 });
  return { dir, conv, inner, runner, logs, plantState, tick: (ms: number) => (clock += ms), now: () => clock };
}

describe('Conversation: the follow-up window', () => {
  it('the first command is fresh; one within the window resumes the previous session id; the window counts from the END', async () => {
    const h = harness(180);
    await h.runner.run('how long from my house to tmu station downtown');
    h.tick(180_000); // exactly at the edge: still in
    h.inner.next = OK('sess-1'); // claude keeps the id when resuming
    await h.runner.run('follow up');
    h.tick(120_000);
    await h.runner.run('what about by car');
    expect(h.inner.resumes()).toEqual([null, 'sess-1', 'sess-1']);
    const saved = JSON.parse(readFileSync(join(h.dir, CONVERSATION_FILE), 'utf8'));
    expect(saved).toEqual({ sessionId: 'sess-1', endedAt: h.now(), trust: 'wake' }); // no trust given: the cautious one
    expect(statSync(join(h.dir, CONVERSATION_FILE)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['trusted', 'wake'],
    ['wake', 'trusted'],
  ] as const)('R7-2: one-shot: a %s conversation is never resumed by a %s command (no --resume, state file gone)', async (first, second) => {
    const h = harness(180);
    await h.runner.run('read me my latest email', { trust: first });
    h.plantState();
    h.tick(10_000);
    expect(h.runner.followUp(second)).toBe(false); // begin() for that trust: reset now
    expect(existsSync(h.conv.statePath)).toBe(false);
    await h.runner.run('what did it say', { trust: second });
    h.tick(10_000);
    h.inner.next = OK('sess-1');
    await h.runner.run('and the one before', { trust: second }); // same trust: resumes
    expect(h.inner.resumes()).toEqual([null, null, 'sess-1']);
    expect(h.inner.calls.map((c) => c.run.trust)).toEqual([first, second, second]);
    expect(JSON.parse(readFileSync(join(h.dir, CONVERSATION_FILE), 'utf8')).trust).toBe(second);
    // A followUp() planned for one trust never carries over to a run of the other.
    expect(h.runner.followUp(second)).toBe(true);
    await h.runner.run('open it', { trust: first });
    expect(h.inner.resumes().at(-1)).toBe(null);
  });

  it('R7-2: a saved conversation without a trust (older file) is never resumed', async () => {
    const h = harness(180);
    writeFileSync(join(h.dir, CONVERSATION_FILE), JSON.stringify({ sessionId: 'sess-old', endedAt: h.now() }), { mode: 0o600 });
    expect(h.conv.peek('trusted')).toBe(null);
    expect(h.conv.peek('wake')).toBe(null);
  });

  it('after the window expires: no --resume, the state file is deleted, no session id held', async () => {
    const h = harness(180);
    await h.runner.run('one');
    h.plantState(); // a server of this conversation noted a private read
    h.tick(180_001);
    await h.runner.run('two');
    expect(h.inner.resumes()).toEqual([null, null]);
    expect(existsSync(h.conv.statePath)).toBe(false);
  });

  it('touch() (reply finished) moves the end forward; it never revives an ended conversation', async () => {
    const h = harness(60);
    await h.runner.run('one');
    h.tick(50_000);
    h.runner.commandEnded(); // the reply took 50 s to speak
    h.tick(59_000);
    await h.runner.run('two');
    expect(h.inner.resumes()).toEqual([null, 'sess-1']);
    h.runner.endConversation();
    h.runner.commandEnded();
    expect(existsSync(join(h.dir, CONVERSATION_FILE))).toBe(false);
  });

  it.each([
    ['an error result', { kind: 'error', message: 'x', sessionId: 'sess-1' } as ClaudeOutcome],
    ['a cancelled run', { kind: 'cancelled' } as ClaudeOutcome],
    ['an OK result without a session id', OK(null)],
  ])('%s ends the conversation (state file deleted, next command fresh)', async (_what, outcome) => {
    const h = harness();
    await h.runner.run('one');
    h.inner.next = outcome;
    h.plantState();
    await h.runner.run('two');
    expect(existsSync(h.conv.statePath)).toBe(false);
    expect(existsSync(join(h.dir, CONVERSATION_FILE))).toBe(false);
    h.inner.next = OK('sess-9');
    h.plantState();
    await h.runner.run('three');
    expect(h.inner.resumes()).toEqual([null, 'sess-1', null]);
    expect(existsSync(h.conv.statePath)).toBe(false);
  });

  it('a runner that throws ends the conversation too', async () => {
    const h = harness();
    await h.runner.run('one');
    h.inner.next = new Error('spawn failed');
    await expect(h.runner.run('two')).rejects.toThrow(/spawn failed/);
    h.inner.next = OK();
    await h.runner.run('three');
    expect(h.inner.resumes()).toEqual([null, 'sess-1', null]);
  });

  it('endConversation (Esc / "Stephen stop") deletes the state file and forgets the session at once', async () => {
    const h = harness();
    await h.runner.run('one');
    h.plantState();
    expect(h.runner.followUp()).toBe(true); // decided…
    h.runner.endConversation(); // …then Esc: the decision is dropped too
    expect(existsSync(h.conv.statePath)).toBe(false);
    await h.runner.run('two');
    expect(h.inner.resumes()).toEqual([null, null]);
  });

  it('a new conversation resets a leftover state file BEFORE claude starts', async () => {
    const h = harness();
    h.plantState();
    h.inner.next = () => {
      expect(existsSync(h.conv.statePath)).toBe(false);
      return OK();
    };
    await h.runner.run('one');
    expect(h.inner.calls).toHaveLength(1);
  });

  it('window 0: every command fresh, nothing saved', async () => {
    const h = harness(0);
    await h.runner.run('one');
    await h.runner.run('two');
    expect(h.inner.resumes()).toEqual([null, null]);
    expect(h.runner.followUp()).toBe(false);
    expect(existsSync(join(h.dir, CONVERSATION_FILE))).toBe(false);
  });

  it('a damaged, foreign-mode or future-dated conversation file is never resumed', async () => {
    for (const [content, mode] of [
      ['not json', 0o600],
      ['{"sessionId":"-p","endedAt":1700000000000}', 0o600],
      ['{"sessionId":"sess-1","endedAt":1700000000000,"x":1}', 0o600],
      ['{"sessionId":"sess-1","endedAt":1700000000000}', 0o644],
      ['{"sessionId":"sess-1","endedAt":1700000999999}', 0o600], // in the future
    ] as const) {
      const h = harness();
      writeFileSync(join(h.dir, CONVERSATION_FILE), content, { mode });
      await h.runner.run('x');
      expect(h.inner.resumes(), content).toEqual([null]);
    }
  });

  it('a reset that fails stops the command (never runs with a stale state file)', async () => {
    const h = harness();
    mkdirSync(h.conv.statePath); // unlink() of a folder fails
    writeFileSync(join(h.conv.statePath, 'x'), '');
    await expect(h.runner.run('one')).rejects.toThrow();
    expect(h.inner.calls).toEqual([]);
  });
});

describe('Assistant: "(follow-up)" status', () => {
  it('prints Working… (follow-up) only when resuming, speaks nothing extra', async () => {
    const h = harness();
    const lines: string[] = [];
    const speaker = new RecordingSpeaker();
    const a = new Assistant({ runner: h.runner, speaker, chimes: new RecordingChimes(), speak: true, status: (l) => lines.push(l) });
    await a.handle('one');
    await a.handle('two');
    expect(lines.filter((l) => l.startsWith('Working'))).toEqual(['Working…', 'Working… (follow-up)']);
    expect(speaker.said).toEqual(['ok', 'ok']);
    expect(h.inner.resumes()).toEqual([null, 'sess-1']);
  });
});

// ───────────── Listener: Esc / "Stephen stop" / cancels end the conversation ─────────────

const OPTS: ListenerOptions = { wakePhrase: 'hey stephen', stopPhrase: 'stephen stop', silenceSec: 0.8, maxCommandSec: 12, noSpeechTimeoutSec: 5, verifyWake: true, once: false };

function listen(pattern: string, hits: Record<number, 'WAKE' | 'STOP' | 'WAKE_BARE'>, texts: string[], gates: (t: { fake: FakeHelper; runner: FakeRunner }) => [number, () => void | Promise<void>][] = () => [], runner = new FakeRunner()) {
  const fake = new FakeHelper();
  const bridge = new HelperBridge(fake);
  const chimes = new RecordingChimes();
  const lines: string[] = [];
  const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes, speak: true, status: (l) => lines.push(l), ...assistantHooks(bridge) });
  const g = new Map<number, () => Promise<void>>();
  for (const [i, fn] of gates({ fake, runner })) g.set(i, async () => fn());
  const listener = new Listener(OPTS, { source: new ScriptedSource(frames(pattern), g), spotter: new ScriptedSpotter(hits), vad: new FakeVad(), transcriber: new FakeTranscriber(texts), assistant, chimes, status: (l) => lines.push(l), helper: bridge });
  return { listener, runner, lines };
}

describe('Listener: ending the conversation', () => {
  it('Esc while idle ends the conversation (and cancels nothing)', async () => {
    const t = listen('.'.repeat(40), {}, [], ({ fake }) => [[10, () => fake.emit({ type: 'esc', at: Date.now() })]]);
    await t.listener.run();
    expect(t.runner.conversationEnds).toBe(1);
    expect(t.runner.cancels).toBe(0);
  });

  it('"Stephen stop" while idle ends the conversation', async () => {
    const t = listen('.'.repeat(40), { 10: 'STOP' }, []);
    await t.listener.run();
    expect(t.runner.conversationEnds).toBe(1);
  });

  it('a bare "Stephen, stop" transcript ends it too', async () => {
    const t = listen('.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40), { 12: 'WAKE_BARE' }, ['Steven, stop.']);
    await t.listener.run();
    expect(t.runner.prompts).toEqual([]);
    expect(t.lines).toContain('Heard "stephen stop" — nothing to stop.');
    expect(t.runner.conversationEnds).toBe(1);
  });

  it('Esc during a run cancels it and ends the conversation; a normal command does not', async () => {
    const runner = new FakeRunner(true);
    const t = listen(
      '.'.repeat(10) + 's'.repeat(20) + '.'.repeat(100),
      { 12: 'WAKE' },
      ['hey stephen play a long podcast'],
      ({ fake }) => [
        [
          90,
          async () => {
            const { waitFor } = await import('./helpers.js');
            await waitFor(() => runner.pending, 5000, 'claude running');
            fake.emit({ type: 'esc', at: Date.now() });
          },
        ],
      ],
      runner,
    );
    await t.listener.run();
    expect(runner.cancels).toBe(1);
    expect(runner.conversationEnds).toBeGreaterThanOrEqual(1);

    const ok = listen('.'.repeat(10) + 's'.repeat(20) + '.'.repeat(40), { 12: 'WAKE' }, ['hey stephen open youtube']);
    await ok.listener.run();
    expect(ok.runner.prompts).toEqual(['open youtube']);
    expect(ok.runner.conversationEnds).toBe(0);
    expect(ok.runner.commandEnds).toBe(1);
  });
});
