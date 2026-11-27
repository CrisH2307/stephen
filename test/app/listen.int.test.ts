/**
 * `stephen listen` serves app.sock (runListen end to end with fake audio engines and --dry-run). Needs the real
 * keyword-spotter model (start-up tokenizes the wake phrases); skipped without it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchInfoPath } from '../../src/app/control.js';
import { AppServer, appSocketPath } from '../../src/app/server.js';
import { phoneDir, phoneOnPath } from '../../src/phone/setup.js';
import type { AudioSource } from '../../src/voice/audio.js';
import { runListen, type ListenEnv } from '../../src/voice/index.js';
import { ASR_ARCHIVES, KWS_MODEL, VAD_MODEL } from '../../src/voice/models.js';
import { FakeTranscriber, FakeVad, FRAME, ScriptedSpotter } from '../voice/fakes.js';
import { fakeInstall, prepareKwsModel, RecordingChimes, RecordingSpeaker, waitFor } from '../voice/helpers.js';
import { TestClient, sleep } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-app-int-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

class EndlessSource implements AudioSource {
  readonly label = 'endless';
  private stopped = false;
  async start() {}
  async read() {
    if (this.stopped) return null;
    await sleep(2);
    return new Float32Array(FRAME);
  }
  async stop() {
    this.stopped = true;
  }
}

const kws = await prepareKwsModel();

describe.skipIf(!kws.ok)('stephen listen serves app.sock', () => {
  function start(app: Record<string, unknown> = {}, home = mkdtempSync(join(tmp, 'home-')), safety?: { blockedDomains: string[]; sensitiveDomains: string[] }, extra: Partial<ListenEnv> = {}) {
    const root = mkdtempSync(join(tmp, 'models-'));
    symlinkSync(join(kws.ok ? kws.root : '', KWS_MODEL.dir), join(root, KWS_MODEL.dir));
    fakeInstall(root, VAD_MODEL);
    fakeInstall(root, ASR_ARCHIVES['whisper-small.en']);
    const source = new EndlessSource();
    const out: string[] = [];
    const err: string[] = [];
    const e: ListenEnv = {
      loadConfig: () => ({ home, voice: { claudeModel: 'haiku' }, app, auditLogPath: join(home, 'audit.log'), ...(safety ? { safety } : {}) }),
      configPath: join(home, 'config.json'),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      speaker: new RecordingSpeaker(),
      chimes: new RecordingChimes(),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      modelsRoot: root,
      download: () => Promise.reject(new Error('must not download')),
      helper: () => null,
      source,
      engines: async () => ({ spotter: new ScriptedSpotter({}), vad: new FakeVad(), transcriber: new FakeTranscriber([]) }),
      ...extra,
    };
    const running = runListen(['--dry-run', '--no-helper'], e);
    return { home, source, out, err, running };
  }

  it('hello, typed chat, memory and settings work while listening; the socket is removed when listening ends', async () => {
    const t = start();
    const sock = appSocketPath(t.home);
    await waitFor(() => existsSync(sock), 10_000, 'app.sock');
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    const c = await TestClient.connect(sock);
    expect(await c.request({ id: 'h', type: 'hello', version: '1' })).toEqual({ id: 'h', type: 'hello', version: '1', listening: true, model: 'haiku', confirms: true });
    await c.waitFor((m) => m.type === 'state' && m.state === 'listening');

    const a = await c.request({ id: 'c', type: 'chat.send', text: 'open youtube' });
    expect(a.type).toBe('chat.accepted');
    expect(await c.waitFor((m) => m.type === 'chat.done')).toMatchObject({ entryId: a.entryId, reply: 'Dry run: Claude was not started.', outcome: 'ok' });
    expect(t.out).toContainEqual(expect.stringContaining('claude argv (dry run)'));

    expect(await c.request({ id: 'm', type: 'memory.list' })).toEqual({ id: 'm', type: 'memory', items: [] });
    const s = await c.request({ id: 's', type: 'settings.get' });
    expect(s).toMatchObject({ type: 'settings', configPath: join(t.home, 'config.json'), config: { voice: { model: 'haiku' }, app: { enabled: true, speakReplies: false } } });
    expect(await c.request({ id: 'w', type: 'window.open' })).toEqual({ id: 'w', type: 'error', message: "Stephen Helper isn't connected to stephen listen" });

    c.close();
    await t.source.stop();
    expect(await t.running).toBe(0);
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(launchInfoPath(t.home))).toBe(false); // R9-8: only install-helper writes it
  });

  it('T6 step 3: audit.recent hides the label, intent, error and args on mail and on the owner\'s sensitive sites', async () => {
    const home = mkdtempSync(join(tmp, 'priv-'));
    const line = (url: string) => JSON.stringify({ ts: new Date().toISOString(), tool: 'click', kind: 'click', urlBefore: url, element: 'row "your code is 771204"', intent: 'open the code mail', error: 'page said 771204', args: { text: '[6 chars] "771204"' }, outcome: 'error' });
    writeFileSync(join(home, 'audit.log'), [line('https://mail.google.com/mail/u/0/'), line('https://intranet.example.org/x'), line('https://www.youtube.com/')].join('\n') + '\n');
    const t = start({}, home, { blockedDomains: [], sensitiveDomains: ['intranet.example.org'] });
    const sock = appSocketPath(t.home);
    await waitFor(() => existsSync(sock), 10_000, 'app.sock');
    const c = await TestClient.connect(sock);
    const a = (await c.request({ id: 'a', type: 'audit.recent' })) as unknown as { entries: Record<string, unknown>[] };
    const byUrl = (u: string) => a.entries.find((e) => String(e.urlBefore).startsWith(u))!;
    for (const u of ['https://mail.google.com', 'https://intranet.example.org']) {
      expect(byUrl(u)).toMatchObject({ tool: 'click', kind: 'click', outcome: 'error' });
      expect(JSON.stringify(byUrl(u))).not.toContain('771204');
      expect(byUrl(u)).not.toHaveProperty('intent');
    }
    expect(byUrl('https://www.youtube.com')).toMatchObject({ element: 'row "your code is 771204"', intent: 'open the code mail' });
    c.close();
    await t.source.stop();
    expect(await t.running).toBe(0);
  });

  it('T6 step 3: the owner\'s sensitive sites reach the chat steps path, so chat.done hides their label and error', async () => {
    const home = mkdtempSync(join(tmp, 'steps-'));
    // A dry run can end in 0 ms, and a 0 ms command reads no steps. Its argv line is printed inside the command, so a
    // 20 ms pause there gives the command a real window that covers the lines written just before it.
    const out = (l: string) => {
      if (!l.includes('claude argv (dry run)')) return;
      const until = Date.now() + 20;
      while (Date.now() < until);
    };
    const t = start({}, home, { blockedDomains: [], sensitiveDomains: ['intranet.example.org'] }, { out });
    const sock = appSocketPath(t.home);
    await waitFor(() => existsSync(sock), 10_000, 'app.sock');
    const c = await TestClient.connect(sock);
    await c.request({ id: 'h', type: 'hello', version: '1' });
    await c.waitFor((m) => m.type === 'state' && m.state === 'listening');
    // Lines stamped now fall inside the typed command's window (no command id: matched by time).
    const line = (url: string, el: string) => JSON.stringify({ ts: new Date().toISOString(), tool: 'click', kind: 'click', urlBefore: url, element: el, error: 'page said 771204', outcome: 'error' });
    writeFileSync(join(home, 'audit.log'), [line('https://intranet.example.org/x', 'row "your code is 771204"'), line('https://www.youtube.com/', 'row "lo-fi radio"')].join('\n') + '\n');
    const a = await c.request({ id: 'c', type: 'chat.send', text: 'open youtube' });
    const done = (await c.waitFor((m) => m.type === 'chat.done' && m.entryId === a.entryId)) as unknown as { steps?: { text: string; status: string }[] };
    // Same time stamp on both lines, so the order is not part of the check.
    expect(done.steps).toHaveLength(2);
    expect(done.steps).toContainEqual({ text: 'Tried click, it failed', status: 'failed' });
    expect(done.steps).toContainEqual({ text: 'Tried click row "lo-fi radio", it failed', status: 'failed' });
    expect(JSON.stringify(done)).not.toContain('771204');
    c.close();
    await t.source.stop();
    expect(await t.running).toBe(0);
  });

  it('R9-4: when listening ends, the Remote Control our own `phone on` started is stopped and the marker removed', async () => {
    const t = start();
    await waitFor(() => existsSync(appSocketPath(t.home)), 10_000, 'app.sock');
    // A stand-in whose command line reads as Remote Control, recorded as started by this (the listener's) process.
    const rc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude', 'remote-control'], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => rc.on('exit', (_c, sig) => r(sig)));
    mkdirSync(phoneDir(t.home), { recursive: true });
    writeFileSync(phoneOnPath(t.home), JSON.stringify({ pid: process.pid, rc: rc.pid }));
    try {
      await t.source.stop();
      expect(await t.running).toBe(0);
      expect(existsSync(phoneOnPath(t.home))).toBe(false);
      expect(await exited).toBe('SIGTERM');
    } finally {
      rc.kill('SIGKILL');
    }
  });

  it('app.enabled false: no socket', async () => {
    const t = start({ enabled: false });
    await waitFor(() => t.out.some((l) => l.includes('Listening for')), 10_000, 'listening');
    expect(existsSync(appSocketPath(t.home))).toBe(false);
    await t.source.stop();
    expect(await t.running).toBe(0);
  });

  it('another listener already serving app.sock: a note, and listening goes on', async () => {
    const home = mkdtempSync(join(tmp, 'busy-'));
    const other = new AppServer({
      home,
      queue: { busy: () => false, start: () => null, stop: () => undefined },
      listening: () => true,
      model: 'x',
      memory: null,
      endConversation: () => undefined,
      history: null,
      audit: null,
      settings: () => ({ config: {}, configPath: '' }),
      speakReplies: false,
      openWindow: () => null,
    });
    await other.start();
    try {
      const t = start({}, home);
      await waitFor(() => t.out.some((l) => l.includes('Listening for')), 10_000, 'listening');
      expect(t.err).toContainEqual(expect.stringMatching(/Stephen window can't connect to this listener \(another `stephen listen` is already serving/));
      await t.source.stop();
      expect(await t.running).toBe(0);
      expect(existsSync(appSocketPath(home))).toBe(true); // the other listener's socket is untouched
    } finally {
      await other.close();
    }
  });
});
