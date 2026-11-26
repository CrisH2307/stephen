/**
 * Node side of the Stephen Helper socket (see `./protocol.ts` for the wire contract).
 *
 * `IHelperClient` is the FROZEN interface the voice listener (track B) codes against. Semantics:
 *  - `start()` launches "Stephen Helper.app" if its socket is not answering, connects (retrying for ~5 s) and
 *    resolves with the helper's first `hello`, or `{ ok: false, reason }` (not installed, not macOS, timeout…).
 *    It never rejects. After `ok: true` the client keeps the connection alive: if the helper quits or restarts it
 *    reconnects in the background (relaunching the app), and every reconnect emits a fresh `hello`.
 *  - `on(type, fn)` subscribes to one event type; it returns an unsubscribe function. Events are validated; malformed
 *    or over-long lines are dropped. Handlers run synchronously in arrival order; a throwing handler is isolated.
 *  - If the connection drops while push-to-talk is down, the client emits a synthetic `ptt_up` (so a recording
 *    never sticks), then `connected` becomes false and `onConnection(false)` fires. While disconnected the
 *    listener should fall back to its no-helper behaviour (wake-word cooldown; assume `audio.playing` unknown).
 *  - `send(cmd)` is fire-and-forget. While disconnected commands are dropped, except that the last `state` is
 *    remembered and re-sent after every (re)connect, and `query_audio` is sent automatically after every hello.
 *  - `close()` stops reconnecting and closes the socket. It does NOT quit the helper app (send `{type:'quit'}`
 *    first for that).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type Socket, createConnection } from 'node:net';
import { LineFramer, encodeCommand, parseHelperLine } from './framing.js';
import { readPrivateJsonFile } from '../lib/fs.js';
import { helperAppPath, helperLogPath, helperNoncePath, helperSocketPath } from './paths.js';
import type { HelperCommand, HelperEvent } from './protocol.js';

export type HelperEventType = HelperEvent['type'];
export type HelperEventOf<T extends HelperEventType> = Extract<HelperEvent, { type: T }>;
export type HelperHello = HelperEventOf<'hello'>;
export type HelperStartResult = { ok: true; hello: HelperHello } | { ok: false; reason: string };

export interface IHelperClient {
  start(): Promise<HelperStartResult>;
  on<T extends HelperEventType>(event: T, fn: (e: HelperEventOf<T>) => void): () => void;
  send(cmd: HelperCommand): void;
  close(): void;
  /** True while a socket to the helper is open and its `hello` has arrived. */
  readonly connected: boolean;
  /** Connection changes (true after each hello, false on each drop). Returns an unsubscribe function. */
  onConnection(fn: (connected: boolean) => void): () => void;
}

// ───────────────────────────── implementation ─────────────────────────────

export type LaunchFn = (appPath: string, stephenHome: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** `open -a "<app>" --args --home <home>` (argv, no shell): macOS attributes permissions to the helper app. */
export const defaultLaunch: LaunchFn = (appPath, stephenHome) =>
  new Promise((resolve) => {
    execFile('/usr/bin/open', openHelperArgv(appPath, stephenHome), { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (!err) resolve({ ok: true });
      else resolve({ ok: false, reason: `open failed: ${String(stderr || err.message).trim().split('\n')[0]}` });
    });
  });

export function openHelperArgv(appPath: string, stephenHome: string): string[] {
  return ['-a', appPath, '--args', '--home', stephenHome];
}

export interface HelperClientOptions {
  /** Stephen's home folder (the helper is started with `--home <home>`). */
  home: string;
  /** Default `<home>/run/helper.sock`. */
  socketPath?: string;
  /** Default `~/Applications/Stephen Helper.app`. */
  appPath?: string;
  /** Start the app when its socket does not answer (default: true on macOS). */
  launch?: boolean;
  launchFn?: LaunchFn;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  /** How long start() keeps trying to connect after launching (default 5000 ms). */
  connectTimeoutMs?: number;
  /** Pause between connection attempts (default 100 ms). */
  retryIntervalMs?: number;
  /** How long to wait for `hello` once connected (default 2000 ms). */
  helloTimeoutMs?: number;
  /** Pause between background reconnect attempts (default 500 ms). */
  reconnectIntervalMs?: number;
  /** While reconnecting, relaunch the app at most this often (default 10 000 ms). */
  relaunchIntervalMs?: number;
  log?: (line: string) => void;
}

type AnyHandler = (e: HelperEvent) => void;

interface Conn {
  socket: Socket;
  hello: HelperHello | null;
}

/** Factory used by the voice listener (src/voice/helper-link.ts loads it lazily). */
export function createHelperClient(options: HelperClientOptions): HelperClient {
  return new HelperClient(options);
}

export class HelperClient implements IHelperClient {
  readonly socketPath: string;
  readonly appPath: string;
  private readonly opts: Required<Omit<HelperClientOptions, 'socketPath' | 'appPath' | 'log'>> & { log: (l: string) => void };
  private readonly handlers = new Map<HelperEventType, Set<AnyHandler>>();
  private readonly connHandlers = new Set<(c: boolean) => void>();
  private conn: Conn | null = null;
  private startPromise: Promise<HelperStartResult> | null = null;
  private started = false;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastLaunchAt = 0;
  private lastState: Extract<HelperCommand, { type: 'state' }> | null = null;
  private pttDownAt: number | null = null;

  constructor(options: HelperClientOptions) {
    const platform = options.platform ?? process.platform;
    this.socketPath = options.socketPath ?? helperSocketPath(options.home);
    this.appPath = options.appPath ?? helperAppPath();
    this.opts = {
      home: options.home,
      launch: options.launch ?? platform === 'darwin',
      launchFn: options.launchFn ?? defaultLaunch,
      platform,
      exists: options.exists ?? existsSync,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
      retryIntervalMs: options.retryIntervalMs ?? 100,
      helloTimeoutMs: options.helloTimeoutMs ?? 2_000,
      reconnectIntervalMs: options.reconnectIntervalMs ?? 500,
      relaunchIntervalMs: options.relaunchIntervalMs ?? 10_000,
      log: options.log ?? (() => undefined),
    };
  }

  get connected(): boolean {
    return !!this.conn?.hello;
  }

  on<T extends HelperEventType>(event: T, fn: (e: HelperEventOf<T>) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    const h = fn as AnyHandler;
    set.add(h);
    return () => void set.delete(h);
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connHandlers.add(fn);
    return () => void this.connHandlers.delete(fn);
  }

  start(): Promise<HelperStartResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: 'client is closed' });
    this.startPromise ??= this.doStart().then((r) => {
      if (r.ok) this.started = true;
      else this.startPromise = null; // a later start() may try again
      return r;
    });
    return this.startPromise;
  }

  send(cmd: HelperCommand): void {
    if (this.closed) return;
    if (cmd.type === 'state') this.lastState = cmd;
    const c = this.conn;
    if (!c?.hello || c.socket.destroyed) return;
    c.socket.write(encodeCommand(cmd));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const c = this.conn;
    this.conn = null;
    if (c) {
      // Flush anything just written (e.g. a final `quit`), then close.
      c.socket.end();
      setTimeout(() => c.socket.destroy(), 200).unref();
    }
    this.handlers.clear();
    this.connHandlers.clear();
  }

  // ───────────── internals ─────────────

  private async doStart(): Promise<HelperStartResult> {
    const first = await this.tryConnect();
    if (first.ok) return first;
    if (this.closed) return { ok: false, reason: 'client is closed' };
    if (!this.opts.launch) return { ok: false, reason: `Stephen Helper is not running (${first.reason})` };
    if (this.opts.platform !== 'darwin') return { ok: false, reason: 'Stephen Helper only runs on macOS' };
    if (!this.opts.exists(this.appPath)) {
      return { ok: false, reason: `Stephen Helper is not installed (${this.appPath} not found) — run \`stephen install-helper\`` };
    }
    const launched = await this.launch();
    if (!launched.ok) return launched;
    const deadline = Date.now() + this.opts.connectTimeoutMs;
    let last = first.reason;
    while (!this.closed && Date.now() < deadline) {
      await sleep(this.opts.retryIntervalMs);
      const r = await this.tryConnect();
      if (r.ok) return r;
      last = r.reason;
    }
    if (this.closed) return { ok: false, reason: 'client is closed' };
    return {
      ok: false,
      reason:
        `Stephen Helper did not answer on ${this.socketPath} within ${Math.round(this.opts.connectTimeoutMs / 1000)} s (${last}). ` +
        `See ${helperLogPath(this.opts.home)}.`,
    };
  }

  private async launch(): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.lastLaunchAt = Date.now();
    this.opts.log(`starting ${this.appPath}`);
    try {
      return await this.opts.launchFn(this.appPath, this.opts.home);
    } catch (e) {
      return { ok: false, reason: `could not start Stephen Helper: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** One attempt: connect, wait for hello. On success the connection becomes current. */
  private tryConnect(): Promise<HelperStartResult> {
    return new Promise((resolve) => {
      if (this.closed) return resolve({ ok: false, reason: 'client is closed' });
      const socket = createConnection(this.socketPath);
      const conn: Conn = { socket, hello: null };
      const framer = new LineFramer();
      let settled = false;
      const settle = (r: HelperStartResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(helloTimer);
        resolve(r);
      };
      const helloTimer = setTimeout(() => {
        settle({ ok: false, reason: `connected but no hello within ${this.opts.helloTimeoutMs} ms` });
        socket.destroy();
      }, this.opts.helloTimeoutMs);

      socket.on('error', (e: NodeJS.ErrnoException) => {
        settle({ ok: false, reason: e.code ?? e.message });
      });
      // F15: the first line is the helper's per-launch nonce, or the helper drops this client before its hello.
      let noNonce = false;
      socket.once('connect', () => {
        const nonce = readHelperNonce(this.socketPath);
        if (nonce) socket.write(`${JSON.stringify({ type: 'auth', nonce })}\n`);
        else {
          noNonce = true;
          this.opts.log(`no readable ${helperNoncePath(this.socketPath)}: the helper will refuse this connection`);
        }
      });
      socket.on('close', () => {
        // An older helper has no nonce file and still says hello; a closed connection without one means the helper's
        // key file is gone or unreadable (#392 review): say that plainly.
        settle({ ok: false, reason: noNonce ? helperKeyMissing(this.socketPath) : 'connection closed before hello' });
        if (this.conn === conn) this.onDrop(conn);
      });
      socket.on('data', (data: Buffer) => {
        const before = framer.dropped;
        for (const line of framer.push(data)) {
          const p = parseHelperLine(line);
          if (p.kind === 'invalid') {
            this.opts.log(`dropped a malformed helper line (${p.reason})`);
            continue;
          }
          if (p.kind === 'unknown') continue;
          const ev = p.event;
          if (!conn.hello) {
            if (ev.type !== 'hello') continue; // nothing before hello counts
            if (this.closed) {
              socket.destroy();
              return;
            }
            conn.hello = ev;
            this.adopt(conn);
            settle({ ok: true, hello: ev });
            continue;
          }
          if (this.conn !== conn) return;
          this.dispatch(ev);
        }
        if (framer.dropped > before) this.opts.log('dropped an over-long helper line');
      });
    });
  }

  /** A connection said hello: make it current, tell listeners, restore state. */
  private adopt(conn: Conn): void {
    const old = this.conn;
    this.conn = conn;
    this.started = true;
    if (old && old !== conn) old.socket.destroy();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dispatch(conn.hello!);
    for (const fn of [...this.connHandlers]) safe(() => fn(true), this.opts.log);
    if (this.conn !== conn) return;
    if (this.lastState) conn.socket.write(encodeCommand(this.lastState));
    conn.socket.write(encodeCommand({ type: 'query_audio' }));
  }

  private dispatch(ev: HelperEvent): void {
    if (ev.type === 'ptt_down') this.pttDownAt = Date.now();
    else if (ev.type === 'ptt_up') this.pttDownAt = null;
    const set = this.handlers.get(ev.type);
    if (!set) return;
    for (const fn of [...set]) safe(() => fn(ev), this.opts.log);
  }

  private onDrop(conn: Conn): void {
    this.conn = null;
    if (this.closed) return;
    this.opts.log('helper connection lost');
    if (this.pttDownAt !== null) {
      const now = Date.now();
      this.dispatch({ type: 'ptt_up', at: now, heldMs: Math.max(0, now - this.pttDownAt), aborted: true });
    }
    if (conn.hello) for (const fn of [...this.connHandlers]) safe(() => fn(false), this.opts.log);
    if (this.started) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed || this.conn) return;
      const r = await this.tryConnect();
      if (r.ok || this.closed || this.conn) return;
      if (
        this.opts.launch &&
        this.opts.platform === 'darwin' &&
        Date.now() - this.lastLaunchAt >= this.opts.relaunchIntervalMs &&
        this.opts.exists(this.appPath)
      ) {
        const l = await this.launch();
        if (!l.ok) this.opts.log(l.reason);
      }
      this.scheduleReconnect();
    }, this.opts.reconnectIntervalMs);
    this.reconnectTimer.unref?.();
  }
}

function safe(fn: () => void, log: (l: string) => void): void {
  try {
    fn();
  } catch (e) {
    log(`helper event handler threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Why the helper refused us when its key file could not be read. */
export function helperKeyMissing(socketPath: string): string {
  return `Stephen Helper refused the connection: its key file ${helperNoncePath(socketPath)} is missing or not readable. Quit Stephen Helper (menu bar, Quit), then start Stephen again. If that does not help, run \`stephen install-helper\`.`;
}

/** The nonce from helper.nonce (0600, this user's, never a link), or null. */
export function readHelperNonce(socketPath: string): string | null {
  const r = readPrivateJsonFile(helperNoncePath(socketPath), 1024);
  const n = 'state' in r ? (r.state as { nonce?: unknown } | null)?.nonce : null;
  return typeof n === 'string' && /^[0-9a-f]{64}$/.test(n) ? n : null;
}

/**
 * Connect once without launching or reconnecting, read `hello`, and disconnect (doctor uses this).
 * Note: the helper serves one client at a time, so this briefly takes the connection from a running
 * `stephen listen`, which reconnects on its own within about a second.
 */
export async function probeHelper(
  socketPath: string,
  timeoutMs = 1_500,
): Promise<{ running: true; hello: HelperHello } | { running: false; reason: string }> {
  const client = new HelperClient({ home: '', socketPath, launch: false, helloTimeoutMs: timeoutMs });
  try {
    const r = await client.start();
    return r.ok ? { running: true, hello: r.hello } : { running: false, reason: r.reason };
  } finally {
    client.close();
  }
}
