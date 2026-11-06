/**
 * `<home>/run/phone.sock`: the only way the phone bridge (`stephen phone-bridge`, the Remote Control session's MCP
 * server) reaches `stephen listen` (docs/ADR-005, Bridge rules). Not app.sock: that one also offers memory.add,
 * history.clear and more. This one has three requests, one JSON line each way:
 *   {id, type: 'ask', text}            → {id, type: 'reply', text}   (runs as source 'phone': wake-word data rules,
 *                                                                     every confirmation declined, no memory writes)
 *   {id, type: 'job_status'}           → {id, type: 'reply', text}
 *   {id, type: 'start_job', task, web?} → {id, type: 'reply', text}   (the owner approved it on the phone)
 * Errors: {id, type: 'error', message}. Same-user only (src/lib/private-socket.ts). Every request is refused while
 * the phone is off (`stephen phone on` / `off`), rate limited, audited, and shown as a notification on the Mac.
 */
import type { Socket } from 'node:net';
import { z } from 'zod';
import { LineFramer } from '../helper/framing.js';
import { listenPrivateSocket, type PrivateSocket } from '../lib/private-socket.js';
import { clean, truncate } from '../safety/text.js';
import type { IAuditLog } from '../types.js';
import { cleanTypedCommand } from '../voice/transcript.js';

export { phoneSocketPath } from './setup.js';
import { phoneSocketPath } from './setup.js';

export const PHONE_MAX_LINE_BYTES = 8 * 1024;
export const PHONE_MAX_TEXT = 2000;
export const PHONE_MAX_REPLY = 4000;
/** Asks per rolling minute (threat T9). */
export const PHONE_ASKS_PER_MIN = 6;
const MAX_CLIENTS = 2;

const id = z.string().min(1).max(64);
const request = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('ask'), text: z.string().max(PHONE_MAX_TEXT) }).strict(),
  z.object({ id, type: z.literal('job_status') }).strict(),
  z.object({ id, type: z.literal('start_job'), task: z.string().max(PHONE_MAX_TEXT), web: z.boolean().optional() }).strict(),
]);
export type PhoneRequest = z.infer<typeof request>;
export type PhoneResponse = { id: string; type: 'reply'; text: string } | { id?: string; type: 'error'; message: string };

export const PHONE_OFF_MESSAGE = 'The phone link is off. Turn it on at the Mac with `stephen phone on`.';
export const PHONE_BUSY_MESSAGE = 'Stephen is busy with something at the Mac. Try again in a moment.';
export const PHONE_RATE_MESSAGE = `Too many requests from the phone (at most ${PHONE_ASKS_PER_MIN} a minute). Wait a minute and try again.`;
export const PHONE_JOBS_OFF = 'Background jobs are off on this Mac.';

export interface PhoneServerOptions {
  home: string;
  socketPath?: string;
  /** The kill switch: false → every request is refused. */
  isOn: () => boolean;
  /** Run `text` as a phone command through the listener queue; null = Stephen is busy. Resolves with the reply. */
  ask: (text: string) => Promise<string> | null;
  /** The jobs summary at phone trust; absent = jobs are off. */
  jobStatus?: () => Promise<string>;
  /** Start a job the owner approved on the phone; absent = jobs are off. */
  startJob?: (task: string, web: boolean) => Promise<string>;
  audit: IAuditLog | null;
  /** A short notice on the Mac for every phone request. */
  notify: (title: string, body: string) => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** Parse one request line. Pure. */
export function parsePhoneRequest(line: string): { req: PhoneRequest } | { error: string; id?: string } {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return { error: 'not JSON' };
  }
  const r = request.safeParse(j);
  if (r.success) return { req: r.data };
  const rid = (j as { id?: unknown } | null)?.id;
  return { error: 'bad request', ...(typeof rid === 'string' && rid.length <= 64 ? { id: rid } : {}) };
}

export class PhoneServer {
  readonly socketPath: string;
  private sock: PrivateSocket | null = null;
  private readonly clients = new Set<Socket>();
  private asks: number[] = [];
  private readonly log: (line: string) => void;

  constructor(private readonly o: PhoneServerOptions) {
    this.socketPath = o.socketPath ?? phoneSocketPath(o.home);
    this.log = o.log ?? (() => undefined);
  }

  async start(): Promise<void> {
    this.sock = await listenPrivateSocket(this.socketPath, (s) => this.accept(s), this.log, 'phone.sock');
  }

  async close(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await sock?.close();
  }

  closeSync(): void {
    this.sock?.closeSync();
    this.sock = null;
  }

  /** One request → its response (exported for tests through the socket too). Never throws. */
  async handle(line: string): Promise<PhoneResponse> {
    const p = parsePhoneRequest(line);
    if ('error' in p) return { ...(p.id ? { id: p.id } : {}), type: 'error', message: p.error };
    const req = p.req;
    const fail = async (message: string, outcome: 'denied' | 'error'): Promise<PhoneResponse> => {
      await this.audited(req, outcome, message);
      return { id: req.id, type: 'error', message };
    };
    if (!this.o.isOn()) return fail(PHONE_OFF_MESSAGE, 'denied');
    try {
      switch (req.type) {
        case 'ask': {
          const text = cleanTypedCommand(req.text);
          if (!text) return fail('Say something first.', 'error');
          if (!this.takeAsk()) return fail(PHONE_RATE_MESSAGE, 'denied');
          const run = this.o.ask(text);
          if (!run) return fail(PHONE_BUSY_MESSAGE, 'denied');
          this.notice(`From your phone: "${truncate(text, 80)}"`);
          await this.audited(req, 'ok');
          return { id: req.id, type: 'reply', text: truncate(await run, PHONE_MAX_REPLY) };
        }
        case 'job_status': {
          if (!this.o.jobStatus) return fail(PHONE_JOBS_OFF, 'error');
          await this.audited(req, 'ok');
          return { id: req.id, type: 'reply', text: truncate(await this.o.jobStatus(), PHONE_MAX_REPLY) };
        }
        case 'start_job': {
          if (!this.o.startJob) return fail(PHONE_JOBS_OFF, 'denied');
          this.notice(`Job requested from your phone: "${truncate(req.task, 80)}"`);
          await this.audited(req, 'ok');
          return { id: req.id, type: 'reply', text: truncate(await this.o.startJob(req.task, req.web === true), PHONE_MAX_REPLY) };
        }
      }
    } catch (e) {
      return fail(`Something went wrong: ${clean((e as Error).message, 120)}`, 'error');
    }
  }

  /** Rolling one-minute window. */
  private takeAsk(): boolean {
    const now = (this.o.now ?? Date.now)();
    this.asks = this.asks.filter((t) => now - t < 60_000);
    if (this.asks.length >= PHONE_ASKS_PER_MIN) return false;
    this.asks.push(now);
    return true;
  }

  private notice(body: string): void {
    try {
      this.o.notify('Stephen: phone', body);
    } catch (e) {
      this.log(`phone: notification failed (${(e as Error).message})`);
    }
  }

  /** Audit one phone request: its type and size, never the text. */
  private async audited(req: PhoneRequest, outcome: 'ok' | 'denied' | 'error', error?: string): Promise<void> {
    const size = req.type === 'ask' ? { chars: req.text.length } : req.type === 'start_job' ? { chars: req.task.length, web: req.web === true } : {};
    try {
      await this.o.audit?.append({ tool: `phone.${req.type}`, args: size, outcome, ...(error ? { error } : {}), intent: 'request from the phone (Remote Control)' });
    } catch (e) {
      this.log(`phone: audit failed (${(e as Error).message})`);
    }
  }

  private accept(sock: Socket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      sock.end(JSON.stringify({ type: 'error', message: 'too many connections' }) + '\n');
      return;
    }
    this.clients.add(sock);
    const framer = new LineFramer(PHONE_MAX_LINE_BYTES);
    sock.on('data', (data: Buffer) => {
      const dropped = framer.dropped;
      const lines = framer.push(data);
      if (framer.dropped > dropped) this.send(sock, { type: 'error', message: 'line too long' });
      for (const line of lines) void this.handle(line).then((r) => this.send(sock, r));
    });
    sock.on('error', () => undefined);
    sock.on('close', () => this.clients.delete(sock));
  }

  private send(sock: Socket, r: PhoneResponse): void {
    if (!sock.destroyed && this.clients.has(sock)) sock.write(JSON.stringify(r) + '\n');
  }
}
