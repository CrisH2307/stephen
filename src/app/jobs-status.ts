/**
 * What `jobs.list` / `jobs.stop` carry to the Stephen window's Jobs tab (docs/ADR-004). Types and caps only: the rows
 * are built from the cleaned job state files by src/voice/job-rows.ts, so nothing in src/app loads src/jobs (boundary
 * test). The summary is the job's own words (untrusted): the window shows it verbatim, never as Markdown or a prompt.
 */

export const APP_JOB_TASK_MAX = 120;
export const APP_JOB_SUMMARY_MAX = 1500;
export const APP_JOBS_MAX = 50;
/** Same shape as src/jobs/spec.ts JOB_ID_RE (a test keeps them equal): the folder name of a job. */
export const APP_JOB_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,39}$/;

export interface JobRow {
  id: string;
  /** The task, one short line. */
  task: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'timeout';
  /** Epoch ms. */
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  turns: number;
  costUsd: number | null;
  folder: string;
  /** Cleaned and capped; empty until the job has one. */
  summary: string;
  /** Why it failed or stopped (cleaned, short). */
  error: string;
}

/** What the server needs from the job manager (rows already built). */
export interface AppJobs {
  list(): JobRow[];
  stop(id: string, by: string): Promise<JobRow | { refused: string }>;
}
