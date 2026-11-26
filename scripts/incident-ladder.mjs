// The incident on-call ladder (docs/INCIDENT-LADDER.md, docs/ADR-017-incident-autowake.md). Run by hand on Cris's Mac:
//
//   npm run incident-ladder            (builds, then runs this)
//   node scripts/incident-ladder.mjs --dry-run    (runs the whole ladder, prints the comment, posts and labels nothing)
//
// Needs `npm run build` first: the rules are in dist/. Argv only, never a shell string. The models never get gh, a shell
// or a token: this script alone posts, with fixed commands and a fixed repo. Issue text never reaches a model; only the
// lines that parseIncidentIssue keeps do.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutSecrets } from '../dist/lib/claude-env.js';
import { checkFindings, findingsComment, inboxLine, parseIncidentIssue } from '../dist/telemetry/incident-bot.js';
import {
  ALLOWED_AUTHOR_IDS,
  bodyHash,
  CLAUDE_LEVELS,
  CLAUDE_RUNS_PER_DAY,
  claudeArgs,
  claudeRunsToday,
  codeWords,
  dayUtc,
  editWindowOk,
  excerpts,
  hasMarker,
  l1Lines,
  l1Prompt,
  LADDER_RUNS_PER_ISSUE_PER_DAY,
  ladderPrompt,
  ladderRunsToday,
  markerFor,
  nextLevel,
  parseModelJson,
  pickL1Model,
  QA_REF,
  resolves,
  withHomeDeny,
} from '../dist/telemetry/incident-ladder.js';
import { jobSettings } from '../dist/jobs/spec.js';

const REPO = 'CrisH2307/stephen';
const [OWNER, NAME] = REPO.split('/');
const INBOX_ISSUE = 274;
const FREELLM_URL = 'http://localhost:3001/v1/chat/completions';
const L1_TIMEOUT_MS = 45_000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

const log = (s) => console.log(s);
const oneLine = (e) => String(e?.message ?? e).split('\n')[0];

/** Runs a program with argv (never a shell). Resolves with stdout; rejects with the error. */
function run(file, args, opts = {}) {
  return new Promise((resolveRun, reject) => {
    const child = execFile(file, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout) => (err ? reject(err) : resolveRun(stdout)));
    child.stdin?.end();
  });
}

const ghJson = async (args) => JSON.parse(await run('gh', ['api', ...args]));

/** The body's last edit (GraphQL lastEditedAt, else createdAt). Comments do not move it. */
async function bodyEditedAt(number) {
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){lastEditedAt createdAt}}}';
  const r = await ghJson(['graphql', '-f', `query=${query}`, '-F', `owner=${OWNER}`, '-F', `name=${NAME}`, '-F', `number=${number}`]);
  const issue = r.data.repository.issue;
  return issue.lastEditedAt ?? issue.createdAt;
}

/** L1: one free model through freellm. No tools. Null when it fails or its answer does not pass the check. */
async function runL1(lines, codeText, fileOk) {
  const model = pickL1Model(process.env.INCIDENT_L1_MODEL);
  const key = process.env.FREELLM_API_KEY;
  if (!model || !key) {
    log('  L1 skipped (model not on the pinned list, or FREELLM_API_KEY is not set).');
    return null;
  }
  try {
    const res = await fetch(FREELLM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: l1Prompt(lines, codeText) }] }),
      signal: AbortSignal.timeout(L1_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = (await res.json())?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? checkFindings(parseModelJson(text), fileOk) : null;
  } catch {
    return null;
  }
}

/** L2 to L4: `claude -p`, read-only, in the copy. Null when it crashes, times out or fails the check. */
async function runClaude(level, lines, previous, copy, settingsFile, fileOk) {
  try {
    const out = await run('claude', claudeArgs(level, ladderPrompt(lines, previous), settingsFile), {
      cwd: copy,
      env: withoutSecrets(process.env),
      timeout: CLAUDE_LEVELS[level].minutes * 60_000,
    });
    return checkFindings(JSON.parse(out).structured_output ?? null, fileOk);
  } catch {
    return null;
  }
}

/** Runs the ladder on one issue and posts one comment. `budget.used` counts Claude runs across issues today. */
async function handleIssue(issue, comments, budget, today) {
  const n = issue.number;
  const body = issue.body ?? '';
  const hash = bodyHash(body);
  if (!editWindowOk(await bodyEditedAt(n), new Date())) return log(`#${n}: skipped, the body was edited less than 10 minutes ago.`);
  if (hasMarker(comments, hash)) return log(`#${n}: skipped, this body was already answered.`);
  if (ladderRunsToday(comments, today) >= LADDER_RUNS_PER_ISSUE_PER_DAY) return log(`#${n}: skipped, ${LADDER_RUNS_PER_ISSUE_PER_DAY} runs today.`);
  const { records } = parseIncidentIssue(body);
  if (!records.length) return log(`#${n}: skipped, no incident lines.`);

  const work = await mkdtemp(join(tmpdir(), 'incident-ladder-'));
  try {
    const copy = join(work, 'qa');
    const meta = join(work, 'meta');
    await mkdir(copy);
    await mkdir(meta, { mode: 0o700 });
    const tar = join(work, 'qa.tar');
    await run('git', ['archive', '--format=tar', `--output=${tar}`, QA_REF, 'src', 'docs', 'test', 'AGENTS.md', 'package.json'], { cwd: ROOT });
    await run('tar', ['-x', '-f', tar, '-C', copy]);
    await rm(tar, { force: true });
    await rm(join(copy, 'test', 'fixtures'), { recursive: true, force: true });
    const settingsFile = join(meta, 'settings.json');
    const settings = withHomeDeny(jobSettings({ stephenHome: join(homedir(), '.stephen'), stephenRepo: ROOT }));
    await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });

    const fileOk = (p) => {
      try {
        return lstatSync(join(copy, p)).isFile();
      } catch {
        return false;
      }
    };
    const lines = l1Lines(records);
    const grep = [];
    for (const word of codeWords(records)) {
      try {
        grep.push(await run('git', ['grep', '-n', '-m', '5', '-F', '-e', word, QA_REF, '--', 'src'], { cwd: ROOT }));
      } catch {
        // No match is not an error.
      }
    }
    const codeText = excerpts(grep.join(''));

    const trail = [];
    let draft = await runL1(lines, codeText, fileOk);
    trail.push(draft ? 'L1 draft' : 'L1 none');
    let level = 1;
    let last = draft;
    let shown = draft;
    let final = null;
    for (;;) {
      const next = nextLevel(level, last, budget.used >= CLAUDE_RUNS_PER_DAY);
      if (next === 5) break;
      level = next;
      budget.used++;
      last = await runClaude(level, lines, last ?? draft, copy, settingsFile, fileOk);
      trail.push(`L${level} ${last ? last.confidence : 'failed'}`);
      if (last) shown = last;
      if (resolves(level, last)) {
        final = last;
        break;
      }
    }
    const resolved = final !== null;
    if (!resolved) trail.push('L5');

    const marker = markerFor(hash);
    const comment = findingsComment(resolved ? final : shown, marker, trail, resolved);
    if (DRY) {
      log(`#${n}: dry run, would post:\n${comment}`);
      if (!resolved) log(`#${n}: dry run, would add label needs-cris and post the #${INBOX_ISSUE} line.`);
      return;
    }
    // The label goes first: if it fails, nothing is posted, so the marker is never written for a run that did not finish.
    if (!resolved) await run('gh', ['issue', 'edit', String(n), '--repo', REPO, '--add-label', 'needs-cris']);
    const commentFile = join(work, 'comment.md');
    await writeFile(commentFile, `${comment}\n`);
    await run('gh', ['issue', 'comment', String(n), '--repo', REPO, '--body-file', commentFile]);
    if (!resolved) {
      const inboxFile = join(work, 'inbox.md');
      await writeFile(inboxFile, `${inboxLine(n, 5, shown ? shown.confidence : 'none')}\n`);
      await run('gh', ['issue', 'comment', String(INBOX_ISSUE), '--repo', REPO, '--body-file', inboxFile]);
    }
    log(`#${n}: posted, trail ${trail.join(', ')}.`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Every page of a GitHub REST list (100 per page). */
async function listAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await ghJson([`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`]);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

async function main() {
  const today = dayUtc(new Date());
  // Open and closed incident issues touched today: the daily cap counts Claude runs on all of them.
  // The author check comes first: a body from any other id is never read.
  const touched = (await listAll(`repos/${REPO}/issues?labels=incident&state=all&since=${today}T00:00:00Z`)).filter(
    (i) => !i.pull_request && ALLOWED_AUTHOR_IDS.includes(i.user?.id),
  );
  const mine = touched.filter((i) => i.state === 'open');
  if (!mine.length) return log('No open incident issues from an allowed author.');
  if (!existsSync(join(ROOT, 'dist', 'telemetry', 'incident-ladder.js'))) throw new Error('Run npm run build first (dist/ is missing).');
  await run('git', ['fetch', '--quiet', 'origin', 'qa'], { cwd: ROOT });

  const commentsOf = new Map();
  for (const i of touched) commentsOf.set(i.number, await listAll(`repos/${REPO}/issues/${i.number}/comments`));
  const budget = { used: claudeRunsToday([...commentsOf.values()].flat(), today) };
  for (const i of mine) {
    try {
      await handleIssue(i, commentsOf.get(i.number), budget, today);
    } catch (e) {
      log(`#${i.number}: failed, ${oneLine(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(`incident-ladder: ${oneLine(e)}`);
  process.exit(1);
});
