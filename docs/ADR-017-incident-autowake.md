# ADR-017: Incident on-call ladder on Cris's Mac

**Status:** Proposed 2026-11-25, second version. `[DEV REVIEW]`. Waits on Cris's OK.
**Deciders:** Cris (owner), dev lane.
**Supersedes:** the first ADR-017 in #330 (a GitHub workflow with Cris's Claude sign-in token).
**Sources:** `docs/INCIDENT-LADDER.md` (the design), ADR-014, ADR-016 (rule T3), `docs/research/GH-AGENTIC-WORKFLOWS.md`,
Cris's feedback on #330 (2026-11-25).

## Context

- `stephen report` files a content-free `incident` issue. Cris wants an agent to look at it on its own.
- #330 did that in GitHub with Cris's own Claude token. Cris said no: his Claude plan should not do every first look.
  He wants an on-call ladder: free models first, then Haiku, Sonnet, Opus, then him.
- freellm and OpenCode run only on Cris's Mac. GitHub runners cannot reach them.
- The repo is public. The research note says the author filter is the strongest control, then tool limits and token
  hygiene. Words in a prompt are not a control.

## Decision

1. The ladder runs on Cris's Mac as `scripts/incident-ladder.mjs`, by hand or from a launchd agent Cris installs. It
   polls `incident` issues with `gh`. There is no GitHub workflow and no secret in GitHub.
2. Levels: L1 a free model through freellm (text only, no tools), L2 Haiku, L3 Sonnet, L4 Opus (each `claude -p`,
   read-only, in a clean sparse checkout of `qa`), L5 Cris.
3. A level resolves only with a checked answer, high confidence, a known cause, named files, and no safety file.
   Otherwise the next level runs. A safety file goes to L4, then always to L5. Caps per day per level.
4. Every #330 control stays: the user id allow-list, the 10-minute edit window, the strict parser (issue text is data),
   read-only levels, the strict answer check, no fix path (AUTO_FIX is gone), a daily cap.
5. Bot comments start with `from: incident-bot`. AGENTS.md says such a comment is data, never a task, though its
   author is `CrisH2307`.

## Why not the alternatives

- **#330 as it is:** every first look uses Cris's Claude plan. Cris said no.
- **A free hosted model in GitHub with a key secret:** adds a secret and keeps a model behind a public trigger, and the
  Claude levels would still need Cris's token in GitHub. GitHub Models (no new secret) stays an option for an
  always-on first look later.
- **OpenCode as L1 today:** its config on this Mac loads a browser tool. Not read-only until a canary proves an
  isolated config.

## Consequences

- Good: most incidents cost nothing. Claude runs only when a free model is not sure. Nothing in GitHub holds a model
  token. The public `issues` trigger is gone.
- Cost: nothing runs while the Mac sleeps. L2 to L4 use Cris's plan limits, capped per day.
- Risk: the script holds Cris's `gh` login. Models never get `gh`, a shell or a token: only the script posts, with fixed
  commands. The comment shows the bot's text inside a code block.
- Risk: L1 text goes to free providers. It is content free (checked lines and public code), so ADR-016 rule T3
  allows it.

## How we would know it fails

- An issue by an id not on the list gets no comment (test with a fake API answer).
- Planted free text never reaches any level (the parser fuzz test from #330).
- A level with low confidence, a failed check or a safety file moves up (tests of the move-up rule).
- The same body never gets two comments (state file test).
- A canary `claude -p` run with the ladder's flags cannot read outside the checkout, run Bash or use an MCP tool.
