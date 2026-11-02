# ADR-003: Phase 3 — one long-lived `claude -p` (stream-json) per conversation, pre-warmed

**Status:** Accepted (owner chose a long-lived `claude -p` over the Agent SDK: no API key), 2026-11-02. Subtasks 1 to 3 implemented (see "Implementation" at the end); Mac measurements pending.
**Measured with:** Claude Code 2.1.316, `--model sonnet`, Stephen's exact lock-down argv (`buildClaudeArgs`), the eval
dry-run server, on the Linux cloud box (not the Mac). Probe scripts: the session scratchpad `p1/` (`bench.mjs`,
`warm.mjs`, `interrupt.mjs`, `persona*.mjs`, `idle.mjs`, `ready.mjs`, `slowtool.mjs`, `realserve.mjs`).

## Context

Today every command spawns `claude -p … --output-format json` plus a fresh `stephen serve`. Follow-ups `--resume`
the session, and the gate's taint goes through `<home>/voice/conversation-state.json`. `formatTiming` splits a run
into `start-up + MCP` (wall − `duration_ms`), `model` (`duration_api_ms`) and `tools + overhead`
(`duration_ms` − api). Phase 3 aims to remove the start-up cost, and to start Claude while the user is still speaking.

## Measurements

**Eval baseline** (`node dist/cli.js eval --model sonnet --jobs 4`, clean env, 55 cases): 53/55 passed (both misses
are behaviour: `mis-lofi`, and `brief-day` needs the weather tool that isn't built yet). Median **7.1 s**, p90
**10.9 s**, min 3.7, max 16.1, 3 turns at the median. A run with the cloud host's env: 53/53, median 8.6 s, p90 14.5 s.
Note: the eval gives every case a fresh cwd, which changes the system prompt and breaks the prompt cache. Each case
re-creates about 5.5k cached tokens (`duration_ms` 0.84 s with a fixed cwd vs 2.8 s with a fresh one). So eval
medians overstate model time compared with the listener, which always uses one `workDir`.

**Cold phases, one direct probe** (real argv, stdin ignored as in `ClaudeRunner`, fixed cwd, n=5, medians):

| spawn → | `serve` child up | `system/init` | first text token | `result` | process exit |
|---|---|---|---|---|---|
| "say hi" (1 turn) | 0.9 s | 1.55 s | 3.75 s | 4.33 s | 4.77 s |
| "open youtube" (2 turns) | 0.9 s | 1.40 s | 5.64 s | 5.67 s | 6.08 s |

`formatTiming`'s "start-up + MCP" comes to **1.8–2.0 s**: about 1.5 s before the first request, plus about 0.45 s
between `result` and exit, which Stephen waits for (`close`).

**Before vs after** (`bench.mjs`, fixed cwd, n=5 per row; "overhead" = wall − Claude Code's own `duration_ms`):

| Case | Before: cold `claude -p` per command | After: warm process (follow-up, same process) | Pre-warm: spawned 3 s before the transcript |
|---|---|---|---|
| "say hi" (fresh) | p50 2.74 s, p90 4.43 s, overhead **1.56 s** | — | p50 **1.91 s**, p90 2.66 s, overhead **0.03 s** |
| "say bye" (follow-up) | `--resume`: p50 3.78 s, p90 7.22 s, overhead 1.43 s | p50 **1.75 s**, overhead **0.01 s** | — |
| "open youtube" (fresh) | p50 5.78 s, overhead 1.45 s | — | p50 5.13 s, overhead 0.02 s |
| "now open gmail" (follow-up) | `--resume`: p50 5.44 s, p90 14.1 s, overhead 1.33 s | p50 **4.49 s**, overhead 0.01 s | — |

Model latency varies by ±3 s from run to run and is the same in every condition. The fixed saving is
**≈1.5 s per command** (≈2 s with the exit wait). The other gain is p90: no process start, no transcript reload.

**Pre-warm lead time** (`warm.mjs`, send → `result`, "say hi"): sending at spawn (0 s) gives 2.85–4.1 s, no gain
(`init` comes 1.4–1.85 s after the send). 1 s ahead is a partial gain. **2 s or more ahead: all start-up hidden**
(0.87, 1.15, 1.02 s at 2, 3, 6 s).
**Idle cost** (`idle.mjs`, 10 min): claude + serve ≈ **265–275 MB RSS**, ≈ **0.6 % of one core**, no self-timeout.
Still answers after 10 min idle, both pre-warmed-unused and after a turn.

## Answers to the questions

1. **Multi-turn works.** One process served 4 commands. The same `stephen serve` PID served every turn, with both the
   dry-run and the real `serve --confirm dialog --voice --session-state` (status `connected`, 36 tools). The same
   `session_id` was kept, and the model remembered earlier turns.
2. **Stdin message shape** (one JSON line each, `\n`-terminated):
   `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}`. `content` can also be
   `[{"type":"text","text":"…"}]`, and the minimal `{type,message:{role,content}}` works. **One malformed line
   (`{"type":"user"}`) kills the process** (`Expected message role 'user'`).
3. **Turn end** = the first `{"type":"result"}` after the write. Its `subtype` is `success` or `error_*`, as today.
   `num_turns` and `duration_ms` are **per turn**. `duration_api_ms` and `total_cost_usd` are **cumulative per
   process**, so take the difference from the previous result. `--max-turns` applies **per message** (cap 2: four
   messages in a row all passed). Ignore `stream_event`, `assistant`, `rate_limit_event`, `system/status` and
   `system/post_turn_summary`. Nothing is printed before the first user message, and `system/init` only follows the
   first write.
4. **Readiness before the first message** (control protocol):
   `{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}` answers
   `control_response/success` in **0.75–0.96 s**. Then `{"…","request":{"subtype":"mcp_status"}}` shows `stephen`
   going `pending` → `connected` (by ~2.3 s).
5. **Interrupt**: `{"type":"control_request","request_id":"i1","request":{"subtype":"interrupt"}}` → ack in 8 ms, and
   the turn ends in 26 ms with `result/error_during_execution`. The process and serve stay up, the next turn works,
   and the partial turn stays in context. **During a tool call**, Claude Code sends MCP `notifications/cancelled`, so
   the server's `AbortSignal` fires, but **the tool keeps running to the end** (a pending dialog would stay live).
   **SIGINT to claude exits the process** (code 0, 0.7 s), so it is not a turn interrupt.
6. **`--resume` after the process exits works**: a stream process after one that closed stdin, and a classic one-shot
   after a SIGTERM-ed stream process, both recalled the codeword with the same `session_id`. Closing stdin exits
   cleanly in 0.4–0.7 s.
7. **Persona file / snapshot**: `--append-system-prompt-file` is read **100–300 ms after spawn**. Deleting it at
   100 ms fails the run (`Append system prompt file not found`), and deleting it right after the `initialize`
   response worked 6/6 times. Rewriting it later changes nothing, not in the same process and not on `--resume`
   (snapshot). So any memory change still needs a new process and a new session. `/dev/fd/3` over a Node pipe
   failed (ECONNRESET), so the persona stays in a file.

## Decision

Add a warm runner. Exactly one `claude -p --input-format stream-json --output-format stream-json --verbose` process
per conversation, with the **same lock-down argv** as `buildClaudeArgs` minus the prompt (no `--resume`, no
`--include-partial-messages` unless streaming TTS is added later). It is spawned **when the wake word fires or F5
goes down** (recording + ASR take ≥ 2 s, which covers start-up) and kept until the conversation ends.
`--session-state` stays exactly as it is. Its job changes from "carry taint between servers" to "fail closed and
survive a restart". **Cancel keeps killing the process group** (no `interrupt`), because an interrupted tool keeps
running and every cancel ends the conversation anyway. The one-shot `ClaudeRunner` stays, both as the eval path and
as the fallback when the protocol probe fails.

### Protocol (for the builder)

1. **Spawn**: argv as above, `stdio: ['pipe','pipe','pipe']`, `detached: true`, `withoutSecrets(env)`, cwd = the
   voice `workDir`. Write the persona file first, as today.
2. **Ready**: send `initialize`, wait for success (timeout 10 s), then **delete the persona file**. Poll `mcp_status`
   every 200 ms until `stephen` is `connected` (timeout 10 s). `failed`, a timeout or an exit → kill and fail closed
   (the command reports an error, and the next one spawns fresh).
3. **Turn**: before each write, check that the memory key equals the key at spawn and that `mcp_status` is
   `connected` (~25 ms). Then write `JSON.stringify(userMsg)+'\n'` (always `JSON.stringify` of a string, never raw
   text) and resolve on the next `result` (outcome mapped like `parseClaudeOutput`; api/cost by difference). Lines
   that don't parse, an `error_*` result, or an exit before `result` → error. One turn at a time.
4. **End the conversation** = SIGTERM the group → await `close` (SIGKILL after the grace period) → `Conversation.reset()`
   (session id first, then the state file) → `onSessionDropped` (transcript) → spawn the next process only when the
   next wake/PTT comes. Kill **before** deleting the state file: an old serve that is still alive could write it again,
   and the new serve would merge that old taint in (stricter, but wrong). Triggers:
   - the follow-up window ran out (`followUpWindowSec` after `touch()`; a timer, and checked again in `begin()`);
   - a memory change: the router's `changed`, or memory key ≠ key at spawn (app, CLI, a hand edit);
   - a cancel: Esc, "Stephen stop" (also when idle), the wake word while running, F5 while busy, Ctrl-C;
   - any error: a non-success result, a protocol/parse error, process exit, `mcp_status` ≠ connected (this also
     covers serve's own exit when a state-file write fails);
   - safety caps: an unused pre-warmed process after 60 s, a live process after `MAX_FOLLOW_UP_WINDOW_SEC` (30 min)
     or 25 commands, and listener exit (`killNow`).
5. **Window 0** (`followUpWindowSec: 0`): end after every command, so it behaves like today, but still pre-warmed.

## Risks

- `--input-format stream-json` and the control requests (`initialize`, `mcp_status`, `interrupt`) are the SDK's wire
  protocol and are only partly documented, so a Claude Code update could change them. Mitigation: check at listener
  start (an `initialize` failure → one-shot runner + a note), tests on a fake, and the real-claude probe test (like
  `claude-help-real.test.ts`).
- The rate limiter is now per conversation, not per command (stricter). Check that its window doesn't block long
  follow-up chains.
- The persona file stays on disk about 1 s after spawn (from spawn until `initialize`), shorter than today's whole run.
- A spawn on every wake word (videos, false alarms) costs about 270 MB and a few CPU-seconds. Unused processes are
  killed after 60 s.
- Context grows within a conversation (bounded by the 30 min / 25 command cap). The tool log (`--tool-log`) is now
  written by one long-lived serve, so `ToolLogRunner` must slice it per command.
- All numbers come from Linux. The owner should confirm on the Mac with `formatTiming` (before = one-shot, after = warm).

## Implementation plan

1. **`src/voice/warm-claude.ts` + `buildWarmArgs` in `claude.ts`.** The process class: spawn, ready
   (initialize → delete persona → mcp_status), `turn(prompt)` → `ClaudeOutcome`, cumulative differences, `kill()`.
   Move the result → outcome mapping out of `parseClaudeOutput` into a shared function. Tests
   `test/voice/warm-claude.test.ts`, with a stream mode added to `fake-claude.mjs`: argv has the lock-down flags, no
   prompt and no `--resume`; prompts with quotes/newlines go out as one valid line; the persona is deleted only after
   `initialize`; `mcp failed` → error; `error_*`/exit mid-turn → error; api/cost differences.
2. **`WarmConversationRunner` (in `conversation.ts`).** It implements `CommandRunner` plus `prewarm()` and owns the end
   rules above, in the order kill → close → reset → drop. Tests (in the style of `followup.test.ts`): each trigger
   kills the process and deletes the state file before the next spawn; a memory change between prewarm and send
   discards the process; window expiry; the 60 s unused kill; cancel during a tool call kills the group.
3. **Wiring + timing.** `voice.claudeMode: "warm" | "oneshot"` (default warm when the probe passes). The listener calls
   `prewarm()` in `onWake`/`onPttDown` (and when the app chat starts a command); `ToolLogRunner` slices per command;
   `formatTiming` gets `warm`/`waitedForReadyMs`, e.g. `claude: 1.9 s (warm, start-up hidden; model 1.8 s in 1 turn,
   tools + overhead 0.1 s)`. Tests: `listener.test.ts` (prewarm on wake/PTT, not while busy), `timing.test.ts`,
   `review*`-style test: nothing in the lock-down argv changes.
4. **Measure.** On the Mac: 10 commands one-shot vs warm (the `formatTiming` lines) and the follow-up pairs. Update
   `docs/VOICE.md` "Where the time goes" and `SYSTEM-DESIGN-STEPHEN.md` §4.1 (the state file now guards restarts).
   Optional, separate: a fixed cwd in the eval so its medians match the listener's prompt cache.

## Implementation (2026-11-02, subtasks 1 to 3)

Built: `src/voice/warm-claude.ts` (`WarmClaude`, `buildWarmArgs` in `claude.ts`, `probeWarmProtocol`),
`WarmConversationRunner` in `src/voice/conversation.ts`, the pre-warm calls in `listener.ts`, and the wiring in
`index.ts`. The result to outcome mapping is shared (`outcomeFromResult`). Tests: `test/voice/warm-claude.test.ts`,
`test/voice/warm-runner.test.ts`, `test/safety/rate-limit-conversation.test.ts`, warm cases in the pipeline and
push-to-talk integration tests, and the opt-in real probe `test/voice/warm-claude-real.test.ts`
(`STEPHEN_REAL_CLAUDE=1`). Differences from the plan above, all small:

- The switch is `voice.warm: true | false` (owner decision), not `voice.claudeMode`.
- `stephen listen --text` and `--dry-run` stay one-shot: `--text` runs one command per process, and its follow-ups
  across runs keep using `--resume`. Typed app chat needs no hook of its own: `run()` spawns when no process is up.
- `kill()` waits for the whole process group (the serve too), not only for Claude Code's `close`, before the reset.
  That is what makes "kill before reset" hold.
- The rate limiter needed no change: it already was a sliding window (`safety.maxActionsPerMinute`, 40 in any 60 s).
- `ToolLogRunner` needed no offset logic: truncating the log before each command already slices it, because serve
  opens the file for every record and writes it before the tool result reaches Claude (tested on one serve).
- A `control_request` from Claude Code (none is expected with `dontAsk` and no callbacks) is answered with an error.
- The timing line keeps the one-shot split, so the two compare directly:
  `claude: 1.9 s (warm, spawned 3.0 s ahead; start-up + MCP 0.0 s, model 1.8 s in 1 turn, tools + overhead 0.1 s)`.
- F5 pressed while a command runs cancels it first; the runner is still busy with the cancelled run at that moment,
  so that one next command starts cold. Every other wake / F5 press pre-warms.
