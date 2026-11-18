// Turns vitest's JSON report into a short Markdown list: failing test names and the first line of each failure.
// No logs, no environment, no stack traces. Usage: node scripts/ci-report.mjs vitest.json
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log('No test result: the job stopped before the tests finished (install, build or typecheck).');
  process.exit(0);
}
const r = JSON.parse(readFileSync(file, 'utf8'));
const clean = (s) => (s ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim())?.trim().slice(0, 200).replaceAll('`', "'") ?? '';
const name = (s) => (s ?? '').replaceAll('`', "'").slice(0, 200); // in a code span: no @mentions, no Markdown
const rel = (p) => 'test/' + p.split('/test/').slice(1).join('/test/');
const lines = [];
for (const f of r.testResults) {
  const failed = f.assertionResults.filter((t) => t.status === 'failed');
  if (f.status === 'failed' && failed.length === 0) lines.push(`- \`${rel(f.name)}\` did not load: \`${clean(f.message)}\``);
  for (const t of failed) lines.push(`- \`${rel(f.name)}\` > \`${name(t.fullName)}\`\n  \`${clean(t.failureMessages?.[0])}\``);
}
console.log(`**${r.numFailedTests} failed, ${r.numPassedTests} passed, ${r.numPendingTests + r.numTodoTests} skipped**`);
if (lines.length) console.log('\n' + lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n- and ${lines.length - 20} more` : ''));
