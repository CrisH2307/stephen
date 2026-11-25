# ADR-014: Incident loop phases 2 and 3: an event workflow, a strict parser, a read-only agent, Cris's Auto-fix switch

**Status:** Proposed 2026-11-25. Adds a CI trigger and a secret, so Cris must OK it. Needs decision D3 (who pays).
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
| B. No agent in GitHub; the workflow only waits and posts "from: ci, to: dev" on #274, and a lane picks it up | No secret at all; free | Slower (when a lane next checks its inbox) |
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
4. **Agent** (option A only), in environment `incident`: Claude Code with the parsed JSON as its only input, tools
   Read, Grep and Glob on a checkout of `qa` (no Bash, no web, no MCP), `--max-turns` and `--max-budget-usd` set,
   `permissions: contents: read, issues: write`. It writes one comment: likely cause, files, a test idea. The comment
   is filtered for key-shaped strings before posting.
5. **Option B path:** the same parse, then a comment on #274 starting `from: ci` and `to: dev` with the issue link.

Phase 3 (the Auto-fix switch):
6. A repository variable `INCIDENT_AUTOFIX`, `off` by default. Only admins (Cris) can change it in Settings.
7. When `on`, a second job (needs the first job's findings) may run Claude Code with Bash for the tests only, on a new
   branch, and open a PR to `qa` with a test. If it touches a safety path, the title carries `[DEV REVIEW]` and the
   normal independent review applies. It never merges and never touches `main`.
8. Its token is the workflow's `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` in that job only. The
   rulesets on `qa` and `main` still require PRs and green checks.

## Consequences

- Good: an incident gets a first look within about 15 minutes, with no laptop on (option A).
- Good: nothing the public writes can reach the agent as text: only parsed code words and numbers.
- Cost: option A spends Claude tokens; capped per run and per month (D3).
- Risk: the phase 3 job runs repo code with Bash while holding a Claude credential. It reads only parsed input, runs
  on `qa` code, and has no network tool; still, it gets an independent review before the switch is ever set to `on`.

## How we would know it fails

- An issue by a non-allow-listed author must start no job (test on a throwaway account before use).
- A body with planted free text must reach the agent as an empty or rejected parse (unit tests of the parser).
- The workflow's run list shows at most one agent run per issue per edit window.
