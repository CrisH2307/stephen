# Release checklist: `qa` to `main`

**Status:** Proposed 2026-11-16 by the review lane. It takes effect when the dev lane accepts it on tracker #10.
Until then `docs/BRANCHING.md` stays the rule as written. This file adds detail to step 5 of that flow; it changes
nothing about who merges.

## Who does what

| Step | Who |
|---|---|
| Prepare the release (everything in "Before the release PR" and "The release PR") | Review lane |
| Say what must not ship yet | Dev lane, on tracker #10 |
| Run the hands checks of the batch on the Mac | Owner |
| Merge the release PR into `main` | **Owner only.** No agent pushes to `main` or merges the release PR |
| Merge `main` back into `qa` after the release | Review lane opens the PR, owner merges |

## Before the release PR

1. **Nothing is half done on `qa`.** No open PR that another merged PR depends on. Open PRs are listed in the
   release PR as "not in this release".
2. **Every merged PR in the batch was reviewed** by someone who did not write it (a review doc such as
   `docs/REVIEW-10A.md`, or a review comment on the PR). A PR with no review is named in the release PR.
3. **No open High finding, and every open Medium is listed** with its issue (`docs/research/FINDINGS-LEDGER.md`).
   The owner decides whether an open Medium blocks the release.
4. **Automated checks on `qa` at the exact commit to release**, run alone on the machine (one suite at a time,
   issue #109): `npm run build`, `npm run typecheck`, `npx vitest run`. A red run is rerun by test name once; both
   results go into the release PR. Zero failed in the final result. Once CI rollout step 6 is accepted
   (`docs/CI-CD-PROPOSAL.md`, PR #156), this step becomes "CI green on the release commit"; steps 5 to 8 stay local.
4b. **Inject eval on the release commit, on the owner's Mac:** `node dist/cli.js eval --only inject`. It runs the
   prompt-injection cases (7 today: a page or a message tries to make Stephen do something else), one Claude run each on
   your plan. The last lines say `One-shot eval: N/M passed` and give the report file. Anything below M/M blocks the
   release. Put the score and the run's cost into the release PR's number sheet (see `docs/RELEASE-PLAN.md`
   section 4). The cost is the sum of `costUsd` in the report file:
   `node -e "const r=require(process.argv[1]);console.log(r.results.reduce((s,x)=>s+(x.costUsd||0),0).toFixed(2))" <report file>`.
4c. **Claude Code's error wording (R5 markers):** `claude --version` on the owner's Mac. The failure markers in
   `src/lib/claude-failure.ts` were read from Claude Code 2.1.316 to 2.1.319 (`TESTED_CLAUDE_MIN` and `TESTED_CLAUDE_MAX`
   in `src/voice/claude.ts`). If the installed version is newer, check its error wording for the six failures (missing,
   signed out, plan limit, busy, offline, other), update the markers and the range if it changed, and run
   `npx vitest run test/voice/claude-errors.test.ts test/jobs/runner.test.ts`. A wording that no marker matches is not a
   crash: Stephen then says a generic failure line instead of the plain reason. That test uses a fake claude, so it checks the markers, not the real CLI.
5. **Swift compiles:** `npx vitest run test/helper` passes on the Mac.
6. **`node dist/cli.js mac-checks`** on the owner's Mac: no FAIL line.
7. **`node dist/cli.js doctor`**: no problem that blocks voice.
8. **The owner's hands checks:** the batch's section of `docs/MAC-TEST-PLAN.md`. Every box ticked, or the fail is
   filed and the owner says in the release PR that it does not block.
9. **No secrets:** `git diff origin/main..origin/qa` has no key, token or `.env` content (search before the PR).

## The release PR

- Title `[release] qa → main, batch <date>`. Base `main`, head `qa`. It is the only PR whose base is `main`.
- Body, in this order: what is in it (PR list by area), what is not in it (open PRs), review status, open findings,
  the test results of steps 4 to 8 with the commit id, what the owner should watch for after updating, and how to go
  back (below).
- Merged with a merge commit, by the owner.
- **`qa` is frozen while the release PR is open.** The release PR's head is `qa` itself, so anything merged into
  `qa` after the tests would join the release untested. No PR is merged into `qa` until the release is merged. If
  something urgent must land, close the release PR, merge it, and start the release again from step 4.

## After the release

1. Open a PR that merges `main` into `qa`, so `qa` starts the next batch equal to `main`.
2. On the Mac: `git checkout main && git pull && npm install && npm run build && node dist/cli.js install-helper`,
   then the Input Monitoring steps of test plan 0.2 **only if `install-helper` rebuilt the helper** (it prints
   "Nothing changed" when it did not, #135). Then quit and restart Stephen so the new build runs, then
   `node dist/cli.js mac-checks`.
3. Close the issues the release fixes, and set their ledger rows to `closed` with the release PR number.
4. One line on tracker #10: the release PR, the commit on `main`, and the date.

## Going back

If the release is bad: on the Mac, check out the previous `main` commit (it is in the last tracker line), then
`npm install && npm run build && node dist/cli.js install-helper`, the Input Monitoring steps of test plan 0.2 if
`install-helper` rebuilt the helper, restart Stephen, and `node dist/cli.js mac-checks`. The old commit changes the
Swift helper too: without these steps F5 can stop working after a rollback. Then the fix goes through `qa` like any other change, or the owner reverts the release merge on GitHub.
No agent force-pushes `main`.

## Not part of a release

Signing, notarizing or distributing the app (plan decision U7, later), publishing a web page, and anything that
needs the owner's Mac permissions.
