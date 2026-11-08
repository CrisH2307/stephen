/**
 * Step timings for ROADMAP P6 ("measure each step, then cut round trips"). The page engine and the tools wrap their
 * waits in `timed('click.settle', …)`; nothing is recorded unless a measuring harness (`stephen eval-clicks`) set a
 * sink with `onStep`. Only a step name and a duration leave here: never URLs, page text or arguments.
 */
type Sink = (step: string, ms: number) => void;

let sink: Sink | null = null;

/** Start (fn) or stop (null) receiving step timings. One sink at a time: the harness that measures. */
export function onStep(fn: Sink | null): void {
  sink = fn;
}

/** Record one step's duration (also when it throws). Costs one null check when nobody measures. */
export async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  if (!sink) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    sink?.(step, performance.now() - t0);
  }
}

/** Nearest-rank percentile (p in 0..100) of unsorted samples; 0 for none. */
export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** Table "step  n  median  p90" in milliseconds, one row per step in insertion order. */
export function formatStepTable(samples: ReadonlyMap<string, readonly number[]>, title = 'step'): string {
  const w = Math.max(title.length, ...[...samples.keys()].map((k) => k.length)) + 2;
  const rows = [`${title.padEnd(w)}${'n'.padStart(5)}${'median'.padStart(9)}${'p90'.padStart(9)}`];
  for (const [k, v] of samples) {
    rows.push(`${k.padEnd(w)}${String(v.length).padStart(5)}${`${Math.round(percentile(v, 50))} ms`.padStart(9)}${`${Math.round(percentile(v, 90))} ms`.padStart(9)}`);
  }
  return rows.join('\n');
}
