// B9: a PR that changes a safety path needs "[DEV REVIEW]" in its title (docs/ARCHITECTURE-PLAN.md, task B9).
// The title comes in through env: only (never ${{ }} in run:). Usage, in CI:
//   TITLE=... node scripts/safety-paths.mjs        (CI: HEAD is the PR's merge commit, so HEAD^1 is the base)
//   TITLE=... BASE=<sha> node scripts/safety-paths.mjs (by hand: compare with that commit)
// It names the changed safety files, never the title. A guard against an honest slip, not against a hostile PR:
// a PR can edit this file and its workflow too, which is why both are on the list.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Folders end with "/", the rest are single files. */
/** The one list (docs/AGENT-LOOP.md "Always Claude-only" points here). The incident ladder list must stay inside it. */
export const SAFETY_PATHS = [
  'src/safety/',
  // Allow and Deny: the confirm dialog, and the ask box and chat thread (their Allow delay, Esc as Deny).
  'helper/AppConfirm.swift',
  'helper/AskBox.swift',
  'helper/Components/ChatThread.swift',
  'helper/AppProtocol.swift',
  // Memory, timer and job writes: the whole folders, plus the atomic private write they share.
  'src/memory/',
  'src/timers/',
  'src/jobs/',
  'src/lib/fs.ts',
  'src/lib/owner-only.ts',
  // The replay recorder and its owner-only switch.
  'src/replay/recorder.ts',
  'src/app/replay-switch.ts',
  'src/app/protocol.ts',
  'src/app/server.ts',
  // Dependencies, CI and the release gate.
  'package.json',
  'package-lock.json',
  'docs/RELEASE-CHECKLIST.md',
  '.github/workflows/',
  'scripts/safety-paths.mjs',
  'scripts/pr-rules.mjs',
];

export const TAG = '[DEV REVIEW]';

/** The changed files that are safety paths. Pure. */
export function safetyFiles(files) {
  return files.filter((f) => SAFETY_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

/** null when the PR is fine, else the message to print. Pure. */
export function safetyProblem(title, files) {
  const hit = safetyFiles(files);
  if (hit.length === 0 || title.includes(TAG)) return null;
  return [`This PR changes safety paths, so its title needs "${TAG}" (an Opus review before merge):`, ...hit.map((f) => `  ${f}`)].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const base = process.env.BASE || 'HEAD^1';
  if (base !== 'HEAD^1' && !/^[0-9a-f]{40}$/.test(base)) {
    console.log('BASE must be a full commit sha.');
    process.exit(1);
  }
  // --no-renames: a move out of a safety folder lists the old path too, so it cannot pass untagged (#386 review).
  const files = execFileSync('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const problem = safetyProblem(process.env.TITLE ?? '', files);
  if (problem) {
    console.log(problem);
    process.exit(1);
  }
  console.log(`OK: ${safetyFiles(files).length} safety file(s) changed${safetyFiles(files).length ? `, and the title has ${TAG}` : ''}.`);
}
