/**
 * The job supervisor: one small Node process per job (`stephen jobs _run <meta folder>`, started detached by
 * manager.ts, so it outlives a listener restart). It is the only writer of the job's state once the job runs:
 *
 *  - spawns `claude` with the job argv (spec.ts) in the job's cwd, detached (its own process group), with the
 *    scratch-built environment, and on macOS `caffeinate -i -w <pid>` so the Mac stays awake until it ends;
 *  - appends the stream-json transcript to `log.jsonl` (0600, capped) and parses it: init (the lock-down check:
 *    exactly the job's tools, no MCP server, or the job is killed), turns, tool calls, denials, the result;
 *  - writes the state file as it goes (at most every few seconds, and at every status change);
 *  - stops the job at the wall-clock deadline or on SIGTERM/SIGINT ("stephen jobs stop"): SIGTERM to Claude Code's
 *    process group, SIGKILL after 10 s;
 *  - audits the end (status, turns, cost, denials).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, constants as fsConstants, openSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readPrivateJsonFile } from '../lib/fs.js';
import { killGroup, pidsWithCwdIn, processStart, startedWithinJob } from '../lib/process.js';
import { AuditLog } from '../safety/audit.js';
import { clean } from '../safety/text.js';
import type { IAuditLog } from '../types.js';
import { MAX_WALL_CLOCK_MIN } from './config.js';
import { KILL_GRACE_MS, buildJobArgs, buildJobEnv, cleanJobOutput, isJobId, jobFiles, jobToolLists, type JobSpec } from './spec.js';
import { isFinal, jobsDir, readJobState, writeJobState, type JobState, type JobStatus } from './state.js';

export type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

/** log.jsonl stops growing here (a note line says so); the state keeps updating. */
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
/** A single stream line longer than this is dropped unparsed (it is still logged up to the cap). */
const MAX_LINE = 8 * 1024 * 1024;
/** State writes while running: at most this often (status changes are written at once). */
export const PROGRESS_EVERY_MS = 3000;

/** spec.json in the meta folder: what the supervisor runs (written by manager.ts, 0600). */
export interface SupervisorSpec {
  version: 1;
  home: string;
  claudePath: string;
  auditLogPath: string | null;
  spec: JobSpec;
}

// ───────────── stream-json → events (pure, in src/lib/claude-stream.ts) ─────────────

import { plainFailureLine } from '../lib/claude-failure.js';
export { parseStreamLine as parseJobLine, type StreamEvent as JobEvent } from '../lib/claude-stream.js';
import { parseStreamLine as parseJobLine, type StreamEvent as JobEvent } from '../lib/claude-stream.js';

/** A result event → final status and Stephen's words for it. */
export function resultStatus(r: Extract<JobEvent, { kind: 'result' }>, spec: Pick<JobSpec, 'maxTurns' | 'maxBudgetUsd'>): { status: JobStatus; error: string } {
  if (r.startupFailure === 'sandbox_required_unavailable') {
    return { status: 'failed', error: "The sandbox isn't available on this computer, so the job didn't start (nothing ran)." };
  }
  if (r.startupFailure) return { status: 'failed', error: `Claude Code didn't start (${clean(r.startupFailure, 60)}).` };
  if (!r.isError && r.subtype === 'success') return { status: 'done', error: '' };
  if (r.subtype === 'error_max_turns') return { status: 'failed', error: `It ran out of turns (${spec.maxTurns}) before finishing.` };
  if (r.subtype === 'error_max_budget_usd') return { status: 'failed', error: `It reached the $${spec.maxBudgetUsd} budget before finishing.` };
  const plain = plainFailureLine([r.text, ...r.errors].join('\n'));
  if (plain) return { status: 'failed', error: plain };
  const detail = r.errors[0] ? `: ${clean(r.errors[0], 160)}` : '';
  return { status: 'failed', error: `Claude Code reported an error (${clean(r.subtype || 'unknown', 40)})${detail}.` };
}

// ───────────── the supervisor ─────────────

export interface SuperviseDeps {
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  now?: () => number;
  audit?: IAuditLog | null;
  /** The environment the job's env is built from (default: this process's, itself already scratch-built). */
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  progressEveryMs?: number;
  log?: (line: string) => void;
  /** Processes still working in the job folder at the end (tests: a fake). Default: pidsWithCwdIn. */
  stragglers?: (folder: string) => number[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Append-only private file (O_NOFOLLOW, 0600) with a byte cap. Never throws after opening. */
class CappedFile {
  private fd: number | null;
  private bytes = 0;
  constructor(
    path: string,
    private readonly cap: number,
  ) {
    this.fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
  }
  write(s: string): void {
    if (this.fd === null || this.bytes >= this.cap) return;
    const b = Buffer.from(s, 'utf8');
    try {
      if (this.bytes + b.length > this.cap) {
        writeSync(this.fd, '{"type":"stephen","note":"log cut at its size cap"}\n');
        this.bytes = this.cap;
        return;
      }
      writeSync(this.fd, b);
      this.bytes += b.length;
    } catch {
      /* best effort */
    }
  }
  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** Runs one job to its end. `run()` resolves with the final state; `stop()` ends it early. */
export class JobSupervisor {
  private state: JobState;
  private child: ChildProcess | null = null;
  private ending: 'stopped' | 'timeout' | 'failed' | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private lastWrite = 0;
  private seen = new Set<string>();
  private result: Extract<JobEvent, { kind: 'result' }> | null = null;
  private lockdownError = '';
  private stderrTail = '';
  private stopRequested = false;

  constructor(
    private readonly s: SupervisorSpec,
    private readonly d: SuperviseDeps = {},
  ) {
    const st = readJobState(s.home, s.spec.id);
    if (!st) throw new Error(`no state for job ${s.spec.id}`);
    this.state = st;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private save(force = false): void {
    const now = this.now();
    if (!force && now - this.lastWrite < (this.d.progressEveryMs ?? PROGRESS_EVERY_MS)) return;
    this.lastWrite = now;
    try {
      writeJobState(this.s.home, this.state);
    } catch (e) {
      this.d.log?.(`could not write the job state (${(e as Error).message})`);
    }
  }

  /** Stop early: SIGTERM to Claude Code's group, SIGKILL after the grace. Safe to call more than once. */
  stop(why: 'stopped' | 'timeout' | 'failed' = 'stopped'): void {
    this.stopRequested = true;
    if (!this.ending) this.ending = why;
    const pid = this.child?.pid;
    if (!pid) return;
    killGroup(pid, 'SIGTERM');
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), this.d.killGraceMs ?? KILL_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  private finish(status: JobStatus, error: string): JobState {
    this.state = { ...this.state, status, error: clean(error, 400), endedAt: this.now() };
    this.save(true);
    const leftover = this.killStragglers();
    void this.d.audit
      ?.append({
        tool: 'job_end',
        outcome: status === 'done' ? 'ok' : 'error',
        args: { id: this.state.id, status, turns: this.state.turns, costUsd: this.state.costUsd ?? 0, denials: this.state.denials, toolCalls: this.state.toolCalls, ...(leftover ? { leftover } : {}) },
        ...(this.state.error ? { error: this.state.error } : {}),
      })
      .catch(() => undefined);
    return this.state;
  }

  /**
   * REVIEW-8 R8-6: a job's command can `setsid` a child out of Claude Code's process group, so killing the group
   * misses it. When the job ends, anything still working inside the job folder is SIGKILLed. Returns how many.
   */
  private killStragglers(): number {
    const since = this.state.startedAt;
    if (since === null) return 0; // Claude Code never ran: nothing can be left
    let pids: number[];
    try {
      // Only what the job could have started: no terminal (the owner's Terminal shells have one) and started at or
      // after the job did (a shell or editor the owner already had open in the folder is never touched).
      // #121: on Linux the start time may be up to 2 s early (see startedWithinJob). That stays safe because a
      // process is killed only if ALL three hold: its working folder is inside this job's folder (pidsWithCwdIn),
      // it has no terminal, and it started inside the slack window. An owner's shell has a terminal; an older
      // background process in the job's own folder would have to have started within 2 s before the job.
      pids = this.d.stragglers
        ? this.d.stragglers(this.s.spec.folder)
        : pidsWithCwdIn(this.s.spec.folder).filter((pid) => {
            const p = processStart(pid);
            return p !== null && (p.tty === '??' || p.tty === '?') && startedWithinJob(p.startedAt, since);
          });
    } catch {
      return 0;
    }
    for (const pid of pids) {
      try {
        (this.d.kill ?? ((p, sig) => process.kill(p, sig)))(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return pids.length;
  }

  async run(): Promise<JobState> {
    const spec = this.s.spec;
    if (isFinal(this.state.status)) return this.state; // stopped before it started
    let args: string[];
    try {
      args = buildJobArgs(spec);
    } catch (e) {
      return this.finish('failed', `The job spec is invalid (${(e as Error).message}).`);
    }
    const f = jobFiles(spec.metaDir);
    let log: CappedFile;
    let errLog: CappedFile;
    try {
      log = new CappedFile(f.log, MAX_LOG_BYTES);
      errLog = new CappedFile(f.stderr, MAX_STDERR_BYTES);
    } catch (e) {
      return this.finish('failed', `Could not open the job log (${(e as Error).message}).`);
    }
    const spawnFn: SpawnFn = this.d.spawn ?? ((c, a, o) => spawn(c, a as string[], o));
    const wallClockMs = Math.min(spec.wallClockMs, MAX_WALL_CLOCK_MIN * 60_000);
    let child: ChildProcess;
    try {
      child = spawnFn(this.s.claudePath, args, { cwd: spec.cwd, env: buildJobEnv(this.d.env ?? process.env), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    } catch (e) {
      log.close();
      errLog.close();
      return this.finish('failed', `Could not start Claude Code (${(e as Error).message}).`);
    }
    this.child = child;
    const started = this.now();
    this.state = { ...this.state, status: 'running', pid: process.pid, claudePid: child.pid ?? null, startedAt: started, deadlineAt: started + wallClockMs };
    // A stop that came while we were starting (manager writes `stopped` for a queued job): honour it.
    const onDisk = readJobState(this.s.home, spec.id);
    if (onDisk && isFinal(onDisk.status)) this.stop('stopped');
    if (this.stopRequested) this.stop(this.ending ?? 'stopped');
    this.save(true);
    if (child.pid && (this.d.platform ?? process.platform) === 'darwin') {
      try {
        const c = spawnFn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore', detached: false, shell: false });
        c.on('error', () => undefined);
        c.unref();
      } catch {
        /* the job still runs; the Mac may sleep */
      }
    }
    this.deadlineTimer = setTimeout(() => this.stop('timeout'), wallClockMs);
    this.deadlineTimer.unref?.();

    let buf = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      log.write(chunk);
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes('\n')) buf = '';
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        this.onLine(line);
      }
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      errLog.write(chunk);
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    const exit = await new Promise<{ code: number | null; error?: string }>((res) => {
      child.once('error', (e: NodeJS.ErrnoException) => res({ code: null, error: e.code === 'ENOENT' ? `Claude Code was not found ("${this.s.claudePath}")` : e.message }));
      child.once('close', (code) => res({ code }));
    });
    if (buf.trim()) this.onLine(buf.trim());
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (child.pid) killGroup(child.pid, 'SIGTERM'); // anything the job left in its group
    log.close();
    errLog.close();
    this.child = null;

    if (this.ending === 'timeout') return this.finish('timeout', `It hit the ${Math.round(wallClockMs / 60_000)} minute time limit and was stopped.`);
    if (this.ending === 'failed') return this.finish('failed', this.lockdownError);
    if (this.ending === 'stopped') return this.finish('stopped', 'Stopped by the owner.');
    if (this.result) {
      const r = resultStatus(this.result, spec);
      return this.finish(r.status, r.error);
    }
    const plain = plainFailureLine(exit.error ?? this.stderrTail);
    if (plain) return this.finish('failed', plain);
    const lastErr = clean(this.stderrTail.trim().split('\n').filter(Boolean).at(-1) ?? '', 160);
    return this.finish('failed', exit.error ? `${exit.error}.` : `Claude Code exited (code ${exit.code ?? 'killed'}) without a result${lastErr ? `: ${lastErr}` : ''}.`);
  }

  private onLine(line: string): void {
    const ev = parseJobLine(line);
    if (!ev) return;
    switch (ev.kind) {
      case 'init': {
        // The lock-down check (fail closed): exactly the job's tools and no MCP server, or the job ends now.
        const want = [...jobToolLists(this.s.spec.web).tools].sort();
        const got = [...new Set(ev.tools)].sort();
        if (ev.mcpServers !== 0 || got.join(',') !== want.join(',')) {
          this.lockdownError = `Stopped at start: the job had the wrong tools (${clean(got.join(', '), 200)}; MCP servers: ${ev.mcpServers}).`;
          this.stop('failed');
        }
        return;
      }
      case 'assistant':
        if (ev.messageId && !this.seen.has(ev.messageId)) {
          this.seen.add(ev.messageId);
          this.state.turns += 1;
        }
        this.state.toolCalls += ev.toolUses;
        this.save();
        return;
      case 'denied':
        this.state.denials += 1;
        this.save();
        return;
      case 'result':
        this.result = ev;
        this.state = {
          ...this.state,
          turns: ev.turns ?? this.state.turns,
          costUsd: ev.costUsd,
          denials: Math.max(this.state.denials, ev.denials),
          summary: cleanJobOutput(ev.text),
        };
        this.save(true);
        return;
    }
  }
}

/**
 * `stephen jobs _run <meta folder>`: read spec.json there and run the job to its end. SIGTERM / SIGINT stop it
 * (that is what `stephen jobs stop` and "Stephen, stop the job" send). Returns the exit code.
 */
export async function runSupervisor(metaDir: string, deps: SuperviseDeps = {}): Promise<number> {
  const id = basename(metaDir);
  if (!isJobId(id) || !metaDir.startsWith('/')) return 2;
  const r = readPrivateJsonFile(jobFiles(metaDir).spec);
  if (!('state' in r)) return 2;
  const s = r.state as SupervisorSpec;
  if (s?.version !== 1 || s.spec?.id !== id || s.spec.metaDir !== metaDir || dirname(metaDir) !== jobsDir(s.home)) return 2;
  const audit = deps.audit !== undefined ? deps.audit : s.auditLogPath ? new AuditLog({ path: s.auditLogPath }) : null;
  let sup: JobSupervisor;
  try {
    sup = new JobSupervisor(s, { ...deps, audit });
  } catch {
    return 2;
  }
  const onSignal = () => sup.stop('stopped');
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', () => undefined); // a closed terminal is not a stop
  try {
    const end = await sup.run();
    return end.status === 'done' ? 0 : 1;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}
