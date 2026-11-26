/**
 * The real Swift core (helper/Core.swift: socket server, framing, JSON parsing, push-to-talk) compiled with the
 * test harness test/helper/swift/main.swift, driven through the real HelperClient. Runs only when a Swift
 * compiler is available: $STEPHEN_TEST_SWIFTC, or `swiftc` on PATH (skipped otherwise). On macOS it also compiles
 * the full app (helper/main.swift with AppKit/CoreAudio/CoreGraphics).
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { type Socket, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HelperClient, readHelperNonce } from '../../src/helper/client.js';
import { LineFramer } from '../../src/helper/framing.js';
import { HELPER_FRAMEWORKS, HELPER_SOURCES, buildWithSdkFallback, findSwiftCompiler, listFallbackSdks, swiftcArgs } from '../../src/helper/install.js';
import type { HelperEvent } from '../../src/helper/protocol.js';
import { defaultRun } from '../../src/zen-launcher.js';
import { until } from './fake-helper.js';
import { SCENARIOS, SCENARIO_MAX_HOLD_MS, harnessLine } from './ptt-model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function findSwiftc(): string | null {
  const env = process.env.STEPHEN_TEST_SWIFTC?.trim();
  const candidates = env ? [env] : ['swiftc'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 60_000 });
      return c;
    } catch {
      // not available
    }
  }
  return null;
}

const SWIFTC = findSwiftc();
let work: string;
let harnessBin: string;

beforeAll(() => {
  if (!SWIFTC) return;
  work = mkdtempSync(join(tmpdir(), 'sh-swift-'));
  harnessBin = join(work, 'harness');
  const args = ['-swift-version', '5', ...(process.platform === 'linux' ? ['-static-stdlib'] : []), '-o', harnessBin, join(ROOT, 'helper', 'Core.swift'), join(ROOT, 'test', 'helper', 'swift', 'main.swift')];
  const r = spawnSync(SWIFTC, args, { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`swiftc failed:\n${r.stderr}${r.stdout}`);
}, 300_000);
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

class Harness {
  readonly proc: ChildProcess;
  readonly lines: string[] = [];
  readonly stderr: string[] = [];
  exitCode: number | null = null;
  constructor(readonly socketPath: string, extra: string[] = []) {
    this.proc = spawn(harnessBin, ['--socket', socketPath, '--max-hold-ms', String(SCENARIO_MAX_HOLD_MS), ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    this.proc.stderr!.on('data', (d: Buffer) => this.stderr.push(d.toString()));
    this.proc.on('exit', (code) => (this.exitCode = code ?? -1));
  }
  input(line: string): void {
    this.proc.stdin!.write(`${line}\n`);
  }
  async ready(): Promise<void> {
    await until(() => this.lines.includes('ready') || this.exitCode !== null, 10_000, 'harness ready');
    if (!this.lines.includes('ready')) throw new Error(`harness failed: ${this.lines.join('\n')}\n${this.stderr.join('')}`);
  }
  kill(): void {
    if (this.exitCode === null) this.proc.kill('SIGKILL');
  }
}

const run = SWIFTC ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run(`Swift core (${SWIFTC ?? 'no swiftc'})`, () => {
  let dir: string;
  const kills: (() => void)[] = [];
  const mk = () => {
    dir = mkdtempSync(join(tmpdir(), 'shs-'));
    return join(dir, 'home', 'run', 'helper.sock');
  };
  afterEach(() => {
    for (const k of kills.splice(0)) k();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const start = async (sock: string) => {
    const h = new Harness(sock);
    kills.push(() => h.kill());
    await h.ready();
    return h;
  };
  /** A raw connection that sends the helper's nonce first (F15). */
  const authed = (sock: string, nonce: string | null = readHelperNonce(sock)): Socket => {
    const s = createConnection(sock);
    s.once('connect', () => s.write(`${JSON.stringify({ type: 'auth', nonce })}\n`));
    return s;
  };
  const client = (sock: string) => {
    const c = new HelperClient({ home: dirname(dirname(sock)), socketPath: sock, launch: false, reconnectIntervalMs: 100 });
    kills.push(() => c.close());
    return c;
  };

  it('#202 C1: the app.sock reconnect wait goes 3, 6, 10, 10 s (nextRetryDelay, max 10 s)', () => {
    const r = spawnSync(harnessBin, ['--retry-delays'], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('3 6 10 10');
  });

  it('creates run/ 0700 and the socket 0600; hello first, then audio', async () => {
    const sock = mk();
    await start(sock);
    expect(statSync(dirname(sock)).mode & 0o777).toBe(0o700);
    expect(statSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    const c = client(sock);
    const audio: HelperEvent[] = [];
    c.on('audio', (e) => audio.push(e));
    expect(await c.start()).toEqual({ ok: true, hello: { type: 'hello', version: '1', inputMonitoring: true, postEvents: true } });
    await until(() => audio.length >= 1);
    expect(audio[0]).toMatchObject({ type: 'audio', playing: false });
  });

  it('runs every push-to-talk scenario like the TypeScript model', async () => {
    const sock = mk();
    const h = await start(sock);
    const c = client(sock);
    const got: HelperEvent[] = [];
    for (const t of ['ptt_down', 'ptt_up', 'esc'] as const) c.on(t, (e) => got.push(e));
    await c.start();
    for (const s of SCENARIOS) {
      got.length = 0;
      for (const step of s.steps) {
        if ('wait' in step) await sleep(step.wait);
        else h.input(harnessLine(step));
        await sleep(15);
      }
      await sleep(80);
      expect(got.map((e) => e.type), s.name).toEqual(s.expect);
      h.input('flags');
      await sleep(30);
    }
  }, 60_000);

  it('heldMs measures the hold; Esc carries a wall-clock timestamp', async () => {
    const sock = mk();
    const h = await start(sock);
    const c = client(sock);
    const got: HelperEvent[] = [];
    for (const t of ['ptt_up', 'esc'] as const) c.on(t, (e) => got.push(e));
    await c.start();
    h.input('flags fn opt');
    await sleep(150);
    h.input('flags fn');
    h.input('key 53');
    await until(() => got.length === 2);
    const up = got[0] as Extract<HelperEvent, { type: 'ptt_up' }>;
    expect(up.heldMs).toBeGreaterThanOrEqual(120);
    expect(up.heldMs).toBeLessThan(1_000);
    expect(Math.abs(got[1]!.type === 'esc' ? got[1]!.at - Date.now() : 1e9)).toBeLessThan(5_000);
  });

  it('#392 review: a link in place of the run folder is refused, and its target keeps its permissions', async () => {
    const sock = mk();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o755 });
    mkdirSync(dirname(dirname(sock)), { recursive: true });
    symlinkSync(elsewhere, dirname(sock));
    const h = new Harness(sock);
    kills.push(() => h.kill());
    await until(() => h.exitCode !== null, 10_000, 'harness exits');
    expect(h.lines.join('\n')).toMatch(/is a link or not a folder/);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
    expect(existsSync(join(elsewhere, 'helper.sock'))).toBe(false);
  });

  it('F15: a fresh 0600 nonce per launch; no auth line, a wrong nonce, or junk first is dropped without a hello, and never replaces the current client', async () => {
    const sock = mk();
    const h = await start(sock);
    const nonceFile = join(dirname(sock), 'helper.nonce');
    expect(statSync(nonceFile).mode & 0o777).toBe(0o600);
    const nonce = readHelperNonce(sock);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const good = authed(sock);
    kills.push(() => good.destroy());
    let goodData = '';
    good.on('data', (d) => (goodData += d.toString()));
    await until(() => goodData.includes('"hello"'));
    const tries: [string, (s: Socket) => void][] = [
      ['silent', () => {}],
      ['wrong nonce', (s) => s.write(`${JSON.stringify({ type: 'auth', nonce: '0'.repeat(64) })}\n`)],
      ['a command first', (s) => s.write('{"type":"quit"}\n')],
      ['an over-long first line', (s) => s.write(`${'x'.repeat(300)}\n`)],
    ];
    for (const [name, send] of tries) {
      const bad = createConnection(sock);
      kills.push(() => bad.destroy());
      let data = '';
      let closed = false;
      bad.on('data', (d) => (data += d.toString()));
      bad.on('close', () => (closed = true));
      bad.on('error', () => {});
      bad.once('connect', () => send(bad));
      await until(() => closed, 4000, `${name} dropped`);
      expect(data, name).toBe('');
    }
    expect(h.lines).not.toContain('quit');
    h.input('key 53');
    await until(() => goodData.includes('"esc"'), 3000, 'the good client is still current');
    expect(h.stderr.join('')).toContain('rejected (no valid auth line');
    // A restart makes a new nonce, so an old one stops working.
    h.input('exit');
    await until(() => h.exitCode !== null, 5000, 'exit');
    expect(existsSync(nonceFile)).toBe(false);
    await start(sock);
    expect(readHelperNonce(sock)).not.toBe(nonce);
  });

  it('#392 review: with the key file gone, the client says so plainly instead of "connection closed before hello"', async () => {
    const sock = mk();
    await start(sock);
    rmSync(join(dirname(sock), 'helper.nonce'));
    const c = new HelperClient({ home: dirname(dirname(sock)), socketPath: sock, launch: false, connectTimeoutMs: 1500 });
    kills.push(() => c.close());
    const r = await c.start();
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/key file .*helper\.nonce is missing or not readable.*install-helper/) });
  });

  it('handles commands: state (incl. JSON escapes), query_audio; ignores malformed, unknown and over-long lines', async () => {
    const sock = mk();
    const h = await start(sock);
    const s: Socket = authed(sock);
    kills.push(() => s.destroy());
    const framer = new LineFramer();
    const events: Record<string, unknown>[] = [];
    s.on('data', (d: Buffer) => framer.push(d).forEach((l) => events.push(JSON.parse(l) as Record<string, unknown>)));
    await until(() => events.length >= 2); // hello + audio
    s.write('{"type":"state","state":"recording"}\n');
    s.write('{"type":"state","state":"dancing"}\n{not json\n{"type":"future"}\n[1,2]\n');
    s.write(`{"type":"state","state":"working","pad":"${'x'.repeat(5000)}"}\n`);
    s.write('{"type":"st\\u0061te", "state" : "speaking", "nested": {"a": [1, 2.5e3, true, null, "\\ud83d\\udd08"]}}\r\n');
    s.write('{"type":"query_audio"}\n');
    await until(() => h.lines.includes('ui speaking') && events.length >= 3, 3000, 'commands');
    expect(h.lines.filter((l) => l.startsWith('ui '))).toEqual(['ui recording', 'ui speaking']);
    expect(events[2]).toMatchObject({ type: 'audio', playing: false });
    expect(h.stderr.join('')).toContain('dropped an over-long line');
  });

  it('open_window (additive command) reaches the platform layer', async () => {
    const sock = mk();
    const h = await start(sock);
    const c = client(sock);
    await c.start();
    c.send({ type: 'open_window' });
    await until(() => h.lines.includes('open_window'), 3000, 'open_window');
    expect(h.stderr.join('')).not.toContain('ignored unknown command type "open_window"');
  });

  it('issue #205: media_key is posted by the platform layer and answered with media_key_done; hello reports postEvents', async () => {
    const sock = mk();
    const h = await start(sock);
    const c = client(sock);
    const got: HelperEvent[] = [];
    for (const t of ['hello', 'media_key_done'] as const) c.on(t, (e) => got.push(e));
    await c.start();
    await until(() => got.some((e) => e.type === 'hello'));
    expect(got.find((e) => e.type === 'hello')).toMatchObject({ postEvents: true });
    c.send({ type: 'media_key', key: 'next' });
    await until(() => got.some((e) => e.type === 'media_key_done'), 3000, 'media_key_done');
    expect(h.lines).toContain('media_key next');
    expect(got.filter((e) => e.type === 'media_key_done')).toEqual([{ type: 'media_key_done', key: 'next', ok: true }]);
    h.input('postkeys 0');
    await sleep(50);
    c.send({ type: 'media_key', key: 'play_pause' });
    await until(() => got.filter((e) => e.type === 'media_key_done').length >= 2, 3000, 'second media_key_done');
    expect(got.filter((e) => e.type === 'media_key_done')[1]).toEqual({ type: 'media_key_done', key: 'play_pause', ok: false, message: 'Stephen Helper needs the Accessibility permission' });
    // A bad key is refused by the parser, never posted.
    c.send({ type: 'media_key', key: 'eject' } as never);
    await sleep(100);
    expect(h.lines.filter((l) => l.startsWith('media_key '))).toEqual(['media_key next', 'media_key play_pause']);
  });

  it('audio is pushed on change only; a permission change re-sends hello', async () => {
    const sock = mk();
    const h = await start(sock);
    const c = client(sock);
    const got: HelperEvent[] = [];
    for (const t of ['hello', 'audio'] as const) c.on(t, (e) => got.push(e));
    await c.start();
    // One audio event on connect, one answering the client's query_audio.
    await until(() => got.filter((e) => e.type === 'audio').length >= 2);
    await sleep(50);
    got.length = 0;
    h.input('audio 1');
    h.input('audio 1');
    h.input('audio 0');
    h.input('perm 0');
    await until(() => got.length >= 3);
    await sleep(100);
    expect(got.map((e) => (e.type === 'audio' ? `audio:${e.playing}` : e.type === 'hello' ? `hello:${e.inputMonitoring}` : e.type))).toEqual([
      'audio:true',
      'audio:false',
      'hello:false',
    ]);
  });

  it('one client at a time: a new connection replaces the old; the UI goes idle when the client leaves', async () => {
    const sock = mk();
    const h = await start(sock);
    const a = authed(sock);
    kills.push(() => a.destroy());
    let aClosed = false;
    let aData = '';
    a.on('data', (d) => (aData += d.toString()));
    a.on('close', () => (aClosed = true));
    await until(() => aData.includes('"hello"'));
    const b = authed(sock);
    kills.push(() => b.destroy());
    let bData = '';
    b.on('data', (d) => (bData += d.toString()));
    await until(() => bData.includes('"hello"') && aClosed, 3000, 'replacement');
    expect(h.lines).not.toContain('ui idle'); // replaced, not abandoned
    h.input('key 53');
    await until(() => bData.includes('"esc"'));
    expect(aData).not.toContain('"esc"');
    b.destroy();
    await until(() => h.lines.includes('ui idle'), 3000, 'ui idle');
  });

  it('quit removes the socket and exits', async () => {
    const sock = mk();
    const h = await start(sock);
    const c = client(sock);
    await c.start();
    c.send({ type: 'quit' });
    await until(() => h.exitCode !== null, 5000, 'exit');
    expect(h.lines).toContain('quit');
    expect(existsSync(sock)).toBe(false);
  });

  it('replaces a stale socket, refuses to steal a live one, never deletes a non-socket file', async () => {
    const sock = mk();
    const first = new Harness(sock);
    await first.ready();
    first.kill(); // SIGKILL: the socket file stays behind
    await until(() => first.exitCode !== null);
    expect(existsSync(sock)).toBe(true);
    const second = await start(sock);
    expect(await client(sock).start()).toMatchObject({ ok: true });

    const third = new Harness(sock);
    kills.push(() => third.kill());
    await until(() => third.exitCode !== null, 5000, 'third exits');
    expect(third.lines.join('\n')).toContain('already listening');
    expect(second.exitCode).toBe(null);

    const other = join(dir, 'other', 'run', 'helper.sock');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, 'not a socket');
    const fourth = new Harness(other);
    kills.push(() => fourth.kill());
    await until(() => fourth.exitCode !== null, 5000, 'fourth exits');
    expect(fourth.lines.join('\n')).toContain('not a socket');
    expect(statSync(other).isFile()).toBe(true);
  });

  it('the client reconnects after the helper restarts and gets a fresh hello', async () => {
    const sock = mk();
    const h1 = await start(sock);
    const c = client(sock);
    const conn: boolean[] = [];
    await c.start();
    c.onConnection((v) => conn.push(v));
    c.send({ type: 'state', state: 'working' });
    await until(() => h1.lines.includes('ui working'));
    h1.input('exit');
    await until(() => conn.includes(false), 3000, 'drop');
    const h2 = await start(sock);
    await until(() => conn.at(-1) === true, 5000, 'reconnect');
    await until(() => h2.lines.includes('ui working'), 3000, 'state restored');
  });

  it.runIf(process.platform === 'darwin')('compiles the full macOS app (same SDK choice as install-helper, #248)', async () => {
    const out = join(work, 'Stephen Helper');
    const found = await findSwiftCompiler(defaultRun);
    const sdk = found.ok ? found.compiler.sdkPath : null;
    const b = await buildWithSdkFallback(sdk, (s) => defaultRun(SWIFTC!, swiftcArgs(join(ROOT, 'helper'), out, s), 600_000), () => listFallbackSdks(sdk));
    expect(b.result.stderr + b.result.stdout).not.toMatch(/error:/);
    expect(b.ok).toBe(true);
  }, 1_200_000);

  it.runIf(process.platform === 'darwin')('T6 step 4: Activity rows say host only, never args or error text, quote and cut page text; R7 failures in plain words', () => {
    const bin = join(work, 'activity');
    const sources = HELPER_SOURCES.filter((f) => f !== 'main.swift').map((f) => join(ROOT, 'helper', f));
    const args = ['-swift-version', '5', '-o', bin, ...sources, join(ROOT, 'test', 'helper', 'swift', 'activity', 'main.swift'), ...HELPER_FRAMEWORKS.flatMap((f) => ['-framework', f])];
    const c = spawnSync(SWIFTC!, args, { encoding: 'utf8', timeout: 600_000 });
    expect(c.stderr + c.stdout).not.toMatch(/error:/);
    const r = spawnSync(bin, [], { encoding: 'utf8', timeout: 10_000 });
    expect(r.stdout.trim()).toBe('ok');
    expect(r.status).toBe(0);
  }, 600_000);
});
