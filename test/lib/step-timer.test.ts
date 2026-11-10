import { afterEach, describe, expect, it } from 'vitest';
import { formatStepTable, onStep, percentile, timed } from '../../src/lib/step-timer.js';
import { formatTimings, type CaseResult } from '../../src/eval/run.js';

afterEach(() => onStep(null));

describe('step timer (P6)', () => {
  it('records nothing without a sink, and records thrown steps with one', async () => {
    expect(await timed('a', async () => 1)).toBe(1);
    const seen: string[] = [];
    onStep((s, ms) => seen.push(`${s}:${ms >= 0}`));
    await timed('ok', async () => undefined);
    await expect(timed('boom', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(seen).toEqual(['ok:true', 'boom:true']);
  });

  it('nearest-rank median and p90', () => {
    const v = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 90)).toBe(9);
    expect(percentile([], 50)).toBe(0);
    expect(formatStepTable(new Map([['click', v]]))).toMatch(/click +10 +5 ms +9 ms/);
  });

  it('stephen eval splits wall time into start-up, model per turn and tools', () => {
    const r = { ms: 5000, durationMs: 4000, apiMs: 3000, turns: 3 } as CaseResult;
    const t = formatTimings([r, { ...r, durationMs: null }]);
    expect(t).toMatch(/start-up \+ MCP +1 +1000 ms/);
    expect(t).toMatch(/model per turn \(think\) +1 +1000 ms/);
    expect(t).toMatch(/tools \+ overhead +1 +1000 ms/);
    expect(formatTimings([])).toBe('');
  });
});
