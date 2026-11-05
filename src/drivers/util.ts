/** Small helpers shared by the drivers (timeouts, clock, spawn typing). Generic file and process helpers are in src/lib/. */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import puppeteer, { type Browser, type ConnectOptions } from 'puppeteer-core';
import { ensurePrivateDir, isInside } from '../lib/fs.js';
import type { ResolvedConfig } from '../types.js';

/** The subset of a ChildProcess the drivers use (lets tests pass a fake). */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  readonly stderr: Readable | null;
  unref(): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;
export type ConnectFn = (options: ConnectOptions) => Promise<Browser>;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], options);
export const defaultConnect: ConnectFn = (options) => puppeteer.connect(options);

/** Marker error for withTimeout. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `promise` against a timer. If the timer wins and the promise later resolves,
 * `onLate` receives the late value (used to disconnect a Browser nobody will use —
 * e.g. the user clicks Chrome's Allow after we gave up).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new TimeoutError(label, ms));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) {
          onLate?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Connect with a timeout; a connection that completes after the timeout is detached (never closed). */
export function connectWithTimeout(connect: ConnectFn, options: ConnectOptions, ms: number, label: string): Promise<Browser> {
  return withTimeout(connect(options), ms, label, (late) => {
    void late.disconnect().catch(() => undefined);
  });
}

export function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
    return `${code ? `${code} ` : ''}${e.message}${cause}`;
  }
  return String(e);
}

/**
 * True if something accepts TCP connections at a ws:// URL's host:port (loopback only). Opens no
 * WebSocket and no BiDi session — Gecko allows only one session, so "is it answering?" must not use one.
 */
export function probeWsEndpoint(wsUrl: string, timeoutMs = 1500): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(wsUrl);
    host = u.hostname.replace(/^\[|\]$/g, '');
    port = Number(u.port);
  } catch {
    return Promise.resolve(false);
  }
  if (!isLoopbackHost(host) || !Number.isInteger(port) || port <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** SIGTERM a detached process group we spawned ourselves (falls back to the single pid). */
export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
}

// ───────────── private directories (D3; helpers in src/lib/fs.ts) ─────────────

/** Create/lock down Stephen's own directories (home, state, output, agent profiles, audit dir). */
export async function securePrivateDirs(cfg: ResolvedConfig): Promise<void> {
  const home = cfg.home;
  await ensurePrivateDir(home);
  const owned = [cfg.stateDir, cfg.output.saveDir, cfg.chrome.agentProfileDir, cfg.zen.agentProfileDir];
  for (const d of owned) await ensurePrivateDir(d, home);
  const auditDir = dirname(cfg.auditLogPath);
  if (isInside(auditDir, home)) await ensurePrivateDir(auditDir, home);
}
