/**
 * The Stephen window's socket: `<home>/run/app.sock`, served by `stephen listen` (docs/PLAN-1.9-MEMORY-DASHBOARD.md
 * section 13; wire format in ./protocol.ts; client in helper/AppClient.swift).
 *
 *  - Who can connect: same-user processes only, by file permissions (folder 0700, socket 0600). That is the same
 *    trust as memory.json itself. Claude can't reach it: voice runs only have Stephen's MCP tools, and a boundary test
 *    fails if Claude-reachable code imports src/app.
 *  - Several clients at once (at most MAX_CLIENTS): the window keeps one connection while it is open, and
 *    `stephen app` connects briefly next to it. Every client gets every push (state, heard, chat.done).
 *  - A stale socket file (a crashed listener) is replaced only when connecting to it fails; a live one means another
 *    `stephen listen` serves it, and start() refuses. The socket is removed on close (only if it is still ours).
 *  - Typed chat runs through the AppCommandQueue: the same queue as voice commands (Listener.submit), so the wake
 *    word, Esc and push-to-talk treat it like a voice command and two commands never run at once.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { LineFramer } from '../helper/framing.js';
import { MAX_SOCKET_PATH_BYTES } from '../helper/paths.js';
import { MAX_REPLY_CHARS, MAX_SAID_CHARS, newHistoryId, type HistoryEntry, type HistoryStore } from '../history/store.js';
import { MEMORY_MESSAGES, type MemoryResult, type MemoryStore } from '../memory/store.js';
import { truncate } from '../safety/text.js';
import type { AuditEntry } from '../types.js';
import type { CommandReport } from '../voice/assistant.js';
import { cleanTypedCommand } from '../voice/transcript.js';
import {
  APP_AUDIT_LIMIT_DEFAULT,
  APP_MAX_LINE_BYTES,
  APP_PROTOCOL_VERSION,
  encodeAppMessage,
  parseAppRequest,
  type AppMessage,
  type AppRequest,
  type AppState,
} from './protocol.js';
import type { AppSettings } from './settings.js';

/** `<home>/run/app.sock` */
export function appSocketPath(home: string): string {
  return join(home, 'run', 'app.sock');
}

export const MAX_CLIENTS = 8;
/** A client that stops reading is dropped once this much output is queued for it. */
export const MAX_QUEUED_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How long start() waits for an existing socket to answer before calling it stale. */
const PROBE_TIMEOUT_MS = 500;

export const MEMORY_OFF_MESSAGE = 'Memory is off (memory.enabled is false in config.json).';
export const MEMORY_GONE_MESSAGE = "That memory doesn't exist any more.";

/** Where typed chat runs (Listener.submit + Assistant.command in `stephen listen`). */
export interface AppCommandQueue {
  /** A command is running or being spoken, or the user is talking. */
  busy(): boolean;
  /** Start a typed command now; null (nothing started) when busy. `text` is cleaned, `raw` as typed. */
  start(text: string, opts: { id: string; raw: string; speak: boolean }): Promise<CommandReport> | null;
  /** Same as Esc: cancel what is running and end the follow-up conversation. */
  stop(): void;
}

export interface AppServerOptions {
  home: string;
  /** Default appSocketPath(home). */
  socketPath?: string;
  queue: AppCommandQueue;
  /** hello.listening: the microphone is on. */
  listening: () => boolean;
  /** hello.model: the Claude model voice commands use. */
  model: string;
  /** null = memory.enabled is false. */
  memory: Pick<MemoryStore, 'list' | 'add' | 'update' | 'forget' | 'clear'> | null;
  /** End the follow-up conversation (after any memory change, like the memory router). */
  endConversation: () => void;
  history: Pick<HistoryStore, 'list' | 'clear'> | null;
  /** null = no audit log configured. */
  audit: { recent(limit: number): Promise<AuditEntry[]> } | null;
  settings: () => AppSettings;
  /** app.speakReplies: speak typed-chat replies too. */
  speakReplies: boolean;
  /** Ask Stephen Helper to show the window: null when sent, else why not. */
  openWindow: () => string | null;
  log?: (line: string) => void;
  /** History entry ids (tests). */
  newId?: () => string;
}

export class AppSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppSocketError';
  }
}

/** True when something accepts connections on `path`. */
export function socketAnswers(path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const done = (v: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Messages listing `items` (newest first), dropping the oldest until the line fits APP_MAX_LINE_BYTES. */
function fitList<T>(items: T[], build: (items: T[]) => AppMessage): AppMessage {
  let n = items.length;
  for (;;) {
    const msg = build(items.slice(0, n));
    if (n === 0 || Buffer.byteLength(JSON.stringify(msg)) <= APP_MAX_LINE_BYTES) return msg;
    n = Math.floor(n * 0.8);
  }
}

export class AppServer {
  readonly socketPath: string;
  private server: Server | null = null;
  private ino: number | null = null;
  private readonly clients = new Set<Socket>();
  private current: AppState = 'idle';
  /** A memory change happened while a command ran: end the conversation again once it is done. */
  private endAfterCommand = false;
  private readonly log: (line: string) => void;

  constructor(private readonly o: AppServerOptions) {
    this.socketPath = o.socketPath ?? appSocketPath(o.home);
    this.log = o.log ?? (() => undefined);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get state(): AppState {
    return this.current;
  }

  /** Create the socket (see the file comment). Throws AppSocketError when it can't. */
  async start(): Promise<void> {
    const path = this.socketPath;
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) throw new AppSocketError(`socket path too long (${Buffer.byteLength(path)} bytes): ${path}`);
    this.prepareDir(dirname(path));
    let st;
    try {
      st = lstatSync(path);
    } catch {
      st = null;
    }
    if (st) {
      if (!st.isSocket()) throw new AppSocketError(`${path} exists and is not a socket; remove it`);
      if (await socketAnswers(path)) throw new AppSocketError(`another \`stephen listen\` is already serving ${path}`);
      try {
        unlinkSync(path); // stale: nobody answers
      } catch (e) {
        throw new AppSocketError(`cannot remove the stale ${path}: ${(e as Error).message}`);
      }
    }
    const server = createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => reject(new AppSocketError(`cannot listen on ${path}: ${e.message}`)));
      server.listen(path, () => resolve());
    });
    server.on('error', (e) => this.log(`app.sock: ${e.message}`));
    try {
      chmodSync(path, 0o600);
      this.ino = lstatSync(path).ino;
    } catch (e) {
      server.close();
      throw new AppSocketError(`cannot secure ${path}: ${(e as Error).message}`);
    }
    this.server = server;
  }

  /** Disconnect every client, stop listening and remove the socket (if it is still ours). */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.removeSocket();
  }

  /** For a process 'exit' hook: remove the socket file synchronously. */
  closeSync(): void {
    this.server?.close();
    this.server = null;
    this.removeSocket();
  }

  // ───────────────────────────── pushes ─────────────────────────────

  /** Listener / assistant state (idle, listening, recording, working, speaking). Consecutive duplicates are dropped. */
  setState(state: AppState): void {
    if (state === this.current) return;
    this.current = state;
    this.broadcast({ type: 'state', state });
  }

  /** A command started (any source): the window shows voice commands live. */
  heard(text: string, source: string): void {
    this.broadcast({ type: 'heard', text: truncate(text, MAX_SAID_CHARS), source });
  }

  /** A command finished (any source). `tools`: names of the tools Claude called (empty when it didn't run). */
  commandDone(r: CommandReport, tools: string[]): void {
    if (this.endAfterCommand) {
      this.endAfterCommand = false;
      this.o.endConversation();
    }
    this.broadcast({
      type: 'chat.done',
      entryId: r.id,
      reply: truncate(r.reply, MAX_REPLY_CHARS),
      outcome: r.outcome,
      tools: [...new Set(tools)],
      ms: r.ms,
    });
  }

  // ───────────────────────────── connections ─────────────────────────────

  private prepareDir(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new AppSocketError(`cannot create ${dir}: ${(e as Error).message}`);
    }
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new AppSocketError(`${dir} must be a real folder (not a symlink)`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new AppSocketError(`${dir} belongs to another user`);
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  }

  private removeSocket(): void {
    if (this.ino === null) return;
    try {
      if (lstatSync(this.socketPath).ino === this.ino) unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
    this.ino = null;
  }

  private accept(sock: Socket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      sock.end(encodeAppMessage({ type: 'error', message: 'too many connections' }));
      return;
    }
    this.clients.add(sock);
    const framer = new LineFramer(APP_MAX_LINE_BYTES);
    sock.on('data', (data: Buffer) => {
      const dropped = framer.dropped;
      const lines = framer.push(data);
      if (framer.dropped > dropped) this.send(sock, { type: 'error', message: `line too long (${APP_MAX_LINE_BYTES} bytes at most)` });
      for (const line of lines) this.receive(sock, line);
    });
    sock.on('error', () => undefined);
    sock.on('close', () => this.clients.delete(sock));
  }

  private send(sock: Socket, msg: AppMessage): void {
    if (sock.destroyed || !this.clients.has(sock)) return;
    let line = encodeAppMessage(msg);
    if (Buffer.byteLength(line) - 1 > APP_MAX_LINE_BYTES) {
      line = encodeAppMessage({ ...('id' in msg && msg.id ? { id: msg.id } : {}), type: 'error', message: 'response too large' });
    }
    sock.write(line);
    if (sock.writableLength > MAX_QUEUED_OUTPUT_BYTES) {
      this.log('app.sock: dropped a client that stopped reading');
      sock.destroy();
    }
  }

  private broadcast(msg: AppMessage): void {
    for (const c of this.clients) this.send(c, msg);
  }

  private receive(sock: Socket, line: string): void {
    const p = parseAppRequest(line);
    if (p.kind === 'unknown') return; // protocol v1: unknown types are ignored
    if (p.kind === 'invalid') {
      this.send(sock, { ...(p.id ? { id: p.id } : {}), type: 'error', message: p.message });
      return;
    }
    const req = p.req;
    if (req.type === 'chat.send') {
      this.chat(sock, req);
      return;
    }
    this.answer(req).then(
      (msg) => {
        this.send(sock, msg);
        if (req.type === 'hello' && msg.type === 'hello') this.send(sock, { type: 'state', state: this.current });
      },
      (e: unknown) => this.send(sock, { id: req.id, type: 'error', message: (e as Error).message || 'error' }),
    );
  }

  /**
   * chat.send: busy → error "busy"; otherwise chat.accepted goes out BEFORE the command starts (so it always comes
   * before that command's heard / chat.done pushes), then chat.done is pushed from commandDone().
   */
  private chat(sock: Socket, req: Extract<AppRequest, { type: 'chat.send' }>): void {
    const text = cleanTypedCommand(req.text);
    if (!text) {
      this.send(sock, { id: req.id, type: 'error', message: 'Type a command first.' });
      return;
    }
    if (this.o.queue.busy()) {
      this.send(sock, { id: req.id, type: 'error', message: 'busy' });
      return;
    }
    const entryId = (this.o.newId ?? newHistoryId)();
    this.send(sock, { id: req.id, type: 'chat.accepted', entryId });
    const fail = (message: string) =>
      this.broadcast({ type: 'chat.done', entryId, reply: message, outcome: 'error', tools: [], ms: 0 });
    let run: Promise<CommandReport> | null;
    try {
      run = this.o.queue.start(text, { id: entryId, raw: req.text.trim(), speak: this.o.speakReplies });
    } catch (e) {
      run = Promise.reject(e);
    }
    if (!run) return fail('Stephen got busy with another command. Try again when it is done.');
    run.catch((e: unknown) => fail(`Something went wrong: ${(e as Error).message}`));
  }

  private memoryChanged(): void {
    this.o.endConversation();
    // A running Claude would save its session again when it ends: end the conversation once more after it.
    if (this.o.queue.busy()) this.endAfterCommand = true;
  }

  private async memory(id: string, change: () => Promise<MemoryResult>): Promise<AppMessage> {
    const r = await change();
    if (!r.ok) return { id, type: 'error', message: r.reason === 'not-found' ? MEMORY_GONE_MESSAGE : r.message };
    if (!r.duplicate) this.memoryChanged();
    return { id, type: 'memory', items: r.items };
  }

  private async answer(req: Exclude<AppRequest, { type: 'chat.send' }>): Promise<AppMessage> {
    const { id } = req;
    const mem = this.o.memory;
    switch (req.type) {
      case 'hello':
        return { id, type: 'hello', version: APP_PROTOCOL_VERSION, listening: this.o.listening(), model: this.o.model };
      case 'chat.stop':
        this.o.queue.stop();
        return { id, type: 'ok' };
      case 'history.list': {
        let entries: HistoryEntry[] = [];
        if (this.o.history) {
          try {
            entries = this.o.history.list({ before: req.before, limit: req.limit });
          } catch (e) {
            return { id, type: 'error', message: (e as Error).message };
          }
        }
        return fitList(entries, (e) => ({ id, type: 'history', entries: e }));
      }
      case 'history.clear':
        this.o.history?.clear();
        return { id, type: 'ok' };
      case 'memory.list':
        if (!mem) return { id, type: 'error', message: MEMORY_OFF_MESSAGE };
        try {
          return { id, type: 'memory', items: await mem.list() };
        } catch {
          return { id, type: 'error', message: MEMORY_MESSAGES.unreadable };
        }
      case 'memory.add':
        return mem ? this.memory(id, () => mem.add(req.text, 'app')) : { id, type: 'error', message: MEMORY_OFF_MESSAGE };
      case 'memory.update':
        return mem ? this.memory(id, () => mem.update(req.memId, req.text)) : { id, type: 'error', message: MEMORY_OFF_MESSAGE };
      case 'memory.forget':
        return mem ? this.memory(id, () => mem.forget(req.memId)) : { id, type: 'error', message: MEMORY_OFF_MESSAGE };
      case 'memory.clear':
        return mem ? this.memory(id, () => mem.clear()) : { id, type: 'error', message: MEMORY_OFF_MESSAGE };
      case 'settings.get':
        try {
          const s = this.o.settings();
          return { id, type: 'settings', config: s.config, configPath: s.configPath };
        } catch {
          return { id, type: 'error', message: 'could not read the config' };
        }
      case 'audit.recent': {
        if (!this.o.audit) return { id, type: 'audit', entries: [] };
        let entries: AuditEntry[];
        try {
          entries = await this.o.audit.recent(req.limit ?? APP_AUDIT_LIMIT_DEFAULT);
        } catch {
          return { id, type: 'error', message: 'could not read the audit log' };
        }
        return fitList(entries, (e) => ({ id, type: 'audit', entries: e }));
      }
      case 'window.open': {
        const why = this.o.openWindow();
        return why === null ? { id, type: 'ok' } : { id, type: 'error', message: why };
      }
    }
  }
}

// ───────────────────────────── queues ─────────────────────────────

interface QueueAssistant {
  readonly busy: boolean;
  command(text: string, opts: { source: 'app'; raw: string; speak: boolean; id: string }): Promise<CommandReport>;
  cancel(): boolean;
  endConversation(): void;
}

interface QueueListener {
  readonly idle: boolean;
  submit(run: () => Promise<CommandReport>): Promise<CommandReport> | null;
  cancel(reason: string): boolean;
}

/** Typed chat in the listener's queue (`stephen listen`). */
export function listenerQueue(listener: QueueListener, assistant: QueueAssistant): AppCommandQueue {
  return {
    busy: () => !listener.idle || assistant.busy,
    start: (text, o) => listener.submit(() => assistant.command(text, { source: 'app', raw: o.raw, speak: o.speak, id: o.id })),
    stop: () => void listener.cancel('app'),
  };
}

/** Typed chat straight into the assistant (no listener). */
export function assistantQueue(assistant: QueueAssistant): AppCommandQueue {
  return {
    busy: () => assistant.busy,
    start: (text, o) => (assistant.busy ? null : assistant.command(text, { source: 'app', raw: o.raw, speak: o.speak, id: o.id })),
    stop: () => {
      assistant.cancel();
      assistant.endConversation();
    },
  };
}
