// AGENTS.md rules a PR breaks by accident, checked in CI (pr-rules.yml), so they stop living only in prose:
//   1. no em or en dash on an added line (except files where the dash is data),
//   2. every commit is Cris's (author, and committer Cris or GitHub's merge button),
//   3. a new dependency in package.json needs "[DEV REVIEW]" in the title.
// The title comes in through env: only (never ${{ }} in run:). It prints rule, file and commit, never the title.
// Usage, by hand: TITLE=... BASE_SHA=<sha> HEAD_SHA=<sha> BASE_REF=qa node scripts/pr-rules.mjs
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CRIS = 'Cris Huynh <119613966+CrisH2307@users.noreply.github.com>';
/** The committer of a merge made with GitHub's merge button. Allowed only with Cris as the author. */
export const GITHUB_MERGE = 'GitHub <noreply@github.com>';
export const TAG = '[DEV REVIEW]';
const DASHES = /[\u2013\u2014]/;

/** Files where a dash is data, not prose: the lookalike tables and their tests, and recorded fixtures. */
export const DASH_DATA = ['src/safety/text.ts', 'test/safety/', 'test/fixtures/'];

const isDashData = (f) => DASH_DATA.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

/** Added lines with a dash, from `git diff -U0` text, as "file:line". Pure. */
export function dashLines(diff) {
  const hits = [];
  let file = null;
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6);
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith('+')) {
      if (file && !isDashData(file) && DASHES.test(l)) hits.push(`${file}:${line}`);
      line++;
    }
  }
  return hits;
}

/** Commits ("sha\tauthor\tcommitter" lines) whose identity is not Cris's. Pure. */
export function badCommits(log) {
  return log
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, a, c]) => a !== CRIS || (c !== CRIS && c !== GITHUB_MERGE))
    .map(([sha]) => sha.slice(0, 12));
}

/** Dependency names in the new package.json that the old one did not have. Pure. */
export function newDeps(oldPkg, newPkg) {
  const names = (p) => new Set(['dependencies', 'devDependencies'].flatMap((k) => Object.keys(p?.[k] ?? {})));
  const had = names(oldPkg);
  return [...names(newPkg)].filter((n) => !had.has(n)).sort();
}

/** The messages to print, empty when the PR is fine. Pure. */
export function prProblems({ title, dashes, commits, deps }) {
  const out = [];
  if (dashes.length) out.push('Rule 1: no em or en dash on an added line. Use a period, comma or colon instead:', ...dashes.map((d) => `  ${d}`));
  if (commits.length)
    out.push(`Rule 2: every commit is authored and committed as ${CRIS}. Fix these commits with new commits, never a force-push:`, ...commits.map((c) => `  ${c}`));
  if (deps.length && !title.includes(TAG)) out.push(`Rule 3: a new dependency needs "${TAG}" in the title (ask Cris first):`, ...deps.map((d) => `  ${d}`));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const sha = (name) => {
    const v = process.env[name] ?? '';
    if (!/^[0-9a-f]{40}$/.test(v)) {
      console.log(`${name} must be a full commit sha.`);
      process.exit(1);
    }
    return v;
  };
  const run = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const head = sha('HEAD_SHA');
  const base = run('merge-base', sha('BASE_SHA'), head).trim();
  const pkg = (rev) => {
    try {
      return JSON.parse(run('show', `${rev}:package.json`));
    } catch {
      return {};
    }
  };
  // Commits already on main landed before (or were checked on the way), so a main-into-qa PR answers only for its own.
  const hasMain = (() => {
    try {
      run('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main');
      return true;
    } catch {
      return false;
    }
  })();
  // A release PR (into main) carries commits and lines that were checked on their way into qa, plus older history
  // from before this check. So rules 1 and 2 apply to PRs into qa only; rule 3 applies to both.
  const intoQa = process.env.BASE_REF !== 'main';
  const log = intoQa ? run('log', '--format=%H%x09%an <%ae>%x09%cn <%ce>', head, '--not', base, ...(hasMain ? ['refs/remotes/origin/main'] : [])) : '';
  const dashes = intoQa ? dashLines(run('diff', '-U0', '--no-renames', base, head)) : [];
  const problems = prProblems({ title: process.env.TITLE ?? '', dashes, commits: badCommits(log), deps: newDeps(pkg(base), pkg(head)) });
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
  console.log(intoQa ? 'OK: no dashes added, every commit is Cris, no untagged new dependency.' : 'OK: no untagged new dependency (dashes and authors are checked on PRs into qa).');
}
