/**
 * What `jobs.list` / `jobs.stop` carry to the Stephen window's Jobs tab (docs/ADR-004). Types and caps only: the rows
 * are built from the cleaned job state files by src/voice/job-rows.ts, so nothing in src/app loads src/jobs (boundary
 * test). The summary is the job's own words (untrusted): the window shows it verbatim, never as Markdown or a prompt.
 */

export const APP_JOB_TASK_MAX = 120;
export const APP_JOB_SUMMARY_MAX = 1500;
export const APP_JOBS_MAX = 50;
/** ADR-010: the owner's own request, for the Edit request editor (same cap as src/jobs/spec.ts TASK_MAX). */
export const APP_JOB_REQUEST_MAX = 500;
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
  /** ADR-010: the owner's own request (an edited job's task without the quoted old one), prefilled in Edit request. */
  request: string;
  /** ADR-010: "Version N of M" on the job card (1 of 1 for a job that was never edited). */
  version: number;
  versions: number;
}

/** What the server needs from the job manager (rows already built). */
export interface AppJobs {
  list(): JobRow[];
  stop(id: string, by: string): Promise<JobRow | { refused: string }>;
  /**
   * ADR-010 Edit request: a NEW job from a stopped, finished or failed one, after the owner approves the job dialog.
   * Refused while the old job is queued or running. The server calls it only for the window socket.
   */
  edit(id: string, request: string): Promise<JobRow | { refused: string }>;
}
