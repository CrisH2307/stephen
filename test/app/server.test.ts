/**
 * app.sock server (src/app/server.ts) over a real Unix socket in a temp home, with a fake command queue, a fake
 * audit log and the real memory / history stores.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { parseAppConfig } from '../../src/app/config.js';
import { APP_MAX_LINE_BYTES } from '../../src/app/protocol.js';
import {
  AppServer,
  MEMORY_GONE_MESSAGE,
  MEMORY_OFF_MESSAGE,
  appSocketPath,
  assistantQueue,
  type AppCommandQueue,
  type AppServerOptions,
} from '../../src/app/server.js';
import { appSettings } from '../../src/app/settings.js';
import type { AppControl } from '../../src/app/control.js';
import { accountsStatus } from '../../src/app/accounts-status.js';
import { personalSummary } from '../../src/app/personal.js';
import { parseHistoryConfig } from '../../src/history/config.js';
import { HistoryStore } from '../../src/history/store.js';
import { parseMemoryConfig } from '../../src/memory/config.js';
import { MEMORY_MESSAGES, MemoryStore } from '../../src/memory/store.js';
import type { AuditEntry } from '../../src/types.js';
import type { CommandReport } from '../../src/voice/assistant.js';
import { parseVoiceConfig } from '../../src/voice/config.js';
import { AppConfirmer } from '../../src/safety/app-confirm.js';
import { buildConfirmer } from '../../src/safety/confirm.js';
import { TestClient, sleep, type Msg } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-app-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

class FakeQueue implements AppCommandQueue {
  isBusy = false;
  readonly started: { text: string; opts: { id: string; raw: string; speak: boolean } }[] = [];
  stops = 0;
  private finishRun: ((r: CommandReport) => void) | null = null;
  busy(): boolean {
    return this.isBusy;
  }
  start(text: string, opts: { id: string; raw: string; speak: boolean }): Promise<CommandReport> | null {
    if (this.isBusy) return null;
    this.isBusy = true;
    this.started.push({ text, opts });
    return new Promise((r) => (this.finishRun = r));
  }
  stop(): void {
    this.stops++;
  }
  /** End the running command like the Assistant would: report it, then push chat.done (onDone). */
  finish(server: AppServer, r: Partial<CommandReport> = {}, tools: string[] = []): CommandReport {
    const last = this.started.at(-1)!;
    const report: CommandReport = {
      id: last.opts.id,
      result: 'ok',
      outcome: 'ok',
      source: 'app',
      said: last.text,
      reply: 'Done.',
      ranClaude: true,
      followUp: false,
      ms: 1234,
      turns: 2,
      ...r,
    };
    this.isBusy = false;
    server.commandDone(report, tools);
    this.finishRun?.(report);
    this.finishRun = null;
    return report;
  }
}

const AUDIT: AuditEntry[] = [
  { ts: '2026-11-01T14:03:20.500Z', tool: 'read_page', browser: 'zen', kind: 'read', urlBefore: 'https://weather.gc.ca/', outcome: 'ok' },
  { ts: '2026-11-01T13:10:02.000Z', tool: 'click', browser: 'zen', kind: 'click', verdict: 'confirm', outcome: 'denied', intent: 'send the email' },
] as AuditEntry[];

const VOICE_RAW = {
  claudeModel: 'sonnet',
  claudePath: '/Users/cris/.local/bin/claude',
  elevenlabs: { apiKeyFile: '/Users/cris/.stephen/elevenlabs-key.txt', voiceId: 'YEBbZ0itqHW31uoXSBns' },
  aboutMe: { school: 'I study software engineering in Toronto.' },
};

const settingsFor = (configPath = '/Users/cris/.stephen/config.json') =>
  appSettings({
    voice: parseVoiceConfig(VOICE_RAW),
    memory: parseMemoryConfig({}),
    history: parseHistoryConfig({}),
    app: parseAppConfig({}),
    configPath,
  });

/** The fixture's answers (src/app/control.ts is tested on its own in control.test.ts). */
const FAKE_CONTROL: AppControl = {
  phoneOn: async () => ({ on: true, lines: ['✓ Locked: the phone session can use only Stephen phone tools.'] }),
  phoneOff: async () => ({ on: false, lines: ['Phone link off: phone requests are refused, Remote Control stopped.'] }),
  openZen: async () => ({ ok: true, message: 'Zen is ready for Stephen (pid 4242).' }),
  doctor: async () => ({ checks: [{ ok: false, label: 'Chrome installed' }], problems: 1, blocking: 0 }),
};

const servers: AppServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

let ids = 0;
async function harness(o: Partial<AppServerOptions> = {}, home = mkdtempSync(join(tmp, 'h-'))) {
  const queue = new FakeQueue();
  const calls = { ends: 0, opens: 0 };
  const memory = new MemoryStore({ home });
  const history = new HistoryStore({ home, retentionDays: 1 });
  const server = new AppServer({
    home,
    queue,
    listening: () => true,
    model: 'sonnet',
    memory,
    endConversation: () => calls.ends++,
    history,
    audit: { recent: async (n) => AUDIT.slice(0, n) },
    settings: () => settingsFor(),
    accounts: () => accountsStatus({ canvas: { enabled: false } }, { platform: 'linux', envFile: null }),
    jobs: {
      list: () => [],
      stop: async (id) => {
        if (id !== '2026-11-05-write-my-lab-report') return { refused: `There's no job ${id}.` };
        return { id, task: 'write my lab report draft', status: 'stopped', folder: `/Users/cris/Stephen Jobs/${id}`, createdAt: 1, startedAt: 2, endedAt: 3, turns: 9, costUsd: 0.25, summary: '', error: 'Stopped by the owner.' };
      },
    },
    speakReplies: false,
    openWindow: () => (calls.opens++, null),
    control: FAKE_CONTROL,
    usage: async () => ({ context: null, memory: { bytes: 6800, budget: 8192, percent: 83, warn: true } }),
    personal: async () =>
      personalSummary({ aboutMe: { name: 'Cris' }, accounts: await accountsStatus({ canvas: { enabled: false } }, { platform: 'linux', envFile: null }), jobsOn: true, timeZone: 'America/Toronto' }),
    newId: () => `h_test${++ids}`,
    ...o,
  });
  await server.start();
  servers.push(server);
  const connect = async () => {
    const c = await TestClient.connect(server.socketPath);
    clients.push(c);
    return c;
  };
  return { home, queue, calls, memory, history, server, connect, client: await connect() };
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'app-protocol-v1.jsonl');
type FixtureLine = { from: 'app' | 'node'; kind: 'request' | 'response' | 'push'; msg: Msg };

describe('protocol fixture (test/fixtures/app-protocol-v1.jsonl) against the real server', () => {
  it('answers every request in the fixture with the response type the fixture expects', async () => {
    const home = mkdtempSync(join(tmp, 'fixture-'));
    // memory.json as in the fixture: m7 saved by push-to-talk.
    writeFileSync(
      join(home, 'memory.json'),
      JSON.stringify({
        version: 1,
        nextId: 8,
        items: [{ id: 'm7', text: 'my prof for sofe 3980 is dr patel', source: 'voice-ptt', createdAt: '2026-11-01T09:12:05.000Z', updatedAt: '2026-11-01T09:12:05.000Z' }],
      }),
      { mode: 0o600 },
    );
    let settingsCalls = 0;
    let openCalls = 0;
    const h = await harness(
      {
        settings: () => {
          if (++settingsCalls > 1) throw new Error('config.json went away');
          return settingsFor();
        },
        openWindow: () => (++openCalls === 1 ? null : "Stephen Helper isn't connected to stephen listen"),
      },
      home,
    );
    h.history.append({ source: 'voice-ptt', said: 'remember my prof', reply: 'Saved', outcome: 'memory', tools: [], followUp: false, ms: 40, turns: 0 });

    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FixtureLine);
    const expected = new Map(lines.filter((l) => l.kind === 'response').map((l) => [l.msg.id!, l.msg]));
    const requests = lines.filter((l) => l.kind === 'request').map((l) => l.msg);
    expect(requests.length).toBeGreaterThan(15);
    for (const req of requests) {
      const got = await h.client.request(req);
      const want = expected.get(req.id!)!;
      expect({ id: got.id, type: got.type }, JSON.stringify(req)).toEqual({ id: want.id, type: want.type });
      if (want.type === 'error' && ['busy', MEMORY_MESSAGES.secret, MEMORY_GONE_MESSAGE].includes(want.message as string)) {
        expect(got.message).toBe(want.message);
      }
      if (want.type === 'memory') expect((got.items as { text: string }[]).map((i) => i.text)).toEqual((want.items as { text: string }[]).map((i) => i.text));
      // The fixture's flow: the first chat command keeps running while the next one is refused, then finishes.
      if (req.type === 'chat.send' && got.type === 'chat.accepted') continue;
      if (req.type === 'chat.send' && got.type === 'error') h.queue.finish(h.server, { reply: "It's 8 degrees." }, ['web_search', 'read_page']);
      if (req.type === 'history.list' && req.before === undefined) expect((got.entries as unknown[]).length).toBeGreaterThan(0);
    }
    const done = await h.client.waitFor((m) => m.type === 'chat.done');
    expect(done).toMatchObject({ reply: "It's 8 degrees.", outcome: 'ok', tools: ['web_search', 'read_page'] });
  });
});

describe('socket file', () => {
  it('folder 0700 (fixed if looser), socket 0600, removed on close', async () => {
    const home = mkdtempSync(join(tmp, 'perm-'));
    mkdirSync(join(home, 'run'), { mode: 0o755 });
    chmodSync(join(home, 'run'), 0o755);
    const h = await harness({}, home);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    expect(statSync(appSocketPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(appSocketPath(home)).isSocket()).toBe(true);
    await h.server.close();
    expect(existsSync(appSocketPath(home))).toBe(false);
  });

  it('closeSync (process exit) removes the socket too', async () => {
    const h = await harness();
    h.server.closeSync();
    expect(existsSync(h.server.socketPath)).toBe(false);
  });

  it('a stale socket (nobody answers) is replaced', async () => {
    const home = mkdtempSync(join(tmp, 'stale-'));
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    // A socket file nobody listens on: listen elsewhere, move the file into place, stop listening.
    const other = join(home, 'run', 'other.sock');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(other, () => r()));
    renameSync(other, appSocketPath(home));
    await new Promise<void>((r) => srv.close(() => r()));
    expect(statSync(appSocketPath(home)).isSocket()).toBe(true);
    const h = await harness({}, home);
    expect((await h.client.request({ id: 'x', type: 'hello', version: '1' })).type).toBe('hello');
  });

  it('a live socket (another listener answers) is left alone and start() refuses', async () => {
    const h = await harness();
    const second = new AppServer({ ...((h.server as unknown as { o: AppServerOptions }).o) });
    await expect(second.start()).rejects.toThrow(/already serving/);
    expect((await h.client.request({ id: 'x', type: 'hello', version: '1' })).type).toBe('hello');
  });

  it('something that is not a socket is never removed', async () => {
    const home = mkdtempSync(join(tmp, 'file-'));
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    writeFileSync(appSocketPath(home), 'keep me');
    const s = new AppServer({ ...(await harnessOptions(home)) });
    await expect(s.start()).rejects.toThrow(/not a socket/);
    expect(readFileSync(appSocketPath(home), 'utf8')).toBe('keep me');
  });

  it('a socket path that is too long for macOS is refused', async () => {
    const s = new AppServer({ ...(await harnessOptions(tmp)), socketPath: join(tmp, 'x'.repeat(120), 'app.sock') });
    await expect(s.start()).rejects.toThrow(/too long/);
  });
});

async function harnessOptions(home: string): Promise<AppServerOptions> {
  return {
    home,
    queue: new FakeQueue(),
    listening: () => true,
    model: 'sonnet',
    memory: null,
    endConversation: () => undefined,
    history: null,
    audit: null,
    settings: () => settingsFor(),
    speakReplies: false,
    openWindow: () => null,
  };
}

describe('framing and caps', () => {
  it('a line over 256 KiB gets an error and the connection keeps working', async () => {
    const h = await harness();
    h.client.send(JSON.stringify({ id: 'big', type: 'memory.add', text: 'x'.repeat(APP_MAX_LINE_BYTES) }));
    const e = await h.client.waitFor((m) => m.type === 'error');
    expect(e.message).toMatch(/line too long/);
    expect(e.id).toBeUndefined();
    expect((await h.client.request({ id: 'after', type: 'hello', version: '1' })).type).toBe('hello');
    expect(await h.memory.list()).toEqual([]);
  });

  it('chat text over 2000 characters is refused and nothing runs', async () => {
    const h = await harness();
    const r = await h.client.request({ id: 'c', type: 'chat.send', text: 'a'.repeat(2001) });
    expect(r).toEqual({ id: 'c', type: 'error', message: 'text is too long (2000 characters at most)' });
    expect(h.queue.started).toEqual([]);
  });

  it('malformed lines get an error (with the id when there is one); unknown types are ignored', async () => {
    const h = await harness();
    h.client.send('{nope');
    h.client.send({ id: 'u1', type: 'shell.run', cmd: 'ls' });
    expect(await h.client.request({ id: 'h1', type: 'history.list', limit: 500 })).toEqual({ id: 'h1', type: 'error', message: 'limit must be a whole number from 1 to 100' });
    expect(h.client.messages[0]).toEqual({ type: 'error', message: 'not JSON' });
    expect(h.client.messages.some((m) => m.id === 'u1')).toBe(false);
  });

  it('a big history page is trimmed (oldest dropped) to fit one line', async () => {
    const h = await harness();
    for (let i = 0; i < 100; i++) {
      h.history.append({ source: 'app', said: `s${i} ${'x'.repeat(1990)}`, reply: 'y'.repeat(3990), outcome: 'ok', tools: [], followUp: false, ms: 1, turns: 1 });
    }
    const r = await h.client.request({ id: 'h', type: 'history.list', limit: 100 });
    const entries = r.entries as { said: string }[];
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.length).toBeLessThan(100);
    expect(entries[0]!.said.startsWith('s99 ')).toBe(true); // newest kept
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(APP_MAX_LINE_BYTES);
  });
});

describe('chat', () => {
  it('chat.accepted comes first, then chat.done with the reply and the tool names (deduplicated)', async () => {
    const h = await harness();
    const accepted = await h.client.request({ id: 'c1', type: 'chat.send', text: "  what's the weather\u0007 in Toronto  " });
    expect(accepted).toEqual({ id: 'c1', type: 'chat.accepted', entryId: expect.stringMatching(/^h_test\d+$/) });
    expect(h.queue.started).toEqual([{ text: "what's the weather in Toronto", opts: { id: accepted.entryId, raw: "what's the weather\u0007 in Toronto", speak: false } }]);
    h.queue.finish(h.server, { reply: "It's 8 degrees and cloudy." }, ['web_search', 'read_page', 'web_search']);
    const done = await h.client.waitFor((m) => m.type === 'chat.done');
    expect(done).toEqual({ type: 'chat.done', entryId: accepted.entryId, reply: "It's 8 degrees and cloudy.", outcome: 'ok', tools: ['web_search', 'read_page'], ms: 1234 });
    expect(h.client.messages.indexOf(accepted)).toBeLessThan(h.client.messages.indexOf(done));
  });

  it('app.speakReplies is passed to the command', async () => {
    const h = await harness({ speakReplies: true });
    await h.client.request({ id: 'c1', type: 'chat.send', text: 'hi' });
    expect(h.queue.started[0]!.opts.speak).toBe(true);
  });

  it('busy: a second command while one runs gets {type:"error",message:"busy"}', async () => {
    const h = await harness();
    expect((await h.client.request({ id: 'c1', type: 'chat.send', text: 'one' })).type).toBe('chat.accepted');
    expect(await h.client.request({ id: 'c2', type: 'chat.send', text: 'two' })).toEqual({ id: 'c2', type: 'error', message: 'busy' });
    expect(h.queue.started.map((s) => s.text)).toEqual(['one']);
  });

  it('empty text after cleaning is refused', async () => {
    const h = await harness();
    expect(await h.client.request({ id: 'c', type: 'chat.send', text: ' \n\t ' })).toEqual({ id: 'c', type: 'error', message: 'Type a command first.' });
  });

  it('chat.stop cancels through the queue', async () => {
    const h = await harness();
    expect(await h.client.request({ id: 's', type: 'chat.stop' })).toEqual({ id: 's', type: 'ok' });
    expect(h.queue.stops).toBe(1);
  });

  it('a command that fails to start still ends with chat.done (outcome error)', async () => {
    const queue: AppCommandQueue = { busy: () => false, start: () => Promise.reject(new Error('boom')), stop: () => undefined };
    const h = await harness({ queue });
    const a = await h.client.request({ id: 'c', type: 'chat.send', text: 'x' });
    const done = await h.client.waitFor((m) => m.type === 'chat.done');
    expect(done).toMatchObject({ entryId: a.entryId, outcome: 'error', reply: 'Something went wrong: boom' });
  });

  it('assistantQueue (no listener): busy follows the assistant; stop cancels and ends the conversation', async () => {
    const calls: string[] = [];
    let busy = false;
    const q = assistantQueue({
      get busy() {
        return busy;
      },
      command: async (text, o) => (calls.push(`run ${text} ${o.source} ${o.id}`), {}) as CommandReport,
      cancel: () => (calls.push('cancel'), true),
      endConversation: () => void calls.push('end'),
    });
    expect(q.start('x', { id: 'h_1', raw: 'x', speak: false })).not.toBeNull();
    busy = true;
    expect(q.busy()).toBe(true);
    expect(q.start('y', { id: 'h_2', raw: 'y', speak: false })).toBeNull();
    q.stop();
    expect(calls).toEqual(['run x app h_1', 'cancel', 'end']);
  });
});

describe('memory, history, settings, audit, window', () => {
  it('every successful memory change ends the conversation; reads, duplicates and refusals do not', async () => {
    const h = await harness();
    const add = await h.client.request({ id: 'm1', type: 'memory.add', text: 'I take the 7:40 GO train on weekdays' });
    expect(add).toMatchObject({ type: 'memory', items: [{ id: 'm1', text: 'I take the 7:40 GO train on weekdays', source: 'app' }] });
    expect(h.calls.ends).toBe(1);
    await h.client.request({ id: 'm2', type: 'memory.add', text: 'i take the 7:40 go train on weekdays' }); // duplicate
    expect(await h.client.request({ id: 'm3', type: 'memory.add', text: 'my bank pin is 4821' })).toEqual({ id: 'm3', type: 'error', message: MEMORY_MESSAGES.secret });
    await h.client.request({ id: 'm4', type: 'memory.list' });
    expect(h.calls.ends).toBe(1);
    await h.client.request({ id: 'm5', type: 'memory.update', memId: 'm1', text: 'I take the 7:50 GO train' });
    expect(await h.client.request({ id: 'm6', type: 'memory.forget', memId: 'm99' })).toEqual({ id: 'm6', type: 'error', message: MEMORY_GONE_MESSAGE });
    await h.client.request({ id: 'm7', type: 'memory.forget', memId: 'm1' });
    await h.client.request({ id: 'm8', type: 'memory.clear' });
    expect(h.calls.ends).toBe(4);
  });

  it('a memory change while a command runs ends the conversation again once it is done', async () => {
    const h = await harness();
    await h.client.request({ id: 'c', type: 'chat.send', text: 'open youtube' });
    await h.client.request({ id: 'm', type: 'memory.add', text: 'my gym is goodlife' });
    expect(h.calls.ends).toBe(1);
    h.queue.finish(h.server);
    expect(h.calls.ends).toBe(2);
    h.server.commandDone({ ...({} as CommandReport), id: 'h_x', reply: '', outcome: 'ok', ms: 1 }, []);
    expect(h.calls.ends).toBe(2); // only once
  });

  it('memory off: memory requests explain it', async () => {
    const h = await harness({ memory: null });
    expect(await h.client.request({ id: 'm', type: 'memory.list' })).toEqual({ id: 'm', type: 'error', message: MEMORY_OFF_MESSAGE });
    expect(await h.client.request({ id: 'n', type: 'memory.add', text: 'x' })).toEqual({ id: 'n', type: 'error', message: MEMORY_OFF_MESSAGE });
  });

  it('an unreadable memory.json is reported, not thrown', async () => {
    const home = mkdtempSync(join(tmp, 'badmem-'));
    writeFileSync(join(home, 'memory.json'), '{not json', { mode: 0o600 });
    const h = await harness({}, home);
    expect(await h.client.request({ id: 'm', type: 'memory.list' })).toEqual({ id: 'm', type: 'error', message: MEMORY_MESSAGES.unreadable });
  });

  it('history.list and history.clear use the HistoryStore', async () => {
    const h = await harness();
    h.history.append({ source: 'app', said: 'one', reply: 'r1', outcome: 'ok', tools: [{ tool: 'open_url', isError: false, ms: 5 }], followUp: false, ms: 9, turns: 1 });
    const r = await h.client.request({ id: 'h', type: 'history.list', limit: 10 });
    expect(r.entries).toEqual([expect.objectContaining({ said: 'one', tools: [{ tool: 'open_url', isError: false, ms: 5 }] })]);
    expect(await h.client.request({ id: 'c', type: 'history.clear' })).toEqual({ id: 'c', type: 'ok' });
    expect(h.history.list()).toEqual([]);
  });

  it('settings.get: allow-listed values only; no key file, binary path or other secret-looking keys', async () => {
    const h = await harness();
    const r = await h.client.request({ id: 's', type: 'settings.get' });
    expect(r.type).toBe('settings');
    expect(r.configPath).toBe('/Users/cris/.stephen/config.json');
    const config = r.config as Record<string, Record<string, unknown>>;
    expect(config.voice).toMatchObject({ model: 'sonnet', wakeWord: true, aboutMe: { school: 'I study software engineering in Toronto.' } });
    expect(config.memory).toEqual({ enabled: true, confirmWakeWord: true, maxItems: 30 });
    expect(config.history).toEqual({ enabled: true, retentionDays: 1 });
    expect(config.app).toEqual({ enabled: true, speakReplies: false });
    const text = JSON.stringify(config);
    for (const leak of ['elevenlabs', 'apiKeyFile', 'elevenlabs-key', 'claudePath', '/.local/bin/claude', 'YEBbZ0itqHW31uoXSBns']) expect(text).not.toContain(leak);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(config);
    for (const k of keys) expect(k).not.toMatch(/key|token|secret|password|path|file/i);
  });

  it('settings that cannot be built answer with an error', async () => {
    const h = await harness({ settings: () => { throw new Error('x'); } });
    expect(await h.client.request({ id: 's', type: 'settings.get' })).toEqual({ id: 's', type: 'error', message: 'could not read the config' });
  });

  it('audit.recent returns AuditLog.recent(limit) (default 100); no audit log → empty', async () => {
    let asked = 0;
    const h = await harness({ audit: { recent: async (n) => ((asked = n), AUDIT.slice(0, 1)) } });
    expect(await h.client.request({ id: 'a', type: 'audit.recent' })).toEqual({ id: 'a', type: 'audit', entries: [AUDIT[0]] });
    expect(asked).toBe(100);
    await h.client.request({ id: 'b', type: 'audit.recent', limit: 7 });
    expect(asked).toBe(7);
    const none = await harness({ audit: null });
    expect(await none.client.request({ id: 'a', type: 'audit.recent' })).toEqual({ id: 'a', type: 'audit', entries: [] });
  });

  it('phone.on / phone.off / zen.open / doctor.run answer from the control; errors and a missing control say why', async () => {
    const h = await harness();
    expect(await h.client.request({ id: 'p', type: 'phone.on' })).toEqual({ id: 'p', type: 'phone', on: true, lines: ['✓ Locked: the phone session can use only Stephen phone tools.'] });
    expect(await h.client.request({ id: 'q', type: 'phone.off' })).toMatchObject({ id: 'q', type: 'phone', on: false });
    expect(await h.client.request({ id: 'z', type: 'zen.open' })).toEqual({ id: 'z', type: 'zen', ok: true, message: 'Zen is ready for Stephen (pid 4242).' });
    expect(await h.client.request({ id: 'd', type: 'doctor.run' })).toEqual({ id: 'd', type: 'doctor', checks: [{ ok: false, label: 'Chrome installed' }], problems: 1, blocking: 0 });
    const failing = await harness({ control: { ...FAKE_CONTROL, phoneOn: async () => Promise.reject(new Error('The phone link is already turning on.')) } });
    expect(await failing.client.request({ id: 'p', type: 'phone.on' })).toEqual({ id: 'p', type: 'error', message: 'The phone link is already turning on.' });
    const none = await harness({ control: undefined });
    expect(await none.client.request({ id: 'd', type: 'doctor.run' })).toEqual({ id: 'd', type: 'error', message: 'not available in this listener' });
  });

  it('usage.get answers from the listener; without it, an error', async () => {
    const h = await harness();
    expect(await h.client.request({ id: 'u', type: 'usage.get' })).toEqual({ id: 'u', type: 'usage', context: null, memory: { bytes: 6800, budget: 8192, percent: 83, warn: true } });
    const none = await harness({ usage: undefined });
    expect(await none.client.request({ id: 'u', type: 'usage.get' })).toEqual({ id: 'u', type: 'error', message: 'not available in this listener' });
  });

  it('personal.summary answers from the listener (read-only); without it, an error', async () => {
    const h = await harness();
    const got = await h.client.request({ id: 'p', type: 'personal.summary' });
    expect(got).toMatchObject({ id: 'p', type: 'personal', about: { name: 'Cris', notes: [], timeZone: 'America/Toronto' } });
    expect((got.permissions as { columns: string[] }).columns).toEqual(['F5', 'Hey Stephen', 'Phone']);
    const none = await harness({ personal: undefined });
    expect(await none.client.request({ id: 'p', type: 'personal.summary' })).toEqual({ id: 'p', type: 'error', message: 'not available in this listener' });
    const broken = await harness({ personal: async () => { throw new Error('boom'); } });
    expect(await broken.client.request({ id: 'p', type: 'personal.summary' })).toEqual({ id: 'p', type: 'error', message: 'could not read the personal summary' });
  });

  it('window.open forwards to the helper, or says why it could not', async () => {
    const h = await harness();
    expect(await h.client.request({ id: 'w', type: 'window.open' })).toEqual({ id: 'w', type: 'ok' });
    expect(h.calls.opens).toBe(1);
    const off = await harness({ openWindow: () => 'no helper' });
    expect(await off.client.request({ id: 'w', type: 'window.open' })).toEqual({ id: 'w', type: 'error', message: 'no helper' });
  });
});

describe('pushes', () => {
  it('hello answers, then pushes the current state; state changes and heard reach every client', async () => {
    const h = await harness({ listening: () => false, model: 'haiku' });
    h.server.setState('listening');
    expect(await h.client.request({ id: 'h', type: 'hello', version: '1' })).toEqual({ id: 'h', type: 'hello', version: '1', listening: false, model: 'haiku', confirms: true });
    const helloAt = h.client.messages.findIndex((m) => m.id === 'h');
    await h.client.waitFor((m) => m.type === 'state' && h.client.messages.indexOf(m) > helloAt);
    expect(h.client.messages[helloAt + 1]).toEqual({ type: 'state', state: 'listening' });

    const second = await h.connect();
    await h.client.request({ id: 'sync', type: 'chat.stop' }); // both connected before pushing
    expect(h.server.clientCount).toBe(2);
    h.server.setState('recording');
    h.server.setState('recording'); // duplicate: not re-sent
    h.server.heard('play some lo-fi on youtube music', 'voice-ptt');
    for (const c of [h.client, second]) {
      await c.waitFor((m) => m.type === 'heard');
      expect(c.messages.filter((m) => m.type === 'state' && m.state === 'recording')).toHaveLength(1);
      expect(c.messages.find((m) => m.type === 'heard')).toEqual({ type: 'heard', text: 'play some lo-fi on youtube music', source: 'voice-ptt' });
    }
  });

  it('voice commands get chat.done too (from commandDone)', async () => {
    const h = await harness();
    h.server.commandDone({ id: 'h_v', result: 'cancelled', outcome: 'cancelled', source: 'voice-ptt', said: 'x', reply: '', ranClaude: true, followUp: false, ms: 900, turns: 0 }, []);
    expect(await h.client.waitFor((m) => m.type === 'chat.done')).toEqual({ type: 'chat.done', entryId: 'h_v', reply: '', outcome: 'cancelled', tools: [], ms: 900 });
  });

  it('closing the server disconnects clients', async () => {
    const h = await harness();
    await h.server.close();
    await sleep(20);
    expect(h.client.closed).toBe(true);
  });
});

describe('Ask box confirmations (confirm.ask / confirm / confirm.answer / confirm.end)', () => {
  const ASK = { type: 'confirm.ask', title: 'mail.google.com — Stephen wants to click a button', body: 'Site: https://mail.google.com', timeoutMs: 60_000 };
  async function withBox() {
    const h = await harness();
    const box = h.client;
    await box.request({ id: 'hb', type: 'hello', version: '1', confirms: true });
    const gate = await h.connect();
    return { h, box, gate };
  }

  it('no Ask box connected: unavailable at once (the gate shows the dialog)', async () => {
    const h = await harness();
    await h.client.request({ id: 'h', type: 'hello', version: '1' }); // a window/CLI that did not opt in
    const gate = await h.connect();
    expect(await gate.request({ id: 'g1', ...ASK })).toEqual({ id: 'g1', type: 'confirm.result', outcome: 'unavailable' });
    expect(h.client.messages.some((m) => m.type === 'confirm')).toBe(false);
  });

  it('the box gets the question; its click with the exact id settles it once, and confirm.end follows', async () => {
    const { box, gate } = await withBox();
    gate.send({ id: 'g1', ...ASK });
    const q = await box.waitFor((m) => m.type === 'confirm');
    expect(q).toMatchObject({ type: 'confirm', title: ASK.title, body: ASK.body });
    expect(gate.messages.some((m) => m.type === 'confirm')).toBe(false); // never sent back to the asker
    const confirmId = q.confirmId as string;
    expect(await box.request({ id: 'b1', type: 'confirm.answer', confirmId, approve: true })).toEqual({ id: 'b1', type: 'ok' });
    expect(await gate.waitFor((m) => m.id === 'g1')).toEqual({ id: 'g1', type: 'confirm.result', outcome: 'approved' });
    expect(await box.waitFor((m) => m.type === 'confirm.end')).toEqual({ type: 'confirm.end', confirmId });
    // A second answer (replay) or another id answers nothing.
    expect(await box.request({ id: 'b2', type: 'confirm.answer', confirmId, approve: false })).toMatchObject({ id: 'b2', type: 'error' });
    expect(gate.messages.filter((m) => m.id === 'g1')).toHaveLength(1);
  });

  it('an answer naming another id, or from the asking connection, does not settle the question', async () => {
    const { box, gate } = await withBox();
    gate.send({ id: 'g1', ...ASK });
    const q = await box.waitFor((m) => m.type === 'confirm');
    const other = '00000000-0000-4000-8000-000000000000';
    expect(await box.request({ id: 'b1', type: 'confirm.answer', confirmId: other, approve: true })).toMatchObject({ type: 'error' });
    expect(await gate.request({ id: 'g2', type: 'confirm.answer', confirmId: q.confirmId, approve: true })).toMatchObject({ type: 'error' });
    expect(gate.messages.some((m) => m.id === 'g1')).toBe(false);
    await box.request({ id: 'b2', type: 'confirm.answer', confirmId: q.confirmId, approve: false });
    expect(await gate.waitFor((m) => m.id === 'g1')).toMatchObject({ outcome: 'declined' });
  });

  it('unanswered: declined after timeoutMs; the last box leaving: unavailable; the asker leaving: confirm.end', async () => {
    const { h, box, gate } = await withBox();
    gate.send({ id: 'g1', ...ASK, timeoutMs: 1000 });
    expect(await gate.waitFor((m) => m.id === 'g1', 3000)).toMatchObject({ outcome: 'declined' });
    await box.waitFor((m) => m.type === 'confirm.end');

    gate.send({ id: 'g2', ...ASK });
    const q2 = await box.waitFor((m) => m.type === 'confirm' && box.messages.filter((x) => x.type === 'confirm').length === 2);
    const gate2 = await h.connect();
    gate2.send({ id: 'g3', ...ASK });
    await box.waitFor((m) => m.type === 'confirm' && m.confirmId !== q2.confirmId && box.messages.filter((x) => x.type === 'confirm').length === 3);
    gate2.close();
    await box.waitFor((m) => m.type === 'confirm.end' && box.messages.filter((x) => x.type === 'confirm.end').length === 2);
    box.close();
    expect(await gate.waitFor((m) => m.id === 'g2')).toMatchObject({ outcome: 'unavailable' });
  });

  it('a box that connects late gets the waiting question', async () => {
    const h = await harness();
    const gate = h.client;
    const early = await h.connect();
    await early.request({ id: 'e', type: 'hello', version: '1', confirms: true });
    gate.send({ id: 'g1', ...ASK });
    await early.waitFor((m) => m.type === 'confirm');
    const late = await h.connect();
    await late.request({ id: 'l', type: 'hello', version: '1', confirms: true });
    expect(await late.waitFor((m) => m.type === 'confirm')).toMatchObject({ title: ASK.title });
  });

  it('AppConfirmer (the gate side): approved / declined from the box, unavailable without a box or a listener', async () => {
    const { h, box } = await withBox();
    const c = new AppConfirmer(h.server.socketPath, 60_000);
    const answer = (approve: boolean) =>
      box.waitFor((m) => m.type === 'confirm' && !box.messages.some((x) => x.type === 'confirm.end' && x.confirmId === m.confirmId)).then((q) =>
        box.send({ id: `b${approve}`, type: 'confirm.answer', confirmId: q.confirmId, approve }),
      );
    let p = c.confirm({ title: 'T', body: 'B' });
    await answer(true);
    expect(await p).toBe('approved');
    await box.waitFor((m) => m.type === 'confirm.end');
    p = c.confirm({ title: 'T', body: 'B' });
    await answer(false);
    expect(await p).toBe('declined');
    box.close();
    await sleep(20);
    expect(await new AppConfirmer(h.server.socketPath, 60_000).confirm({ title: 'T', body: 'B' })).toBe('unavailable');
    expect(await new AppConfirmer(join(h.home, 'run', 'nobody.sock'), 60_000).confirm({ title: 'T', body: 'B' })).toBe('unavailable');
  });

  it('AppConfirmer: an older listener (hello without confirms) is unavailable, not a silent wait', async () => {
    const home = mkdtempSync(join(tmp, 'old-'));
    const path = join(home, 'old.sock');
    const old = createServer((s) =>
      s.on('data', (d) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          const m = JSON.parse(line) as Msg;
          if (m.type === 'hello') s.write(`${JSON.stringify({ id: m.id, type: 'hello', version: '1', listening: true, model: 'x' })}\n`);
        }
      }),
    );
    await new Promise<void>((r) => old.listen(path, r));
    try {
      expect(await new AppConfirmer(path, 60_000).confirm({ title: 'T', body: 'B' })).toBe('unavailable');
    } finally {
      old.close();
    }
  });

  it("buildConfirmer 'auto' on macOS: elicit, then the Ask box, then the dialog; 'dialog' mode never uses the box", () => {
    const safety = { confirm: 'auto' as const, confirmTimeoutSec: 120 };
    const kinds = (c: ReturnType<typeof buildConfirmer>) => ('confirmers' in c ? (c.confirmers as { kind: string }[]).map((x) => x.kind) : [c.kind]);
    expect(kinds(buildConfirmer(safety, { platform: 'darwin', home: '/h', elicit: async () => 'accept' }))).toEqual(['elicit', 'app', 'dialog']);
    expect(kinds(buildConfirmer(safety, { platform: 'linux', home: '/h' }))).toEqual(['dialog']);
    expect(kinds(buildConfirmer(safety, { platform: 'darwin' }))).toEqual(['dialog']);
    expect(kinds(buildConfirmer({ ...safety, confirm: 'dialog' }, { platform: 'darwin', home: '/h' }))).toEqual(['dialog']);
  });

  it('the gate and the listener agree on the socket path', async () => {
    const { appSocketFor } = await import('../../src/safety/app-confirm.js');
    expect(appSocketFor('/Users/cris/.stephen')).toBe(appSocketPath('/Users/cris/.stephen'));
  });
});
