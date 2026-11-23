/**
 * The job registry: one state file per job, `<stephen home>/jobs/<id>.json` (0600, atomic writes through
 * src/lib/fs.ts), next to the job's meta folder `<stephen home>/jobs/<id>/` (0700). Both are outside the job's reach
 * (`sandbox.filesystem.denyRead` names Stephen's home; file tools are confined to the job folder).
 *
 * Writers: the listener writes the first `queued` state; from then on only the job's supervisor (runner.ts) writes,
 * until the job is final. A reader that finds a job whose supervisor is gone without a final state marks it `failed`
 * (reconcile), so `stephen jobs list` is right after a crash, a reboot or a listener restart.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { commandOf, commandOfAsync, killGroup } from '../lib/process.js';
import { clean } from '../safety/text.js';
import { SUMMARY_MAX, isJobId } from './spec.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'timeout';
export const FINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'stopped', 'timeout']);
export const isFinal = (s: JobStatus): boolean => FINAL_STATUSES.has(s);

/** A queued job whose supervisor never wrote `running` within this long is marked failed. */
export const QUEUED_STALE_MS = 60_000;
/** Past its deadline by this much, a "running" job can't be (its supervisor kills it at the deadline). */
export const OVERDUE_MS = 15 * 60_000;

export interface JobState {
  version: 1;
  id: string;
  /** The owner's task, cleaned, exactly as the dialog showed it. */
  task: string;
  status: JobStatus;
  /** The job folder (what the owner opens) and Claude's cwd (the worktree for a code job). */
  folder: string;
  cwd: string;
  /** Who asked: the command source ("voice-ptt", "voice-wake", "text", …). */
  source: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** startedAt + wall clock; the supervisor stops the job here. */
  deadlineAt: number | null;
  /** The supervisor's pid (signal it to stop) and Claude Code's (a process-group leader). */
  pid: number | null;
  claudePid: number | null;
  sessionId: string;
  model: string;
  web: boolean;
  maxTurns: number;
  maxBudgetUsd: number;
  wallClockMs: number;
  repo: { name: string; branch: string } | null;
  /** Progress, updated as it runs. */
  turns: number;
  toolCalls: number;
  costUsd: number | null;
  denials: number;
  /** The result text, cleaned (cleanJobOutput) and capped. Untrusted: only shown or spoken. */
  summary: string;
  /** Why it failed or stopped, in Stephen's words (plus at most a cleaned line from Claude Code). */
  error: string;
  /**
   * ADR-010: an edited job (a new job the owner approved through the job dialog) names the job it was edited from and
   * its version (the old version + 1). Absent on a job that was never edited (version 1). `version` above is the
   * state file's format, so the edit's version is `editVersion`.
   */
  editOf?: string;
  editVersion?: number;
}

export const jobsDir = (home: string): string => join(home, 'jobs');
export const statePath = (home: string, id: string): string => join(jobsDir(home), `${id}.json`);
export const metaDirOf = (home: string, id: string): string => join(jobsDir(home), id);

const num = (v: unknown, d: number | null = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max: number) => (typeof v === 'string' ? clean(v, max) : '');
const path = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !/[\0\n]/.test(v) ? v : '');
const STATUSES: readonly JobStatus[] = ['queued', 'running', 'done', 'failed', 'stopped', 'timeout'];

/** Parse a state file's JSON; null when it isn't one of ours. Strings are cleaned again (they are shown in a terminal). */
export function parseJobState(raw: unknown, id: string): JobState | null {
  const r = raw as Partial<JobState> | null;
  if (!r || typeof r !== 'object' || r.version !== 1 || r.id !== id || !isJobId(id)) return null;
  if (!STATUSES.includes(r.status as JobStatus)) return null;
  const pid = num(r.pid);
  const claudePid = num(r.claudePid);
  const repo = r.repo && typeof r.repo === 'object' ? { name: str(r.repo.name, 40), branch: str(r.repo.branch, 80) } : null;
  return {
    version: 1,
    id,
    task: str(r.task, 600),
    status: r.status as JobStatus,
    folder: path(r.folder),
    cwd: path(r.cwd),
    source: str(r.source, 20),
    createdAt: num(r.createdAt, 0)!,
    startedAt: num(r.startedAt),
    endedAt: num(r.endedAt),
    deadlineAt: num(r.deadlineAt),
    pid: pid !== null && Number.isInteger(pid) && pid > 1 ? pid : null,
    claudePid: claudePid !== null && Number.isInteger(claudePid) && claudePid > 1 ? claudePid : null,
    sessionId: str(r.sessionId, 40),
    model: str(r.model, 64),
    web: r.web === true,
    maxTurns: num(r.maxTurns, 0)!,
    maxBudgetUsd: num(r.maxBudgetUsd, 0)!,
    wallClockMs: num(r.wallClockMs, 0)!,
    repo,
    turns: num(r.turns, 0)!,
    toolCalls: num(r.toolCalls, 0)!,
    costUsd: num(r.costUsd),
    denials: num(r.denials, 0)!,
    summary: str(r.summary, SUMMARY_MAX),
    error: str(r.error, 400),
    // ADR-010: field by field; a bad value is dropped, never trusted.
    ...(isJobId(r.editOf) && r.editOf !== id && Number.isInteger(r.editVersion) && r.editVersion! >= 2 && r.editVersion! <= 1000 ? { editOf: r.editOf, editVersion: r.editVersion! } : {}),
  };
}

/** ADR-010: a job's version and the highest version of its family (the jobs linked to it by editOf). */
export function jobVersions(all: readonly JobState[]): Map<string, { version: number; versions: number }> {
  const byId = new Map(all.map((j) => [j.id, j]));
  const rootOf = (j: JobState): string => {
    const seen = new Set<string>();
    while (j.editOf && byId.has(j.editOf) && !seen.has(j.id)) {
      seen.add(j.id);
      j = byId.get(j.editOf)!;
    }
    return j.id;
  };
  const top = new Map<string, number>();
  const roots = new Map(all.map((j) => [j.id, rootOf(j)]));
  for (const j of all) top.set(roots.get(j.id)!, Math.max(top.get(roots.get(j.id)!) ?? 1, j.editVersion ?? 1));
  return new Map(all.map((j) => [j.id, { version: j.editVersion ?? 1, versions: top.get(roots.get(j.id)!)! }]));
}

/** Read one job's state (null: missing, not ours, or unreadable). */
export function readJobState(home: string, id: string): JobState | null {
  if (!isJobId(id)) return null;
  const r = readPrivateJsonFile(statePath(home, id));
  return 'state' in r ? parseJobState(r.state, id) : null;
}

/** Write one job's state (the jobs folder must exist). Throws. */
export function writeJobState(home: string, s: JobState): void {
  if (!isJobId(s.id)) throw new Error('bad job id');
  writePrivateJsonFileSync(statePath(home, s.id), s);
}

export interface ReconcileOptions {
  now?: () => number;
  /** Told once, when this call marks a job failed (the manager audits it, R8-4). */
  onFailed?: (s: JobState) => void;
  /** Tests: is this pid still ours? Default: the pid's command line is this job's supervisor / Claude Code (R8-5). */
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
}

const RUNNER_NOT_STARTED = "The job runner didn't start.";
const RUNNER_GONE = "Stephen's job runner ended without a result (the Mac restarted, or it crashed).";

/** Is `pid` still this job's supervisor (`stephen jobs _run <meta folder of this id>`)? A reused pid is not (R8-5). */
export function supervisorRuns(s: Pick<JobState, 'id'>, pid: number, alive?: (pid: number) => boolean): boolean {
  if (alive) return alive(pid);
  return isSupervisorCommand(s, commandOf(pid));
}

const isSupervisorCommand = (s: Pick<JobState, 'id'>, cmd: string): boolean => /\bjobs _run\b/.test(cmd) && cmd.includes(s.id);

/** Is `pid` still this job's Claude Code (its `--session-id`)? Without a recorded session id: not provably ours. */
function claudeRuns(s: Pick<JobState, 'sessionId'>, pid: number, alive?: (pid: number) => boolean): boolean {
  if (alive) return alive(pid);
  return !!s.sessionId && commandOf(pid).includes(`--session-id ${s.sessionId}`);
}

/**
 * A job that says queued/running but whose supervisor is gone: mark it failed (and stop a Claude Code it left
 * behind: proven ours by its --session-id, or before the deadline + OVERDUE_MS). Returns the state to use.
 */
export function reconcile(home: string, s: JobState, o: ReconcileOptions = {}): JobState {
  if (isFinal(s.status)) return s;
  const now = (o.now ?? Date.now)();
  const deadline = (s.deadlineAt ?? s.createdAt + s.wallClockMs) + OVERDUE_MS;
  let why = '';
  if (s.status === 'queued' && s.pid === null) {
    if (now - s.createdAt > QUEUED_STALE_MS) why = RUNNER_NOT_STARTED;
  } else if (s.pid === null || !supervisorRuns(s, s.pid, o.alive) || now > deadline) {
    why = RUNNER_GONE;
    if (s.claudePid !== null && (now <= deadline || !o.alive) && claudeRuns(s, s.claudePid, o.alive)) (o.kill ?? killGroup)(s.claudePid, 'SIGKILL');
  }
  return why ? markFailed(home, s, now, why, o) : s;
}

/** supervisorRuns / claudeRuns with an async ps: null when ps did not answer in time (unknown). */
async function runsAsync(pid: number, alive: ((pid: number) => boolean) | undefined, ours: (cmd: string) => boolean): Promise<boolean | null> {
  if (alive) return alive(pid);
  const cmd = await commandOfAsync(pid);
  return cmd === null ? null : ours(cmd);
}

function markFailed(home: string, s: JobState, now: number, why: string, o: ReconcileOptions): JobState {
  const next: JobState = { ...s, status: 'failed', endedAt: now, error: why };
  try {
    writeJobState(home, next);
  } catch {
    /* shown as failed anyway */
  }
  o.onFailed?.(next);
  return next;
}

/**
 * reconcile for the listener's job watcher (#202 B2): the same rules, but `ps` runs async with a timeout, so the
 * audio loop never blocks. When ps does not answer in time the job is left as it is (checked again next poll) and
 * nothing is killed. The Claude pid gets its own fresh ps check right before the kill (R8-5), never a cached one.
 */
export async function reconcileAsync(home: string, s: JobState, o: ReconcileOptions = {}): Promise<JobState> {
  if (isFinal(s.status)) return s;
  const now = (o.now ?? Date.now)();
  const deadline = (s.deadlineAt ?? s.createdAt + s.wallClockMs) + OVERDUE_MS;
  if (s.status === 'queued' && s.pid === null) return now - s.createdAt > QUEUED_STALE_MS ? markFailed(home, s, now, RUNNER_NOT_STARTED, o) : s;
  if (s.pid !== null && now <= deadline) {
    const runs = await runsAsync(s.pid, o.alive, (cmd) => isSupervisorCommand(s, cmd));
    if (runs !== false) return s; // still running, or ps did not answer: look again next poll
  }
  const claudePid = s.claudePid;
  // Past the deadline only with the --session-id match: then the pid is still ours, whatever the time (#296).
  if (claudePid !== null && (now <= deadline || !o.alive) && (o.alive || s.sessionId)) {
    // Fresh check, then the kill at once: no cache, no other await in between (R8-5).
    const claude = await runsAsync(claudePid, o.alive, (cmd) => cmd.includes(`--session-id ${s.sessionId}`));
    if (claude === null) return s; // ps did not answer: Claude may still run, so look again next poll
    if (claude) (o.kill ?? killGroup)(claudePid, 'SIGKILL');
  }
  // The supervisor may have written its final state while ps ran: that state wins.
  const cur = readJobState(home, s.id);
  if (cur && isFinal(cur.status)) return cur;
  return markFailed(home, s, now, RUNNER_GONE, o);
}

/** Every job's state as stored, not reconciled. */
function readJobStates(home: string): JobState[] {
  let names: string[];
  try {
    names = readdirSync(jobsDir(home));
  } catch {
    return [];
  }
  const out: JobState[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const s = readJobState(home, n.slice(0, -5));
    if (s) out.push(s);
  }
  return out;
}

const newestFirst = (a: JobState, b: JobState): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/** Every job, newest first, reconciled (see reconcile). */
export function listJobStates(home: string, o: ReconcileOptions = {}): JobState[] {
  return readJobStates(home)
    .map((s) => reconcile(home, s, o))
    .sort(newestFirst);
}

/** listJobStates without blocking the event loop (the listener's job watcher, #202 B2). One job at a time. */
export async function listJobStatesAsync(home: string, o: ReconcileOptions = {}): Promise<JobState[]> {
  const out: JobState[] = [];
  for (const s of readJobStates(home)) out.push(await reconcileAsync(home, s, o));
  return out.sort(newestFirst);
}

/** Delete the state and meta folder (logs, settings) of jobs that ended more than `keepDays` ago. The job folders stay. */
export function purgeJobs(home: string, keepDays: number, now = Date.now()): string[] {
  const gone: string[] = [];
  for (const s of listJobStates(home, { now: () => now })) {
    if (!isFinal(s.status) || s.endedAt === null || now - s.endedAt < keepDays * 86_400_000) continue;
    rmSync(metaDirOf(home, s.id), { recursive: true, force: true });
    rmSync(statePath(home, s.id), { force: true });
    gone.push(s.id);
  }
  return gone;
}
