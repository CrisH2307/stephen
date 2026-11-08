/**
 * The click-reliability eval (src/eval/clicks.ts) through the real tool pipeline, and the P1 fixes it measures:
 * settle before clicking, re-find once on STALE_REF for clicks the gate allows without asking, verify after.
 */
import { describe, expect, it } from 'vitest';
import { CLICK_CASES, formatClickReport, runClickEval, type ClickCase } from '../../src/eval/clicks.js';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';

const run = async (cases: readonly ClickCase[], runs = 1) => runClickEval({ runs, cases, executablePath: await chromiumPath(), args: chromiumArgs() });

describe('stephen eval-clicks', () => {
  it('every case passes (settle, re-find, focus) and the log folds refs', async () => {
    const reports = await run(CLICK_CASES, 2);
    expect(reports.map((r) => r.id)).toEqual(CLICK_CASES.map((k) => k.id));
    for (const r of reports) expect(r.failures, `${r.id}: ${JSON.stringify(r.failures)}`).toEqual([]);
    const text = formatClickReport(reports);
    expect(text).toMatch(/^case +pass +what/);
    expect(text).not.toMatch(/\b[cz]\d+:e\d+\b/);
  }, 180_000);

  it('never re-finds a gated click (Send) or an ambiguous one: STALE_REF, nothing clicked', async () => {
    const seen: string[] = [];
    const staleClick = (id: string, label: string): ClickCase => ({
      id,
      cause: 'stale ref',
      what: id,
      run: async (a) => {
        const tab = await a.open(id);
        const ref = (await a.find(tab, label)).find((m) => m.role === 'button')!.ref;
        await a.sleep(600);
        const r = await a.click(tab, ref);
        seen.push(`${id}:${r.ok}:${/STALE_REF|no longer|disappeared|stale/i.test(r.text)}:${await a.result(tab)}`);
      },
    });
    await run([staleClick('stale-send', 'Send'), staleClick('stale-twins', 'Open')]);
    expect(seen).toEqual(['stale-send:false:true:', 'stale-twins:false:true:']);
  }, 60_000);

  it('re-checks identity after the settle wait: renamed while covered gives STALE_REF, nothing clicked (R9-3)', async () => {
    let seen = '';
    await run([
      {
        id: 'swap-during-settle',
        cause: 'other',
        what: 'renamed during settle',
        run: async (a) => {
          const tab = await a.open('swap-during-settle');
          const ref = (await a.find(tab, 'Save draft')).find((m) => m.role === 'button')!.ref;
          const r = await a.click(tab, ref);
          await a.sleep(300);
          seen = `${r.ok}:${/STALE_REF|no longer/i.test(r.text)}:${await a.result(tab)}`;
        },
      },
    ]);
    expect(seen).toBe('false:true:');
  }, 60_000);

  it('says so when a click changed nothing on the page', async () => {
    let text = '';
    await run([
      {
        id: 'still-loading',
        cause: 'other',
        what: 'dead button',
        run: async (a) => {
          const tab = await a.open('cookie-banner');
          const h1 = (await a.find(tab, 'News')).find((m) => m.role === 'heading');
          // A heading has no handler: clicking it changes nothing.
          text = h1 ? (await a.click(tab, h1.ref)).text : 'no heading';
        },
      },
    ]);
    expect(text).toMatch(/no change/i);
  }, 60_000);
});
