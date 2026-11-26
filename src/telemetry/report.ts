/**
 * `stephen report [--last N]` (phase 1 of the incident loop, docs/NFR-STEPHEN.md section 9): print the newest
 * incidents in plain words, then ask "Send this to GitHub as an issue? (y/N)". Only a typed "y" (or "yes") sends, with
 * the person's own `gh` sign-in, and the issue holds exactly the text that was shown. Anything else sends nothing.
 *
 * The text comes only from parseIncidentRecord's fields (ids, times, versions, code words, numbers), so it is safe on
 * a public repo.
 */
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { purgeIncidents, readIncidents, type IncidentRecord } from './incidents.js';

export const REPORT_REPO = 'CrisH2307/stephen';
export const REPORT_LABEL = 'incident';
export const REPORT_DEFAULT_LAST = 5;
export const REPORT_MAX_LAST = 50;
export const REPORT_QUESTION = 'Send this to GitHub as an issue? (y/N) ';

export const REPORT_HELP = `stephen report: show recent crashes and failed commands, and send them to GitHub if you want

  stephen report [--last N]   the newest N incidents (default ${REPORT_DEFAULT_LAST}, at most ${REPORT_MAX_LAST})
  stephen report --copy       copy them and open GitHub's empty issue form (no question; for people without gh)

Incidents hold ids, times, versions, code words and numbers only: never your words, pages or names.
Nothing is sent unless you type "y". Sending uses your own gh sign-in; without gh, the text is copied
and GitHub's form opens instead (the text never goes in the address).`;

export function parseReportArgs(argv: string[]): { last: number } | { error: string } | 'help' {
  let last = REPORT_DEFAULT_LAST;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--last' || a.startsWith('--last=')) {
      const v = Number(a === '--last' ? argv[++i] : a.slice('--last='.length));
      if (!Number.isInteger(v) || v < 1 || v > REPORT_MAX_LAST) return { error: `--last must be a whole number from 1 to ${REPORT_MAX_LAST}` };
      last = v;
    } else return { error: `Unknown option "${a}" for report.` };
  }
  return { last };
}

export function incidentLine(r: IncidentRecord): string {
  const where = r.darwin ? `Node ${r.node}, Darwin ${r.darwin}` : `Node ${r.node}`;
  const lines = [`- ${r.ts}  ${r.part}  ${r.code}  at ${r.stage}  (Stephen ${r.stephen}, ${where})  id ${r.id}`];
  const nums = [
    ...Object.entries(r.stages ?? {}).map(([k, v]) => `${k} ${v} ms`),
    ...(['modelMs', 'toolMs', 'firstTokenMs'] as const).flatMap((k) => (r[k] === undefined ? [] : [`${k} ${r[k]} ms`])),
  ];
  if (nums.length) lines.push(`  ${nums.join(', ')}`);
  return lines.join('\n');
}

/** The issue title and body. The title is the body's first line, so everything sent is in what was shown. */
export function formatReport(records: IncidentRecord[]): { title: string; body: string } {
  const newest = records[0]!;
  const title = `Incident: ${newest.part} ${newest.code} (Stephen ${newest.stephen})`;
  const body = [title, '', `${records.length} incident${records.length === 1 ? '' : 's'}, newest first:`, '', ...records.map(incidentLine), ''].join('\n');
  return { title, body };
}

/**
 * F12: the issue form chooser. No query and no fragment, ever: the text goes by the clipboard, never in a URL (a URL
 * lands in browser history, logs and referrers).
 */
export const REPORT_FORM_URL = `https://github.com/${REPORT_REPO}/issues/new/choose`;

export function manualSteps(): string {
  return `To send it by hand: open https://github.com/${REPORT_REPO}/issues/new, paste the text above, and add the label "${REPORT_LABEL}".`;
}

export type RunResult = { code: number; stderr: string };

export interface ReportDeps {
  home: string;
  out: (s: string) => void;
  /** Ask a question, resolve with the typed answer ('' at end of input). */
  ask: (question: string) => Promise<string>;
  /** Run a program with `input` on stdin. A missing program resolves with code 127. */
  run: (file: string, args: string[], input?: string) => Promise<RunResult>;
  platform: NodeJS.Platform;
}

/**
 * F12, no `gh` (most friends): put the shown text on the clipboard and open the empty issue form. Returns false when
 * that is not possible (not macOS, or pbcopy failed); the caller then prints the manual steps.
 */
async function copyAndOpen(body: string, d: ReportDeps): Promise<boolean> {
  if (d.platform !== 'darwin') return false;
  if ((await d.run('/usr/bin/pbcopy', [], body)).code !== 0) return false;
  d.out('Copied the text above.');
  const opened = (await d.run('/usr/bin/open', [REPORT_FORM_URL])).code === 0;
  d.out(opened ? `Opened GitHub's form in your browser: pick "Crash", paste into "Incident report", and send it.` : `Open ${REPORT_FORM_URL}, pick "Crash", and paste.`);
  d.out('No GitHub account? Send the copied text to Cris instead (it holds only ids, versions and error codes).');
  return true;
}

export async function runReport(argv: string[], d: ReportDeps): Promise<number> {
  const copyOnly = argv.includes('--copy'); // the helper's "Report a problem…": no question, nothing sent
  const args = parseReportArgs(argv.filter((a) => a !== '--copy'));
  if (args === 'help') {
    d.out(REPORT_HELP);
    return 0;
  }
  if ('error' in args) {
    d.out(args.error);
    return 2;
  }
  purgeIncidents(d.home); // expired days are deleted before anything is shown or sent
  const records = readIncidents(d.home, args.last);
  if (!records.length) {
    d.out('No incidents recorded. Nothing to report.');
    return 0;
  }
  const { title, body } = formatReport(records);
  d.out(body);
  if (copyOnly) {
    if (await copyAndOpen(body, d)) return 0;
    d.out(manualSteps());
    return 1;
  }
  const answer = (await d.ask(REPORT_QUESTION)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    d.out('Not sent.');
    return 0;
  }
  const auth = await d.run('gh', ['auth', 'status']);
  if (auth.code !== 0) {
    if (await copyAndOpen(body, d)) return 0;
    d.out(auth.code === 127 ? 'The GitHub CLI (gh) is not installed.' : 'gh is not signed in (run `gh auth login`).');
    d.out(manualSteps());
    return 1;
  }
  const r = await d.run('gh', ['issue', 'create', '--repo', REPORT_REPO, '--label', REPORT_LABEL, '--title', title, '--body-file', '-'], body);
  if (r.code !== 0) {
    d.out(`gh could not create the issue (exit ${r.code}).`);
    d.out(manualSteps());
    return 1;
  }
  d.out('Sent. Thank you.');
  return 0;
}

function runProgram(file: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: 60_000 }, (e, _stdout, stderr) => {
      const code = e ? ((e as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1) : 0;
      resolve({ code, stderr: String(stderr) });
    });
    child.stdin?.end(input ?? '');
  });
}

export async function runReportCli(argv: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ended = false;
  rl.once('close', () => (ended = true));
  try {
    return await runReport(argv, {
      home: loadConfig().home,
      out: (s) => console.log(s),
      ask: (q) => (ended ? Promise.resolve('') : Promise.race([rl.question(q), new Promise<string>((res) => rl.once('close', () => res('')))])),
      run: runProgram,
      platform: process.platform,
    });
  } finally {
    rl.close();
  }
}
