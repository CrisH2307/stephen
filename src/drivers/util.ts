/** Small helpers shared by the drivers (timeouts, clock, spawn typing). */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import puppeteer, { type Browser, type ConnectOptions } from 'puppeteer-core';
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

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
    return `${code ? `${code} ` : ''}${e.message}${cause}`;
  }
  return String(e);
}

/** True if a process with this pid exists (signal 0 probe). EPERM means it exists but isn't ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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

// ───────────── private directories (D3) ─────────────

/** Directories we must never chmod even if a config points there. */
function isProtectedDir(dir: string): boolean {
  const d = resolve(dir);
  return d === resolve(homedir()) || d === resolve('/') || dirname(d) === d;
}

function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/**
 * mkdir -p `dir` with mode 0700 and chmod it (and, when it lies inside `root`, every directory
 * between `root` and `dir`, root included) to 0700 — profile, state and output dirs hold cookies,
 * session state and page content that other local users must not read.
 */
export async function ensurePrivateDir(dir: string, root?: string): Promise<void> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const chain: string[] = [target];
  if (root && isInside(target, root)) {
    for (let d = dirname(target); isInside(d, root); d = dirname(d)) {
      chain.push(d);
      if (resolve(d) === resolve(root)) break;
    }
  }
  for (const d of chain) {
    if (isProtectedDir(d)) continue;
    await chmod(d, 0o700);
  }
}

/** Create/lock down Stephen's own directories (home, state, output, agent profiles, audit dir). */
export async function securePrivateDirs(cfg: ResolvedConfig): Promise<void> {
  const home = cfg.home;
  await ensurePrivateDir(home);
  const owned = [cfg.stateDir, cfg.output.saveDir, cfg.chrome.agentProfileDir, cfg.zen.agentProfileDir];
  for (const d of owned) await ensurePrivateDir(d, home);
  const auditDir = dirname(cfg.auditLogPath);
  if (isInside(auditDir, home)) await ensurePrivateDir(auditDir, home);
}
