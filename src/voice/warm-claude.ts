/**
 * Phase 3 (docs/ADR-003-long-lived-claude.md): ONE long-lived `claude -p --input-format stream-json
 * --output-format stream-json --verbose` per conversation, with the same lock-down argv as the one-shot runner
 * (buildWarmArgs). It is spawned when the wake word fires or F5 goes down, so Claude Code and `stephen serve` start
 * while the user is still talking; follow-ups reuse the same process and the same serve.
 *
 * Wire protocol (checked against Claude Code 2.1.316, see the ADR):
 *  - Ready: `control_request` initialize → success (then the persona file is deleted: Claude Code has read it), then
 *    `mcp_status` every 200 ms until the `stephen` server is `connected`. Failure, a timeout or an exit = not ready.
 *  - Turn: `mcp_status` must still say connected, then ONE line `JSON.stringify({type:'user',…})`; the turn ends at the
 *    next `result` line. `duration_api_ms` and `total_cost_usd` are cumulative per process, so the outcome carries the
 *    difference from the previous result. Every other line type is ignored.
 *  - Anything that isn't a JSON line, or an exit before the result, is an error. One turn at a time.
 * Cancel = kill the whole process group (never the stream `interrupt`: an interrupted tool keeps running).
 * WarmConversationRunner (conversation.ts) owns when a process lives and dies; this class only drives one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  MCP_SERVER_NAME,
  buildWarmArgs,
  killGroup,
  outcomeFromResult,
  personaFor,
  removePersonaFile,
  withoutSecrets,
  writePersonaFile,
  type ClaudeOutcome,
  type ClaudeSettings,
  type ResultJson,
  type SpawnFn,
} from './claude.js';

/** initialize and the MCP connection each get this long. */
export const WARM_READY_TIMEOUT_MS = 10_000;
/** mcp_status poll interval while `stephen` is still pending. */
export const WARM_MCP_POLL_MS = 200;
/** A stdout line longer than this is a protocol error (a real result line is a few KB). */
const MAX_LINE = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export interface WarmClaudeOptions extends ClaudeSettings {
  /** The voice workdir (an empty private folder). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** SIGTERM → SIGKILL grace period on kill(). Default 2000. */
  killGraceMs?: number;
  readyTimeoutMs?: number;
  mcpPollMs?: number;
  now?: () => number;
}

/** What WarmConversationRunner needs from a process (WarmClaude; tests also use an in-memory fake). */
export interface WarmProcess {
  /** now() when it was created (the pre-warm lead and the age cap count from here). */
  readonly spawnedAt: number;
  /** Memory key of the persona it was started with: Claude Code snapshots the system prompt. */
  readonly memoryKey: string | undefined;
  /** It has exited (or never started). */
  readonly exited: boolean;
  /** Resolves once it takes commands; rejects with a user-facing message otherwise. */
  ready(): Promise<void>;
  /** One command. Resolves (never rejects) with the outcome; `cancelled` when kill() ended it. */
  turn(prompt: string): Promise<ClaudeOutcome>;
  /** SIGTERM the group (SIGKILL after the grace period); resolves once claude and its group are gone. Never rejects. */
  kill(): Promise<void>;
  /** Synchronous SIGKILL of the group (process exit handler). */
  killNow(): void;
  /** Called once when it exits, for any reason. */
  onExit(fn: () => void): void;
}

/** The stdin line for one command: always JSON.stringify of a string, never text pasted into JSON. */
export function userMessageLine(prompt: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }) + '\n';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export class WarmClaude implements WarmProcess {
  readonly spawnedAt: number;
  private child: ChildProcess | null = null;
  private buf = '';
  private stderr = '';
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private current: ((o: ClaudeOutcome) => void) | null = null;
  private prevApiMs = 0;
  private prevCostUsd = 0;
  private killing = false;
  private killed: Promise<void> | null = null;
  private done = false;
  private readonly exitFns: (() => void)[] = [];
  private markClosed!: () => void;
  private readonly closed = new Promise<void>((r) => (this.markClosed = r));
  /** initialize answered (the listener's start-up protocol check waits for only this). */
  readonly initialized: Promise<void>;
  private readonly readyP: Promise<void>;

  constructor(
    private readonly o: WarmClaudeOptions,
    readonly memoryKey: string | undefined,
    memory: readonly string[] = [],
  ) {
    this.spawnedAt = this.now();
    let init!: { resolve: () => void; reject: (e: Error) => void };
    this.initialized = new Promise<void>((resolve, reject) => (init = { resolve, reject }));
    this.readyP = this.boot(memory, init);
    this.initialized.catch(() => undefined);
    this.readyP.catch(() => undefined);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  get exited(): boolean {
    return this.done;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  ready(): Promise<void> {
    return this.readyP;
  }

  onExit(fn: () => void): void {
    if (this.done) queueMicrotask(fn);
    else this.exitFns.push(fn);
  }

  private async boot(memory: readonly string[], init: { resolve: () => void; reject: (e: Error) => void }): Promise<void> {
    try {
      await this.start(memory);
      const timeout = this.o.readyTimeoutMs ?? WARM_READY_TIMEOUT_MS;
      try {
        await this.request('initialize', timeout);
      } finally {
        // Claude Code has read the persona once initialize answers (ADR-003 question 7): delete it now, or on failure.
        if (this.o.personaFile) removePersonaFile(this.o.personaFile);
      }
      init.resolve();
      await this.waitConnected(this.now() + timeout);
    } catch (e) {
      init.reject(e as Error);
      void this.kill();
      throw e;
    }
  }

  private async start(memory: readonly string[]): Promise<void> {
    if (this.o.personaFile) {
      try {
        await writePersonaFile(this.o.personaFile, personaFor(this.o.aboutMe, memory));
      } catch (e) {
        this.onClosed();
        throw new Error(`Could not write the persona file (${(e as Error).message}).`);
      }
    }
    if (this.killing) {
      if (this.o.personaFile) removePersonaFile(this.o.personaFile);
      this.onClosed();
      throw new Error('Claude Code was stopped before it started.');
    }
    const spawnFn: SpawnFn = this.o.spawn ?? ((c, a, opts) => spawn(c, a as string[], opts));
    let child: ChildProcess;
    try {
      child = spawnFn(this.o.claudePath, buildWarmArgs(this.o, memory), {
        cwd: this.o.cwd,
        env: withoutSecrets(this.o.env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // own process group: kill() takes claude AND the stephen serve it started
        shell: false,
      });
    } catch (e) {
      this.onClosed();
      throw new Error(`Could not start Claude Code (${(e as Error).message}).`);
    }
    this.child = child;
    child.stdout?.setEncoding('utf8').on('data', (d: string) => this.onData(d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (this.stderr.length < MAX_STDERR) this.stderr += d;
    });
    child.stdin?.on('error', () => undefined); // EPIPE after an exit: the close handler reports it
    child.once('error', (e: NodeJS.ErrnoException) => {
      this.stderr += e.code === 'ENOENT' ? `\nClaude Code was not found ("${this.o.claudePath}"). Install it, or set "voice": {"claudePath": "…"}.` : `\n${e.message}`;
      this.onClosed();
    });
    child.once('close', () => this.onClosed());
  }

  /** The last stderr line (or a generic reason) for error messages. */
  private why(): string {
    return (this.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'it exited').slice(0, 300);
  }

  private write(msg: unknown): void {
    this.child?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private request(subtype: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.done) return Promise.reject(new Error(`Claude Code stopped (${this.why()}).`));
    const id = `stephen-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Claude Code didn't answer ${subtype} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ type: 'control_request', request_id: id, request: { subtype } });
    });
  }

  /** The `stephen` server's status from mcp_status ("connected", "pending", "failed", …, or "missing"). */
  private async mcpStatus(timeoutMs: number): Promise<string> {
    const r = await this.request('mcp_status', timeoutMs);
    const servers = Array.isArray(r.mcpServers) ? (r.mcpServers as unknown[]) : [];
    const me = servers.find((s): s is { name: string; status?: unknown } => !!s && typeof s === 'object' && (s as { name?: unknown }).name === MCP_SERVER_NAME);
    return me && typeof me.status === 'string' ? me.status : 'missing';
  }

  private async waitConnected(deadline: number): Promise<void> {
    for (;;) {
      const status = await this.mcpStatus(Math.max(1, deadline - this.now()));
      if (status === 'connected') return;
      if (status !== 'pending') throw new Error(`Stephen's tools didn't start (MCP status: ${status}).`);
      if (this.now() >= deadline) throw new Error("Stephen's tools didn't connect in time.");
      await sleep(this.o.mcpPollMs ?? WARM_MCP_POLL_MS);
    }
  }

  async turn(prompt: string): Promise<ClaudeOutcome> {
    if (this.current) throw new Error('a command is already running');
    if (!prompt.trim()) throw new Error('empty prompt');
    try {
      await this.readyP;
      const status = await this.mcpStatus(this.o.readyTimeoutMs ?? WARM_READY_TIMEOUT_MS);
      if (status !== 'connected') throw new Error(`Stephen's tools are not connected (MCP status: ${status}).`);
    } catch (e) {
      if (this.killing) return { kind: 'cancelled' };
      return { kind: 'error', message: (e as Error).message, sessionId: null };
    }
    if (this.killing) return { kind: 'cancelled' };
    if (this.done) return { kind: 'error', message: `Claude Code stopped before it answered (${this.why()}).`, sessionId: null };
    return new Promise<ClaudeOutcome>((resolve) => {
      this.current = (o) => {
        this.current = null;
        resolve(o);
      };
      this.child?.stdin?.write(userMessageLine(prompt));
    });
  }

  private onData(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
      if (this.done) return;
    }
    if (this.buf.length > MAX_LINE) this.protocolError('a line from Claude Code was too long');
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const j: unknown = JSON.parse(line);
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
      msg = j as Record<string, unknown>;
    } catch {
      this.protocolError("Claude Code printed something that isn't stream-json");
      return;
    }
    if (msg.type === 'control_response') {
      const r = (msg.response ?? {}) as { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown };
      const p = typeof r.request_id === 'string' ? this.pending.get(r.request_id) : undefined;
      if (!p) return;
      this.pending.delete(r.request_id as string);
      if (r.subtype === 'success') p.resolve(r.response && typeof r.response === 'object' ? (r.response as Record<string, unknown>) : {});
      else p.reject(new Error(`Claude Code refused the request (${typeof r.error === 'string' ? r.error.slice(0, 200) : 'error'}).`));
    } else if (msg.type === 'control_request') {
      // Stephen registers no callbacks (no permission prompt tool, no hooks): deny anything Claude Code asks.
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Stephen does not answer control requests' } });
    } else if (msg.type === 'result') {
      this.onResult(msg as ResultJson);
    }
    // stream_event, assistant, user, system/*, rate_limit_event…: ignored.
  }

  private onResult(res: ResultJson): void {
    const api = num(res.duration_api_ms);
    const cost = num(res.total_cost_usd);
    const out = outcomeFromResult(res);
    const perCommand: ClaudeOutcome =
      out.kind === 'ok'
        ? { ...out, apiMs: api !== null ? Math.max(0, api - this.prevApiMs) : null, costUsd: cost !== null ? Math.max(0, cost - this.prevCostUsd) : null }
        : out;
    if (api !== null) this.prevApiMs = api;
    if (cost !== null) this.prevCostUsd = cost;
    this.current?.(perCommand);
  }

  /** Fail closed: the running turn (if any) errors and the process is killed. */
  private protocolError(why: string): void {
    const msg = `${why}; stopping it.`;
    for (const p of this.pending.values()) p.reject(new Error(msg));
    this.pending.clear();
    this.current?.({ kind: 'error', message: `${msg[0]!.toUpperCase()}${msg.slice(1)}`, sessionId: null });
    void this.kill();
  }

  private onClosed(): void {
    if (this.done) return;
    this.done = true;
    const err = new Error(`Claude Code stopped (${this.why()}).`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.current?.(this.killing ? { kind: 'cancelled' } : { kind: 'error', message: `Claude Code stopped before it answered (${this.why()}).`, sessionId: null });
    if (this.o.personaFile) removePersonaFile(this.o.personaFile);
    this.markClosed();
    for (const fn of this.exitFns.splice(0)) {
      try {
        fn();
      } catch {
        /* a hook never breaks the close */
      }
    }
  }

  kill(): Promise<void> {
    if (this.killed) return this.killed;
    this.killing = true;
    this.killed = (async () => {
      const pid = this.child?.pid;
      if (!pid) {
        if (!this.child) this.onClosed(); // never spawned (or still writing the persona: start() sees `killing`)
        await this.closed;
        return;
      }
      const grace = this.o.killGraceMs ?? 2000;
      killGroup(pid, 'SIGTERM');
      const hard = setTimeout(() => killGroup(pid, 'SIGKILL'), grace);
      hard.unref?.();
      await this.closed;
      // claude is gone; wait for the rest of its group (the stephen serve) too, so nothing can still write the
      // conversation's state file once the caller resets it (kill before reset).
      const until = this.now() + grace;
      while (groupAlive(pid) && this.now() < until) await sleep(25);
      if (groupAlive(pid)) {
        killGroup(pid, 'SIGKILL');
        const last = this.now() + 1000;
        while (groupAlive(pid) && this.now() < last) await sleep(25);
      }
      clearTimeout(hard);
    })().catch(() => undefined);
    return this.killed;
  }

  killNow(): void {
    this.killing = true;
    if (this.child?.pid) killGroup(this.child.pid, 'SIGKILL');
  }
}

/** Is any process of group `pid` still there? */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The listener's start-up check of the stream protocol: spawn one warm process, wait for initialize only, kill it.
 * Returns null when it works, else the reason (the listener then falls back to the one-shot runner).
 */
export async function probeWarmProtocol(o: WarmClaudeOptions): Promise<string | null> {
  const p = new WarmClaude(o, undefined, []);
  try {
    await p.initialized;
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await p.kill();
  }
}
