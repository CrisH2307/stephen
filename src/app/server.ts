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
 *  - Control requests (phone.on/off, zen.open, doctor.run; src/app/control.ts) are the owner's clicks, like jobs.stop.
 *    Errors they throw go back as `{id, type:"error", message}`.
 *  - Typed chat runs through the AppCommandQueue: the same queue as voice commands (Listener.submit), so the wake
 *    word, Esc and push-to-talk treat it like a voice command and two commands never run at once.
 *  - Ask box confirmations (protocol.ts, confirm.*): the gate's question is relayed to clients that said
 *    `confirms: true` in hello, and only an answer naming that exact random confirmId, from another connection,
 *    settles it. No Ask box → "unavailable" (the gate shows the dialog); unanswered → "declined".
 */
import { randomUUID } from 'node:crypto';
import { type Socket } from 'node:net';
import { join } from 'node:path';
import { LineFramer } from '../helper/framing.js';
import type { MediaKeyAction } from '../helper/protocol.js';
import { listenPrivateSocket, type PrivateSocket } from '../lib/private-socket.js';
import { MAX_REPLY_CHARS, MAX_SAID_CHARS, newHistoryId, type HistoryEntry, type HistoryStore } from '../history/store.js';
import { VERSION_GONE_MESSAGE, branchView, deleteVersionRefusal, editContext, versionsOf, type EditContext } from '../history/branch.js';
import { quotePrompt } from '../history/resume.js';
import { MEMORY_MESSAGES, type MemoryResult, type MemoryStore } from '../memory/store.js';
import type { ProposalStore } from '../memory/proposals.js';
import { memoryGraph } from './memory-graph.js';
import type { ModelChanges } from './model.js';
import { truncate } from '../safety/text.js';
import type { AuditEntry } from '../types.js';
import type { ChatStep } from './steps.js';
import type { CommandReport, ResumeRequest } from '../voice/assistant.js';
import { cleanTypedCommand } from '../voice/transcript.js';
import {
  APP_AUDIT_LIMIT_DEFAULT,
  APP_CHAT_MAX_CHARS,
  APP_MAX_LINE_BYTES,
  APP_PROTOCOL_VERSION,
  encodeAppMessage,
  parseAppRequest,
  type AppMessage,
  type AppRequest,
  type AppState,
  type ConfirmResult,
} from './protocol.js';
import type { AppSettings } from './settings.js';
import type { TalkState } from '../voice/talk.js';
import type { AccountsStatus } from './accounts-status.js';
import { APP_JOBS_MAX, type AppJobs } from './jobs-status.js';
import type { AppControl } from './control.js';
import type { PersonalSummary } from './personal.js';
import type { UsageReport } from './usage.js';

/** `<home>/run/app.sock` */
export function appSocketPath(home: string): string {
  return join(home, 'run', 'app.sock');
}

export const MAX_CLIENTS = 8;
/** A client that stops reading is dropped once this much output is queued for it. */
export const MAX_QUEUED_OUTPUT_BYTES = 8 * 1024 * 1024;

export const MEMORY_OFF_MESSAGE = 'Memory is off (memory.enabled is false in config.json).';
export const MEMORY_GONE_MESSAGE = "That memory doesn't exist any more.";
export const PROPOSAL_GONE_MESSAGE = 'That suggestion is no longer waiting.';
export const ONLY_WINDOW_EDITS_MESSAGE = 'Only the Stephen window can edit a message.';
export { VERSION_GONE_MESSAGE };

/** Where typed chat runs (Listener.submit + Assistant.command in `stephen listen`). */
export interface AppCommandQueue {
  /** A command is running or being spoken, or the user is talking. */
  busy(): boolean;
  /**
   * Start a typed command now; null (nothing started) when busy. `text` is cleaned, `raw` as typed. `window`: it came
   * from the Stephen window (a client that said hello with confirms), the only sender that may take an armed resume.
   * `edit` (ADR-010): the window's chat.edit, built from the store; it goes the resume path and is ignored without
   * `window`.
   */
  start(text: string, opts: { id: string; raw: string; speak: boolean; window?: boolean; edit?: ResumeRequest }): Promise<CommandReport> | null;
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
  /** hello.model: the Claude model voice commands use (a function: it can change live, Settings > Model). */
  model: string | (() => string);
  /** null = memory.enabled is false. */
  memory: Pick<MemoryStore, 'list' | 'add' | 'update' | 'forget' | 'clear'> | null;
  /** Memory page proposals (src/memory/proposals.ts). Used only while memory is on; absent = no proposals. */
  proposals?: ProposalStore;
  /** End the follow-up conversation (after any memory change, like the memory router). */
  endConversation: () => void;
  /** `all` and `deleteVersion` (ADR-010 edit and resend, versions, Delete this version); absent = not available. */
  history: (Pick<HistoryStore, 'list' | 'clear'> & Partial<Pick<HistoryStore, 'all' | 'deleteVersion'>>) | null;
  /** null = no audit log configured. */
  audit: { recent(limit: number): Promise<AuditEntry[]> } | null;
  settings: () => AppSettings;
  /** settings.set (How Stephen talks): validated changes in, the saved settings out. Absent = read-only. */
  setTalk?: (changes: Partial<TalkState>) => void;
  /** model.set (Settings > Model): validated changes in; applies from the next command. Absent = read-only. */
  setModel?: (changes: ModelChanges) => void;
  /**
   * replay.set / replay.delete (Settings > Privacy and permissions, issue #48 PR 2): `set` writes voice.replay.enabled to
   * config.json, `deleteAll` is `stephen replay delete --all` (behind any queued write). Absent = not available.
   */
  replay?: { set: (enabled: boolean) => void; deleteAll: () => Promise<number>; on: () => boolean };
  /** How often the replay switch is re-read for the "Recording on" sign (default 2000 ms; tests use less). */
  replayPollMs?: number;
  /** accounts.status: which accounts are connected (no network, no secrets). Absent = not available. */
  accounts?: () => Promise<AccountsStatus>;
  /** jobs.list / jobs.stop (background jobs). Absent = jobs are off. */
  jobs?: AppJobs;
  /** app.speakReplies: speak typed-chat replies too. */
  speakReplies: boolean;
  /** phone.on / phone.off / zen.open / doctor.run (src/app/control.ts). Absent = not available. */
  control?: AppControl;
  /** latency.get: the `stephen latency` report of the last `days` days as text. Absent = not available. */
  latency?: (days: number) => { triggers: number; text: string };
  /** usage.get (src/app/usage.ts). Absent = not available. */
  usage?: () => Promise<UsageReport>;
  /** personal.summary (src/app/personal.ts). Absent = not available. */
  personal?: () => Promise<PersonalSummary>;
  /** Ask Stephen Helper to show the window: null when sent, else why not. */
  openWindow: () => string | null;
  /**
   * chat.resume / chat.resume.cancel (ADR-007 v2): `arm` arms the resume of that conversation (null when armed, else
   * why not), `cancel` clears it, `armed` says whether one is armed. Absent = not available. Arming sends nothing to
   * the model: the owner's next chat.send carries it (listenerQueue).
   */
  resume?: { arm: (conv: string) => string | null; cancel: () => void; armed: () => boolean };
  /** media.key (issue #205): press a Mac media key through Stephen Helper; null when done, else why not. */
  mediaKey?: (action: MediaKeyAction) => Promise<string | null>;
  log?: (line: string) => void;
  /** History entry ids (tests). */
  newId?: () => string;
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
  private sock: PrivateSocket | null = null;
  private readonly clients = new Set<Socket>();
  /** Clients that show confirm questions (hello confirms:true): the Ask box. */
  private readonly askBoxes = new Set<Socket>();
  /** Connections that sent confirm.ask: the gate in a serve process. They get no broadcasts (R9-7). */
  private readonly gates = new Set<Socket>();
  /** Waiting questions by confirmId: who asked, with which request id. */
  private readonly confirms = new Map<string, { asker: Socket; id: string; timer: NodeJS.Timeout; push: AppMessage }>();
  private current: AppState = 'idle';
  /** The last `replay` push: the switch as config.json says (issue #208). */
  private replayOn = false;
  private replayTimer: NodeJS.Timeout | null = null;
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

  /** Create the socket (src/lib/private-socket.ts). Throws PrivateSocketError when it can't. */
  async start(): Promise<void> {
    this.sock = await listenPrivateSocket(this.socketPath, (sock) => this.accept(sock), this.log, 'app.sock');
    if (this.o.replay) {
      this.replayTimer = setInterval(() => this.recordingAllowed(), this.o.replayPollMs ?? 2000);
      this.replayTimer.unref();
    }
  }

  /** Disconnect every client, stop listening and remove the socket (if it is still ours). */
  async close(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
    for (const c of this.confirms.values()) clearTimeout(c.timer);
    this.confirms.clear();
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    await sock?.close();
  }

  /** For a process 'exit' hook: remove the socket file synchronously. */
  closeSync(): void {
    this.sock?.closeSync();
    this.sock = null;
  }

  // ───────────────────────────── pushes ─────────────────────────────

  /**
   * The replay recorder's `enabled` (issue #208): true only while the switch is on AND a Stephen window is connected
   * (hello with confirms: true), so a clip is never saved without the "Recording on" sign there to show it. Pushes
   * `replay` to the windows whenever the switch changes. Never throws.
   */
  recordingAllowed(): boolean {
    let on = false;
    try {
      on = this.o.replay?.on() === true;
    } catch {
      on = false;
    }
    if (on !== this.replayOn) {
      this.replayOn = on;
      this.broadcast({ type: 'replay', on });
    }
    return on && this.askBoxes.size > 0;
  }

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

  /**
   * A command just ended: if memory changed while it ran, end the conversation again now. finishCommand calls it at
   * once, before the audit read, so the next command can't resume in the meantime. Safe to call twice.
   */
  commandEnding(): void {
    if (this.endAfterCommand) {
      this.endAfterCommand = false;
      this.o.endConversation();
    }
  }

  /**
   * A command finished (any source). `tools`: names of the tools Claude called (empty when it didn't run); `steps`:
   * the action chain readCommandSteps built, the same list the history line stores (ADR-007 point 6).
   */
  commandDone(r: CommandReport, tools: string[], steps?: ChatStep[]): void {
    this.commandEnding();
    const msg = {
      type: 'chat.done' as const,
      entryId: r.id,
      reply: truncate(r.reply, MAX_REPLY_CHARS),
      outcome: r.outcome,
      tools: [...new Set(tools)],
      ms: r.ms,
    };
    this.broadcast(steps && steps.length > 0 ? { ...msg, steps } : msg);
  }

  // ───────────────────────────── connections ─────────────────────────────

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
    sock.on('close', () => {
      this.clients.delete(sock);
      this.askBoxes.delete(sock);
      this.gates.delete(sock);
      for (const [confirmId, c] of this.confirms) {
        if (c.asker === sock) this.settle(confirmId, null);
        // The last Ask box left: the gate shows the dialog instead.
        else if (this.askBoxes.size === 0) this.settle(confirmId, 'unavailable');
      }
    });
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

  /** Pushes go to the window and Ask boxes, never to a gate (serve, model-reachable) waiting on a question (R9-7). */
  private broadcast(msg: AppMessage): void {
    for (const c of this.clients) if (!this.gates.has(c)) this.send(c, msg);
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
    if (req.type === 'confirm.ask') {
      this.ask(sock, req);
      return;
    }
    if (req.type === 'confirm.answer') {
      const c = this.confirms.get(req.confirmId);
      // Only an Ask box (hello with confirms: true) answers (R9-7).
      if (!c || c.asker === sock || !this.askBoxes.has(sock)) {
        this.send(sock, { id: req.id, type: 'error', message: 'That question is no longer waiting.' });
        return;
      }
      this.send(sock, { id: req.id, type: 'ok' });
      this.settle(req.confirmId, req.approve ? 'approved' : 'declined');
      return;
    }
    if (req.type === 'chat.edit') {
      this.edit(sock, req);
      return;
    }
    if (req.type === 'history.deleteVersion') {
      this.send(sock, this.deleteVersion(sock, req));
      return;
    }
    if (req.type === 'chat.resume' || req.type === 'chat.resume.cancel') {
      this.send(sock, this.resumeRequest(sock, req));
      return;
    }
    if (req.type === 'hello' && req.confirms) {
      this.askBoxes.add(sock);
      // A box that connects late still gets the questions already waiting.
      for (const c of this.confirms.values()) if (c.asker !== sock) this.send(sock, c.push);
    }
    this.answer(req).then(
      (msg) => {
        this.send(sock, msg);
        if (req.type === 'hello' && msg.type === 'hello' && !this.gates.has(sock)) {
          this.send(sock, { type: 'state', state: this.current });
          if (this.o.replay) {
            this.recordingAllowed();
            this.send(sock, { type: 'replay', on: this.replayOn });
          }
          if (this.o.resume) this.send(sock, { type: 'resume', armed: this.o.resume.armed() });
        }
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
    this.startChat(sock, req.id, text, req.text.trim());
  }

  /** chat.accepted, then the command in the queue (chat.send, chat.edit); chat.done comes from commandDone(). */
  private startChat(sock: Socket, reqId: string, text: string, raw: string, edit?: ResumeRequest): void {
    const entryId = (this.o.newId ?? newHistoryId)();
    this.send(sock, { id: reqId, type: 'chat.accepted', entryId });
    const fail = (message: string) =>
      this.broadcast({ type: 'chat.done', entryId, reply: message, outcome: 'error', tools: [], ms: 0 });
    let run: Promise<CommandReport> | null;
    try {
      // Whether the reply is spoken follows the window's normal setting, for an edit too (ADR-010).
      run = this.o.queue.start(text, { id: entryId, raw, speak: this.o.speakReplies, window: this.isWindow(sock), ...(edit ? { edit } : {}) });
    } catch (e) {
      run = Promise.reject(e);
    }
    if (!run) return fail('Stephen got busy with another command. Try again when it is done.');
    run.catch((e: unknown) => fail(`Something went wrong: ${(e as Error).message}`));
  }

  /** The window: a client that said hello with confirms (the helper), never a gate connection (a serve). */
  private isWindow(sock: Socket): boolean {
    return this.askBoxes.has(sock) && !this.gates.has(sock);
  }

  /**
   * chat.edit (ADR-010), [DEV REVIEW]: only from the window, never while a command runs. The request gives only the
   * old command id, the old text's hash, the conversation on screen and the new text; a line outside that branch is
   * refused; the earlier turns and the replaced turns' step lines come
   * from the store (editContext), and the command goes the resume path: a new conversation, a new process with
   * `--assume-private-read`, window trust, source `app`. Like chat.send: chat.accepted, then chat.done.
   */
  private edit(sock: Socket, req: Extract<AppRequest, { type: 'chat.edit' }>): void {
    if (!this.isWindow(sock)) {
      this.send(sock, { id: req.id, type: 'error', message: ONLY_WINDOW_EDITS_MESSAGE });
      return;
    }
    const history = this.o.history;
    if (!history?.all) {
      this.send(sock, { id: req.id, type: 'error', message: 'not available in this listener' });
      return;
    }
    const text = truncate(cleanTypedCommand(req.text), Math.min(MAX_SAID_CHARS, APP_CHAT_MAX_CHARS));
    if (!text) {
      this.send(sock, { id: req.id, type: 'error', message: 'Type a command first.' });
      return;
    }
    if (this.o.queue.busy()) {
      this.send(sock, { id: req.id, type: 'error', message: 'busy' });
      return;
    }
    const all = history.all.bind(history);
    const first = editContext(all(), req.oldId, req.oldHash, req.conv);
    if ('refused' in first) {
      this.send(sock, { id: req.id, type: 'error', message: first.refused });
      return;
    }
    // Read again when the command runs (the store may have changed in between); saved() false sends nothing.
    let ctx: EditContext | null = null;
    const edit: ResumeRequest = {
      saved: () => {
        const c = editContext(all(), req.oldId, req.oldHash, req.conv);
        ctx = 'refused' in c ? null : c;
        return ctx !== null;
      },
      prompt: (message, trust) => (ctx ? quotePrompt(ctx.earlier, trust, message, ctx.replaced) : message),
      edit: { ...first.editOf, source: first.source },
    };
    this.startChat(sock, req.id, text, req.text.trim(), edit);
  }

  /**
   * history.deleteVersion (ADR-010), [DEV REVIEW]: the window's "Delete this version" click, behind a confirm in the
   * helper. Checked here, not trusted from the page: only a version's own line of a message with two or more versions,
   * and never while another branch still shows a line it would delete (deleteVersionRefusal).
   */
  private deleteVersion(sock: Socket, req: Extract<AppRequest, { type: 'history.deleteVersion' }>): AppMessage {
    if (!this.isWindow(sock)) return { id: req.id, type: 'error', message: 'Only the Stephen window can delete a version.' };
    const history = this.o.history;
    if (!history?.all || !history.deleteVersion) return { id: req.id, type: 'error', message: 'not available in this listener' };
    try {
      const all = history.all();
      const why = deleteVersionRefusal(all, req.entryId);
      if (why !== null) return { id: req.id, type: 'error', message: why };
      const e = all.find((x) => x.id === req.entryId)!;
      history.deleteVersion(e.conv!, e.id);
      return { id: req.id, type: 'ok' };
    } catch (e) {
      return { id: req.id, type: 'error', message: (e as Error).message || 'could not delete that version' };
    }
  }

  /**
   * chat.resume / chat.resume.cancel: only from the window (a client that said hello with confirms, the helper), never
   * from a gate connection (a serve, which the model can reach). Arming sends nothing to the model.
   */
  private resumeRequest(sock: Socket, req: Extract<AppRequest, { type: 'chat.resume' | 'chat.resume.cancel' }>): AppMessage {
    if (!this.o.resume) return { id: req.id, type: 'error', message: 'not available in this listener' };
    if (!this.isWindow(sock)) return { id: req.id, type: 'error', message: 'Only the Stephen window can continue a chat.' };
    if (req.type === 'chat.resume.cancel') {
      this.o.resume.cancel();
      return { id: req.id, type: 'ok' };
    }
    let why: string | null;
    try {
      why = this.o.resume.arm(req.conv);
    } catch (e) {
      why = (e as Error).message || 'could not read that conversation';
    }
    return why === null ? { id: req.id, type: 'ok' } : { id: req.id, type: 'error', message: why };
  }

  /** The resume arm changed (ADR-007 v2): tell the window, for the "Continuing an earlier chat" line. */
  resumeArmed(armed: boolean): void {
    this.broadcast({ type: 'resume', armed });
  }

  /** confirm.ask: relay to the Ask boxes (never back to the asker), or "unavailable" when there is none. */
  private ask(sock: Socket, req: Extract<AppRequest, { type: 'confirm.ask' }>): void {
    this.gates.add(sock);
    const boxes = [...this.askBoxes].filter((b) => b !== sock);
    if (boxes.length === 0) {
      this.send(sock, { id: req.id, type: 'confirm.result', outcome: 'unavailable' });
      return;
    }
    const confirmId = randomUUID();
    const push: AppMessage = { type: 'confirm', confirmId, title: req.title, body: req.body };
    const timer = setTimeout(() => this.settle(confirmId, 'declined'), req.timeoutMs);
    timer.unref?.();
    this.confirms.set(confirmId, { asker: sock, id: req.id, timer, push });
    for (const b of boxes) this.send(b, push);
  }

  /** End a question: answer the asker (null = it left), and tell the Ask boxes it is gone. */
  private settle(confirmId: string, outcome: ConfirmResult | null): void {
    const c = this.confirms.get(confirmId);
    if (!c) return;
    this.confirms.delete(confirmId);
    clearTimeout(c.timer);
    if (outcome) this.send(c.asker, { id: c.id, type: 'confirm.result', outcome });
    for (const b of this.askBoxes) this.send(b, { type: 'confirm.end', confirmId });
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

  /**
   * The Memory page's graph and proposals. Keep is the only way a proposal becomes memory, and only this socket (the
   * owner's own click) can send it.
   */
  private async proposal(
    req: Extract<AppRequest, { type: 'memory.graph' | 'memory.suggestions' | 'memory.propose' | 'memory.keep' | 'memory.skip' }>,
    mem: NonNullable<AppServerOptions['memory']>,
  ): Promise<AppMessage> {
    const { id } = req;
    const props = this.o.proposals;
    const suggestions = (): AppMessage => ({ id, type: 'suggestions', suggestions: props?.list() ?? [] });
    switch (req.type) {
      case 'memory.graph':
        try {
          return { id, type: 'graph', ...memoryGraph(await mem.list(), props?.list() ?? []) };
        } catch {
          return { id, type: 'error', message: MEMORY_MESSAGES.unreadable };
        }
      case 'memory.suggestions':
        return suggestions();
      case 'memory.propose': {
        if (!props) return { id, type: 'error', message: 'not available in this listener' };
        const r = props.propose(req.text, 'you');
        return r.ok ? suggestions() : { id, type: 'error', message: r.message };
      }
      case 'memory.keep': {
        const p = props?.get(req.propId);
        if (!p) return { id, type: 'error', message: PROPOSAL_GONE_MESSAGE };
        const msg = await this.memory(id, () => mem.add(req.text ?? p.text, 'app', p.origin));
        if (msg.type === 'memory') props!.remove(p.id);
        return msg;
      }
      case 'memory.skip':
        return props?.remove(req.propId) ? suggestions() : { id, type: 'error', message: PROPOSAL_GONE_MESSAGE };
    }
  }

  private async answer(
    req: Exclude<AppRequest, { type: 'chat.send' | 'confirm.ask' | 'confirm.answer' | 'chat.resume' | 'chat.resume.cancel' | 'chat.edit' | 'history.deleteVersion' }>,
  ): Promise<AppMessage> {
    const { id } = req;
    const mem = this.o.memory;
    switch (req.type) {
      case 'hello':
        return { id, type: 'hello', version: APP_PROTOCOL_VERSION, listening: this.o.listening(), model: typeof this.o.model === 'function' ? this.o.model() : this.o.model, confirms: true };
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
      case 'history.versions': {
        if (!this.o.history?.all) return { id, type: 'error', message: 'not available in this listener' };
        try {
          const all = this.o.history.all();
          const versions = versionsOf(all, req.entryId);
          const line = all.find((e) => e.id === req.entryId);
          const expired = line?.conv ? branchView(all, line.conv).expired : false;
          return fitList(versions.reverse(), (e) => ({ id, type: 'versions', entries: [...e].reverse(), expired }));
        } catch (e) {
          return { id, type: 'error', message: (e as Error).message };
        }
      }
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
      case 'settings.set':
        if (!this.o.setTalk) return { id, type: 'error', message: 'not available in this listener' };
        try {
          this.o.setTalk(req.values);
          const s = this.o.settings();
          return { id, type: 'settings', config: s.config, configPath: s.configPath };
        } catch {
          return { id, type: 'error', message: 'could not save the setting' };
        }
      case 'model.set':
        if (!this.o.setModel) return { id, type: 'error', message: 'not available in this listener' };
        try {
          this.o.setModel({ ...(req.model !== undefined ? { model: req.model } : {}), ...(req.effort !== undefined ? { effort: req.effort as ModelChanges['effort'] } : {}) });
          // The warm conversation was started with the old model: end it so the next command starts with the new one.
          this.memoryChanged();
          const s = this.o.settings();
          return { id, type: 'settings', config: s.config, configPath: s.configPath };
        } catch {
          return { id, type: 'error', message: 'could not save the setting' };
        }
      case 'replay.set':
        if (!this.o.replay) return { id, type: 'error', message: 'not available in this listener' };
        try {
          this.o.replay.set(req.enabled);
          this.recordingAllowed(); // the sign changes now, not at the next poll
          const s = this.o.settings();
          return { id, type: 'settings', config: s.config, configPath: s.configPath };
        } catch {
          return { id, type: 'error', message: 'could not save the setting' };
        }
      case 'replay.delete':
        if (!this.o.replay) return { id, type: 'error', message: 'not available in this listener' };
        try {
          await this.o.replay.deleteAll();
          return { id, type: 'ok' };
        } catch {
          return { id, type: 'error', message: 'could not delete the recordings' };
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
      case 'accounts.status':
        if (!this.o.accounts) return { id, type: 'error', message: 'accounts status is not available' };
        try {
          const s = await this.o.accounts();
          return { id, type: 'accounts', accounts: s.accounts, ...(s.note ? { note: s.note } : {}) };
        } catch {
          return { id, type: 'error', message: 'could not read the accounts status' };
        }
      case 'jobs.list': {
        const jobs = this.o.jobs;
        if (!jobs) return { id, type: 'jobs', jobs: [] };
        try {
          const rows = jobs.list().slice(0, APP_JOBS_MAX);
          return fitList(rows, (r) => ({ id, type: 'jobs', jobs: r }));
        } catch {
          return { id, type: 'error', message: 'could not read the jobs' };
        }
      }
      case 'jobs.stop': {
        if (!this.o.jobs) return { id, type: 'error', message: 'jobs are turned off' };
        try {
          const r = await this.o.jobs.stop(req.jobId, 'app');
          return 'refused' in r ? { id, type: 'error', message: r.refused } : { id, type: 'job', job: r };
        } catch {
          return { id, type: 'error', message: 'could not stop the job' };
        }
      }
      case 'phone.on':
      case 'phone.off':
      case 'zen.open':
      case 'doctor.run': {
        const c = this.o.control;
        if (!c) return { id, type: 'error', message: 'not available in this listener' };
        if (req.type === 'zen.open') return { id, type: 'zen', ...(await c.openZen()) };
        if (req.type === 'doctor.run') return { id, type: 'doctor', ...(await c.doctor()) };
        return { id, type: 'phone', ...(await (req.type === 'phone.on' ? c.phoneOn() : c.phoneOff())) };
      }
      case 'latency.get': {
        if (!this.o.latency) return { id, type: 'error', message: 'not available in this listener' };
        const days = req.days ?? 7;
        return { id, type: 'latency', days, ...this.o.latency(days) };
      }
      case 'usage.get':
        if (!this.o.usage) return { id, type: 'error', message: 'not available in this listener' };
        return { id, type: 'usage', ...(await this.o.usage()) };
      case 'personal.summary':
        if (!this.o.personal) return { id, type: 'error', message: 'not available in this listener' };
        try {
          return { id, type: 'personal', ...(await this.o.personal()) };
        } catch {
          return { id, type: 'error', message: 'could not read the personal summary' };
        }
      case 'memory.graph':
      case 'memory.suggestions':
      case 'memory.propose':
      case 'memory.keep':
      case 'memory.skip':
        return mem ? this.proposal(req, mem) : { id, type: 'error', message: MEMORY_OFF_MESSAGE };
      case 'memory.usage':
        if (!this.o.usage) return { id, type: 'error', message: 'not available in this listener' };
        return { id, type: 'memory.usage', memory: (await this.o.usage()).memory };
      case 'window.open': {
        const why = this.o.openWindow();
        return why === null ? { id, type: 'ok' } : { id, type: 'error', message: why };
      }
      case 'media.key': {
        const why = this.o.mediaKey ? await this.o.mediaKey(req.action) : 'not available in this listener';
        return why === null ? { id, type: 'ok' } : { id, type: 'error', message: why };
      }
    }
  }
}

// ───────────────────────────── queues ─────────────────────────────

interface QueueAssistant {
  readonly busy: boolean;
  command(text: string, opts: { source: 'app'; raw: string; speak: boolean; id: string; resume?: ResumeRequest }): Promise<CommandReport>;
  cancel(): boolean;
  endConversation(): void;
}

interface QueueListener {
  readonly idle: boolean;
  submit(run: () => Promise<CommandReport>): Promise<CommandReport> | null;
  cancel(reason: string): boolean;
}

/**
 * Typed chat in the listener's queue (`stephen listen`). `takeResume` (ADR-007 v2): the armed resume, taken when a
 * window command runs, so only the window's next message continues an earlier chat.
 */
export function listenerQueue(listener: QueueListener, assistant: QueueAssistant, takeResume?: () => ResumeRequest | null): AppCommandQueue {
  return {
    busy: () => !listener.idle || assistant.busy,
    start: (text, o) =>
      listener.submit(() => {
        // Only the window's own message takes the arm (ADR-007 v2): another app.sock client never does. An edit
        // (ADR-010) is the window's too, and it clears the arm: it goes the same resume path with its own context.
        const armed = o.window ? (takeResume?.() ?? null) : null;
        const resume = o.window && o.edit ? o.edit : armed;
        return assistant.command(text, { source: 'app', raw: o.raw, speak: o.speak, id: o.id, ...(resume ? { resume } : {}) });
      }),
    stop: () => void listener.cancel('app'),
  };
}

