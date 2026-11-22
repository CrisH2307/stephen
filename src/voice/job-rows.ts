/**
 * Job state → the rows of the Stephen window's Jobs tab (app.sock `jobs.list` / `jobs.stop`). Built only from the
 * cleaned state file, cleaned and capped again; no pid, session id or log path leaves. Lives here (not in src/app)
 * because only the listener may load src/jobs.
 */
import { APP_JOB_REQUEST_MAX, APP_JOB_SUMMARY_MAX, APP_JOB_TASK_MAX, type AppJobs, type JobRow } from '../app/jobs-status.js';
import type { JobManager } from '../jobs/manager.js';
import type { JobRouter } from '../jobs/router.js';
import { cleanJobOutput, requestOf } from '../jobs/spec.js';
import { jobVersions, type JobState } from '../jobs/state.js';

export { jobVersions };
import { clean } from '../safety/text.js';

export function jobRow(j: JobState, v: { version: number; versions: number } = { version: j.editVersion ?? 1, versions: j.editVersion ?? 1 }): JobRow {
  return {
    id: j.id,
    task: clean(j.task, APP_JOB_TASK_MAX),
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    turns: j.turns,
    costUsd: j.costUsd,
    folder: j.folder,
    summary: cleanJobOutput(j.summary, APP_JOB_SUMMARY_MAX),
    error: clean(j.error, 300),
    request: clean(requestOf(j.task), APP_JOB_REQUEST_MAX),
    version: v.version,
    versions: v.versions,
  };
}

/** The server's view of the job manager. A stop waits at most `waitMs` (the window's request times out at 15 s). */
export function appJobs(manager: JobManager, router: JobRouter, waitMs = 4000): AppJobs {
  const row = (j: JobState) => jobRow(j, jobVersions(manager.list()).get(j.id));
  return {
    list: () => {
      const all = manager.list();
      const v = jobVersions(all);
      return all.map((j) => jobRow(j, v.get(j.id)));
    },
    stop: async (id, by) => {
      const r = await manager.stop(id, by, waitMs);
      return 'refused' in r ? r : row(r);
    },
    // ADR-010 Edit request: the router's dialog decides; the server calls this for the window socket only.
    edit: async (id, request) => {
      const r = await router.editJob(id, request);
      return 'refused' in r ? r : row(r);
    },
  };
}
