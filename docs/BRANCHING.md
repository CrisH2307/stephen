# Branches and releases

| Branch | Role | Who changes it |
|---|---|---|
| `main` | Production: what runs on the owner's Mac day to day. Only reviewed, Mac-tested PRs land here. | The owner, by merging PRs |
| `qa` | Test (integration) branch: `main` plus every open PR of the current batch, merged in merge order. The owner builds this on the Mac and runs `docs/MAC-TEST-PLAN.md`. | The agent, by merging branches into it |
| `p1/…`, `ui/…`, `fix/…`, `docs/…` | One feature or fix each, one PR each, cut from `main` (or from the PR below it when stacked). | The agent |

## Flow
1. Work happens on a feature branch and gets a PR to `main` (or to its parent branch when stacked).
2. When a batch is open, every PR branch is merged into `qa` in merge order. The full suite and the Swift compile
   run on `qa`, then it is pushed.
3. The owner tests `qa` on the Mac: `git checkout qa && npm install && npm run build && node dist/cli.js
   install-helper`, then the batch's MAC-TEST-PLAN section.
4. A failed check is fixed on its own feature branch (never on `qa` directly), carried down any stacked PRs, then
   merged into `qa` again and retested.
5. When `qa` passes, one release PR `qa` → `main` (`[release] qa → main, batch <date>`, the PR list and the test
   result in the body) is merged with a merge commit, by the owner or by the agent when the owner says so. The feature
   PRs then show as merged (base `main`) or are closed with a link to the release PR (stacked ones). Then `main` is
   merged into `qa`, so `qa` starts the next batch equal to `main`. First release: #39 (2026-11-09).

## Rules
- Each change is still reviewed in its own PR; it reaches `main` through the release PR of its batch.
- `qa` only moves forward with merges; no force-push, so anyone on it can always `git pull`.
- Nothing lands on `qa` without the full suite passing there.
- Never push straight to `main`.
