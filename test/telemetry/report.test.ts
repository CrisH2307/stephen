/** `stephen report` (incident loop phase 1): nothing is sent without a typed "y", and the issue is what was shown. */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { incidentDir, recordIncident } from '../../src/telemetry/incidents.js';
import { REPORT_LABEL, REPORT_QUESTION, REPORT_REPO, parseReportArgs, runReport, type RunResult } from '../../src/telemetry/report.js';

function setup(answer: string, runs: RunResult[] = [{ code: 0, stderr: '' }, { code: 0, stderr: '' }]) {
  const home = mkdtempSync(join(tmpdir(), 'stephen-rep-'));
  const out: string[] = [];
  const asked: string[] = [];
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const deps = {
    home,
    out: (s: string) => out.push(s),
    ask: async (q: string) => (asked.push(q), answer),
    run: async (file: string, args: string[], input?: string) => (calls.push({ file, args, input }), runs.shift() ?? { code: 0, stderr: '' }),
  };
  return { home, out, asked, calls, deps };
}

const today = () => new Date();

describe('runReport', () => {
  it('no incidents: says so, asks nothing, sends nothing', async () => {
    const t = setup('y');
    expect(await runReport([], t.deps)).toBe(0);
    expect(t.out).toEqual(['No incidents recorded. Nothing to report.']);
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it.each(['', 'n', 'no', 'N', 'yeah', 'yes please', 'y y', 'sure', 'ok'])('answer %j sends nothing', async (answer) => {
    const t = setup(answer);
    recordIncident(t.home, { part: 'listen', code: 'command_error', id: 'h_a' }, today());
    expect(await runReport([], t.deps)).toBe(0);
    expect(t.asked).toEqual([REPORT_QUESTION]);
    expect(t.calls).toEqual([]);
    expect(t.out.at(-1)).toBe('Not sent.');
  });

  it.each(['y', 'Y', 'yes', ' YES '])('answer %j sends exactly the text that was shown', async (answer) => {
    const t = setup(answer);
    recordIncident(t.home, { part: 'serve', code: 'uncaught', id: 'h_b' }, today());
    expect(await runReport([], t.deps)).toBe(0);
    const shown = t.out[0]!;
    expect(t.calls[0]).toEqual({ file: 'gh', args: ['auth', 'status'], input: undefined });
    const create = t.calls[1]!;
    expect(create.file).toBe('gh');
    expect(create.args.slice(0, 6)).toEqual(['issue', 'create', '--repo', REPORT_REPO, '--label', REPORT_LABEL]);
    expect(create.input).toBe(shown);
    const title = create.args[create.args.indexOf('--title') + 1]!;
    expect(shown.split('\n')[0]).toBe(title);
    expect(t.out.at(-1)).toBe('Sent. Thank you.');
  });

  it('gh missing or not signed in: nothing is created, the manual steps are shown', async () => {
    for (const code of [127, 1]) {
      const t = setup('y', [{ code, stderr: '' }]);
      recordIncident(t.home, { part: 'job', code: 'uncaught', id: 'h_c' }, today());
      expect(await runReport([], t.deps)).toBe(1);
      expect(t.calls).toHaveLength(1);
      expect(t.out.at(-1)).toContain('/issues/new');
    }
  });

  it('a day file older than 30 days is deleted first, and never shown or sent', async () => {
    const t = setup('y');
    recordIncident(t.home, { part: 'listen', code: 'command_error', id: 'h_new' }, today());
    const old = new Date(Date.now() - 40 * 86_400_000);
    recordIncident(t.home, { part: 'listen', code: 'command_error', id: 'h_old' }, old);
    expect(readdirSync(incidentDir(t.home))).toHaveLength(2);
    await runReport(['--last', '50'], t.deps);
    expect(readdirSync(incidentDir(t.home))).toHaveLength(1);
    expect(t.out[0]).toContain('h_new');
    expect(t.out[0]).not.toContain('h_old');
    expect(t.calls[1]!.input).not.toContain('h_old');
  });

  it('free text planted in the file is never shown or sent', async () => {
    const t = setup('y');
    recordIncident(t.home, { part: 'listen', code: 'command_error', id: 'h_d' }, today());
    const file = join(incidentDir(t.home), readdirSync(incidentDir(t.home))[0]!);
    const evil = 'https://evil.example/?q=my bank balance';
    writeFileSync(file, `${JSON.stringify({ v: 1, id: 'h_e', ts: new Date().toISOString(), stephen: evil, part: evil, code: evil, stage: evil, node: evil, darwin: evil, message: evil })}\n`, { flag: 'a' });
    await runReport([], t.deps);
    expect(t.out.join('\n')).not.toContain('evil');
    expect(t.calls[1]!.input).not.toContain('bank');
  });
});

describe('parseReportArgs', () => {
  it('--last is a whole number from 1 to 50', () => {
    expect(parseReportArgs([])).toEqual({ last: 5 });
    expect(parseReportArgs(['--last', '3'])).toEqual({ last: 3 });
    expect(parseReportArgs(['--last=50'])).toEqual({ last: 50 });
    for (const bad of [['--last', '0'], ['--last', '51'], ['--last', '2.5'], ['--last'], ['--what']]) expect(parseReportArgs(bad)).toHaveProperty('error');
    expect(parseReportArgs(['--help'])).toBe('help');
  });
});
