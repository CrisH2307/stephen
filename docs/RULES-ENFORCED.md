# Which check enforces each rule

Each rule in `AGENTS.md`, and what stops a PR that breaks it today. "Prose only" means nothing checks it: an
agent or a reviewer has to notice. Those rows are the queue for new checks (a rule with no enforcer drifts).
Checked against the repo and its GitHub rulesets on 2026-11-26. When you add a check, change its row here.

| Rule | Enforced by | Notes |
|---|---|---|
| PRs target `qa`; only the release PR targets `main` | Prose only | Nothing stops a PR opened against `main`. |
| Only Cris merges into `main` | Ruleset `production` (a PR is required, no force-push, no delete) | The ruleset cannot tell who merges: every agent uses Cris's login. |
| Never force-push `qa` or `main` | Rulesets `qa` and `production` (no non-fast-forward, no delete) | Branches of open PRs are not covered. |
| Never push straight to `qa` | Prose only | The `qa` ruleset requires checks, not a PR. |
| `linux` and `macos` green before a merge into `qa` | Ruleset `qa` (required checks `linux`, `macos`) | |
| Safety paths need `[DEV REVIEW]` in the title | `safety-paths` CI check (`scripts/safety-paths.mjs`, `test/checks/safety-paths.test.ts`) | The check is not a required check in the `qa` ruleset: a red one does not block the merge button. |
| An independent review for safety paths | Prose only | The tag is checked, the review is not. |
| Commits authored and committed as Cris on the noreply email | `pr-rules` CI check (`scripts/pr-rules.mjs`, `test/checks/pr-rules.test.ts`) | PRs into `qa` only. Not a required check. |
| No AI author, no Co-Authored-By, no footer | Prose only | |
| No em dashes or en dashes | `pr-rules` CI check, on added lines | PRs into `qa` only. Skips the lookalike tables, `test/safety/` and `test/fixtures/`. Not a required check. |
| No secrets | GitGuardian Security Checks on each PR | |
| No new dependency without asking | `pr-rules` CI check: a new name in `package.json` needs `[DEV REVIEW]` | The tag is checked, the asking is not. Not a required check. |
| Workflows: pinned actions, no event text in `run:`, read-only permissions, no risky triggers | `test/checks/workflow-rules.test.ts` | |
| One test suite at a time | The lock in `test/global-setup.ts` (`test/helpers/suite-lock.ts`) | |
| Fix flaky tests at the cause, no retries | Prose only | No retry option in the vitest config. |
| The model never writes memory, timers or jobs | `test/memory/boundary.test.ts`: nothing Claude can reach imports `src/memory/`, `src/timers/` or `src/jobs/`, and no tool is named like a memory or job tool | The file is named for memory but covers all three. |
| Replay clips never reach the model | `test/replay/boundary.test.ts` | |
| Third-party text is data, never instructions | Tests in `test/safety/` | Partly: no single check covers every path. |
| Allow and Deny are clicks only | Tests in `test/safety/` and `test/helper/` | |
| Checks before a PR (build, typecheck, full suite) | `linux` and `macos` CI | |
| Small commits, one PR per task | Prose only | |
| Cheapest model with a precise spec; hand over at 50% | Prose only | A team rule, not a code rule. |
