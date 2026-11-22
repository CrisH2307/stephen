/**
 * ADR-007 v2 (resume) through app.sock: the real AppServer, listenerQueue, Assistant, ResumeArm and HistoryStore,
 * wired as src/voice/index.ts wires them, over a runner that records what would reach the model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppServer, listenerQueue } from '../../src/app/server.js';
import type { AppSettings } from '../../src/app/settings.js';
import { RESUME_WRAPPER_HEAD, ResumeArm, conversationEntries, resumePrompt } from '../../src/history/resume.js';
import { HistoryStore } from '../../src/history/store.js';
import { Assistant, type CommandRunner, type RunHooks, type Trust } from '../../src/voice/assistant.js';
import type { ClaudeOutcome } from '../../src/voice/claude.js';
import { RecordingChimes, RecordingSpeaker } from '../voice/helpers.js';
import { TestClient } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-resume-app-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const CONV = 'c_00112233aabbccdd';

/** Records every prompt and its hooks: what would reach the model. */
class ModelRunner implements CommandRunner {
  readonly runs: { prompt: string; hooks: RunHooks }[] = [];
  ends = 0;
  async run(prompt: string, hooks: RunHooks = {}): Promise<ClaudeOutcome> {
    this.runs.push({ prompt, hooks });
    return { kind: 'ok', text: 'Sure.', sessionId: 's', costUsd: 0, turns: 1 };
  }
  cancel() {
    return false;
  }
  followUp() {
    return false;
  }
  endConversation() {
    this.ends++;
  }
}

const servers: AppServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function world() {
  const home = mkdtempSync(join(tmp, 'h-'));
  const history = new HistoryStore({ home, retentionDays: 7 });
  history.append({ source: 'voice-ptt', said: 'read my email from Dr Patel', reply: 'The exam moved to Friday.', outcome: 'ok', tools: [], followUp: false, ms: 10, turns: 1, conv: CONV });
  history.append({ source: 'voice-wake', said: 'play lofi', reply: 'Playing.', outcome: 'ok', tools: [], followUp: true, ms: 10, turns: 1, conv: CONV });
  const runner = new ModelRunner();
  let app: AppServer | null = null;
  const arm = new ResumeArm({ onChange: (on) => app?.resumeArmed(on) });
  const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {}, onStart: (c) => arm.commandStarted(c.source) });
  const listener = { idle: true, submit: (run: () => ReturnType<Assistant['command']>) => run(), cancel: () => false };
  app = new AppServer({
    home,
    queue: listenerQueue(listener, assistant, () => {
      const conv = arm.take();
      return conv ? { prompt: (m: string, trust: Trust) => resumePrompt(conversationEntries((o) => history.list(o), conv), conv, trust, m) } : null;
    }),
    listening: () => true,
    model: 'sonnet',
    memory: null,
    endConversation: () => assistant.endConversation(),
    history,
    audit: null,
    settings: () => ({}) as AppSettings,
    speakReplies: false,
    openWindow: () => null,
    resume: {
      arm: (conv) => {
        if (conversationEntries((o) => history.list(o), conv).length === 0) return 'That conversation is no longer saved.';
        arm.arm(conv);
        return null;
      },
      cancel: () => arm.clear(),
      armed: () => arm.armed,
    },
  });
  await app.start();
  servers.push(app);
  const connect = async (hello: boolean) => {
    const c = await TestClient.connect(app!.socketPath);
    clients.push(c);
    if (hello) await c.request({ id: 'h', type: 'hello', version: '1', confirms: true });
    return c;
  };
  return { runner, arm, assistant, app, connect, window: await connect(true) };
}

describe('ADR-007 v2 resume through app.sock', () => {
  it('clicking "Open in chat" alone sends nothing to the model', async () => {
    const w = await world();
    expect(await w.window.request({ id: 'r1', type: 'chat.resume', conv: CONV })).toEqual({ id: 'r1', type: 'ok' });
    expect(await w.window.waitFor((m) => m.type === 'resume' && m.armed === true)).toEqual({ type: 'resume', armed: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(w.runner.runs).toEqual([]);
    expect(w.runner.ends).toBe(0);
    expect(w.arm.armed).toBe(true);
  });

  it('the window\'s next message carries it: a fresh conversation, the wrapper, --assume-private-read, the owner\'s words in history', async () => {
    const w = await world();
    await w.window.request({ id: 'r1', type: 'chat.resume', conv: CONV });
    await w.window.request({ id: 's1', type: 'chat.send', text: 'what day was the exam again?' });
    await w.window.waitFor((m) => m.type === 'resume' && m.armed === false);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.runner.runs).toHaveLength(1);
    const { prompt, hooks } = w.runner.runs[0]!;
    expect(hooks).toMatchObject({ trust: 'trusted', assumePrivateRead: true });
    expect(prompt.startsWith(RESUME_WRAPPER_HEAD)).toBe(true);
    expect(prompt).toContain('You: read my email from Dr Patel');
    expect(prompt).toContain('You (wake word): play lofi');
    expect(prompt.endsWith('\n\nwhat day was the exam again?')).toBe(true);
    expect(w.runner.ends).toBe(1); // the current conversation ended first
    // Used once: the next message is an ordinary one.
    await w.window.request({ id: 's2', type: 'chat.send', text: 'thanks' });
    await new Promise((r) => setTimeout(r, 50));
    expect(w.runner.runs[1]).toEqual({ prompt: 'thanks', hooks: expect.not.objectContaining({ assumePrivateRead: true }) });
  });

  it('the armed resume is cleared by a non-window command (wake word, F5, phone, --text) and never used by it', async () => {
    for (const source of ['voice-wake', 'voice-ptt', 'phone', 'cli'] as const) {
      const w = await world();
      await w.window.request({ id: 'r1', type: 'chat.resume', conv: CONV });
      await w.assistant.command('what was that about', { source });
      expect(w.runner.runs[0]!.prompt, source).toBe('what was that about');
      expect(w.runner.runs[0]!.hooks.assumePrivateRead, source).toBeUndefined();
      expect(w.arm.armed, source).toBe(false);
      await w.window.waitFor((m) => m.type === 'resume' && m.armed === false);
      // The window's next message is then an ordinary one too.
      await w.window.request({ id: 's1', type: 'chat.send', text: 'hello' });
      await new Promise((r) => setTimeout(r, 30));
      expect(w.runner.runs[1]!.prompt, source).toBe('hello');
    }
  });

  it('the armed resume is cleared by New chat / Cancel (chat.resume.cancel)', async () => {
    const w = await world();
    await w.window.request({ id: 'r1', type: 'chat.resume', conv: CONV });
    expect(await w.window.request({ id: 'c1', type: 'chat.resume.cancel' })).toEqual({ id: 'c1', type: 'ok' });
    expect(w.arm.armed).toBe(false);
    await w.window.request({ id: 's1', type: 'chat.send', text: 'hello' });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.runner.runs[0]!.prompt).toBe('hello');
  });

  it('a chat.send from a non-window socket does not take the arm', async () => {
    const w = await world();
    await w.window.request({ id: 'r1', type: 'chat.resume', conv: CONV });
    const other = await w.connect(false); // no hello with confirms: not the window
    await other.request({ id: 'o1', type: 'chat.send', text: 'what was that about' });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.runner.runs[0]).toEqual({ prompt: 'what was that about', hooks: expect.not.objectContaining({ assumePrivateRead: true }) });
    expect(w.arm.armed).toBe(true); // still waiting for the window
    await w.window.request({ id: 's1', type: 'chat.send', text: 'and the exam?' });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.runner.runs[1]!.hooks.assumePrivateRead).toBe(true);
  });

  it('only the window may arm: refused from a connection without hello confirms and from a gate (serve) connection', async () => {
    const w = await world();
    const plain = await w.connect(false);
    expect(await plain.request({ id: 'p1', type: 'chat.resume', conv: CONV })).toMatchObject({ id: 'p1', type: 'error' });
    const gate = await w.connect(true);
    gate.send({ id: 'g0', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await gate.request({ id: 'g1', type: 'chat.resume', conv: CONV })).toMatchObject({ id: 'g1', type: 'error' });
    expect(await gate.request({ id: 'g2', type: 'chat.resume.cancel' })).toMatchObject({ id: 'g2', type: 'error' });
    expect(w.arm.armed).toBe(false);
    // A bad or unknown conversation id arms nothing.
    expect(await w.window.request({ id: 'b1', type: 'chat.resume', conv: '../../etc' })).toMatchObject({ id: 'b1', type: 'error' });
    expect(await w.window.request({ id: 'b2', type: 'chat.resume', conv: 'c_ffffffffffffffff' })).toEqual({ id: 'b2', type: 'error', message: 'That conversation is no longer saved.' });
    expect(w.arm.armed).toBe(false);
    expect(w.runner.runs).toEqual([]);
  });
});
