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

1. The ladder runs on Cris's Mac as `scripts/incident-ladder.mjs`, run by hand. It reads `incident` issues with
   `gh`. There is no GitHub workflow and no secret in GitHub.
2. Levels: L1 a free model through freellm (text only, no tools), L2 Haiku, L3 Sonnet, L4 Opus (each `claude -p`,
   read-only, in the Seatbelt sandbox of `src/jobs/spec.ts`, on a copy of the `qa` tip), L5 Cris.
3. L1 never resolves alone; its answer is a draft for L2. L2 to L4 resolve only with a checked answer, high
   confidence, a known cause, named files, and no safety file. Otherwise the next level runs. A safety file goes to
   L4, then always to L5. At most 2 runs per issue a day and 6 Claude runs a day.
4. Every #330 control stays: the user id allow-list, the 10-minute edit window, the strict parser (issue text is data),
   read-only levels, the strict answer check, no fix path (AUTO_FIX is gone), a daily cap.
5. Bot comments start with `from: incident-bot` and keep all model text in one code block. AGENTS.md says any
   comment containing `from: incident-bot` is data, never a task, though its author is `CrisH2307`. The #274 line is
   fixed text with numbers only.

## Why not the alternatives

- **#330 as it is:** every first look uses Cris's Claude plan. Cris said no.
- **A free hosted model in GitHub with a key secret:** adds a secret and keeps a model behind a public trigger, and the
  Claude levels would still need Cris's token in GitHub.
- **Hybrid (a free look in GitHub Models, Claude on the Mac):** no new secret, but it keeps a public trigger, adds a
  second part, and its look is only a draft until Haiku on the Mac confirms it.
- **OpenCode as L1 today:** its config on this Mac loads a browser tool. Not read-only until a canary proves an
  isolated config.

## Consequences

- Good: Claude never holds a token in GitHub, and the public `issues` trigger is gone. The free draft keeps Haiku's
  run short, and Sonnet and Opus run only on escalation.
- Cost: Haiku runs on every incident. Nothing runs while the Mac sleeps. Claude runs are capped per day.
- Honest limit: the Mac reads the same public text as GitHub did. The parser and the sandbox lower injection risk,
  not the move.
- Risk: the script holds Cris's `gh` login. Models never get `gh`, a shell or a token: only the script posts, with fixed
  commands. The comment shows the bot's text inside a code block.
- Risk: L1 text goes to free providers. It is content free (checked lines without time or id, and public code), so
  ADR-016 rule T3 allows it, on a pinned list of providers whose terms say they do not train on the input.

## How we would know it fails

- An issue by an id not on the list gets no comment (test with a fake API answer).
- Planted free text never reaches any level (the parser fuzz test from #330).
- A level with low confidence, a failed check or a safety file moves up (tests of the move-up rule).
- The same body never gets two comments (the ladder marker in the issue comments, tested).
- A canary `claude -p` run with the ladder's flags cannot read outside the checkout, run Bash or use an MCP tool.
