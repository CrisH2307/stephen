# Incident ladder: free models first (design note)

Asked by Cris (#367): try free models first, FreeLLMAPI and then a free OpenCode model, before any Claude level.
Builds on docs/INCIDENT-LADDER.md. Plan only.

## Today
- L1: one free model through freellm (`http://localhost:3001/v1/chat/completions`), pinned to `gpt-oss-120b` in
  `L1_MODELS`. It runs only when `INCIDENT_L1_MODEL` and `FREELLM_API_KEY` are set. Text in, JSON out, no tools.
- L2 to L4: `claude -p` with Haiku, Sonnet, Opus, read-only in a copy of `qa`. `nextLevel` and `resolves` pick the way up.
- L1 never resolves alone. Its answer is only a draft for L2.
- OpenCode is not used yet. The doc says it can join once a canary shows a config with no MCP, edit, shell or web.

## The new order
1. **L1a, FreeLLMAPI.** Same as today's L1.
2. **L1b, OpenCode free model.** Runs only when L1a gave no draft. One pinned model from the `opencode/` provider
   (OpenCode Zen free models, for example `opencode/deepseek-v4.1-flash-free`). Not a `freellmapi/` model: those go
   through the same freellm server as L1a, so they would fail the same way.
3. **L2 to L4, Claude.** As today. L2 gets the first draft that passed `checkFindings`.

Step up when: the server is unreachable, 45 s pass (`L1_TIMEOUT_MS`), the answer is empty, it is not JSON, or it fails
`checkFindings`. Each counts as "no draft". The trail shows `L1a draft` or `L1a none`, then `L1b ...`.

## How each is called (node, no new dependency)
- L1a: unchanged, `fetch` to freellm.
- L1b: `execFile('opencode', ['run', '--standalone', '--format', 'json', '-m', model, prompt])` through `io.run`. No `--auto`.
  `cwd` is a new empty temp dir. `env` is `withoutSecrets(process.env)` plus `OPENCODE_CONFIG` pointing to a temp config
  the script writes (the canary confirms opencode reads it): no MCP servers, no plugins, every tool and permission denied. `timeout: 45_000`. Parse the last
  text part of the JSON events, then `parseModelJson` and `checkFindings`, like L1a.
- Opt in like L1a: `INCIDENT_L1B_MODEL` must be set to a name on a new `L1B_MODELS` list (only `-free` names).
  `auto`, `fusion`, `free-router` and `claude-*` names are refused.

## Safety
- Issue text is data. Only the lines `parseIncidentIssue` keeps reach a model, without `ts` and `id` (`l1Lines`), plus
  public code excerpts from `git grep` of `src/`. No titles, comments, paths outside `src`, tokens or private data.
- Both free levels are text in, text out. No tools, no files, no web, no posting. The script alone posts with `gh`.
- L1b must pass a canary before it is turned on: the isolated config loads no MCP server, and a prompt that asks for a
  shell, a file write or a web fetch gets no tool call. Record the result in docs/INCIDENT-LADDER.md.
- Neither free level resolves alone. Haiku still checks every draft.
- Safety paths: `scripts/incident-ladder.mjs` and `src/telemetry/incident-ladder.ts` are not on the
  `scripts/safety-paths.mjs` list, so CI will not ask for `[DEV REVIEW]`. It still gets an Opus review, because it
  starts a new model process.

## Tests (test/scripts/incident-ladder-main.test.ts and test/telemetry/incident-ladder.test.ts)
1. L1a gives a draft: `opencode` is never run, and L2's prompt holds L1a's draft.
2. L1a unreachable, timeout or bad JSON: L1b runs, and L2 gets L1b's draft.
3. Both fail: L2 runs with no draft, the trail says `L1a none, L1b none`.
4. `INCIDENT_L1B_MODEL` unset or not on the list: no `opencode` call.
5. `pickL1bModel` refuses `auto`, `fusion`, `free-router`, `claude-*` and non `-free` names.
6. The `opencode` call: argv has `--standalone` and the pinned `-m`, no `--auto`; env has no secret; cwd is the empty dir.

## Questions for Cris
1. OpenCode Zen free models may keep prompts to improve their models. Is that OK for content-free lines plus public
   code? Recommend: yes, it is the same data L1a sends, and the repo is public.
2. Should a free answer ever resolve without Claude, for example when L1a and L1b agree? Recommend: no, keep Haiku as
   the checker. It costs little and stops a wrong public answer.
