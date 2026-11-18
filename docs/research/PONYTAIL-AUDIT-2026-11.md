# Ponytail audit, 2026-11: where Stephen can be simpler, smaller or faster

Date: 2026-11-18. Base: `origin/qa` at `1edc178`. Lane: review. Status: **proposals only**.

This is a report. No product code was changed. Every fix below needs the dev lane's OK first. Findings marked
**SEC** touch Allow/Deny, refusals, memory or the trust gate. They also need a dev-lane security review.

## How this was done

- Three read-only Opus subagents read the code in parallel: `src/` core (page, server, drivers, safety, app,
  desktop), `src/` voice side (voice, memory, jobs, accounts, eval, selftest, history, telemetry), and `helper/` plus
  `test/`. Method: ponytail-audit, ponytail-review, ponytail-debt, deslop-shared-libs and test-audit, as guides only.
- Every "dead code" claim was checked with grep over `src/`, `helper/` and `test/`. I spot-checked the main claims
  again by hand (A1, A6, A7, B2, C3, C4, T3, T4, T5).
- Numbers come only from existing tools: `stephen latency --days 30` on the owner's Mac, and one unit run
  (`vitest run --exclude 'test/**/*.int.test.ts'`) after waiting for the suite lock.
- Nothing was profiled with new code. Where a finding says "measure first", nobody has measured it yet.

## Measurements used as evidence

`stephen latency --days 30` (42 triggers, ids and numbers only):

| Group | Step | p50 | p95 | Note |
|---|---|---|---|---|
| wake / model (n=7) | endpoint | 1500 ms | 1522 ms | A flat 1.5 s wait on every wake command. See P1. |
| wake / model | speech to reply | 10171 ms | 20102 ms | OVER target (4800 / 8800 ms) |
| ptt / model (n=8) | endpoint | 11 ms | 42 ms | Push to talk has no such wait |
| app / model (n=12) | warm start | 2291 ms | 2413 ms | Starting the warm Claude |
| wake / model | warm start | 3109 ms | 11193 ms | |
| all model groups | first token | about 1100 ms | about 1600 ms | Model side, not ours to cut |

Unit suite: 3,248 tests in 146 files, 57 s wall, 40 s summed file time. 3 failures, all in
`test/eval/dry-server.test.ts`, because they need `dist/` and the audit worktree had no build. They are not code
bugs. Slowest files: `voice/tts/chain.test.ts` 6.4 s, `voice/index.test.ts` 4.0 s, `voice/warm-claude.test.ts` 3.2 s,
`jobs/runner.test.ts` 2.0 s.

## Top findings, ranked by value

Value = lines saved times low risk, or a real speed win the owner can feel.

| Rank | Id | What | Lines | Risk | SEC |
|---|---|---|---|---|---|
| 1 | P1 | Wake commands always wait 1.5 s for end of speech | about 2 | med | no |
| 2 | DEAD | One batch of dead code in src and helper (A6, A7, B6, B8, B9, C3, C4, C5, T4, T6) | about 250 | low | partly |
| 3 | A1 | `recent()` reads the whole 5 MB audit log to get the last 100 lines | +10 | low | yes |
| 4 | B1 | Two Claude spawn wrappers repeat the same setup | 25 to 30 | med | yes |
| 5 | C6 + C7 | Helper re-renders every window view every 5 s, even with no jobs | about 0 net | low | no |
| 6 | T1 + T2 | About 270 test lines that pin UI wording or test a TypeScript copy of Swift | about 270 | low to med | keep the SEC greps |
| 7 | B3 | Two copies of the private day-file append and read code | 30 to 35 | low | no |
| 8 | C1 + C2 | Helper reconnect and poll loops keep running after state settles | about 0 net | low | C1 yes |
| 9 | B2 | Job watcher runs a blocking `ps` every 10 s on the audio thread | +10 | med | yes |
| 10 | A2 | Payment-frame check written twice | about 22 | low | yes |

Rough total if every low-risk batch lands: about 450 src and Swift lines and about 330 test lines removed.

## P: performance findings with evidence

| Id | file:line | What is wrong | Proposed change | Lines removed | Risk | Touches | Test that proves it |
|---|---|---|---|---|---|---|---|
| P1 | src/voice/listener.ts:122, :598-610; src/voice/config.ts:168, :173 | A command counts as "long" after 2.5 s of speech (`LONG_COMMAND_AFTER_SEC`). `speechSec` also counts the VAD's 0.8 s hangover after the last word (engine.ts:38: `speaking()` stays true for `silenceSec`). So almost every wake command passes 2.5 s and then waits the full `longSilenceSec` (1.5 s). The latency log shows wake endpoint p50 1500 ms, p95 1522 ms. | Count only real speech in `speechSec` (not the hangover), or start the count after the wake phrase. Then check the endpoint p50 again with `stephen latency`. Do not lower `longSilenceSec` itself: it exists for multi-part requests. | about 2 | med (could cut off a long request) | none | test/voice/listener.test.ts (add: a 1.5 s command after "hey stephen" ends after `silenceSec`, a 4 s one waits `longSilenceSec`); then `stephen latency` on the Mac |
| A1 | src/safety/audit.ts:175-205 (used by src/app/server.ts:231, src/server/tools.ts:1115) | `recent()` reads the whole audit.log (up to 5 MB) and splits it, just to get the last 100 lines. This runs on every app chat.done under a 400 ms deadline. | Read from the end in 64 KB chunks and stop after `n` lines. | +10 | low | trust (audit) **SEC** | test/safety/audit.test.ts, test/app/server.test.ts |
| A3 | src/page/index.ts:1003-1041 | `wait_for` copies the full `innerText` of every frame into Node every 250 ms. On a big page that is MBs per poll, and each poll forces layout. | Do the `includes` check inside each frame and return two booleans. Edge case: a phrase split across two frames would stop matching. | about 3 | med | none | test/page/read.int.test.ts, robust.int.test.ts (wait_for cases) |
| A8 | src/page/runtime.ts:331-343, :357 | `effectiveBg` walks all ancestors and parses colors for each text parent on each snapshot. No cache for the result. Not measured. | Memoize per element in a Map reset in `begin()`, like `textVis`. Measure on a large DOM first. | +4 | med | trust (hidden-text filter) **SEC** | test/page/security.int.test.ts, snapshot.int.test.ts |
| A9 | src/safety/audit.ts:143-160 | Every audit line runs `mkdir -p` and `stat` before the append. | `mkdir` once; keep the size in memory, re-stat only after rotate or error. Keep the chmod on new files. | about 3 | low | trust (audit) **SEC** | test/safety/audit.test.ts (rotation) |
| A16 | src/cli.ts:5-38 | Every command, also `serve`, imports selftest, helper install and doctor, TTS setup and doctor. Voice spawns a `serve` per Claude start. Cold serve start is 140 to 210 ms (ADR-008-MEASUREMENTS.md). | Move those imports into their `case` with `await import()`, like `listen` and `eval`. Measure with `node --cpu-prof dist/cli.js serve` first. | 0 (moves 8) | low | none | test/cli/*.test.ts, test/app/listen.int.test.ts |
| B2 | src/jobs/finish.ts:14, :131; src/jobs/state.ts:135; src/lib/process.ts:22 | Every 10 s the listener's job watcher lists jobs. For each running job it runs a blocking `execFileSync('ps')` on the same event loop as the audio frames (about 5 to 15 ms each). | Cache `commandOf(pid)` per pid while the pid stays alive, or make the check async here. Do not drop the command check: it guards against pid reuse (R8-5) before a kill. | +10 | med | decides which pid gets killed **SEC** | test/jobs/state-pid.test.ts, finish.test.ts; new: two polls, one running job, `ps` runs once |
| B4 | src/voice/conversation.ts:138, :367; src/voice/index.ts:353, :432, :452-458, :822; src/memory/store.ts:227 | One warm command reads and re-checks memory.json 6 to 9 times (parse, secret regex, sha256). Each read is under 1 ms, so this is mostly simplicity. | Cache `listSync` keyed on (ino, size, mtimeMs). Writes are atomic renames, so ino changes. | about 10 | med | memory (stale cache sends old items) **SEC** | test/memory/store.test.ts; new: a hand edit of memory.json shows on the next read |
| B15 | src/voice/warm-claude.ts:342-343 | Each warm turn sends one extra `mcp_status` round trip before the prompt. Cost not measured. | Measure first. Remove only if it costs real time and review agrees `serveProblem()` is enough. Listed so nobody removes it without review. | 2 | med | trust (fail closed if tools are gone, R7-1) **SEC** | test/voice/warm-claude.test.ts |
| C1 | helper/AppClient.swift:1024-1032; helper/main.swift:537; helper/MainWindow.swift:246 | While the listener is stopped, the helper tries to reconnect every 3 s forever. With the window open, each flip also runs a blocking `control.refresh()` on the main thread. docs/HELPER.md:122 is stale. | Back off 3 s to 10 s; reset to 3 s on open, retry, Start, or when app.sock appears. Fix the doc line. | +4 | low | Allow/Deny prompts use this connection **SEC** | By hand: stop the listener, count connects with `lsof` |
| C2 | helper/AppClient.swift:1669-1679, :1741, :1770, :1499-1507 | After Start it polls every 1 s for 60 s (12 s after Stop), even after the state settles. Each tick is a blocking connect on the main thread. | Stop the loop when the state leaves `.starting` or reaches `.stopped`. | +3 | low | none | By hand on the Mac |
| C6 | helper/JobsPage.swift:40, :64; helper/AppClient.swift:1403 | Jobs page polls `jobs.list` every 5 s even with no running jobs. Each answer reassigns `jobs`, so the sidebar, Home and Ask box all re-render. | A `.task` loop that runs only while jobs are running. | about 0 | low | none | test/helper/app-protocol.test.ts:529 pins `Timer.publish(every: 5` and must change (T1) |
| C7 | helper/AppClient.swift:871-924 and the refresh handlers (1173, 1270, 1379, 1391, 1403, 1442) | AppModel has about 35 `@Published` fields. Every refresh reassigns them even when unchanged, so every view re-renders. | A 3-line `assign(&x, new)` that skips equal values. Do not split the object yet. | +3 | low | none | Instruments on the Mac |
| C10 | helper/AppClient.swift:1120, :1308; helper/ChatThread.swift:18, :42; helper/AskBox.swift:118; helper/MemoryPage.swift:243-244 | Repeated work per render: `thread` filters up to 300 bubbles on each access; dates parsed on each render; memory graph layout reruns on each keystroke. Small n, low value. | Keep `thread` as stored state; parse dates once at decode. | about 0 | low | none | app-protocol.test.ts:344-369 keeps passing |

## Dead code (one batch, low risk)

All confirmed by grep: no use outside the defining file, or only tests use them.

| Id | file:line | What | Lines | Risk | Touches | Test |
|---|---|---|---|---|---|---|
| A6 | src/page/frames.ts:146 `highWater`; src/refs.ts:27 `isTabId`; src/server/tool-log.ts:34 `APP_TOOL_LOG_FILE`; src/safety/session-state.ts:30 `MAX_SESSION_STATE_BYTES`; src/desktop/index.ts:42 `DESKTOP_TOOLS` | No use anywhere | about 13 | low | none | `npm run typecheck` + suite |
| A7 / T6 | src/safety/domains.ts:264-268 `BLOCKED_SCHEMES`; src/safety/egress.ts:286-289 `hasDocumentScopes`, :67 `PATH_DATA_THRESHOLD`; src/safety/classify.ts:131 `isHighRiskControl` | Dead or test-only. `BLOCKED_SCHEMES` says it enforces blocked schemes, but the real rule is the http/https allow-list in policy.ts:204-220. A reader could think editing it changes policy. | about 25 | low | trust model docs **SEC** | test/safety/policy.test.ts scheme cases; point classify.test.ts:119-161 at `highRiskReason` |
| B6 | src/voice/claude.ts:634 `export { killGroup }`; src/voice/tts/index.ts:28 and src/voice/tts/keys.ts:12 `redactKey` | Re-exports nobody imports; an unused import (tsc TS6133) | 3 | low | none | tsc |
| B8 | src/voice/claude.ts:627, :660-662, :667, :677, :691 | `pid` getter and `RunnerOptions.now` have no users; argv built twice | about 8 | low | memory (args carry the persona) | test/voice/claude.test.ts, memory-persona.test.ts |
| B9 | src/voice/conversation.ts:30, :162-175 | `DEFAULT_FOLLOW_UP_WINDOW_SEC` unused; `drop()` only forwards to `dropped()` | 5 | low | none | test/voice/followup.test.ts |
| B7 | src/voice/models.ts:173, :197-201 | `onProgress` never passed; fetch fallback (only without curl) holds the whole archive in memory | 6 | low | none | test/voice/models.test.ts |
| C3 | helper/AppClient.swift:1496, :1631, :1636-1638, :1789-1821 | Old log tailer (`watchLog`, `readLog`, `logLines`, `logTimer`...) with no caller | about 42 | low | none | Mac build (test/helper/swift.int.test.ts) |
| C4 | helper/AppWindow.swift:15-41; helper/Components/Gallery.swift; helper/Theme.swift:97 | `NoticeView`, `EmptyStateView`, `ComponentGallery` unused. UI-REVIEW-2026-11.md:448 already asked to remove them. Also drop Gallery from `HELPER_SOURCES` (src/helper/install.ts:22). | about 85 | low | none | test/helper/install.test.ts:98 + Mac build |
| C5 | helper/AppClient.swift:23, 876/996, 892/1334, 1784-1787 | `APP_MEMORY_MAX_ITEMS`, `modelName`, `settingsText` (renders the whole config, never shown), `StephenControl.usage()` | about 12 | low | none | app-protocol.test.ts:311-342 |
| T3 | src/safety/index.ts:36, :41-55 | `evaluateLanding` (with its own WeakMap cache) is not used in production. Production uses `SafetyGate.landing` to `landingVerdict`. Tests check both. | about 21 | low | trust gate **SEC** | test/safety/review2.test.ts #12 via `landingVerdict`; mcp.int.test.ts:262 |
| T4 | src/app/server.ts:594-603 `assistantQueue`; src/voice/transcript.ts:62 `findWakePhrase`; src/page/index.ts:1045-1053, :1137 `screenshotNote` | Only tests call them. The clipped-screenshot note is stored but never read in production, so the user never sees it. | about 60 | low | none | typecheck. Decide: show the screenshot note, or delete it |
| T5 | src/jobs/spec.ts:275-279 | `untrustedJobOutput` claims to frame job summaries "wherever shown or spoken", but nothing calls it. | about 10 | med | trust (untrusted framing) **SEC** | Decide: delete, or wire it into the phone `job_status` path with a new test |

## Duplicates and over-building

| Id | file:line | What is wrong | Proposed change | Lines | Risk | Touches | Test |
|---|---|---|---|---|---|---|---|
| B1 | src/voice/claude.ts:663-725; src/voice/warm-claude.ts:220-262 | Both Claude wrappers repeat: serve instance, persona file write, spawn options (cwd, `withoutSecrets` env, detached), ENOENT message | One `prepareClaude()` + `spawnClaude()` used by both. Keep the same error words and cleanup order. | 25-30 | med | trust, memory, privacy (env scrub) **SEC** | test/voice/claude.test.ts, warm-claude.test.ts, memory-persona.test.ts, warm-runner.test.ts |
| B3 | src/history/store.ts:79, :167-196, :316-333; src/telemetry/latency.ts:149, :302-315, :337-352 | Two copies of "append one line to a private day file" (O_NOFOLLOW, 0600, size cap) and "read a private file"; `localDate` copied byte for byte | `appendPrivateLineCapped` and `readPrivateRegularFile` in src/lib/fs.ts | 30-35 | low | privacy | test/history/store.test.ts, test/telemetry/latency.test.ts |
| A2 | src/page/frames.ts:345-367 vs src/safety/classify.ts:21-28 | `isPaymentFrame` written twice; the classify one also handles IDN | Delete the frames copy, import from classify (page/index.ts:177, :521) | about 22 | low | privacy (payment redaction) **SEC** | test/page/format.test.ts:178-189, test/safety/classify.test.ts |
| A4 + A15 | src/server/util.ts:184-197; src/desktop/index.ts:599-614; src/page/frames.ts:39-49 | Same timeout race written 3 times; `tryAttach` repeats `isZenAttachOnly` with a cast | Keep frames.ts version (+hint arg) and drivers/util (needs `onLate`); use them | about 24 | low | none | test/server/server.test.ts, test/desktop/reuse.test.ts |
| A5 | src/safety/policy.ts:253-258; src/safety/confirm.ts:96-101 | `elementRef` written word for word twice, plus an alias `label` | confirm.ts imports it from policy.ts | about 9 | low | approval prompt text **SEC** | test/safety/confirm.test.ts, policy.test.ts |
| A10 | src/zen-launcher.ts:44-51; src/install.ts:58-69; src/safety/confirm.ts:326-333 | Three never-throwing `execFile` wrappers with different shapes | One `execNoThrow` in src/lib/process.ts | about 15 | med | confirm dialog exec **SEC** | test/safety/confirm.test.ts, test/cli/install.test.ts |
| A11 + B5 | 7 sites in page, server, desktop; 5 in voice, memory, selftest, helper client | `new Promise(r => setTimeout(r, ms))` and private `sleep` copies; page/index.ts:687 has `sleep` and skips it 3 times | `import { setTimeout as sleep } from 'node:timers/promises'` (`{ ref: false }` in warm-claude) | about 18 | low | none | existing suites |
| A12 | src/server/tools.ts:83 vs src/safety/policy.ts:90 | Same 2000-char evaluate limit defined twice; schema and deny rule can drift | Import `EVALUATE_MAX_CHARS` in tools.ts | 1 | low | permission gate **SEC** | test/safety/policy.test.ts |
| B10 | src/voice/claude.ts:149-153 | `cleanMemoryItem` repeats `cleanMemoryText` | Call `cleanMemoryText` then truncate. Keep the second cleaning pass. | 2 | low | memory, prompt framing **SEC** | test/voice/memory-persona.test.ts, persona.test.ts |
| B12 | src/voice/warm-claude.ts:510-517 | `groupAlive` belongs next to `killGroup` | Move to src/lib/process.ts. Do not merge `pidAlive` into `isPidAlive`: their EPERM answers differ on purpose. | 5 | low | trust (serve liveness) **SEC if merged** | test/server/instance.test.ts |
| B13 | src/selftest/index.ts:175 | `isInside` redefined (strict) | `p !== root && isInside(p, root)` from lib/fs | 4 | low | none (delete guard) | test/selftest/selftest.test.ts |
| A13 | src/drivers/chrome.ts:99-105; src/drivers/zen.ts:345-351 | Same 5-line start of `disconnect()` | `protected takeBrowser()` in DriverBase | 6 | low | none | test/drivers/*.test.ts |
| A14 | src/safety/confirm.ts:47; src/server/connect.ts:22; src/desktop/index.ts:684; src/selftest/index.ts:80 | `{ chrome: 'Chrome', zen: 'Zen' }` copied 4 times | One `SHORT_BROWSER_LABEL` in desktop/browsers.ts | 4 | low | none | test/safety/confirm.test.ts |
| B11 | src/accounts/index.ts:100, 186, 207, 268, 411 | Fetch option spread repeated 5 times, time zone spread 8 times | Hoist `http` and `tzOpt` once | 0 net | low | none | test/accounts/accounts.test.ts |
| B14 | 22 inline `n === 1 ? '' : 's'`; src/jobs/router.ts:35 | Hand-written plurals; `plural` exists in src/page/format.ts:126 | Reuse it only while touching those files | about 10 | low | none | existing tests |
| C8 | helper/MemoryPage.swift:171-172, 399-401, 441-443; helper/AppClient.swift:1218, 1232, 1239 | After Forget or Edit, the page sends 4 refresh requests right away, before the answer. The graph can show the old state. | Refresh once, in the answer handler | about 10 | med | memory **SEC** | First check app.sock answers in order |
| C9 | helper/AppClient.swift:1540-1572 | `appRequestOnce` re-implements connect, framer and decode. Its reason ("works with the window closed") is gone. | Use `sharedAppModel().request` with a timeout parameter | about 30 | med | none | test/app/control.test.ts (server side), Mac by hand |
| C11 | 10 sites (Lists, MemoryPage, SettingsPage, ConversationsPage, MainWindow, AskBox, Controls) | Same rounded surface box copied 10 times | One `surfaceBox` modifier in Theme.swift (UI review asked for this too) | about 10 | low | none | Mac build |
| C12 | helper/AppClient.swift:335-469 | Six lenient `init(from:)` with the same line pattern | A small `lenient` decode extension | about 20 | low | none | new: decode test/fixtures/app-protocol-v1.jsonl in Swift |

## Tests (low value or duplicate)

| Id | file:line | What is wrong | Proposed change | Lines | Risk | Touches | Proof |
|---|---|---|---|---|---|---|---|
| T1 | test/helper/app-protocol.test.ts:320-342, 449-460, 486-534, 535-577, 598-608 | About 300 lines grep Swift UI source for exact words and sizes (`'No jobs yet.'`, `expanded: CGFloat = 220`, `Timer.publish(every: 5`). They break on any rename and block C4, C6, C11. | Retire the wording and layout greps. **Keep** the contract greps (311-318, 344-369, 371-398, 400-415, 433-447, 461-466). | about 120 | low | the kept ones guard Allow/Deny: do not touch **SEC** | the kept greps |
| T2 | test/helper/ptt-model.ts; test/helper/logic.test.ts:10-30 | A 198-line TypeScript copy of Swift `PushToTalk` is tested against itself. The real Swift runs the same scenarios in swift.int.test.ts:124. | Keep `SCENARIOS` as data, delete the model and model-only tests. First check CI does not skip swift.int. | about 150 | med | none | test/helper/swift.int.test.ts:124, :145 |
| T7 | test/app/personal.test.ts:44 | Greps the exact source line in voice/claude.ts; duplicates a behaviour test in test/phone/routers.test.ts:33 | Call `mcpConfig(..., 'phone')` and check `--confirm deny` | 0 net | low | permission table **SEC** | test/phone/routers.test.ts:33 |
| T8 | test/helper/install.test.ts:88-92 | Copies the full swiftc file list; :98 already checks every Swift file compiles | Check only the argv shape | 3 | low | none | install.test.ts:98 |
| T9 | test/helpers/smoke.int.test.ts | Tests the test harness by starting 2 real browsers; every page/*.int test does the same | Retire | 16 | low | none | test/page/*.int.test.ts |
| T10 | test/voice/claude-help-real.test.ts; test/voice/review4.test.ts:31-54 | `checkClaudeFlags` tested in 4 files with the same fixture | Merge into claude-contract.test.ts | about 10 | low | none | claude-contract.test.ts |
| T11 | test/e2e/mcp.int.test.ts:146, :152 | E2e copies of unit checks (0700 dirs, tool list) | Drop the 2 duplicates | about 12 | low | none | review1.test.ts:118, server.test.ts:55 |

## Needs dev-lane security review

A1, A2, A5, A7/T6, A8, A9, A10, A12, B1, B2, B4, B10, B12 (only if merged), B15, C1, C8, T1 (kept greps), T3, T5, T7.

Two of these are not refactors but open questions for the security review:

- **T5:** the comment on `untrustedJobOutput` claims job summaries are framed as untrusted, but nothing calls it.
  Either the claim or the wiring is wrong.
- **T4 (`screenshotNote`):** the "screenshot was clipped" note never reaches the user or the model.

One more side note from the voice audit: jobs (allow-list env, src/jobs/spec.ts:203) drop
`CLAUDE_CODE_OAUTH_TOKEN` and the Bedrock/Vertex variables that voice keeps. That may be on purpose. Worth a check.

## Looked at and kept

- `IBrowserManager`, `ISafetyGate`, `IAuditLog`: each has a test fake, so they are not one-implementation interfaces.
- The iframe walk in src/page/index.ts:162-229 is serial on purpose: frames share one character budget.
- `buildJobEnv` (allow-list) and `withoutSecrets` (deny-list) differ on purpose. Do not merge.
- helper/Core.swift's own JSON parser: it must build without Foundation for the Linux harness.
- test/helpers/suite-lock.ts is not over-built: link-based create avoids a half-written lock.
- test/page/security.int.test.ts:131-144 takes about 19 s. It is a security test. Keep it.
- About 200 exports in voice and about 140 in core are used only in their own file. Dropping `export` saves no lines.

## Suggested order for the dev lane

1. **Batch 1, no review needed:** P1 (after a listener test), the dead code that is not SEC (A6, B6, B7, B8, B9, C3,
   C4, C5, T4 minus the screenshot decision), A11 + B5, B3, A4 + A15, T8, T9, T10, T11.
2. **Batch 2, helper speed:** C2, C6 + T1 (wording greps only), C7.
3. **Batch 3, with security review:** A1, A2, A5, A7/T6, A12, T3, B1, B2, B4.
4. **Measure first:** A8, A16, B15.
