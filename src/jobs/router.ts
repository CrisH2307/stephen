/**
 * Job commands in `stephen listen`, before Claude (Assistant `jobs` option), like timers. Starting a job ALWAYS
 * shows a native dialog with the exact task, folder, budgets and web on/off (rule 2), whatever the source: F5, typed
 * text and the wake word alike. A spoken "yes" never counts; Deny, a timeout or no dialog at all means nothing is
 * created. After the wake word, stopping asks too and the list is a count only (same trust split as timers).
 */
import { quoteUntrusted } from '../safety/confirm.js';
import { clean } from '../safety/text.js';
import type { ConfirmPrompt, Confirmer } from '../types.js';
import { spokenShow } from './finish.js';
import { parseJobIntent } from './intent.js';
import type { JobManager, JobPlan } from './manager.js';
import { TASK_MAX } from './spec.js';
import { isFinal, type JobState } from './state.js';

/** Same shape as the timer router's result (the Assistant handles them the same way). */
export interface JobRoute {
  reply: string;
  changed: false;
  said?: string;
}

export interface JobRouterOptions {
  jobs: JobManager;
  /** The native dialog (src/safety/confirm.ts DialogConfirmer); anything but "approved" starts nothing. */
  confirmer: Confirmer;
  now?: () => number;
  /** Prints a line to the terminal (the folder path of "show my job"); not spoken. */
  print?: (line: string) => void;
  /** How long "stop the job" waits for the job to end before answering "stopping it". */
  stopWaitMs?: number;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A task as Stephen says it: one line, short. */
const said = (task: string) => `"${clean(task, 60)}"`;

/** The dialog for one start (rule 2). Every value is computed or quoted; the task is the owner's exact words. */
export function startPrompt(plan: JobPlan, source: string): ConfirmPrompt {
  const lines = [
    `Task: ${quoteUntrusted(plan.task, TASK_MAX)}`,
    `Folder: ${plan.folder}`,
    ...(plan.repo ? [`Code: a new git worktree of "${plan.repo.name}" (${plan.repo.path}) on branch ${plan.repo.branch}. Nothing is pushed.`] : []),
    plan.repo
      ? 'Input: the repo itself (the inbox is not used for code jobs).'
      : plan.inputs?.length
        ? `Input files (moved from your jobs inbox): ${plan.inputs.slice(0, 8).map((n) => quoteUntrusted(n, 60)).join(', ')}${plan.inputs.length > 8 ? ` and ${plan.inputs.length - 8} more` : ''}.`
        : 'Input files: none (put files in the inbox folder inside your jobs folder before starting).',
    `Budgets: up to ${plural(minutes(plan.wallClockMs), 'minute')}, ${plural(plan.maxTurns, 'turn')}, $${plan.maxBudgetUsd}.`,
    plan.web ? 'Web: ON. The job may search and read web pages (WebSearch, WebFetch); its shell stays offline.' : 'Web: off. The job has no internet.',
    `Model: ${clean(plan.model, 40)}`,
    'The job runs Claude Code on its own: file and shell tools in that folder only (sandboxed), no browser, no apps, no accounts, no memory. It cannot send, post or push.',
  ];
  if (source === 'voice-wake') lines.push('You said this after the wake word: anyone in the room or a video can say that. Allow only if it was you.');
  return { title: 'Stephen: start a background job?', body: lines.join('\n') };
}

export const PHONE_JOB_START_REPLY = 'To start a job from your phone, ask me to start it and approve the request on your phone.';
export const PHONE_JOB_STOP_REPLY = "I can't stop a job from your phone yet. Stop it at the Mac (say \"stop the job\", or the Jobs tab).";

export class JobRouter {
  constructor(private readonly o: JobRouterOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Handle `text` if it is a job command; null = not one (Claude gets it). Never throws. */
  async route(text: string, opts: { source: string; raw?: string } = { source: 'cli' }): Promise<JobRoute | null> {
    // The task keeps the owner's own spelling ("SOFE 3980"): parse the original text when there is one.
    const intent = parseJobIntent(opts.raw ?? text);
    if (!intent) return null;
    // The phone (docs/ADR-005) gets wake-word replies; nobody is at the Mac for a dialog, so start and stop are
    // refused here (a phone job starts through the bridge's start_job, which the owner approves on the phone).
    const phone = opts.source === 'phone';
    const wake = opts.source === 'voice-wake' || phone;
    try {
      switch (intent.kind) {
        case 'start':
          if (phone) return { reply: PHONE_JOB_START_REPLY, changed: false };
          return await this.start(intent.task, opts.source);
        case 'list':
          return { reply: this.listReply(wake), changed: false };
        case 'show':
          return this.show(wake);
        case 'stop':
          if (phone) return { reply: PHONE_JOB_STOP_REPLY, changed: false };
          return await this.stop(intent.which, opts.source, wake);
      }
    } catch (e) {
      return { reply: `Something went wrong with the job (${clean((e as Error).message, 120)}).`, changed: false };
    }
  }

  private async start(task: string, source: string): Promise<JobRoute> {
    const plan = await this.o.jobs.plan(task);
    if ('error' in plan) return { reply: plan.error, changed: false };
    let answer: 'approved' | 'declined' | 'unavailable';
    try {
      answer = await this.o.confirmer.confirm(startPrompt(plan, source));
    } catch {
      answer = 'unavailable';
    }
    if (answer !== 'approved') {
      this.o.jobs.declined(plan, answer, source);
      return {
        reply: answer === 'unavailable' ? "I couldn't show the confirmation dialog, so I didn't start the job." : "Okay, I didn't start it.",
        changed: false,
      };
    }
    const r = await this.o.jobs.start(plan, source);
    if ('refused' in r) return { reply: r.refused, changed: false };
    return {
      reply: `Bet, job started. I've got up to ${plural(minutes(plan.wallClockMs), 'minute')}, and it'll be in your Stephen Jobs folder. Say "how's the job going" to check on it.`,
      changed: false,
    };
  }

  private describe(j: JobState): string {
    const now = this.now();
    const ago = (t: number | null) => (t ? plural(minutes(Math.max(0, now - t)), 'minute') : '');
    const cost = j.costUsd !== null ? `, $${j.costUsd.toFixed(2)}` : '';
    switch (j.status) {
      case 'queued':
        return `${said(j.task)} is starting`;
      case 'running':
        return `${said(j.task)} has been running for ${ago(j.startedAt)}, ${plural(j.turns, 'turn')} so far`;
      case 'done':
        return `${said(j.task)} is done${cost}; it's in your Stephen Jobs folder`;
      case 'timeout':
        return `${said(j.task)} hit its time limit`;
      case 'stopped':
        return `${said(j.task)} was stopped`;
      case 'failed':
        return `${said(j.task)} failed: ${clean(j.error, 120)}`;
    }
  }

  /** Running jobs plus the ones that ended in the last 12 hours, newest first, at most 4. */
  private listReply(wake: boolean): string {
    const now = this.now();
    const all = this.o.jobs.list();
    const running = all.filter((j) => !isFinal(j.status));
    const recent = all.filter((j) => isFinal(j.status) && j.endedAt !== null && now - j.endedAt < 12 * 3600_000);
    if (!running.length && !recent.length) return 'No jobs running.';
    if (wake) return `You've got ${plural(running.length, 'job')} running${recent.length ? ` and ${recent.length} finished recently` : ''}. Hold F5 and ask again to hear them.`;
    const shown = [...running, ...recent].slice(0, 4).map((j) => this.describe(j));
    return `${shown.join('. ')}.`;
  }

  /** "show my job": the latest finished job's cleaned summary, capped. No Claude. After the wake word: a count only. */
  private show(wake: boolean): JobRoute {
    const finished = this.o.jobs.list().filter((j) => isFinal(j.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const j = finished[0];
    if (!j) return { reply: this.o.jobs.running().length ? "Your job hasn't finished yet." : 'No finished jobs yet.', changed: false };
    if (wake) return { reply: 'Hold F5 and ask again to hear what the job said. It is also in the Jobs tab.', changed: false };
    const s = spokenShow(j);
    this.o.print?.(s.print);
    return { reply: s.say, changed: false };
  }

  private async stop(which: 'one' | 'all' | { query: string }, source: string, wake: boolean): Promise<JobRoute> {
    const running = this.o.jobs.running();
    if (!running.length) return { reply: 'No job is running.', changed: false };
    let targets: JobState[];
    if (which === 'all') targets = running;
    else if (which === 'one') {
      if (running.length > 1) return { reply: `You've got ${running.length} jobs running: ${running.map((j) => said(j.task)).join(' and ')}. Say "stop the job about" and a word from it, or "stop all jobs".`, changed: false };
      targets = running;
    } else {
      const q = new Set(which.query.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2));
      const scored = running
        .map((j) => ({ j, n: j.task.toLowerCase().split(/[^a-z0-9]+/).filter((x) => q.has(x)).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n);
      if (!scored.length) return { reply: `No running job is about ${clean(which.query, 60)}.`, changed: false };
      if (scored.length > 1 && scored[0]!.n === scored[1]!.n) return { reply: `More than one job matches "${clean(which.query, 60)}". Say it more exactly.`, changed: false };
      targets = [scored[0]!.j];
    }
    if (wake) {
      const what = targets.length === 1 ? `the job ${said(targets[0]!.task)}` : `all ${targets.length} jobs`;
      let a: string;
      try {
        a = await this.o.confirmer.confirm({ title: 'Stephen: stop a job?', body: `Stop ${what}?\n\nYou said it after the wake word. Hold F5 to do this without the question.` });
      } catch {
        a = 'unavailable';
      }
      if (a !== 'approved') return { reply: targets.length === 1 ? 'Okay, it keeps running.' : 'Okay, they keep running.', changed: false };
    }
    const ends = await Promise.all(targets.map((j) => this.o.jobs.stop(j.id, source, this.o.stopWaitMs ?? 4000)));
    const done = ends.every((e) => !('refused' in e) && isFinal(e.status));
    if (targets.length === 1) return { reply: done ? `Stopped the job ${said(targets[0]!.task)}. What it made so far is in its folder.` : `Stopping the job ${said(targets[0]!.task)} now.`, changed: false };
    return { reply: done ? `Stopped all ${targets.length} jobs.` : `Stopping all ${targets.length} jobs now.`, changed: false };
  }
}
