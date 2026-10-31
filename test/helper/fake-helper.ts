/** A Node Unix-socket server that speaks the helper protocol (one client at a time; a new one replaces the old). */
import { mkdirSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { dirname } from 'node:path';
import { LineFramer } from '../../src/helper/framing.js';
import type { HelperCommand, HelperEvent } from '../../src/helper/protocol.js';

export interface FakeHelperOptions {
  inputMonitoring?: boolean;
  /** Do not send hello on connect. */
  silent?: boolean;
}

export class FakeHelper {
  private server: Server | null = null;
  private client: Socket | null = null;
  readonly received: HelperCommand[] = [];
  readonly rawReceived: string[] = [];
  connections = 0;
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];

  constructor(
    readonly socketPath: string,
    readonly opts: FakeHelperOptions = {},
  ) {}

  async listen(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const server = createServer((sock) => this.onConnection(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => resolve());
    });
  }

  private onConnection(sock: Socket): void {
    this.connections++;
    const old = this.client;
    this.client = sock;
    old?.destroy();
    const framer = new LineFramer();
    sock.on('error', () => undefined);
    sock.on('data', (d: Buffer) => {
      for (const line of framer.push(d)) {
        this.rawReceived.push(line);
        try {
          this.received.push(JSON.parse(line) as HelperCommand);
        } catch {
          // ignore
        }
      }
      this.check();
    });
    sock.on('close', () => {
      if (this.client === sock) this.client = null;
      this.check();
    });
    if (!this.opts.silent) this.sendRaw(JSON.stringify({ type: 'hello', version: '1', inputMonitoring: this.opts.inputMonitoring ?? true }));
    this.check();
  }

  get hasClient(): boolean {
    return !!this.client && !this.client.destroyed;
  }

  emit(ev: HelperEvent): void {
    this.sendRaw(JSON.stringify(ev));
  }

  sendRaw(text: string, newline = true): void {
    this.client?.write(newline ? `${text}\n` : text);
  }

  /** Drop the current client (like the helper restarting its connection). */
  kick(): void {
    this.client?.destroy();
    this.client = null;
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('FakeHelper.waitFor timed out')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
      });
    });
  }

  private check(): void {
    this.waiters = this.waiters.filter((w) => {
      if (w.pred()) {
        w.resolve();
        return false;
      }
      return true;
    });
  }
}

/** Resolve when `pred` holds (polling). */
export async function until(pred: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
