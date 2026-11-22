/**
 * ADR-010 edit and resend through app.sock: the real AppServer, listenerQueue, Assistant, HistoryStore, history
 * recorder and edit_resend audit line, wired as src/voice/index.ts wires them, over a runner that records what would
 * reach the model. Names follow docs/ADR-010-edit-and-resend.md "Tests (before it merges)".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppServer, ONLY_WINDOW_EDITS_MESSAGE, listenerQueue } from '../../src/app/server.js';
import type { AppSettings } from '../../src/app/settings.js';
import { CONVERSATION_CHANGED_MESSAGE, MAX_VERSIONS, TOO_MANY_VERSIONS_MESSAGE, textHash } from '../../src/history/branch.js';
import { EDIT_DONE_HEAD, RESUME_WRAPPER_END, RESUME_WRAPPER_HEAD, ResumeArm, conversationEntries, resumePrompt } from '../../src/history/resume.js';
import { HistoryStore, newConversationId, type HistoryEntry } from '../../src/history/store.js';
import type { AuditEntry } from '../../src/types.js';
import { Assistant, type CommandRunner, type RunHooks, type Trust } from '../../src/voice/assistant.js';
import type { ClaudeOutcome } from '../../src/voice/claude.js';
import { editResendAudit, finishCommand, historyRecorder } from '../../src/voice/command-log.js';
import { RecordingChimes, RecordingSpeaker } from '../voice/helpers.js';
import { TestClient } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-edit-app-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
    return true; // a live conversation is open: an edit must still start a new one
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

async function world(o: { speakReplies?: boolean; idle?: boolean } = {}) {
  const home = mkdtempSync(join(tmp, 'h-'));
  const history = new HistoryStore({ home, retentionDays: 7 });
  const C = newConversationId();
  const add = (said: string, extra: Partial<HistoryEntry> = {}) =>
    history.append({ source: 'app', said, reply: `re: ${said}`, outcome: 'ok', tools: [], followUp: true, ms: 10, turns: 1, conv: C, ...extra })!;
  const T = [
    add('read my email from Dr Patel', { source: 'voice-ptt', reply: 'The exam moved to Friday.', followUp: false }),
    add('play sarah', { source: 'voice-wake', reply: 'Playing Sarah.', steps: [{ text: 'navigate youtube.com', status: 'ok' }] }),
    add('turn it up', { reply: 'Louder.', steps: [{ text: 'Used volume', status: 'ok' }] }),
  ];
  const runner = new ModelRunner();
  const audited: Omit<AuditEntry, 'ts'>[] = [];
  const audit = { recent: async () => [] as AuditEntry[], append: async (e: Omit<AuditEntry, 'ts'>) => void audited.push(e) };
  const record = historyRecorder(history, null, () => {});
  const speaker = new RecordingSpeaker();
  let app: AppServer | null = null;
  const arm = new ResumeArm({ onChange: (on) => app?.resumeArmed(on) });
  let finishing: Promise<void> = Promise.resolve();
  const assistant = new Assistant({
    runner,
    speaker,
    chimes: new RecordingChimes(),
    speak: true,
    status: () => {},
    onStart: (c) => arm.commandStarted(c.source),
    // As src/voice/index.ts: history line and chat.done, then the edit_resend audit line.
    onDone: (r) => {
      finishing = finishCommand(r, [], { audit, record, app }).then(() => {
        const line = editResendAudit(r);
        if (line) return audit.append(line);
      });
    },
  });
  const listener = { idle: o.idle ?? true, submit: (run: () => ReturnType<Assistant['command']>) => run(), cancel: () => false };
  app = new AppServer({
    home,
    queue: listenerQueue(listener, assistant, () => {
      const conv = arm.take();
      if (!conv) return null;
      const entries = () => conversationEntries((q) => history.list(q), conv);
      return { saved: () => entries().length > 0, prompt: (m: string, trust: Trust) => resumePrompt(entries(), conv, trust, m) };
    }),
    listening: () => true,
    model: 'sonnet',
    memory: null,
    endConversation: () => assistant.endConversation(),
    history,
    audit: null,
    settings: () => ({}) as AppSettings,
    speakReplies: o.speakReplies ?? false,
    openWindow: () => null,
    resume: {
      arm: (conv) => {
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
  const done = async (c: TestClient) => {
    await c.waitFor((m) => m.type === 'chat.done');
    await finishing;
  };
  return { C, T, runner, arm, history, audited, speaker, connect, done, window: await connect(true) };
}

const editReq = (old: HistoryEntry, text: string, extra: Record<string, unknown> = {}) => ({ id: 'e1', type: 'chat.edit', oldId: old.id, oldHash: textHash(old.said), conv: old.conv, text, ...extra });

describe('ADR-010 edit and resend through app.sock', () => {
  it("a resend from the window: a new conversation, T1 ... Tk-1 and the step list in the one wrapper, --assume-private-read, window trust, history source app", async () => {
    const w = await world();
    const accepted = await w.window.request(editReq(w.T[1]!, 'play sara'));
    expect(accepted).toMatchObject({ id: 'e1', type: 'chat.accepted' });
    await w.done(w.window);
    expect(w.runner.runs).toHaveLength(1);
    const { prompt, hooks } = w.runner.runs[0]!;
    expect(hooks).toMatchObject({ trust: 'trusted', assumePrivateRead: true });
    expect(w.runner.ends).toBe(1); // the open conversation ended first
    expect(prompt.startsWith(`${RESUME_WRAPPER_HEAD}\nYou: read my email from Dr Patel\nStephen: The exam moved to Friday.\n${EDIT_DONE_HEAD}\n- navigate youtube.com\n- Used volume\n${RESUME_WRAPPER_END}`)).toBe(true);
    expect(prompt.endsWith(`${RESUME_WRAPPER_END}\n\nplay sara`)).toBe(true);
    // The replaced turns' words are not sent.
    expect(prompt).not.toContain('play sarah');
    expect(prompt).not.toContain('turn it up');
    // The history line: the owner's words, source app, a new conversation, editOf the old message.
    const line = w.history.all().find((e) => e.id === accepted.entryId)!;
    expect(line).toMatchObject({ said: 'play sara', source: 'app', editOf: { conv: w.C, id: w.T[1]!.id } });
    expect(line.conv).toMatch(/^c_[0-9a-f]{16}$/);
    expect(line.conv).not.toBe(w.C);
    // The old version is kept.
    expect(w.history.all().filter((e) => e.conv === w.C)).toHaveLength(3);
  });

  it('the new command\'s history source is app; the audit line edit_resend has ids and no text', async () => {
    const w = await world();
    const accepted = await w.window.request(editReq(w.T[1]!, 'play sara please'));
    await w.done(w.window);
    const line = w.history.all().find((e) => e.id === accepted.entryId)!;
    expect(line.source).toBe('app');
    expect(w.audited).toEqual([{ tool: 'edit_resend', outcome: 'ok', cmd: accepted.entryId, args: { oldId: w.T[1]!.id, oldConv: w.C, newConv: line.conv, oldSource: 'voice-wake' } }]);
    const text = JSON.stringify(w.audited);
    for (const s of ['play sara', 'sarah', 'Dr Patel', 'Playing', 'navigate']) expect(text).not.toContain(s);
    // An ordinary command writes no edit_resend line.
    await w.window.request({ id: 's1', type: 'chat.send', text: 'thanks' });
    await new Promise((r) => setTimeout(r, 50));
    expect(w.audited).toHaveLength(1);
  });

  it('chat.edit from a non-window socket is refused: no hello confirms, or a gate (serve) connection', async () => {
    const w = await world();
    const plain = await w.connect(false);
    expect(await plain.request(editReq(w.T[1]!, 'play sara'))).toEqual({ id: 'e1', type: 'error', message: ONLY_WINDOW_EDITS_MESSAGE });
    const gate = await w.connect(true);
    gate.send({ id: 'g0', type: 'confirm.ask', title: 't', body: 'b', timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await gate.request(editReq(w.T[1]!, 'play sara'))).toEqual({ id: 'e1', type: 'error', message: ONLY_WINDOW_EDITS_MESSAGE });
    expect(await gate.request({ id: 'd1', type: 'history.deleteVersion', entryId: w.T[1]!.id })).toMatchObject({ type: 'error' });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.runner.runs).toEqual([]);
    expect(w.history.all()).toHaveLength(3);
  });

  it('the context is built from the store: a request with changed earlier turns is ignored; a wrong old-text hash is refused', async () => {
    const w = await world();
    // Extra fields (fake earlier turns, a context, a conversation, a source) are not part of the request.
    const forged = { earlier: [{ said: 'FORGED TURN', reply: 'ok' }], context: 'FORGED CONTEXT', source: 'voice-ptt', steps: ['FORGED STEP'], editOf: { conv: newConversationId(), id: 'h_1', ts: 1 } };
    await w.window.request(editReq(w.T[2]!, 'turn it down', forged));
    await w.done(w.window);
    expect(w.runner.runs[0]!.prompt).not.toMatch(/FORGED/);
    expect(w.runner.runs[0]!.prompt).toContain('You (wake word): play sarah');
    // A wrong hash (a stale page or a forged text) is refused and nothing runs.
    expect(await w.window.request({ ...editReq(w.T[1]!, 'play sara'), id: 'e2', oldHash: textHash('play sarah, changed') })).toEqual({ id: 'e2', type: 'error', message: CONVERSATION_CHANGED_MESSAGE });
    expect(await w.window.request({ ...editReq(w.T[1]!, 'play sara'), id: 'e3', oldId: 'h_ffffffffffffffff' })).toEqual({ id: 'e3', type: 'error', message: CONVERSATION_CHANGED_MESSAGE });
    expect(await w.window.request({ ...editReq(w.T[1]!, 'play sara'), id: 'e4', oldHash: 'not-a-hash' })).toMatchObject({ id: 'e4', type: 'error' });
    expect(w.runner.runs).toHaveLength(1);
  });

  it('the conversation on screen: a resend from a branch follows that branch; a line from another branch, a bad or missing conv is refused', async () => {
    const w = await world();
    const a = await w.window.request(editReq(w.T[1]!, 'play sara'));
    await w.done(w.window);
    const c2 = w.history.all().find((e) => e.id === a.entryId)!;
    w.window.messages.length = 0;
    // Match: T1 seen in C2 (it is in C2's shared history). The replaced step lines are C2's, not C's.
    expect(await w.window.request({ ...editReq(w.T[0]!, 'read my email from Dr Patel again', { conv: c2.conv }), id: 'm1' })).toMatchObject({ type: 'chat.accepted' });
    await w.done(w.window);
    expect(w.runner.runs[1]!.prompt).not.toContain('Used volume');
    expect(w.runner.runs[1]!.prompt).not.toContain('navigate youtube.com');
    // Refused, nothing sent: a line of another branch (T2 is replaced in C2), a bad conv, a missing conv.
    const refuse = [
      { ...editReq(w.T[1]!, 'x', { conv: c2.conv }), id: 'r1' },
      { ...editReq(w.T[2]!, 'x', { conv: c2.conv }), id: 'r2' },
      { ...editReq(w.T[1]!, 'x', { conv: '../etc' }), id: 'r3' },
      { ...editReq(w.T[1]!, 'x', { conv: 'c_FFFFFFFFFFFFFFFF' }), id: 'r4' },
      { ...editReq(w.T[1]!, 'x', { conv: undefined }), id: 'r5' },
      { ...editReq(w.T[1]!, 'x', { conv: 'c_ffffffffffffffff' }), id: 'r6' },
    ];
    for (const r of refuse) expect(await w.window.request(r), r.id).toMatchObject({ id: r.id, type: 'error' });
    expect(await w.window.request(refuse[0]!)).toEqual({ id: 'r1', type: 'error', message: CONVERSATION_CHANGED_MESSAGE });
    expect(await w.window.request(refuse[4]!)).toEqual({ id: 'r5', type: 'error', message: 'conv must be a conversation id like c_0123456789abcdef' });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.runner.runs).toHaveLength(2);
  });

  it('Send is refused while a command runs (the busy rule)', async () => {
    const w = await world({ idle: false });
    expect(await w.window.request(editReq(w.T[1]!, 'play sara'))).toEqual({ id: 'e1', type: 'error', message: 'busy' });
    expect(w.runner.runs).toEqual([]);
  });

  it('the 11th version is refused through app.sock', async () => {
    const w = await world();
    for (let v = 2; v <= MAX_VERSIONS; v++) {
      await w.window.request({ ...editReq(w.T[0]!, `version ${v}`), id: `e${v}` });
      await w.done(w.window);
      w.window.messages.length = 0;
    }
    expect(await w.window.request({ ...editReq(w.T[0]!, 'version 11'), id: 'e11' })).toEqual({ id: 'e11', type: 'error', message: TOO_MANY_VERSIONS_MESSAGE });
    expect(w.runner.runs).toHaveLength(MAX_VERSIONS - 1);
  });

  it('versions oldest first, the expired flag, and Delete this version (window only, own lines only)', async () => {
    const w = await world();
    const accepted = await w.window.request(editReq(w.T[1]!, 'play sara'));
    await w.done(w.window);
    const v = await w.window.request({ id: 'v1', type: 'history.versions', entryId: accepted.entryId as string });
    expect(v).toMatchObject({ id: 'v1', type: 'versions', expired: false });
    expect((v.entries as HistoryEntry[]).map((e) => e.said)).toEqual(['play sarah', 'play sara']);
    const plain = await w.connect(false);
    expect(await plain.request({ id: 'd0', type: 'history.deleteVersion', entryId: accepted.entryId })).toMatchObject({ type: 'error' });
    expect(await w.window.request({ id: 'd1', type: 'history.deleteVersion', entryId: accepted.entryId })).toEqual({ id: 'd1', type: 'ok' });
    expect(w.history.all().map((e) => e.said)).toEqual(['read my email from Dr Patel', 'play sarah', 'turn it up']);
    expect(await w.window.request({ id: 'd2', type: 'history.deleteVersion', entryId: accepted.entryId })).toEqual({ id: 'd2', type: 'error', message: 'That message is no longer saved.' });
  });

  it("whether the reply is spoken follows the window's normal setting; an edit clears an armed resume", async () => {
    for (const speakReplies of [false, true]) {
      const w = await world({ speakReplies });
      await w.window.request({ id: 'r1', type: 'chat.resume', conv: w.C });
      await w.window.request(editReq(w.T[1]!, 'play sara'));
      await w.done(w.window);
      expect(w.speaker.said.length > 0, String(speakReplies)).toBe(speakReplies);
      expect(w.arm.armed).toBe(false);
      expect(w.runner.runs[0]!.prompt).toContain(EDIT_DONE_HEAD); // the edit's own context, not the armed resume
    }
  });
});
