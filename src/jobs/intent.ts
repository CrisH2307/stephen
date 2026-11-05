/**
 * Job commands, recognized by a small anchored grammar BEFORE Claude (rule 1: the model never starts a job; it has
 * no job tool). Pure. Anything else goes to Claude, which tells the owner to say "start a job to …".
 *   start:  "start a job to <task>"            (any task)
 *           "in the background, <task>"        (the task starts with a work verb: write, research, fix, …)
 *           "while I'm <doing x>, <task>"      (same; the comma is optional: "while i'm cooking write my report")
 *   stop:   "stop the job" / "cancel the job" / "stop all jobs" / "stop the job about <words>"
 *   list:   "what are my jobs" / "how's the job going" / "is the job done" / "list my jobs"
 * The work-verb rule keeps "while I'm cooking, play some lofi" and "in the background play music" for Claude.
 */

export type JobIntent = { kind: 'start'; task: string } | { kind: 'stop'; which: 'one' | 'all' | { query: string } } | { kind: 'list' };

/** A task after "in the background" / "while I'm …" must start with one of these (or a WORK_PHRASES pair). */
export const WORK_VERBS: ReadonlySet<string> = new Set([
  'write', 'draft', 'rewrite', 'edit', 'proofread', 'research', 'summarize', 'summarise', 'outline', 'finish', 'do', 'make', 'build',
  'create', 'code', 'fix', 'prepare', 'plan', 'study', 'solve', 'translate', 'review', 'refactor', 'implement', 'debug', 'compare',
  'analyze', 'analyse', 'organize', 'organise', 'brainstorm', 'document', 'design', 'compile', 'collect', 'gather', 'test',
]);
export const WORK_PHRASES: readonly string[] = ['put together', 'work on', 'figure out', 'come up with', 'look into', 'go through', 'clean up', 'write up', 'vibe code'];

/** Leading "hey stephen,", "please", "can you" and trailing punctuation off; quotes made plain. Case is kept. */
function tidy(text: string): string {
  let t = String(text).normalize('NFKC').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(?:hey|yo|ok|okay|so|um|uh)\b[,\s]*/i, '').replace(/^stephen\b[,\s]*/i, '').replace(/^(?:please|can you|could you|would you|will you)\b[,\s]*/i, '');
    if (t === before) break;
  }
  return t.trim();
}

/** Lower case, letters/digits/apostrophes only (for the fixed phrases). */
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Strip "please" / "can you" / "go ahead and" in front of a task. */
function taskHead(t: string): string {
  let s = t.trim().replace(/^[,:;\s-]+/, '');
  for (let i = 0; i < 3; i++) s = s.replace(/^(?:please|can you|could you|go ahead and|stephen)\b[,\s]*/i, '');
  return s.trim();
}

/** True when the task starts with a work verb or phrase. */
export function startsWithWork(task: string): boolean {
  const w = words(task);
  const first = w.split(' ')[0] ?? '';
  return WORK_VERBS.has(first) || WORK_PHRASES.some((p) => w === p || w.startsWith(`${p} `));
}

const STOP_VERB = '(?:stop|cancel|kill|end|abort|halt)';
const JOB = '(?:background )?jobs?';

export function parseJobIntent(command: string): JobIntent | null {
  const t = tidy(command);
  if (!t) return null;
  const w = words(t);

  // list / status
  if (
    new RegExp(`^(?:what|which) (?:are )?(?:my |the )?${JOB}(?: (?:are )?(?:running|there|going|do i have|have i got))?$`).test(w) ||
    new RegExp(`^(?:list|show|show me) (?:my |the |all )?${JOB}$`).test(w) ||
    new RegExp(`^(?:my )?${JOB} status$`).test(w) ||
    new RegExp(`^how(?:'s| is| are|s) (?:the |my )?${JOB} (?:going|doing|coming along|getting on)$`).test(w) ||
    new RegExp(`^(?:is|are) (?:the |my )?${JOB} (?:done|finished|ready|still running)(?: yet)?$`).test(w)
  ) {
    return { kind: 'list' };
  }
  // stop
  if (new RegExp(`^${STOP_VERB} (?:all|all the|all my|every|both) (?:of my |the )?(?:background )?(?:jobs|job)$`).test(w)) return { kind: 'stop', which: 'all' };
  if (new RegExp(`^${STOP_VERB} (?:the |my |that |this |current |the current )?(?:background )?job$`).test(w)) return { kind: 'stop', which: 'one' };
  let m = new RegExp(`^${STOP_VERB} (?:the |my )?(?:background )?job (?:about|for|on|to|that) (.+)$`).exec(w);
  if (m) return { kind: 'stop', which: { query: m[1]! } };

  // start: explicit
  m = /^(?:start|run|kick off|begin|set up|make|create|launch) (?:a |an |another |one more |new |a new )?(?:background )?job,? (?:to |that |which |for |about |on |where you |and )?(.+)$/i.exec(t);
  if (m) {
    const task = taskHead(m[1]!);
    return task.split(' ').length >= 2 ? { kind: 'start', task } : null;
  }
  // start: "in the background, <work>"
  m = /^in the background\b,?\s*(.+)$/i.exec(t);
  if (m) {
    const task = taskHead(m[1]!);
    return startsWithWork(task) && task.split(' ').length >= 2 ? { kind: 'start', task } : null;
  }
  // start: "while I'm <activity>, <work>" (comma optional; the activity is 1 to 5 words, never "at it")
  m = /^while (?:i'm|i am|im|i'll be|i will be) (.+)$/i.exec(t);
  if (m) {
    const rest = m[1]!;
    const comma = rest.indexOf(',');
    const tries: [string, string][] = [];
    if (comma > 0) tries.push([rest.slice(0, comma), rest.slice(comma + 1)]);
    else {
      const ws = rest.split(' ');
      for (let k = 1; k <= Math.min(5, ws.length - 2); k++) tries.push([ws.slice(0, k).join(' '), ws.slice(k).join(' ')]);
    }
    for (const [activity, after] of tries) {
      const a = words(activity);
      if (!a || a === 'at it' || a.split(' ').length > 6) continue;
      const task = taskHead(after);
      if (startsWithWork(task) && task.split(' ').length >= 2) return { kind: 'start', task };
    }
  }
  return null;
}
