# CI and CD for Stephen: proposal

**Status:** Proposed 2026-11-17 by the review lane, at the owner's request. **Nothing is enabled until the dev team
accepts it** on tracker #10, step by step (section 9). This PR adds this document only. It adds no
`.github/workflows/` file: in a public repository a workflow runs as soon as it is merged, so turning CI on is the dev
team's decision. The workflow below is ready to copy; step 1 of the rollout is the PR that adds it.

The owner's request (2026-11-17), in short: when CI or CD fails, the failure must come back to the agents
automatically, so they investigate; and the setup must be secure, fault tolerant, "load balanced" and prove the code
works, because the code is now big.

GitHub facts below were read on 2026-11-17 from the pages listed in section 11. Where a page did not answer a
question, this document says so instead of guessing.

## Contents
1. Today
2. CI on every PR
3. Getting failures back to an agent automatically
4. CD: what "deploy" means for Stephen
5. Security
6. Fault tolerance
7. "Load balancing"
8. What CI proves, and what it cannot
9. Rollout plan
10. Decisions
11. Sources

## 1. Today

There is no CI. The repository has no `.github/` folder, Actions is allowed for all actions with no SHA pinning
required, `main` and `qa` have no branch protection, and the one ruleset (`production`: no deletion, no force-push) is
disabled. Secret scanning, push protection and Dependabot security updates are all reported "disabled" by the GitHub
API for this repository. Every check is a local run by an agent on the owner's Mac: `npm run build`,
`npm run typecheck`, then the full suite (`npx vitest run`, about 3,360 tests in 165 files, about 5 minutes), and the
result is pasted into the PR. The suite was flaky under CPU load (#109): the measured cause was fixed sleeps in
`src/eval/clicks.ts`, fixed in #131, which also added a lock so only one suite runs per machine
(`test/global-setup.ts`). Some tests only do their full work on a Mac (Swift app compile, a real Chrome at the Mac
path), and the real-model checks need the owner's Claude login. The only Linux run so far (Docker
`node:24-bookworm` on the Mac, arm64, #121) needed `lsof` and `procps` and failed every browser test.

## 2. CI on every PR

### What runs where

I sorted the 165 test files by what they need (grep for `runIf`, `skipIf`, `process.platform`, `swiftc`, Chrome and
macOS tools, 2026-11-17 on `qa` at `aa75112`). The result changes the shape the owner first suggested: **the Linux
runner can run almost the whole suite, not only the unit tests.**

| Group | Files | Needs | Linux x64 | macOS |
|---|---|---|---|---|
| Plain unit tests | about 140 | Node only. macOS tools (`osascript`, `security`, `afplay`) are faked through injected `exec` and `platform: 'darwin'` options, not called | yes | yes |
| Browser integration (`test/page/*.int`, `test/drivers/*.int`, `test/e2e/*`, `test/eval/clicks.int`, `test/selftest/selftest.int`, `test/helpers/smoke.int`) | 14 | A Chromium. `test/helpers/chromium.ts` uses `@sparticuz/chromium` (a bundled x64 Linux build) on Linux and Google Chrome at `/Applications/Google Chrome.app` on a Mac | yes, expected (see note) | yes, Chrome is on the image |
| Zen tests | `test/e2e/zen-attach.int`, `test/drivers/bidi.int` | No real Zen: a fake "zen" (`test/helpers/fake-zen.ts`) and Chromium over WebDriver BiDi | yes | yes |
| Swift | `test/helper/swift.int` | `swiftc`. Compiles the Swift core anywhere; `it.runIf(darwin)` compiles the full macOS app | core only, if `swiftc` is present | yes, full app |
| Voice models | `test/voice/*.int`, `test/app/listen.int`, `test/jobs/finish.int`, `keywords`, `index` | Downloads speech models (sherpa-onnx releases on github.com) into `~/.cache/stephen-voice-test`. **Skips silently** if the download fails | yes, with a cache | yes, with a cache |
| Built CLI | `instance`, `command-id`, `tool-log`, `jobs/manager`, three int files | `dist/cli.js`. Several `skipIf(!existsSync(cli))`: they **skip silently** without a build | yes, build first | yes, build first |
| `process-cwd` | `test/lib/process-cwd` | `lsof`, `ps` (Linux slack fixed in #132) | yes | yes |
| Real Claude | `test/jobs/real-claude`, `test/voice/warm-claude-real` | The owner's Claude login. Opt-in, `STEPHEN_REAL_CLAUDE=1` | skipped (correct) | skipped (correct) |

Note on browsers: the #121 run failed the browser tests because the Mac's Docker is arm64 and `@sparticuz/chromium`
ships an x64 build only. GitHub's `ubuntu-24.04` runner is x64, so these tests are **expected** to pass there. This is
not measured yet; step 1 of the rollout measures it.

No test needs Zen itself, so nothing is skipped "because Zen is missing". `zen-attach` skips one test when a real Zen
process is running, which never happens on a runner.

### Proposed jobs

- **`linux`** on `ubuntu-24.04` (4 vCPU, 16 GB, free for a public repo): `npm ci`, build, typecheck, the full suite.
  This is the fast check and the first one to make required.
- **`macos`** on `macos-15` (arm64, 3 vCPU, 7 GB, free for a public repo, at most 5 macOS jobs at once on the Free
  plan): the same steps, plus a check that `swiftc` exists, so the Swift tests can never skip silently. This is the
  machine the product runs on, and the only place the full Swift app compiles.
- **`macos-14`** on `macos-14`: the same steps on the oldest macOS Stephen supports (macOS 14, the helper's
  `LSMinimumSystemVersion`), so code that needs a newer macOS fails here first.

Why the full suite on both instead of "unit on Linux, integration on macOS": the suite is 5 minutes, both runners are
free for a public repo, and splitting would leave each platform's half untested on the other. If macOS queue time
becomes a problem, the macOS job can drop to `test/helper` plus the `*.int` files (section 6).

Why `ubuntu-24.04` and `macos-15` instead of `-latest`: `-latest` moves (today `macos-latest` is macOS 26), so a red
run could come from an image change, not from our code. We move the label on purpose, in its own PR.

Rules for both jobs:
- **One test process per runner.** The suite already runs files one at a time (`fileParallelism: false`) and the
  #131 lock stops a second suite. No `--shard` and no matrix inside a job.
- **Build before tests**, so the `dist/cli.js` tests run instead of skipping.
- **Voice models cached** with `actions/cache`, keyed on the files that pin the model hashes
  (`src/voice/models.ts`, `src/voice/tts/kokoro.ts`). A cache miss downloads again; it never fails the job.
- **Timeouts:** `timeout-minutes: 25` for `linux`, `30` for `macos` (the default is 360).
- **Superseded runs cancelled:** a new push to the same PR cancels the old run. Each push to `qa` gets its own
  concurrency group, so every merge commit gets a result (a shared group would cancel a waiting `qa` run).
- **Skipped tests are counted** in the job summary. A jump in skipped tests means a silent skip (models or build).

### The workflow (copy into `.github/workflows/ci.yml` in rollout step 1)

Actions are pinned to full commit SHAs, read from each action's own repository on 2026-11-17. Refresh them when
adopting.

```yaml
name: ci

on:
  pull_request:
    branches: [qa, main]
  push:
    branches: [qa]
  workflow_dispatch:

# Read-only by default. Only the report job asks for more, and only for what it writes.
permissions:
  contents: read

concurrency:
  # PRs share a group per PR (a new push cancels the old run). Each qa push gets its own group, because GitHub
  # cancels a pending run in the same group even with cancel-in-progress false.
  group: ci-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: linux
            runner: ubuntu-24.04
            timeout: 25
          - os: macos
            runner: macos-15
            timeout: 30
    name: ${{ matrix.os }}
    runs-on: ${{ matrix.runner }}
    timeout-minutes: ${{ matrix.timeout }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          cache: npm
      - name: Linux tools the tests need
        if: matrix.os == 'linux'
        run: |
          command -v lsof >/dev/null && command -v ps >/dev/null || \
            { sudo apt-get update && sudo apt-get install -y lsof procps; }
      - name: Swift must exist on macOS (the Swift tests skip without it)
        if: matrix.os == 'macos'
        run: swiftc --version
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: ~/.cache/stephen-voice-test
          key: voice-models-${{ runner.os }}-${{ hashFiles('src/voice/models.ts', 'src/voice/tts/kokoro.ts') }}
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - name: Tests
        run: npx vitest run --reporter=default --reporter=json --outputFile=vitest.json
      - name: Failure report
        if: always()
        run: |
          node scripts/ci-report.mjs vitest.json > report-${{ matrix.os }}.md
          cat report-${{ matrix.os }}.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        if: always()
        with:
          name: report-${{ matrix.os }}
          path: report-${{ matrix.os }}.md
          retention-days: 7

  # Runs no repository code: it only posts the two report files the test jobs wrote.
  report:
    needs: test
    if: failure()
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: write
      issues: write
    env:
      GH_TOKEN: ${{ github.token }}
      GH_REPO: ${{ github.repository }}
      RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
      SHA: ${{ github.event.pull_request.head.sha || github.sha }}
      PR: ${{ github.event.pull_request.number }}
      SAME_REPO: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          pattern: report-*
          merge-multiple: true
      - name: Build the message
        run: |
          { echo "CI failed on \`$SHA\`. Run: $RUN_URL"; echo
            cat report-*.md 2>/dev/null || echo "No report file: the jobs stopped before the tests ran."
            echo; echo "Flaky? Rerun the file alone, record both results on #109. Do not just press Re-run."
          } > message.md
      - name: Comment on the PR (branches of this repository only)
        if: github.event_name == 'pull_request' && env.SAME_REPO == 'true' && github.actor != 'dependabot[bot]'
        run: gh pr comment "$PR" --body-file message.md
      - name: Open or update the ci-failure issue (qa only)
        if: github.event_name == 'push'
        run: |
          n=$(gh issue list --label ci-failure --state open --json number --jq '.[0].number')
          if [ -n "$n" ]; then gh issue comment "$n" --body-file message.md
          else gh issue create --title "CI failed on qa" --label ci-failure --body-file message.md; fi
```

`scripts/ci-report.mjs` (added in rollout step 2; until then step 1 uses only the job summary):

```js
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
```

The field names (`testResults`, `assertionResults`, `fullName`, `failureMessages`, `numPendingTests`) were checked
against a real `vitest run --reporter=json` of this repository on 2026-11-17.

## 3. Getting failures back to an agent automatically

This is the heart of the owner's request. GitHub cannot start a Claude session by itself. A failure reaches an agent
only if a session is watching, or when the next session reads what was written down. So there are two paths, a fast
one and a safety net, plus facts in the failure message so the agent starts from evidence.

**(a) Fast path: the Claude app watches the PR.** The Claude desktop app can watch a PR's checks and wake the session
that bound the PR when a check fails ("Auto-fix", through the app's PR tools `bind_pr`, `get_status`,
`set_monitor`). **Proposed rule for both lanes:** the session that opens a PR binds it and turns Auto-fix on at once.
When CI fails, that session wakes with the failure, investigates and pushes a fix to the same branch. It never merges.
It stays bound until the owner merges or closes the PR. A session that hands over (context full) names its bound PRs
in the hand-over brief, and the new session binds them again.

**(b) Facts in the PR.** On a failed run the `report` job posts one comment on the PR: the commit, the run link, the
failing test names and the first assertion line of each (at most 20), and the skipped count. No log dump, no
environment, no stack trace. One comment per failed run; cancelled runs post nothing. Only for PRs from branches of
this repository: a fork PR and a Dependabot PR get a read-only token from GitHub, so their report stays in the run's
summary page. Test names and messages are put in code spans, so a test title cannot @mention anyone.

**(c) Safety net for `qa`.** After a merge, `qa` runs CI on the push. If it fails, the `report` job adds a comment to
the open issue labelled `ci-failure`, or opens one ("CI failed on qa"). **Proposed rule:** the review lane checks for
an open `ci-failure` issue at the start of every session, before other work, and says on #10 who takes it. The issue
is closed by the PR that makes `qa` green again (section 6, "A broken `qa`").

**(d) What cannot happen.** No session is started by GitHub. If no session is bound to a PR and nobody opens a
session, a failure waits in the PR comment or the `ci-failure` issue until someone does. That is why (a) is the fast
path and (c) is the net.

**A flaky failure is never "fixed" by a retry.** The #109 rule stands: rerun the failing file alone, record both
results in the PR, and open or update #109 with the test name and the assertion text. The comment in (b) says this.
No `retry:` in vitest, no automatic re-run in the workflow.

## 4. CD: what "deploy" means for Stephen

Stephen has no server, so there is nothing to deploy to. "Deployment" is two human steps: the release PR from `qa` to
`main` (`docs/BRANCHING.md` step 5, detailed in `docs/RELEASE-CHECKLIST.md`, PR #127), and the owner rebuilding on
the Mac (`git pull && npm install && npm run build && node dist/cli.js install-helper`). Proposed:

1. **CI green on the exact `qa` commit** before the release PR is opened. The release PR's own checks run too (the
   workflow runs on PRs to `main`). This replaces checklist step 4's local full-suite run, but not steps 5 to 8 (Swift
   on the owner's Mac, `mac-checks`, `doctor`, the hands checks).
2. **`main` and `qa` protected** (rollout step 4): a PR is required, the `linux` and `macos` checks are required, no
   force-push, no deletion. **No required approving review**: every PR here is authored under the owner's account,
   and GitHub does not let an author approve their own PR, so a required review would block every merge.
3. **No bypass, including for the owner's account.** Agents push with the owner's GitHub login, so GitHub cannot tell
   an agent from the owner. A bypass for the owner is a bypass for every agent. The owner still merges:
   PRs whose checks are green are merged as today. In an emergency the owner can switch the rule off in Settings for a moment; that is a
   deliberate human step, and it is written on #10 when it happens. This guards against mistakes, not against an
   agent acting on purpose: the same login can switch the ruleset off. The owner can check the repository's audit
   log for ruleset changes.
4. **No build artifact on the release PR.** The owner builds on the Mac anyway, and a Linux `dist/` is not what runs.
   Add one only if a second machine ever installs Stephen without building (decision U7).
5. **No automatic merge into `main`, ever.** No auto-merge on any PR, no bot that merges.

## 5. Security

The repository is public, so the workflow is code that strangers can read and try to abuse.

- **Least privilege.** `permissions: contents: read` for the whole workflow. Only the `report` job gets
  `pull-requests: write` and `issues: write`, and it runs no code from the repository: it downloads the two report
  files and posts them.
- **Actions pinned to full commit SHAs**, with the version in a comment. Then turn on the repository setting "Require
  actions to be pinned to a full-length commit SHA" (Settings, Actions, General). Dependabot updates the pins
  (below).
- **No `pull_request_target`.** It runs with write access and secrets in the base repository, and checking out the PR
  code there runs a stranger's code with those rights. This workflow uses `pull_request` only. If fork PRs ever need a
  comment, the GitHub-documented pattern is a separate `workflow_run` workflow that treats the artifact as untrusted
  data; not needed while all PRs come from this repository's branches.
- **No PR-controlled text inside `run:`.** Branch names and PR titles can contain shell code. The workflow passes
  values through `env:` and never writes `${{ github.event.pull_request.title }}` or a branch name into a script.
- **`persist-credentials: false`** on checkout, so the token is not left in `.git/config` for the test code to read.
- **Fork PR approval.** GitHub requires approval before a first-time contributor's workflow runs (the default). Set
  the stricter option, "Require approval for all external contributors", in Settings, Actions, General.
- **No secrets in CI at all.** The workflow references no `secrets.*`. Tests must never need Gmail, Notion, Canvas,
  ElevenLabs or Claude credentials. Checked 2026-11-17: the only environment reads in `test/` are test switches
  (`STEPHEN_REAL_CLAUDE`, `STEPHEN_TEST_CHROME`, `STEPHEN_TEST_SWIFTC`, `STEPHEN_VOICE_SKIP_MODELS`,
  `STEPHEN_VOICE_TEST_MODELS`, `STEPHEN_HOME`, `STEPHEN_CONFIG`, `BROWSER_HUB_CONFIG`) and `FAKE_*` values for the fake
  `claude`. Account tests use injected fake keychains and fake tokens; real-Claude tests are opt-in and skip.
  **Rule for new tests:** a test that needs a real credential is opt-in by an environment switch and skips without
  it, like `test/jobs/real-claude.test.ts`.
- **Secret scanning and push protection on.** GitHub's documentation says they are available free for public
  repositories; the API reports both "disabled" for this repository today, so the owner turns them on in Settings,
  Code security.
- **Dependabot.** Alerts on. Version updates for `npm` and `github-actions` weekly, with `target-branch: qa`, so the
  PRs follow the normal flow. Dependabot *security* update PRs always target the default branch (`main`), which breaks
  the rule that only the release PR targets `main`; so leave automatic security-update PRs off and act on the alerts
  through `qa`. Proposed `.github/dependabot.yml` (rollout step 5):
  ```yaml
  version: 2
  updates:
    - package-ecosystem: npm
      directory: /
      target-branch: qa
      schedule: { interval: weekly }
      open-pull-requests-limit: 5
    - package-ecosystem: github-actions
      directory: /
      target-branch: qa
      schedule: { interval: weekly }
  ```
- **`npm ci` only**, from `package-lock.json`. Never `npm install` in CI. The lockfile already lists the Linux and
  macOS builds of `sherpa-onnx`.

**Found in the repository today (reported, not changed):**
1. Fake tokens shaped like real ones in tests (`ghp_…` in `test/jobs/finish.test.ts:209`, `sk-ant-api03-…` in
   `test/jobs/fake-claude-job.mjs:60`, `ntn_…` and `ya29.…` in the account tests). They are fake on purpose (the tests
   check that they never leak). Once secret scanning is on, expect alerts on them; close those as "used in tests".
2. Test fixtures with the owner's first name in paths (`/Users/cris/...` in `test/app/server.test.ts`,
   `test/app/cli.test.ts`, `test/voice/transcripts.test.ts`, `test/fixtures/app-protocol-v1.jsonl`), the address
   `cris@gmail.com` in `test/accounts/gmail-oauth.test.ts`, and a city ("Toronto, ON") in
   `test/fixtures/app-protocol-v1.jsonl`. They are already public. CI does not make this worse (the report prints only
   test names and assertion lines), but a failing assertion could print them in a PR comment. **Owner decision:**
   replace them with neutral values (`/Users/owner`, `owner@example.com`, a made-up city) in a small dev-lane PR, or
   leave them.
3. The ElevenLabs voice id in `src/voice/tts/config.ts` is a public voice id, not a secret. No action.

## 6. Fault tolerance

| What fails | What happens | Who acts |
|---|---|---|
| A flaky test | The run is red. No retry. The #109 rule: rerun the file alone, record both results, update #109. A test may be quarantined (`it.skip` with the issue number in the reason) only with an open issue per test and an expiry date in that issue; past the date it is fixed or deleted | The PR's bound session; the review lane for `qa` |
| A GitHub runner outage or a stuck job | The job times out (25 or 30 minutes). Re-run it by hand once the status page is green. Nothing merges meanwhile, because the checks are required | Whoever owns the PR |
| macOS queue time | Free plan: at most 5 macOS jobs at once. With two lanes this is enough. If queues grow, cancel-in-progress already drops old runs; next, drop the macOS job to `test/helper` and `*.int` only | Dev team |
| Cache miss (npm or voice models) | Slower run (download again), not a failure. A failed model download makes those tests skip, which shows as a higher skipped count in the report | Reader of the report |
| `npm ci` fails (registry down) | Red before the tests; the report says "no test result". Re-run later | PR owner |
| A broken `qa` (red after a merge) | The `ci-failure` issue opens. **Rule:** if the cause is not found within one working session, the review lane opens a PR that reverts the merge that broke it (`git revert -m 1 <merge>`), the owner merges it, and the fix comes back as a new PR. Nobody pushes to `qa` | Review lane opens the revert, owner merges |
| A red `main` | Should not happen (release only from a green `qa`). If it does: the "Going back" section of `docs/RELEASE-CHECKLIST.md` | Owner |

Every job has `timeout-minutes`. Nothing in the workflow merges, pushes or retries.

## 7. "Load balancing"

Stephen is a single-user app on one Mac, so there is no network traffic to balance. Here the word maps to two real
things:

1. **Spreading the test load across machines.** CI already splits it by platform (Linux and macOS jobs run in
   parallel on separate runners). Inside a job, `vitest --shard=1/2` could split further, but the suite is 5 minutes
   and runs files one at a time on purpose (browsers fight over CPU, #109). **Shard only if** a job takes over 15
   minutes, and only after measuring that two shards are faster than one.
2. **Not overloading the owner's Mac.** One suite per machine (the #131 lock). With CI on, agents no longer need a full
   local run for every PR: they run the files they touched, and CI runs the rest. The local full run stays for the
   release (`docs/RELEASE-CHECKLIST.md` step 4 until CI replaces it) and for #109 diagnosis.

Real load balancing matters only if Stephen becomes a hosted service with many users (plan decision U7, later). That
would need its own design: servers, health checks, more than one instance.

## 8. What CI proves, and what it cannot

CI proves: the code builds, types check, and about 3,360 automated tests pass on Linux and on macOS, including the
browser integration tests against a real Chromium, the safety gate tests, the memory and account boundary tests, and
the Swift compile.

CI cannot prove:
- **Anything that needs the owner's Mac permissions**: microphone, Input Monitoring, Accessibility, the real F5 key,
  the menu bar app, sound. These are the hands checks in `docs/MAC-TEST-PLAN.md`.
- **Swift UI behaviour**: CI compiles the app; nobody clicks it.
- **The real model**: `STEPHEN_REAL_CLAUDE=1` tests and the eval with a real Claude need the owner's login. They stay
  local.
- **The owner's real Zen and real accounts**.

So `node dist/cli.js mac-checks`, `doctor` and the batch's hands checks **stay a local release gate** on the owner's
Mac (`docs/RELEASE-CHECKLIST.md` steps 5 to 8). CI replaces only the "full suite passed" line.

## 9. Rollout plan

Each step is one small PR or one settings change. The dev team accepts, changes or rejects each on #10. Each can be
undone on its own.

| Step | What | Accepted when | Rollback |
|---|---|---|---|
| 1. Linux job | `.github/workflows/ci.yml` with the `linux` job only, without the "Failure report" and upload steps and without the `report` job (failures are read in the run log) | 3 runs in a row green on PRs, the browser tests pass on Linux, skipped count written down as the baseline | Delete the workflow file (one PR) |
| 2. Failure report | `scripts/ci-report.mjs` and the `report` job; create the `ci-failure` label; the "bind and Auto-fix" rule in both lanes' instructions | A deliberately failing test on a throwaway PR produces one correct comment; a red `qa` run opens the issue; a job forced past its timeout produces a report (or we record that it does not) | Remove the `report` job |
| 3. macOS job | Add the `macos` row to the matrix | 3 green runs; Swift full-app compile runs (not skipped); queue time under 10 minutes | Remove the row |
| 4. Protect `qa` and `main` | Ruleset (or branch protection) on both: PR required, `linux` and `macos` required, no force-push, no deletion, no bypass. The disabled `production` ruleset already has the last two rules | The owner merges one normal PR with green checks; a direct push to `qa` is refused | Set the ruleset to disabled |
| 5. Security settings | Secret scanning and push protection on; "require SHA pinning" on; "Require approval for all external contributors"; Dependabot alerts and `.github/dependabot.yml` | First Dependabot PR targets `qa`; scanning alerts reviewed | Turn each setting off |
| 6. Release uses CI | `docs/RELEASE-CHECKLIST.md` step 4 becomes "CI green on the release commit" | First release PR shows green checks | Revert the doc line |

Steps 1 to 3 are the dev team's code area (`.github/`, `scripts/`). Steps 4 and 5 are settings only the owner can
change. The review lane can write any of the PRs if the dev team prefers.

Not proposed: sharding, a test retry, a hosted Claude agent in GitHub Actions (it would need a Claude credential as a
repository secret in a public repository), automatic merge, a deployment workflow.

## 10. Decisions

For the owner:
1. **Turn on secret scanning and push protection now?** Recommended: yes, today. They are free and independent of
   the rest.
2. **Protect `qa` and `main` with no bypass, even for your account?** Recommended: yes (agents use your login, so a
   bypass for you is a bypass for them). You can still merge green PRs.
3. **Replace the fixture name, address and city with neutral values?** Recommended: yes, one small PR.

For the dev team (each on #10: accept, change or reject):
4. Rollout steps 1 to 6. Recommended: accept 1 to 3 now, 4 once step 3 has been green for a week, 5 with step 4,
   6 at the next release.
5. Full suite on both runners (recommended) or "unit on Linux, integration on macOS".
6. The "bind the PR and turn on Auto-fix" rule for every session that opens a PR. Recommended: yes.
7. The broken-`qa` revert rule (review lane opens the revert PR when the cause is not found within one session).
   Recommended: yes.
8. Who owns `.github/` after adoption. Recommended: the dev team, with the review lane reviewing every change to it.

## 11. Sources

GitHub documentation, all read on 2026-11-17 (the pages show no publication date unless noted):
- Runners, labels and sizes: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
  (public repos: Linux x64 4 vCPU and 16 GB; macOS arm64 3 vCPU and 7 GB; `ubuntu-latest` is 24.04, `macos-latest`
  is macOS 26).
- Cost: https://docs.github.com/en/billing/concepts/product-billing/github-actions (standard runners are free in
  public repositories).
- Limits: https://docs.github.com/en/actions/reference/limits (Free plan: 20 concurrent jobs, at most 5 macOS; 6
  hours per job; "subject to change").
- Workflow syntax (`timeout-minutes` default 360, `concurrency`, `cancel-in-progress` as an expression):
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- Fork PRs get no secrets and a read-only token; `pull_request_target` and `workflow_run`:
  https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- Secure use (SHA pinning, `pull_request_target`, `workflow_run`):
  https://docs.github.com/en/actions/reference/security/secure-use
- Actions settings (default token permissions, require SHA pinning, fork approval):
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
- Secret scanning and push protection for public repositories:
  https://docs.github.com/en/code-security/getting-started/github-security-features
- Dependabot `target-branch`, and security updates always on the default branch:
  https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- Protected branches (force-push and deletion blocked by default, admins exempt unless "Do not allow bypassing"):
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- Runner images: https://github.com/actions/runner-images (Ubuntu 24.04 image 20261111 has Google Chrome; macOS 26
  arm64 image 20261102 has Chrome and Xcode 26.6. `lsof` is not listed in the Ubuntu table, so the workflow installs
  it if missing. The macOS 15 image was not read; step 3 confirms `swiftc` with its own check).
- Action versions and SHAs: the latest release of `actions/checkout`, `setup-node`, `cache`, `upload-artifact`,
  `download-artifact`, read with the GitHub API.
- Vitest `--shard`: https://vitest.dev/guide/cli.html

Not answered by the pages read, and so not relied on: whether rulesets are documented for public repositories on the
Free plan (the rulesets page names Team and Enterprise; this repository already has a ruleset object, so step 4
confirms in Settings, and classic branch protection is the fallback); whether a job stopped by `timeout-minutes` counts as
failed or cancelled for `failure()` (rollout step 2 tests it).

From this repository, 2026-11-17: `gh api repos/CrisH2307/stephen` (security settings, rulesets, Actions
permissions), and the test inventory in section 2 on `qa` at `aa75112`.
