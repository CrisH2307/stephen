/**
 * Typed chat through app.sock in the real voice queue: AppServer + listenerQueue + the real Listener, Assistant,
 * memory router, memory and history stores, wired like runListen does (fake audio, ASR and Claude runner).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AppServer, listenerQueue } from '../../src/app/server.js';
import { appMediaKey } from '../../src/desktop/media-key.js';
import { appSettings } from '../../src/app/settings.js';
import { parseAppConfig } from '../../src/app/config.js';
import { parseHistoryConfig } from '../../src/history/config.js';
import { HistoryStore } from '../../src/history/store.js';
import { parseMemoryConfig } from '../../src/memory/config.js';
import { MemoryStore } from '../../src/memory/store.js';
import type { ConfirmOutcome, Confirmer } from '../../src/types.js';
import { Assistant, type CommandReport } from '../../src/voice/assistant.js';
import type { AudioSource } from '../../src/voice/audio.js';
import { historyRecorder } from '../../src/voice/command-log.js';
import { parseVoiceConfig } from '../../src/voice/config.js';
import { HelperBridge, assistantHooks } from '../../src/voice/helper-link.js';
import { Listener } from '../../src/voice/listener.js';
import { MemoryRouter } from '../../src/voice/memory-router.js';
import { FakeHelper, FakeRunner, FakeTranscriber, FakeVad, FRAME, SPEECH, ScriptedSpotter } from '../voice/fakes.js';
import { RecordingChimes, RecordingSpeaker, waitFor } from '../voice/helpers.js';
import { TestClient, sleep } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-app-listen-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Live-like audio: silence (or speech while `speaking`) until stopped. */
class EndlessSource implements AudioSource {
  readonly label = 'endless';
  speaking = false;
  private stopped = false;
  async start() {}
  async read() {
    if (this.stopped) return null;
    await sleep(1);
    const f = new Float32Array(FRAME);
    f[0] = this.speaking ? SPEECH : 0;
    return f;
  }
  async stop() {
    this.stopped = true;
  }
}

class CountingConfirmer implements Confirmer {
  readonly kind = 'fake';
  asked = 0;
  async confirm(): Promise<ConfirmOutcome> {
    this.asked++;
    return 'approved';
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(o: { hold?: boolean; texts?: string[] } = {}) {
  const home = mkdtempSync(join(tmp, 'h-'));
  const store = new MemoryStore({ home });
  const history = new HistoryStore({ home, retentionDays: 1 });
  const confirmer = new CountingConfirmer();
  const runner = new FakeRunner(o.hold ?? false);
  const speaker = new RecordingSpeaker();
  const chimes = new RecordingChimes();
  const fake = new FakeHelper();
  const bridge = new HelperBridge(fake);
  const router = new MemoryRouter({ store, confirmWakeWord: true, confirmer });
  const record = historyRecorder(history, () => [{ tool: 'open_url', isError: false, ms: 3 }, { tool: 'open_url', isError: false, ms: 4 }], () => {});
  let app: AppServer | null = null;
  const hooks = assistantHooks(bridge);
  const assistant = new Assistant({
    runner,
    speaker,
    chimes,
    speak: true,
    status: () => {},
    memory: router,
    onDone: (r: CommandReport) => {
      record(r);
      app?.commandDone(r, r.ranClaude ? ['open_url', 'open_url'] : []);
    },
    onStart: (c) => app?.heard(c.said, c.source),
    ...hooks,
    onPhase: (p) => {
      hooks.onPhase?.(p);
      if (p === 'running') app?.setState('working');
      else if (p === 'speaking') app?.setState('speaking');
    },
  });
  const source = new EndlessSource();
  const listener = new Listener(
    { wakePhrase: 'hey stephen', silenceSec: 0.8, maxCommandSec: 12, noSpeechTimeoutSec: 5, verifyWake: true, once: false, cooldownSec: 0 },
    { source, spotter: new ScriptedSpotter({}), vad: new FakeVad(), transcriber: new FakeTranscriber(o.texts ?? []), assistant, chimes, status: () => {}, helper: bridge, onState: (s) => app?.setState(s) },
  );
  app = new AppServer({
    home,
    queue: listenerQueue(listener, assistant),
    listening: () => true,
    model: 'sonnet',
    memory: store,
    endConversation: () => assistant.endConversation(),
    history,
    audit: null,
    settings: () => appSettings({ voice: parseVoiceConfig({}), memory: parseMemoryConfig({}), history: parseHistoryConfig({}), app: parseAppConfig({}), configPath: '/x/config.json' }),
    speakReplies: false,
    openWindow: () => (bridge.openWindow() ? null : 'no helper'),
    mediaKey: async (action) => {
      const r = await bridge.media(action);
      return r.ok ? null : r.reason;
    },
  });
  await app.start();
  const running = listener.run();
  const client = await TestClient.connect(app.socketPath);
  await client.request({ id: 'hello', type: 'hello', version: '1' });
  await client.waitFor((m) => m.type === 'state' && m.state === 'listening');
  cleanups.push(async () => {
    client.close();
    listener.requestExit();
    runner.finish();
    await running;
    await app!.close();
  });
  return { home, store, history, confirmer, runner, speaker, fake, listener, source, client, app };
}

describe('typed chat in the listener queue', () => {
  it('runs as an "app" command: accepted, heard, working, chat.done with tools, history entry with the same id, not spoken', async () => {
    const t = await setup();
    const a = await t.client.request({ id: 'c1', type: 'chat.send', text: 'open youtube' });
    expect(a.type).toBe('chat.accepted');
    const done = await t.client.waitFor((m) => m.type === 'chat.done');
    expect(done).toMatchObject({ entryId: a.entryId, reply: 'Opened open youtube.', outcome: 'ok', tools: ['open_url'] });
    expect(t.client.messages).toContainEqual({ type: 'heard', text: 'open youtube', source: 'app' });
    expect(t.client.messages).toContainEqual({ type: 'state', state: 'working' });
    expect(t.runner.prompts).toEqual(['open youtube']);
    expect(t.speaker.said).toEqual([]); // app.speakReplies false
    expect(t.history.list()).toEqual([expect.objectContaining({ id: a.entryId, source: 'app', said: 'open youtube', outcome: 'ok', tools: [expect.objectContaining({ tool: 'open_url' }), expect.anything()] })]);
    await waitFor(() => t.listener.idle, 2000, 'listening again');
    expect(t.client.messages.filter((m) => m.type === 'state').at(-1)).toEqual({ type: 'state', state: 'listening' });
  });

  it('busy while a command runs; chat.stop cancels it and ends the conversation', async () => {
    const t = await setup({ hold: true });
    await t.client.request({ id: 'c1', type: 'chat.send', text: 'play lofi' });
    await waitFor(() => t.runner.pending, 2000, 'claude running');
    expect(await t.client.request({ id: 'c2', type: 'chat.send', text: 'open notion' })).toEqual({ id: 'c2', type: 'error', message: 'busy' });
    expect(t.listener.busy).toBe(true);
    expect(await t.client.request({ id: 's', type: 'chat.stop' })).toEqual({ id: 's', type: 'ok' });
    const done = await t.client.waitFor((m) => m.type === 'chat.done');
    expect(done.outcome).toBe('cancelled');
    expect(t.runner.cancels).toBe(1);
    expect(t.runner.conversationEnds).toBeGreaterThanOrEqual(1);
    expect(t.runner.prompts).toEqual(['play lofi']);
  });

  it('Esc from the helper cancels a typed command like a voice one', async () => {
    const t = await setup({ hold: true });
    await t.client.request({ id: 'c1', type: 'chat.send', text: 'play lofi' });
    await waitFor(() => t.runner.pending, 2000, 'claude running');
    t.fake.emit({ type: 'esc', at: Date.now() });
    expect((await t.client.waitFor((m) => m.type === 'chat.done')).outcome).toBe('cancelled');
  });

  it('typed "remember …" saves directly (no dialog, source app) and ends the conversation', async () => {
    const t = await setup();
    await t.client.request({ id: 'c1', type: 'chat.send', text: 'remember my prof for SOFE 3980 is Dr. Patel' });
    const done = await t.client.waitFor((m) => m.type === 'chat.done');
    expect(done).toMatchObject({ outcome: 'memory', tools: [] });
    expect((await t.store.list()).map((i) => [i.text, i.source])).toEqual([['my prof for SOFE 3980 is Dr. Patel', 'app']]);
    expect(t.confirmer.asked).toBe(0);
    expect(t.runner.conversationEnds).toBe(1);
  });

  it('memory edits from the window end the conversation', async () => {
    const t = await setup();
    await t.client.request({ id: 'm', type: 'memory.add', text: 'my gym is goodlife' });
    expect(t.runner.conversationEnds).toBe(1);
  });

  it('a push-to-talk command shows up live: recording, heard (voice-ptt), chat.done', async () => {
    const t = await setup({ texts: ['play some lofi on youtube music'] });
    t.fake.emit({ type: 'ptt_down', at: Date.now() });
    t.source.speaking = true;
    await t.client.waitFor((m) => m.type === 'state' && m.state === 'recording');
    expect(await t.client.request({ id: 'c', type: 'chat.send', text: 'open notion' })).toEqual({ id: 'c', type: 'error', message: 'busy' });
    await sleep(400);
    t.source.speaking = false;
    t.fake.emit({ type: 'ptt_up', at: Date.now(), heldMs: 800 });
    expect(await t.client.waitFor((m) => m.type === 'heard')).toEqual({ type: 'heard', text: 'play some lofi on youtube music', source: 'voice-ptt' });
    expect((await t.client.waitFor((m) => m.type === 'chat.done')).outcome).toBe('ok');
    expect(t.runner.prompts).toEqual(['play some lofi on youtube music']);
  });

  it('window.open is forwarded to the helper as open_window', async () => {
    const t = await setup();
    expect(await t.client.request({ id: 'w', type: 'window.open' })).toEqual({ id: 'w', type: 'ok' });
    expect(t.fake.sent).toContainEqual({ type: 'open_window' });
  });

  it('issue #205: media.key from media_control (its real client) reaches the helper as media_key', async () => {
    const t = await setup();
    const press = appMediaKey(t.app.socketPath);
    expect(await press('next')).toEqual({ ok: true });
    expect(t.fake.sent).toContainEqual({ type: 'media_key', key: 'next' });
    // pause presses play/pause only while sound plays (the key is a toggle).
    t.fake.playing = false;
    expect(await press('pause')).toEqual({ ok: false, reason: 'nothing is playing' });
    t.fake.playing = true;
    expect(await press('pause')).toEqual({ ok: true });
    expect(t.fake.sent.filter((c) => c.type === 'media_key')).toEqual([{ type: 'media_key', key: 'next' }, { type: 'media_key', key: 'play_pause' }]);
    t.fake.mediaKeyAnswer = { ok: false, message: 'Stephen Helper needs the Accessibility permission' };
    expect(await press('play')).toEqual({ ok: false, reason: 'Stephen Helper needs the Accessibility permission' });
  });

  it('issue #205: media_control gets a clear reason when no listener runs', async () => {
    expect(await appMediaKey(join(tmp, 'no.sock'))('next')).toEqual({ ok: false, reason: 'stephen listen is not running' });
  });
});
