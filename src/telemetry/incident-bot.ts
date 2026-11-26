/**
 * The incident workflow's two strict checks (docs/ADR-017-incident-autowake.md). The issue is public, so its text is
 * data, never instructions:
 *
 * - parseIncidentIssue: keeps only the lines `stephen report` writes, and only when a line parses to an incident record
 *   and formats back to the very same text. So only ids, times, versions, code words and numbers reach the agent.
 * - findingsComment: checks the agent's answer (a fixed JSON shape) before anything is posted on GitHub.
 */
import { parseIncidentRecord, type IncidentRecord } from './incidents.js';
import { REPORT_MAX_LAST, incidentLine } from './report.js';

export const ISSUE_BODY_MAX = 20_000;

const LINE_RE = /^- (\S+) {2}(\S+) {2}(\S+) {2}at (\S+) {2}\(Stephen (\S+), Node (\S+?)(?:, Darwin (\S+))?\) {2}id (\S+)$/;
const NUM_RE = /^([A-Za-z]{1,20}) (\d{1,9}) ms$/;

function fromLines(head: string, nums: string | undefined): IncidentRecord | null {
  const m = LINE_RE.exec(head);
  if (!m) return null;
  const o: Record<string, unknown> = { v: 1, ts: m[1], part: m[2], code: m[3], stage: m[4], stephen: m[5], node: m[6], id: m[8] };
  if (m[7] !== undefined) o.darwin = m[7];
  if (nums !== undefined) {
    const stages: Record<string, number> = {};
    for (const part of nums.slice(2).split(', ')) {
      const n = NUM_RE.exec(part);
      if (!n) return null;
      if (n[1] === 'modelMs' || n[1] === 'toolMs' || n[1] === 'firstTokenMs') o[n[1]] = Number(n[2]);
      else stages[n[1]!] = Number(n[2]);
    }
    o.stages = stages;
  }
  return parseIncidentRecord(o);
}

/** The incident records in an issue body. Lines that do not round-trip exactly are dropped and counted. */
export function parseIncidentIssue(body: string): { records: IncidentRecord[]; dropped: number } {
  const lines = body.slice(0, ISSUE_BODY_MAX).replace(/\r\n/g, '\n').split('\n');
  const records: IncidentRecord[] = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!;
    if (!head.startsWith('- ')) {
      if (head.trim()) dropped++;
      continue;
    }
    const next = lines[i + 1];
    const nums = next !== undefined && next.startsWith('  ') ? next : undefined;
    const text = nums === undefined ? head : `${head}\n${nums}`;
    const rec = fromLines(head, nums);
    if (rec && incidentLine(rec) === text && records.length < REPORT_MAX_LAST) records.push(rec);
    else dropped += nums === undefined ? 1 : 2;
    if (nums !== undefined) i++;
  }
  return { records, dropped };
}

/** The agent's answer. The workflow passes the matching JSON schema to Claude Code with --json-schema. */
export interface Findings {
  cause: string;
  confidence: 'low' | 'medium' | 'high';
  files: string[];
  test: string;
  summary: string;
}

export const SUMMARY_MAX = 1500;
const CAUSE_RE = /^[a-z][a-z0-9_]{1,23}$/;
const PATH_RE = /^(src|docs|test)\/[A-Za-z0-9._/-]{1,120}$/;
const TEST_RE = /^test\/[A-Za-z0-9._/-]{1,120}\.test\.ts$/;
/** Anything that looks like a key or token: an Anthropic or GitHub prefix, or a long unbroken run of key characters. */
const SECRET_RE = /sk-ant-|gh[pousr]_|github_pat_|[A-Za-z0-9+/=_-]{40,}/;

function okPath(p: unknown, re: RegExp, fileExists: (path: string) => boolean): p is string {
  return typeof p === 'string' && re.test(p) && !SECRET_RE.test(p) && fileExists(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '') && !p.startsWith('test/fixtures/');
}

/** Checks the agent's answer. Returns null when anything is off: then nothing the agent wrote is posted. */
export function checkFindings(raw: unknown, fileExists: (path: string) => boolean): Findings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !['cause', 'confidence', 'files', 'test', 'summary'].includes(k))) return null;
  if (typeof o.cause !== 'string' || !CAUSE_RE.test(o.cause) || SECRET_RE.test(o.cause)) return null;
  if (o.confidence !== 'low' && o.confidence !== 'medium' && o.confidence !== 'high') return null;
  if (!Array.isArray(o.files) || o.files.length > 10 || !o.files.every((f) => okPath(f, PATH_RE, fileExists))) return null;
  if (typeof o.test !== 'string' || (o.test !== '' && !okPath(o.test, TEST_RE, fileExists))) return null;
  if (typeof o.summary !== 'string' || !o.summary.trim() || o.summary.length > SUMMARY_MAX || SECRET_RE.test(o.summary)) return null;
  // Printable ASCII and new lines only, no backticks: it cannot leave the code block or hide text (bidi, zero width).
  if (!/^[\n\x20-\x5f\x61-\x7e]*$/.test(o.summary)) return null;
  return { cause: o.cause, confidence: o.confidence, files: o.files as string[], test: o.test, summary: o.summary.trim() };
}

/** The issue comment and the one inbox line. The summary sits in a code block: no links, images or @mentions work there. */
export function findingsComment(f: Findings, issue: number, runUrl: string): { comment: string; inbox: string } {
  const comment = [
    'Incident bot findings (an agent read the repo; nothing was run).',
    '',
    `- Cause: \`${f.cause}\` (confidence ${f.confidence})`,
    `- Files: ${f.files.length ? f.files.map((p) => `\`${p}\``).join(', ') : 'none named'}`,
    `- Test to add: ${f.test ? `\`${f.test}\`` : 'none named'}`,
    '',
    '```text',
    f.summary,
    '```',
    '',
    `Run: ${runUrl}`,
  ].join('\n');
  const inbox = ['from: incident-bot', 'to: dev', '', `Incident #${issue}: cause \`${f.cause}\`, confidence ${f.confidence}. Findings are on #${issue}.`].join('\n');
  return { comment, inbox };
}
