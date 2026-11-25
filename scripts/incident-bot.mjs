// The incident workflow's strict checks (.github/workflows/incident.yml, docs/ADR-017-incident-autowake.md).
// Needs `npm run build` first. Input comes from env, never from the command line.
//
//   node scripts/incident-bot.mjs parse   ISSUE_BODY -> stdout: the verified incident lines (empty when none)
//   node scripts/incident-bot.mjs post    FINDINGS, ISSUE, RUN_URL, QA_DIR -> comment.md and inbox.md; exit 1 if the answer fails the check
//                                         (paths must exist in QA_DIR, a checkout of qa, the code the agent read)
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFindings, findingsComment, parseIncidentIssue } from '../dist/telemetry/incident-bot.js';
import { incidentLine } from '../dist/telemetry/report.js';

const cmd = process.argv[2];
if (cmd === 'parse') {
  const { records, dropped } = parseIncidentIssue(process.env.ISSUE_BODY ?? '');
  console.error(`${records.length} incident line(s) kept, ${dropped} line(s) dropped.`);
  process.stdout.write(records.map(incidentLine).join('\n'));
} else if (cmd === 'post') {
  let raw = null;
  try {
    raw = JSON.parse(process.env.FINDINGS ?? '');
  } catch {}
  // A regular file in the qa checkout only (no links), so a path cannot point outside the repo.
  const qa = process.env.QA_DIR || '.';
  const f = checkFindings(raw, (p) => existsSync(join(qa, p)) && lstatSync(join(qa, p)).isFile());
  const issue = Number(process.env.ISSUE);
  if (!f || !Number.isInteger(issue) || issue < 1) {
    console.error('The agent answer failed the strict check. Nothing it wrote is posted.');
    process.exit(1);
  }
  const { comment, inbox } = findingsComment(f, issue, process.env.RUN_URL ?? '');
  writeFileSync('comment.md', comment);
  writeFileSync('inbox.md', inbox);
} else {
  console.error('usage: incident-bot.mjs parse|post');
  process.exit(2);
}
