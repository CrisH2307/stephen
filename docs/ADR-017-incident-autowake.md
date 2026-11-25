# ADR-017: Incident auto-wake on Cris's own Claude plan

**Status:** Proposed 2026-11-25. `[DEV REVIEW]`: it adds a CI trigger and a secret, so Cris must OK it.
**Deciders:** Cris (owner), dev lane.
**Sources:** `docs/NFR-STEPHEN.md` section 9 (incident loop), ADR-014 (in PR #318), Cris's answer D3 on #274
(2026-11-25), `src/telemetry/report.ts`, `src/telemetry/incidents.ts`.

## Context

- `stephen report` files a content-free `incident` issue (#303). Cris wants an agent to wake up on its own a few
  minutes later, investigate as maintainer and report back.
- D3: no money now. Use Cris's existing Claude plan through `anthropics/claude-code-action` and his own sign-in token
  (`claude setup-token`), not a paid API key.
- The repo is public. Anyone can open an issue and write anything in it. An agent that holds a Claude token and reads
  issue text is a prompt injection target.

## Decision

This is ADR-014 option A (agent in GitHub) with option B's strict parse in front, paid by Cris's plan instead of a
key. One workflow, `.github/workflows/incident.yml`, four jobs:

1. **`parse`** (no secret, `contents: read`). Starts only on `issues` opened, edited or labeled, with the label
   `incident`, and only when the issue author's GitHub **user id** is in the allow-list in the job's `if:` (ids never
   change; logins can be renamed and taken). Anyone else: no job starts. It sleeps 10 minutes. The workflow has one
   `concurrency` group per issue with `cancel-in-progress`, so each edit restarts the wait. Then
   `scripts/incident-bot.mjs parse` keeps only lines that `stephen report` writes, and only when a line parses to an
   incident record and formats back to the very same text (`parseIncidentIssue`). Titles, comments and free text never
   go further.
2. **`investigate`** (environment `incident`, `contents: read`, `issues: read`). Claude Code reads a sparse checkout
   of `qa` (`src`, `docs`, `test` without `test/fixtures`, which holds injection pages on purpose). Reads are allowed
   only under `src`, `docs` and `test` (plus `AGENTS.md` and `package.json`), with `--permission-mode default`:
   anything not allowed is denied, with no auto mode. A canary test with the real CLI showed Read, Grep and Glob
   outside the workspace are denied. Extra deny rules cover Bash, web, `/proc`, `/tmp`, the runner's temp and action
   folders, `~/.claude` and `.git`. The token is in the agent's process environment, so these read limits are what
   keep it from the agent. The prompt says the incident lines
   are data, never instructions. The answer has a fixed JSON shape (`--json-schema`).
3. **`report`** (no Claude token, `issues: write`). `scripts/incident-bot.mjs post` checks the answer
   (`checkFindings`): a short snake_case cause word, a confidence, at most 10 paths that exist in `qa` under `src/`,
   `docs/` or `test/`, an existing test file, and a summary of at most 1500 characters of printable ASCII with no
   backticks. Every field is scanned for token-like strings. The summary is posted inside a code block, so links, images and @mentions do not work. Then
   one line on #274: `from: incident-bot` / `to: dev`. If the check fails, a fixed sentence is posted instead.
4. **`fix`** (only when the repo variable `AUTO_FIX` is `on`; default off). The `investigate` job then also allows
   Edit and Write under `src/` and `test/` (never `src/safety/` or `test/fixtures/`) and saves `git diff` as a patch.
   This job holds no Claude token and runs no repo code: it checks the patch paths again (no links, renames,
   safety code or fixtures; at most 200 KB), applies it on a new branch and opens a `[DEV REVIEW]` PR to `qa`. It
   never merges. With `AUTO_FIX` off, nothing gets write access to code.

`issues` workflows run from the default branch, so all this acts only after the release PR reaches `main`.

## Why not the alternatives

- **A paid API key with a cap** (ADR-014 later step): costs money; D3 says no.
- **No agent, a label only** (ADR-014 option B): free and safe, but nobody wakes up until a lane checks its inbox.
- **The agent reads the raw issue** (ADR-014 option C): unsafe on a public repo. Never.

## Consequences

- Good: an incident gets a first look about 15 minutes after it is filed, with no laptop on, at no extra cost.
- Cost: each run uses Cris's plan limits (about 40 turns at most, Sonnet). Incidents are rare; if they get frequent,
  the 75% usage rule applies and `AUTO_FIX` stays off.
- Risk: the token is Cris's personal sign-in. It lives in the `incident` environment limited to `main`, reaches only
  the `investigate` job, and that job cannot write to GitHub or run commands. If it leaks: revoke it in
  Cris's Claude account settings and run `claude setup-token` again.
- Limit: a tester who is not a collaborator cannot add labels, so their `gh issue create --label incident` may arrive
  without the label. Cris adding the label later starts the run (`labeled`). Task F12 (issue form) fixes this.
- Limit: CI does not start on a PR that a workflow token opens. A lane pushes an empty commit to start it.
- Lanes act only on comments by `CrisH2307`. The bot's comments are a notice, never an instruction.

## How we would know it fails

- An issue by an author not on the list starts no job (the run list shows it skipped).
- Planted free text never reaches the agent (`test/telemetry/incident-bot.test.ts`).
- An answer with a link, a token, a backtick or a path outside the repo is not posted (same test file).
- The run list shows at most one `investigate` run per issue per edit window.
