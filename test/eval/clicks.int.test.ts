/**
 * The click-reliability eval itself (src/eval/clicks.ts): one run per case through the real tool pipeline,
 * failures attributed to the cause each fixture reproduces. It measures, so this only checks the harness works.
 */
import { describe, expect, it } from 'vitest';
import { CLICK_CASES, formatClickReport, runClickEval } from '../../src/eval/clicks.js';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';

describe('stephen eval-clicks', () => {
  it('runs every case and logs failures under the cause the case reproduces', async () => {
    const reports = await runClickEval({ runs: 1, cases: CLICK_CASES, executablePath: await chromiumPath(), args: chromiumArgs() });
    expect(reports.map((r) => r.id)).toEqual(CLICK_CASES.map((k) => k.id));
    for (const r of reports) {
      const k = CLICK_CASES.find((c) => c.id === r.id)!;
      expect(r.passed + r.failures.length).toBe(1);
      for (const f of r.failures) expect(f.cause, `${r.id}: ${f.detail}`).toBe(k.cause);
    }
    // The cookie banner is reported as OBSCURED (nothing clicked through it), then dismissed.
    expect(reports.find((r) => r.id === 'cookie-banner')?.passed).toBe(1);
    const text = formatClickReport(reports);
    expect(text).toMatch(/^case +pass +what/);
    expect(text).not.toMatch(/\b[cz]\d+:e\d+\b/); // refs are folded so the log groups by cause
  }, 120_000);
});
