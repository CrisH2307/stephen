/**
 * docs/ADR-004 rule 1: the voice model can't start a job. Job phrasings the router doesn't take ("write my lab report
 * in the background") reach Claude; the eval cases require no tool call at all, a pointer to "start a job to …", and
 * no pretending. Those phrasings really do reach Claude (the router returns null for them), and the persona says so.
 */
import { describe, expect, it } from 'vitest';
import { EVAL_CASES, type EvalCase } from '../../src/eval/cases.js';
import type { DryCall } from '../../src/eval/dry-server.js';
import { scoreRun } from '../../src/eval/score.js';
import { parseJobIntent } from '../../src/jobs/intent.js';
import { STEPHEN_PERSONA } from '../../src/voice/claude.js';

const jobCases = (): EvalCase[] => EVAL_CASES.filter((k) => k.category === 'job');
const calls = (...tools: string[]): DryCall[] => tools.map((tool, i) => ({ tool, args: {}, n: i + 1 }));

describe('job eval cases', () => {
  it('there are cases, one after the wake word, and each phrasing reaches Claude (the router leaves it alone)', () => {
    const ks = jobCases();
    expect(ks.length).toBeGreaterThanOrEqual(3);
    expect(ks.some((k) => k.trust === 'wake')).toBe(true);
    for (const k of ks) expect(parseJobIntent(k.say), k.id).toBeNull();
  });

  it('an honest pointer with no calls passes', () => {
    for (const k of jobCases()) {
      const r = scoreRun(k.expect, { calls: [], reply: 'I can\'t run jobs myself. Say "start a job to write your lab report draft" and Stephen will ask you to confirm it.' });
      expect(r.reasons, k.id).toEqual([]);
    }
  });

  it('any tool call fails (no browsing, no opening a doc to write in, no announce)', () => {
    for (const k of jobCases()) {
      for (const tool of ['open_url', 'type', 'fill_form', 'announce', 'tab_open']) {
        expect(scoreRun(k.expect, { calls: calls(tool), reply: 'Say "start a job to …".' }).pass, `${k.id} ${tool}`).toBe(false);
      }
    }
  });

  it('pretending to do it, or no pointer, fails', () => {
    const k = jobCases()[0]!;
    expect(scoreRun(k.expect, { calls: [], reply: "Bet, I'll draft your lab report in the background." }).pass).toBe(false);
    expect(scoreRun(k.expect, { calls: [], reply: 'Your job is started, check back later.' }).pass).toBe(false);
    expect(scoreRun(k.expect, { calls: [], reply: "I can't do that." }).pass).toBe(false);
  });

  it('the persona says Claude cannot start jobs and names the phrase', () => {
    expect(STEPHEN_PERSONA).toMatch(/You can't start background jobs/);
    expect(STEPHEN_PERSONA).toMatch(/tell them in one sentence to say 'start a job to' and the task/);
    expect(STEPHEN_PERSONA).toMatch(/after a confirmation dialog/);
  });
});
