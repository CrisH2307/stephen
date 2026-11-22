/**
 * Job state → the rows of the Stephen window's Jobs tab (app.sock `jobs.list` / `jobs.stop`). Built only from the
 * cleaned state file, cleaned and capped again; no pid, session id or log path leaves. Lives here (not in src/app)
 * because only the listener may load src/jobs.
 */
import { APP_JOB_REQUEST_MAX, APP_JOB_SUMMARY_MAX, APP_JOB_TASK_MAX, type AppJobs, type JobRow } from '../app/jobs-status.js';
import type { JobManager } from '../jobs/manager.js';
import type { JobRouter } from '../jobs/router.js';
import { cleanJobOutput, requestOf } from '../jobs/spec.js';
import type { JobState } from '../jobs/state.js';
import { clean } from '../safety/text.js';

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
