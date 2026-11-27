/**
 * The `jobs` section of config.json (docs/ADR-004-jobs-while-away.md, owner defaults 2026-11-05). Every budget has
 * a hard cap the owner can't raise by config: 3 h wall clock, 2 jobs at once.
 *
 *   "jobs": { "root": "~/Stephen Jobs", "model": "sonnet", "wallClockMin": 45, "maxTurns": 150, "maxBudgetUsd": 5,
 *             "maxRunning": 2, "dailyStarts": 10, "keepDays": 30, "repos": { "stephen": "~/code/stephen" } }
 */
import { z } from 'zod';
import { ConfigError } from '../lib/errors.js';
import { unknownKeyPaths } from '../config.js';

/** Hard caps (rule 5). */
export const MAX_WALL_CLOCK_MIN = 180;
export const MAX_RUNNING_CAP = 2;
/** A repo name as the owner says it ("stephen", "sofe-3980"): also used in the branch name. */
export const REPO_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const JobsConfigSchema = z.object({
  /** Recognize "start a job to …" and friends. Off: those phrases go to Claude, which can't start jobs either. */
  enabled: z.boolean().default(true),
  /** Where job folders are made, one per job (`<root>/<date>-<slug>/`). */
  root: z.string().min(1).default('~/Stephen Jobs'),
  /** Claude model for jobs. */
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/, 'a model name like "sonnet"').default('sonnet'),
  /** Wall clock per job, minutes (hard cap 180). */
  wallClockMin: z.number().int().min(1).max(MAX_WALL_CLOCK_MIN).default(45),
  maxTurns: z.number().int().min(1).max(500).default(150),
  maxBudgetUsd: z.number().positive().max(50).default(5),
  /** Jobs running at the same time (hard cap 2). */
  maxRunning: z.number().int().min(1).max(MAX_RUNNING_CAP).default(MAX_RUNNING_CAP),
  /** Jobs started per local day. */
  dailyStarts: z.number().int().min(1).max(50).default(10),
  /** Logs and state of finished jobs are deleted after this many days (the job folders are yours and stay). */
  keepDays: z.number().int().min(1).max(365).default(30),
  /** Code jobs: a request that names one of these gets a git worktree of it (branch stephen/job-<slug>). */
  repos: z.record(z.string().regex(REPO_NAME_RE, 'repo names are lower-case letters, digits and "-"'), z.string().min(1)).default({}),
});

export type JobsConfig = z.output<typeof JobsConfigSchema>;

export class JobsConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'JobsConfigError';
  }
}

function describe(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const key = i.path.map(String).join('.');
      return `"jobs${key ? `.${key}` : ''}": ${i.message}`;
    })
    .join('; ');
}

/** Validate the raw `jobs` section (null values mean "use the default"). Throws JobsConfigError. */
export function parseJobsConfig(raw: unknown, unknownKeys?: string[]): JobsConfig {
  const obj: Record<string, unknown> = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new JobsConfigError('"jobs" must be an object');
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v !== null && v !== undefined) obj[k] = v;
  }
  const r = JobsConfigSchema.safeParse(obj);
  if (!r.success) throw new JobsConfigError(`Invalid jobs config: ${describe(r.error)}`);
  unknownKeys?.push(...unknownKeyPaths(obj, r.data, 'jobs'));
  return r.data;
}
