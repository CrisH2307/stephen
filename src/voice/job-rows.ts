/**
 * Job state → the rows of the Stephen window's Jobs tab (app.sock `jobs.list` / `jobs.stop`). Built only from the
 * cleaned state file, cleaned and capped again; no pid, session id or log path leaves. Lives here (not in src/app)
 * because only the listener may load src/jobs.
 */
import { APP_JOB_SUMMARY_MAX, APP_JOB_TASK_MAX, type AppJobs, type JobRow } from '../app/jobs-status.js';
import type { JobManager } from '../jobs/manager.js';
import { cleanJobOutput } from '../jobs/spec.js';
import type { JobState } from '../jobs/state.js';
import { clean } from '../safety/text.js';

export function jobRow(j: JobState): JobRow {
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
  };
}

/** The server's view of the job manager. A stop waits at most `waitMs` (the window's request times out at 15 s). */
export function appJobs(manager: JobManager, waitMs = 4000): AppJobs {
  return {
    list: () => manager.list().map(jobRow),
    stop: async (id, by) => {
      const r = await manager.stop(id, by, waitMs);
      return 'refused' in r ? r : jobRow(r);
    },
  };
}
