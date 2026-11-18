/**
 * The finish flow of a background job (docs/ADR-004): the listener polls the job state files and, for each job that
 * reached a final status since it last looked, shows a macOS notification and (when the listener is idle) says a short
 * summary. The ids already announced are kept in `<stephen home>/jobs/.announced.json` (0600), so a restart doesn't
 * repeat them. The summary is the job's own words (untrusted): it is only shown or spoken from the cleaned state file,
 * never given to Claude as a prompt.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { clean } from '../safety/text.js';
import { jobsDir, isFinal, type JobState, type JobStatus } from './state.js';

export const FINISH_POLL_MS = 10_000;
/** A job that ended longer ago than this is marked seen without an announcement (e.g. the first run, or a long absence). */
export const ANNOUNCE_WINDOW_MS = 12 * 3600_000;
/** At most this many jobs are announced in one poll (the rest are marked seen). */
export const ANNOUNCE_MAX_PER_POLL = 3;
export const SPOKEN_SUMMARY_MAX = 200;

const announcedPath = (home: string) => join(jobsDir(home), '.announced.json');

/** "Stephen job done" and friends. */
export function finishTitle(status: JobStatus): string {
  switch (status) {
    case 'done':
      return 'Stephen job done';
    case 'failed':
      return 'Stephen job failed';
    case 'stopped':
      return 'Stephen job stopped';
    case 'timeout':
      return 'Stephen job timed out';
    default:
      return 'Stephen job';
  }
}

/** The task as said aloud or shown in a notification: one short line. */
export const shortTask = (task: string): string => clean(task, 60);

/** The first sentence of `text`, cleaned and capped at `max` characters (cut at a word, no ellipsis). */
export function firstSentence(text: string, max = SPOKEN_SUMMARY_MAX): string {
  const s = clean(text, 4000);
  if (!s) return '';
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  let out = (m ? m[0] : s).replace(/[.!?]+$/, '').trim();
  if ([...out].length > max) {
    const cut = [...out].slice(0, max).join('');
    const sp = cut.lastIndexOf(' ');
    out = (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '');
  }
  return out;
}

const VERB: Record<string, string> = { done: 'is done', failed: 'failed', stopped: 'was stopped', timeout: 'hit its time limit' };

/** What Stephen says when a job ends. Words from the summary are untrusted data: spoken, never run. */
export function spokenFinish(j: JobState): string {
  const detail = firstSentence(j.status === 'done' ? j.summary : j.error || j.summary);
  return `Your job '${shortTask(j.task)}' ${VERB[j.status] ?? 'ended'}${detail ? `: ${detail}` : ''}. Say 'show my job' or open the Jobs tab for the rest.`;
}

/** What "show my job" says: the same, with a longer cap, and where the files are. */
export function spokenShow(j: JobState): { say: string; print: string } {
  const detail = firstSentence(j.status === 'done' ? j.summary : j.error || j.summary, 600);
  return {
    say: `Your job '${shortTask(j.task)}' ${VERB[j.status] ?? 'ended'}${detail ? `: ${detail}` : ''}.`,
    print: `Job folder: ${j.folder}`,
  };
}

export interface FinishWatcherOptions {
  home: string;
  list: () => JobState[] | Promise<JobState[]>;
  /** The macOS notification (title, body). */
  notify: (title: string, body: string) => void;
  /** Show and say `text` when the listener is idle (never during a recording); returns at once. */
  say: (text: string) => void;
  now?: () => number;
  pollMs?: number;
  log?: (line: string) => void;
}

export class FinishWatcher {
  private timer: NodeJS.Timeout | null = null;
  private seen: Set<string> | null = null;
  private polling = false;

  constructor(private readonly o: FinishWatcherOptions) {}

  private load(): Set<string> {
    const r = readPrivateJsonFile(announcedPath(this.o.home));
    const ids = 'state' in r && r.state && typeof r.state === 'object' && Array.isArray((r.state as { ids?: unknown }).ids) ? (r.state as { ids: unknown[] }).ids : [];
    return new Set(ids.filter((x): x is string => typeof x === 'string'));
  }

  /** One look at the jobs: announce the newly final ones once. Never rejects. A poll still running skips the next. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const jobs = await this.o.list();
      this.seen ??= this.load();
      const seen = this.seen;
      const now = (this.o.now ?? Date.now)();
      const fresh = jobs.filter((j) => isFinal(j.status) && !seen.has(j.id));
      const toTell = fresh.filter((j) => j.endedAt !== null && now - j.endedAt < ANNOUNCE_WINDOW_MS).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(-ANNOUNCE_MAX_PER_POLL);
      // Remember before telling: a crash while speaking must not repeat it. Forget ids whose job is gone.
      const alive = new Set(jobs.map((j) => j.id));
      const next = new Set([...seen].filter((id) => alive.has(id)));
      for (const j of fresh) next.add(j.id);
      if (next.size !== seen.size || [...next].some((id) => !seen.has(id))) {
        try {
          mkdirSync(jobsDir(this.o.home), { recursive: true, mode: 0o700 });
          writePrivateJsonFileSync(announcedPath(this.o.home), { ids: [...next].sort() });
        } catch (e) {
          this.o.log?.(`Note: couldn't save the announced jobs (${(e as Error).message}).`);
        }
      }
      this.seen = next;
      for (const j of toTell) {
        this.o.notify(finishTitle(j.status), shortTask(j.task));
        this.o.say(spokenFinish(j));
      }
    } catch (e) {
      this.o.log?.(`Note: couldn't check the jobs (${(e as Error).message}).`);
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.o.pollMs ?? FINISH_POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
