# Branches and releases

| Branch | Role | Who changes it |
|---|---|---|
| `main` | Production: what runs on the owner's Mac day to day. Only tested work lands here, through a release PR. | The owner, by merging the release PR |
| `qa` | Working (integration) branch: `main` plus every merged PR of the current batch. It is ahead of `main` on purpose. The owner builds this on the Mac and runs `docs/MAC-TEST-PLAN.md`. | The owner, by merging feature PRs |
| `feat/…`, `p1/…`, `ui/…`, `fix/…`, `docs/…` | One feature or fix each, one PR each, cut from `main` (or from the PR below it when stacked). | The agent |

## Flow
1. Work happens on a feature branch cut from `main`. Its PR targets **`qa`** (or its parent branch when stacked). A
   feature PR never targets `main`, so the Merge button cannot put untested work on `main`.
2. The agent runs the full suite and the Swift compile on the branch and shows the result. The agent asks before a
   commit and does not push or merge; the owner pushes the branch and merges the PR into `qa`.
3. The owner tests `qa` on the Mac: `git checkout qa && git pull && npm install && npm run build && node dist/cli.js
   install-helper`, then the batch's MAC-TEST-PLAN section.
4. A failed check is fixed on its own feature branch (never on `qa` directly), with its own PR to `qa`, then retested.
5. When `qa` passes, one release PR `qa` → `main` (`[release] qa → main, batch <date>`, the PR list and the test
   result in the body) is merged with a merge commit by the owner. Then `main` is merged into `qa`, so `qa` starts the
   next batch equal to `main`. First release: #39 (2026-11-09).

## Rules
- Each change is reviewed in its own PR to `qa`; it reaches `main` only through the release PR of its batch.
- The only PR whose base is `main` is the release PR.
- `qa` only moves forward with merges; no force-push, so anyone on it can always `git pull`.
- Nothing is released from `qa` without the full suite passing there.
- Never push straight to `main`.
- Commit small: one small change per commit (a few files, one function or one fix), many small commits rather than one big one, a clear message on each. Still one branch and one PR per task.
- CI (both lanes): the session that opens a PR binds it in the Claude app (`bind_pr`) and turns Auto-fix on at once.
  When CI fails, that session investigates and prepares the fix, but asks Cris before a commit; Cris (or the app's
  commit button) pushes. Auto-fix never means auto-merge. The session stays bound until the PR is merged or closed. A
  hand-over brief names the bound PRs, and the new session binds them again. (`docs/CI-CD-PROPOSAL.md` section 3.)
- **Sibling cases (H1, #202).** A fix covers the reported case and its siblings. Before the fix PR, list the cases
  next to the reported one (other phrasings, the typed path and the voice path, the other browser, the other trust
  tier) and add a test for each one that applies. Why: about 1 in 3 fixes on `qa` in November repaired an earlier fix
  (`docs/research/PONYTAIL-AUDIT-2026-11.md`, "Bug history"). Example: the "remember" fixes #90, #122 and #137.
- **One day on `qa` (H4, #202).** A new feature stays on `qa` for at least one day before another PR builds on it,
  and before it goes into a release PR. Do not stack several fixes for the same feature on the day it lands without a
  review. Why: the replay feature and three fixes landed on one day (#169), and the Claude CLI contract needed two
  more fixes (#65, #123).
- **Mac click check for helper PRs (H2, #202).** A PR that changes `helper/` gets the two-minute click check in
  `docs/MAC-TEST-PLAN.md` ("Two-minute click check") before merge, and says so in the PR.

## History
- Until 2026-11-10 feature PRs targeted `main` and the agent merged branches into `qa`. PR #44 was merged straight to
  `main` that way, before `qa` had it; `main` was then merged into `qa` to bring them back in line. The flow above
  replaces it.
