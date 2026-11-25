# ADR-014: Incident loop phases 2 and 3: an event workflow, a strict parser, a read-only agent, Cris's Auto-fix switch

**Status:** Proposed 2026-11-25. Adds a CI trigger and a secret, so Cris must OK it. Needs decision D3 (who pays).
**Cris, 2026-11-25 (D3):** no paid key. The agent runs through `claude-code-action` (pinned to a full SHA) with
Cris's own Claude sign-in token as a secret in the `incident` environment, which Cris adds himself. All the limits
below stay (allow-list, edit window, strict parser, path limits, output parser, Auto-fix off by default).
**Deciders:** Cris (owner), dev lane.
**Sources:** `docs/NFR-STEPHEN.md` section 9 (Cris's incident loop, 2026-11-23), `src/telemetry/incidents.ts`
(`INCIDENT_PARTS`, `INCIDENT_CODES`, `INCIDENT_STAGES`, `parseIncidentRecord`), `src/telemetry/report.ts`
(`formatReport`, label `incident`), `docs/CI-CD-PROPOSAL.md` section 5 (no secrets in CI so far, and why).

## Context

- Phase 1 is built (#303): a content-free incident file and `stephen report`, which opens an `incident` issue with the
  person's own `gh` after they type "y".
- Cris wants an on-call style loop: the agents get the report a few minutes after it is filed (after a short edit
  window), investigate, and a switch decides whether they may also open a fix.
- The repo is public. Anyone can open an issue and write anything in it. An agent that reads issue text and holds a
  Claude credential is a prompt injection target.

## Options

| Option | Good | Bad |
|---|---|---|
| A. A GitHub workflow with a Claude credential in a protected environment, fed only a strictly parsed body | Minutes, not hours; no laptop needs to be on | A secret in a public repo's Actions; cost |
| B. No agent in GitHub; the workflow only waits, parses and labels the issue `incident-ready`, and a lane picks it up | No secret at all; free | Slower (when a lane next checks its inbox) |
| C. Agent reads the raw issue text with full tools | Most capable | Unsafe: issue text is attacker-controlled |

## Decision

Build B first (it needs no secret), then A when incidents come more than a few times a week (decision D3). Never C.

Phase 2 (`.github/workflows/incident.yml`):
1. **Trigger:** `issues: [opened, edited, labeled]` with label `incident`. `if:` the issue author's login is in an
   allow-list written in the workflow file (Cris and named testers). Comments never trigger it.
2. **Edit window:** `concurrency: { group: incident-<number>, cancel-in-progress: true }`, then `sleep 600`. Each
   edit restarts the wait. Experiment E5 proves it before use.
3. **Parse, with no secret:** `scripts/incident-parse.mjs` reads the body from `env:` (never inside `run:`), keeps only
   lines that match the exact format of `formatReport`, and only code words from `INCIDENT_PARTS`, `INCIDENT_CODES`
   and `INCIDENT_STAGES`, versions and numbers. Everything else is dropped. Output: a small JSON artifact.
4. **Agent** (option A only), in environment `incident`: Claude Code with the parsed JSON as its only input. Read,
   Grep and Glob limited to `src/` and `docs/` of a `qa` checkout, with deny rules for `test/fixtures/**` (it holds
   prompt injection pages on purpose), `/proc/**`, `~/.claude/**` and the runner's temp folder, where the key could be
   read. No Bash, no web, no MCP; `--max-turns` and `--max-budget-usd` set; `contents: read`. Its answer has a fixed
   shape (a cause code word, file paths that exist, a test name). A separate step with no Claude key parses that
   answer strictly and posts only what passes; only that step holds `issues: write` (which could edit any issue).
5. **Option B path:** the same parse, then the label `incident-ready`. A lane acts only on comments by `CrisH2307`
   (AGENTS.md), so a bot comment would be ignored by design; the lanes list the label at the start of a session and
   read the parsed fields themselves.

Phase 3 (the Auto-fix switch):
6. A repository variable `INCIDENT_AUTOFIX`, `off` by default. Only admins (Cris) can change it in Settings.
7. When `on`, a fix is made in two jobs. Job A runs Claude Code with Bash inside Claude Code's sandbox with an empty
   network allow-list (the same settings Stephen's jobs use, `src/jobs/spec.ts`), and the Claude key is not in the
   environment the tests see. Bash can run any code, so it is treated as able to do anything the sandbox allows. Job A
   holds no write token; it outputs a patch as an artifact.
8. Job B holds no Claude key and runs no repo code: it applies the patch on a new branch and opens a PR to `qa` with
   `contents: write` and `pull-requests: write`. If the patch touches a safety path, the title carries `[DEV REVIEW]`
   and the normal independent review applies. It never merges and never touches `main`; the rulesets still require
   PRs and green checks.

## Consequences

- Good: an incident gets a first look within about 15 minutes, with no laptop on (option A).
- Good: nothing the public writes can reach the agent as text: only parsed code words and numbers. Text inside the
  repo (the injection fixtures) is out of the agent's reach by path rules.
- Cost: option A spends Claude tokens; capped per run and per month (D3).
- Risk: the phase 3 job A runs code with Bash. The sandbox's empty network list and the split credentials are what
  keep the key and the write token apart; it gets an independent review before the switch is ever set to `on`.

## How we would know it fails

- An issue by a non-allow-listed author must start no job (test on a throwaway account before use).
- A body with planted free text must reach the agent as an empty or rejected parse (unit tests of the parser).
- With the agent: a read of `test/fixtures/` or `/proc` is denied, and a free-text answer is not posted.
- The workflow's run list shows at most one agent run per issue per edit window.
