# ADR-016: Free or local models behind the same safety gate

**Status:** Proposed, LATER. Paper only; no code ships with this ADR. Work starts only after the friends beta, after
B11 (tolerant config readers) and F3 (clean launch environment), and after Cris accepts it on #10.
**Date:** 2026-11-25
**Deciders:** Cris (owner), dev lane
**Sources:** `docs/ARCHITECTURE-PLAN.md` (PR #318, sections 2 and 7), `docs/ADR-008-tier1-fast-path.md`,
`docs/ADR-014-incident-agent.md`, `docs/SYSTEM-DESIGN-STEPHEN.md`, `docs/PRODUCTION-READINESS.md` (item 20), the code in
`src/voice/claude.ts` (`claudeSpawnOptions`, `withoutSecrets`, `REQUIRED_CLAUDE_FLAGS`), `src/safety/`,
`src/jobs/`.

## Context

- Every model run in Stephen is the person's own `claude -p` (Claude Code) on their own Claude account. We pay for
  nothing. A friend without a paid Claude plan cannot use Stephen (#318, D2).
- Our own background work may need a paid key: the incident agent (ADR-014, D3), and the dev lanes.
- Two kinds of model could lower the cost:
  - **Free cloud providers** (free tiers of hosted models). Their terms often allow them to keep or train on the
    input. The text goes to a company the person did not choose.
  - **Local models** (Ollama, MLX, llama.cpp) on the person's Mac. Nothing leaves the Mac. They are slower and weaker
    at tool use than Claude, and need RAM and disk.
- The safety of Stephen does not live in the model. It lives in code: the SafetyGate, taint, egress pins and the
  rate limit in `serve` (`src/safety/`), the native Allow and Deny clicks, the import boundaries that keep memory,
  timers and jobs out of the model's reach, and the job sandbox. That is what makes a model swap thinkable at all.
- Fact found while writing this: `withoutSecrets` in `src/voice/claude.ts` removes Stephen's secrets and Claude
  Code session variables, but passes the rest of the shell environment to `claude`. A person who has
  `ANTHROPIC_BASE_URL` set in their shell already sends Stephen's prompts to that endpoint. F3 (clean environment in
  the release build) ends that for the app; this ADR makes any other endpoint an explicit, visible setting instead.

## Decision (proposed)

1. **Keep Claude Code as the only agent loop.** Do not write our own tool loop. Claude Code holds the flags Stephen
   locks down (`REQUIRED_CLAUDE_FLAGS`), the strict MCP config, the permission mode and the job sandbox. A loop of our
   own would be new safety code with none of that.
2. **A different model comes in only as a backend behind Claude Code**, through its gateway setting (an
   Anthropic-compatible endpoint, for example a local Ollama or a LiteLLM proxy in front of MLX). Stephen passes the
   endpoint only from its own setting, never from the inherited environment.
3. **Local before free cloud, for anything that touches the person's data.** A local model may see what Claude sees
   today. A free cloud provider may see only text that is already public or content-free (rule T3 below). In
   practice: for the person's commands, local only.
4. **Per role, not all or nothing.** Each role below gets a model only after it passes its eval.
5. **The person chooses.** Off by default. A Settings choice "Model: Claude (your account) / Local model", with a
   plain line on what each means. No silent fallback from Claude to another model.

## What can move, and what cannot

| Role | Today | Can it move? | Why |
|---|---|---|---|
| Routers (memory, timers, jobs), Tier 1 grammar | No model (`src/voice/assistant.ts`, ADR-008) | Nothing to move | Already free |
| Speech to text, wake word, VAD | Local (sherpa-onnx) | Already local | |
| Short answers with no tool and no private data ("what's 15% of 80") | `claude -p` | Yes, local | Low risk: no tool call, no private text |
| Summaries of text Stephen already read (the morning briefing) | `claude -p` with tools | Local only | The text is private (mail, calendar); never to a free cloud provider |
| Conversations that use browser or account tools | `claude -p` plus `serve` | Local only, and only after its eval passes | Small models follow injected text more often. The gate still bounds what can happen, but more attempts mean more Ask boxes and a worse experience |
| Jobs while away | `claude -p` in the Seatbelt sandbox | **No** | Long, many tool calls, budget limits; the sandbox and the budget flags are Claude Code's. Stays on Claude |
| Memory suggestions | `claude -p` proposes, the owner keeps or skips | Local only | Private text; the owner's click stays the write |
| Incident triage (ADR-014) | Planned, a paid key in GitHub | Yes, free cloud allowed | Its input is the strict-parsed, content-free incident fields only (no words, URLs or names). Output goes through the same strict output parser |
| Dev lanes (docs, drafts, tests) | Claude, OpenCode, freellm | Already done (`docs/AGENT-LOOP.md`) | Never with user data or secrets |

## Trust rules that never get weaker

- T1. The model never writes memory, timers or jobs. No tool exists for it, whatever the model.
- T2. Third-party text is data, never instructions. Taint, egress pins and the gate work the same for every model.
- T3. Private data (anything a tool read, the memory block, history, the persona) goes only to Claude under the
  person's account or to a model on their own Mac. Never to a free cloud provider.
- T4. Allow and Deny are clicks only. A model cannot answer an Ask box.
- T5. The same `serve`, the same strict MCP config and the same locked-down flags for every backend. A backend that
  cannot run with them is refused, as an old `claude` is refused today.
- T6. No secret goes to a model or into its environment (`withoutSecrets` stays).
- T7. A failed or missing local model is a plain spoken reason (R5 in `docs/PRODUCTION-READINESS.md`), never a quiet
  switch to another provider.

## Eval gate per role

A model may take a role only when, on the release commit:
- `stephen eval` for that role's categories meets the same bar as Claude today, and the `inject` category is 100%
  (the model does not call an acting tool from injected text, even though the gate would stop it);
- the latency targets in `src/telemetry/cli.ts` (`TARGETS`) hold on a 16 GB Apple Silicon Mac;
- idle use with the model loaded stays inside NFR section 5, or the model loads only when used.

## Experiments (before any code)

| # | Question | Smallest experiment | Who |
|---|---|---|---|
| L1 | Does Claude Code run Stephen's locked-down flags and `serve` tools against a local Anthropic-compatible endpoint? | Ollama or LiteLLM on Cris's Mac, `ANTHROPIC_BASE_URL` set by hand, `stephen eval --category single,read,inject` | Sonnet plus Cris, half a day |
| L2 | Which local model passes the inject cases, and how slow is it? | The same run over 3 model sizes; record pass rate, p50 and p95, RAM | Sonnet plus Cris |
| L3 | Do Claude Code's terms allow a non-Anthropic backend for this use? | Read the current terms and gateway docs | Opus, 1 hour |
| L4 | Can the incident triage run on a free provider within its rate limits? | Replay 20 parsed test incidents | Free agent, Sonnet checks |

## Consequences

- Good: a friend without a paid plan could use part of Stephen; incident triage could cost nothing; nothing private
  ever moves to a new company.
- Bad: a second model path to test every release; local models need several GB of disk and RAM; answers with a local
  model will be slower and worse, and the person must understand that.
- A new config key (the model choice) means B11 must be in a release first (the N-1 rule, ARCHITECTURE-PLAN
  section 4.2).
- `serve` and the gate do not change. If they would have to change for a backend, that backend is out.
