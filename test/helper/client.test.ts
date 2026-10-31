/**
 * HelperClient against a fake helper (a real Unix socket speaking the protocol): start/launch/timeout, typed
 * events, validation, state restore, reconnect, synthetic ptt_up on drop, close.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HelperClient, type HelperClientOptions, type IHelperClient, openHelperArgv } from '../../src/helper/client.js';
import type { HelperEvent } from '../../src/helper/protocol.js';
import { FakeHelper, until } from './fake-helper.js';

let dir: string;
let sock: string;
const cleanups: (() => unknown)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sh-client-'));
  sock = join(dir, 'run', 'helper.sock');
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

async function fake(opts?: ConstructorParameters<typeof FakeHelper>[1]): Promise<FakeHelper> {
  const f = new FakeHelper(sock, opts);
  await f.listen();
  cleanups.push(() => f.close());
  return f;
}

function client(over: Partial<HelperClientOptions> = {}): HelperClient {
  const c = new HelperClient({
    home: dir,
    socketPath: sock,
    appPath: join(dir, 'Stephen Helper.app'),
    platform: 'darwin',
    launch: false,
    retryIntervalMs: 20,
    reconnectIntervalMs: 50,
    helloTimeoutMs: 500,
    ...over,
  });
  cleanups.push(() => c.close());
  return c;
}

/** Record all events of every type. */
function recorder(c: IHelperClient): HelperEvent[] {
  const got: HelperEvent[] = [];
  for (const t of ['hello', 'ptt_down', 'ptt_up', 'esc', 'audio', 'error'] as const) c.on(t, (e) => got.push(e));
  return got;
}

describe('HelperClient', () => {
  it('connects to a running helper and resolves with its hello; asks for audio right away', async () => {
    const f = await fake({ inputMonitoring: false });
    const c = client();
    const r = await c.start();
    expect(r).toEqual({ ok: true, hello: { type: 'hello', version: '1', inputMonitoring: false } });
    expect(c.connected).toBe(true);
    await f.waitFor(() => f.received.some((m) => m.type === 'query_audio'));
    expect(f.received).toEqual([{ type: 'query_audio' }]);
  });

  it('emits typed events in order; drops malformed, unknown and over-long lines', async () => {
    const f = await fake();
    const c = client();
    const got = recorder(c);
    const downs: number[] = [];
    c.on('ptt_down', (e) => downs.push(e.at)); // e is typed as the ptt_down event
    await c.start();
    f.emit({ type: 'ptt_down', at: 10 });
    f.sendRaw('{not json');
    f.sendRaw('{"type":"ptt_up","at":11}'); // missing heldMs
    f.sendRaw('{"type":"brand_new","x":1}');
    f.sendRaw(`{"type":"error","message":"${'x'.repeat(5000)}"}`);
    f.sendRaw('{"type":"ptt_up","at":12,', false); // split across writes
    f.sendRaw('"heldMs":300}');
    f.emit({ type: 'esc', at: 13 });
    f.emit({ type: 'audio', playing: true, at: 14 });
    await until(() => got.length >= 5, 2000, 'events');
    expect(got).toEqual([
      { type: 'hello', version: '1', inputMonitoring: true },
      { type: 'ptt_down', at: 10 },
      { type: 'ptt_up', at: 12, heldMs: 300 },
      { type: 'esc', at: 13 },
      { type: 'audio', playing: true, at: 14 },
    ]);
    expect(downs).toEqual([10]);
  });

  it('on() returns an unsubscribe; a throwing handler does not stop the others', async () => {
    const f = await fake();
    const logs: string[] = [];
    const c = client({ log: (l) => logs.push(l) });
    const a: number[] = [];
    const b: number[] = [];
    const offA = c.on('esc', (e) => a.push(e.at));
    c.on('esc', () => {
      throw new Error('boom');
    });
    c.on('esc', (e) => b.push(e.at));
    await c.start();
    f.emit({ type: 'esc', at: 1 });
    await until(() => b.length === 1);
    offA();
    f.emit({ type: 'esc', at: 2 });
    await until(() => b.length === 2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });

  it('sends commands as JSON lines; remembers the last state and re-sends it after a reconnect', async () => {
    const f = await fake();
    const c = client();
    await c.start();
    c.send({ type: 'state', state: 'recording' });
    c.send({ type: 'state', state: 'working' });
    await f.waitFor(() => f.received.length === 3);
    expect(f.rawReceived).toEqual(['{"type":"query_audio"}', '{"type":"state","state":"recording"}', '{"type":"state","state":"working"}']);

    const conn: boolean[] = [];
    c.onConnection((v) => conn.push(v));
    f.kick();
    await until(() => conn.length === 2, 3000, 'reconnect');
    expect(conn).toEqual([false, true]);
    await f.waitFor(() => f.received.length === 5);
    expect(f.received.slice(3)).toEqual([{ type: 'state', state: 'working' }, { type: 'query_audio' }]);
    expect(f.connections).toBe(2);
  });

  it('a drop while push-to-talk is down emits a synthetic ptt_up before connection(false)', async () => {
    const f = await fake();
    const c = client({ reconnectIntervalMs: 5_000 });
    const order: string[] = [];
    c.on('ptt_up', (e) => order.push(`ptt_up:${e.heldMs >= 0}:${e.aborted === true}`));
    await c.start();
    c.onConnection((v) => order.push(`connected:${v}`));
    f.emit({ type: 'ptt_down', at: Date.now() });
    await until(() => f.hasClient);
    await new Promise((r) => setTimeout(r, 50));
    f.kick();
    await until(() => order.length === 2);
    // review #4 finding 1: the synthetic release is marked aborted so the listener discards the recording
    expect(order).toEqual(['ptt_up:true:true', 'connected:false']);
    expect(c.connected).toBe(false);
  });

  it('reconnects when the helper process restarts (socket gone, then back)', async () => {
    let f = await fake();
    const c = client();
    const hellos: boolean[] = [];
    c.on('hello', (h) => hellos.push(h.inputMonitoring));
    await c.start();
    await f.close();
    await until(() => !c.connected);
    await new Promise((r) => setTimeout(r, 150)); // a few failed attempts
    f = await fake({ inputMonitoring: false });
    await until(() => c.connected, 3000, 'reconnect');
    expect(hellos).toEqual([true, false]);
  });

  it('while disconnected, commands other than state are dropped', async () => {
    const f = await fake();
    const c = client({ reconnectIntervalMs: 200 });
    await c.start();
    await f.waitFor(() => f.received.length === 1);
    await f.close();
    await until(() => !c.connected);
    c.send({ type: 'quit' });
    c.send({ type: 'state', state: 'speaking' });
    const g = await fake();
    await until(() => c.connected, 3000);
    await g.waitFor(() => g.received.length === 2);
    expect(g.received).toEqual([{ type: 'state', state: 'speaking' }, { type: 'query_audio' }]);
  });

  it('launches the app when the socket does not answer, then connects (open -a <app> --args --home <home>)', async () => {
    const calls: [string, string][] = [];
    const c = client({
      launch: true,
      exists: () => true,
      launchFn: async (app, home) => {
        calls.push([app, home]);
        setTimeout(() => void fake(), 150); // the "app" opens its socket a bit later
        return { ok: true };
      },
    });
    const r = await c.start();
    expect(r.ok).toBe(true);
    expect(calls).toEqual([[join(dir, 'Stephen Helper.app'), dir]]);
    expect(openHelperArgv('/A/Stephen Helper.app', '/h o')).toEqual(['-a', '/A/Stephen Helper.app', '--args', '--home', '/h o']);
  });

  it('not installed / not macOS / launch disabled → ok:false with a reason, never throws', async () => {
    expect(await client({ launch: true, exists: () => false }).start()).toEqual({
      ok: false,
      reason: expect.stringContaining('stephen install-helper'),
    });
    expect(await client({ launch: true, platform: 'linux' }).start()).toEqual({ ok: false, reason: expect.stringContaining('only runs on macOS') });
    expect(await client({ launch: false }).start()).toEqual({ ok: false, reason: expect.stringContaining('not running') });
  });

  it('gives up after connectTimeoutMs when the launched helper never answers', async () => {
    const t0 = Date.now();
    const r = await client({ launch: true, exists: () => true, launchFn: async () => ({ ok: true }), connectTimeoutMs: 300 }).start();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/did not answer .* within/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a socket that never says hello fails start()', async () => {
    await fake({ silent: true });
    const r = await client({ helloTimeoutMs: 150 }).start();
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('no hello') });
  });

  it('a launch failure is reported', async () => {
    const r = await client({ launch: true, exists: () => true, launchFn: async () => ({ ok: false, reason: 'open failed: nope' }) }).start();
    expect(r).toEqual({ ok: false, reason: 'open failed: nope' });
  });

  it('close() stops reconnecting and silences handlers', async () => {
    const f = await fake();
    const c = client();
    const got = recorder(c);
    await c.start();
    c.close();
    await new Promise((r) => setTimeout(r, 50));
    f.emit({ type: 'esc', at: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(got.map((e) => e.type)).toEqual(['hello']);
    expect(f.connections).toBe(1);
    expect(await c.start()).toEqual({ ok: false, reason: 'client is closed' });
  });

  it('concurrent start() calls share one attempt', async () => {
    const f = await fake();
    const c = client();
    const [a, b] = await Promise.all([c.start(), c.start()]);
    expect(a).toEqual(b);
    expect(f.connections).toBe(1);
  });
});
