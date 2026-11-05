/**
 * `stephen jobs list | status <id> | stop <id> | show <id>`: the owner's view of background jobs (docs/ADR-004).
 * Owner-only: loaded on demand by src/cli.ts, never by anything Claude can reach (boundary test). There is no
 * `start` here on purpose: a job starts only from the listener, after the native dialog.
 * `stephen jobs _run <meta folder>` is the supervisor of one job (started by the listener, not for typing).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { AuditLog } from '../safety/audit.js';
import { clean } from '../safety/text.js';
import { parseJobsConfig } from './config.js';
import { JobManager, jobIdArg } from './manager.js';
import { runSupervisor } from './runner.js';
import { isFinal, purgeJobs, type JobState } from './state.js';

export const JOBS_HELP = `stephen jobs: background jobs ("Stephen, start a job to …"; each one asks in a dialog first)

  stephen jobs [list]        all jobs, newest first
  stephen jobs status <id>   one job in detail
  stephen jobs show <id>     its summary (written by the job: check it) and its folder
  stephen jobs stop <id>     stop it (what it made so far stays in its folder)

<id> is the folder name, like 2026-11-05-write-my-lab-report-draft. Settings: "jobs" in config.json.`;

export interface JobsCliEnv {
  manager?: JobManager;
  out?: (l: string) => void;
  err?: (l: string) => void;
  now?: () => number;
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '-');

/** One line (plus the task) per job. Every string is cleaned again before it reaches the terminal. */
export function formatJobLine(j: JobState, now: number): string {
  const time = j.status === 'running' && j.startedAt ? ago(now - j.startedAt) : j.endedAt && j.startedAt ? ago(j.endedAt - j.startedAt) : '';
  const parts = [j.id, j.status, time, `${j.turns} turns`, j.costUsd !== null ? `$${j.costUsd.toFixed(2)}` : '', j.web ? 'web on' : '', j.repo ? `branch ${clean(j.repo.branch, 80)}` : ''];
  return `${parts.filter(Boolean).join('  ')}\n  "${clean(j.task, 200)}"${j.error && j.status !== 'done' ? `\n  ${clean(j.error, 200)}` : ''}`;
}

export function formatJobStatus(j: JobState, now: number): string {
  return [
    `${j.id}: ${j.status}`,
    `  task:     "${clean(j.task, 500)}"`,
    `  folder:   ${j.folder}`,
    ...(j.cwd !== j.folder ? [`  worktree: ${j.cwd}${j.repo ? ` (branch ${clean(j.repo.branch, 80)})` : ''}`] : []),
    `  started:  ${when(j.startedAt)}${j.status === 'running' && j.startedAt ? ` (${ago(now - j.startedAt)} ago)` : ''}`,
    `  deadline: ${when(j.deadlineAt)}`,
    `  ended:    ${when(j.endedAt)}`,
    `  budgets:  ${Math.round(j.wallClockMs / 60_000)} min, ${j.maxTurns} turns, $${j.maxBudgetUsd}; model ${clean(j.model, 40)}; web ${j.web ? 'on' : 'off'}`,
    `  used:     ${j.turns} turns, ${j.toolCalls} tool calls, ${j.denials} denied, ${j.costUsd !== null ? `$${j.costUsd.toFixed(2)}` : 'cost unknown'}`,
    ...(j.error ? [`  note:     ${clean(j.error, 400)}`] : []),
    ...(j.sessionId ? [`  resume:   cd ${JSON.stringify(j.cwd)} && claude --resume ${clean(j.sessionId, 40)}`] : []),
  ].join('\n');
}

export async function runJobsCli(argv: string[], e: JobsCliEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  const [cmd = 'list', ...rest] = argv;
  if (cmd === '_run') return rest.length === 1 ? runSupervisor(rest[0]!) : 2;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    out(JOBS_HELP);
    return 0;
  }
  if (!['list', 'status', 'stop', 'show'].includes(cmd)) {
    err(`Unknown jobs command "${clean(cmd, 40)}".\n\n${JOBS_HELP}`);
    return 2;
  }
  const now = (e.now ?? Date.now)();
  let jobs = e.manager;
  if (!jobs) {
    const c = loadConfig();
    const home = c.home;
    let config;
    try {
      config = parseJobsConfig(c.jobs);
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
    purgeJobs(home, config.keepDays, now);
    jobs = new JobManager({ home, config, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, claudePath: 'claude', audit: new AuditLog({ path: c.auditLogPath }) });
  }
  if (cmd === 'list') {
    if (rest.length) {
      err(`Unknown option "${clean(rest[0], 40)}" for jobs list.`);
      return 2;
    }
    const all = jobs.list();
    out(all.length ? all.map((j) => formatJobLine(j, now)).join('\n') : 'No jobs yet. Say "Stephen, start a job to …".');
    return 0;
  }
  const id = rest.length === 1 ? jobIdArg(rest[0]!) : null;
  if (!id) {
    err(`Usage: stephen jobs ${cmd} <id>   (the folder name, like 2026-11-05-write-my-lab-report-draft)`);
    return 2;
  }
  const j = jobs.get(id);
  if (!j) {
    err(`There's no job ${id}. \`stephen jobs\` lists them.`);
    return 1;
  }
  if (cmd === 'status') {
    out(formatJobStatus(j, now));
    return 0;
  }
  if (cmd === 'show') {
    const summaryFile = join(j.cwd, 'SUMMARY.md');
    out(
      [
        `${j.id}: ${j.status}`,
        `Folder: ${j.folder}`,
        ...(existsSync(summaryFile) ? [`Summary file: ${summaryFile}`] : []),
        'Summary (written by the job, so check it; links and codes are hidden):',
        j.summary ? `  ${clean(j.summary, 2000)}` : '  (none yet)',
      ].join('\n'),
    );
    return 0;
  }
  // stop
  if (isFinal(j.status)) {
    out(`${j.id} already ended (${j.status}).`);
    return 0;
  }
  const r = await jobs.stop(id, 'cli');
  if ('refused' in r) {
    err(r.refused);
    return 1;
  }
  out(isFinal(r.status) ? `Stopped ${id} (${r.status}). What it made so far is in ${r.folder}` : `Asked ${id} to stop; \`stephen jobs status ${id}\` shows when it has.`);
  return 0;
}
