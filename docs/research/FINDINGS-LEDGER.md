# Findings ledger

Started 2026-11-12 by `docs/plan-reconcile` (review item DOC1). One table of every open or recently closed finding and plan item.

**How to keep it current.** One row per finding. Never delete a row: set Status to `closed` with the PR or commit. Change the row in the same PR as the fix. New findings (a review, an issue, a Mac test) get a row the day they are filed. Issue numbers come from GitHub only; write `none` if there is no issue yet. Reviews and plan items that have their own doc stay summarised here in one line.

Columns. **Source**: where it was found (review = `docs/research/PLAN-REVIEW-2026-11.md`, plan = `PRODUCT-PLAN-2026-11.md`, R10a = `docs/REVIEW-10A.md` on branch `docs/review-10a`). **Severity**: Medium or Low for review findings; P0, P1, P2 for plan items (plan 4.1); Finding for the review's ten findings (not rated). **Lane**: dev (voice, trigger, gate, app code), review (review, docs, design, measurement), owner. **Status** values: open, in progress, fixed in code (not recorded), accepted, closed.

Status below is as of 2026-11-12 from the review and open GitHub issues. Nothing here was re-verified on the Mac.

## A. The review's ten findings (section 0)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| RV-1 | review 0.1 | Finding | Reliable trigger has no P0 task; F5 works about 1 in 10, mic cannot be stopped | fixed in code, Mac check pending | dev | #86, `fix/mic-stop-f5` |
| RV-2 | review 0.2 | Finding | Tier 1 targets need endpointing; about 2.8 s on the wake path with zero model time | open | dev | #73, `fix/wake-endpoint` |
| RV-3 | review 0.3 | Finding | A2 mostly done on `qa`; `tier` always null, Esc and chime not recorded; only #44 on `main` | open | dev | #43, `feat/latency-gaps` |
| RV-4 | review 0.4 | Finding | "Parakeet expected winner" contradicts `docs/VOICE.md`; 300 ms rule excludes whisper-small | open | owner | #61 |
| RV-5 | review 0.5 | Finding | Several plan tasks already built or smaller than stated (see plan corrections) | in progress | review | `docs/plan-reconcile` |
| RV-6 | review 0.6 | Finding | B1 overstated: non-owner memory origins exist only in the type | fixed in code | dev | #53, `fix/memory-origin-you` |
| RV-7 | review 0.7 | Finding | Review timing: #32 to #41 and A2 unreviewed; Review 10 too late | in review | review | `docs/review-10a`, PR #95 |
| RV-8 | review 0.8 | Finding | E1 "same gate" has no code path; needs an ADR before code | open | review | #60, `docs/adr-008-fast-path` |
| RV-9 | review 0.9 | Finding | Prompt-size baseline stale: 39 tools, 42.4 KB, not 29 and 27 KB | in progress | review | `docs/plan-reconcile` |
| RV-10 | review 0.10 | Finding | Accuracy baseline cannot finish in a week; start the recorder, add "that was wrong" | open | dev | #48, `feat/replay-recorder` |

## B. Review section 4 items (two-week plan)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| S4-1 T1 | review 4 | P0 | Mic cannot be stopped; F5 fails 9 in 10 | fixed in code, Mac check pending | dev | #86, `fix/mic-stop-f5` |
| S4-2 A7 | review 4 | P0 | "Forget that" same-ms tie; Linux `process-cwd` tty; `runner.ts:192` literal | fixed in code | dev | #52, `fix/forget-tie-ps-tty` |
| S4-3 R10a | review 4 | P0 | Review 10a over `013696d..qa` | in review | review | `docs/review-10a`, PR #95 |
| S4-4 A6a | review 4 | P0 | Replay recorder and "that was wrong" mark | open | dev | #48, `feat/replay-recorder` |
| S4-5 A1 | review 4 | P0 | Check script and plain Mac test steps | open | review | #91, #49, `feat/mac-checks`, `docs/mac-test-plain` |
| S4-6 B5 B2 | review 4 | P0 | "Remember" needs repeating; memory accuracy set | fixed in code, Mac check pending | dev | #90, #54, #68, `fix/remember-once` |
| S4-7 | review 4 | P1 | Ask Stephen button does nothing | fixed in code, Mac check pending | dev | #87, `fix/ask-button` |
| S4-8 A5 A8 | review 4 | P1 | CLI contract: `--effort` probe, version range, stream-json fixture | fixed in code | dev | #65, #67, `fix/claude-cli-contract` |
| S4-9 B1 | review 4 | P0 | Owner-only memory origin | fixed in code | dev | #53, `fix/memory-origin-you` |
| S4-10 DOC1 | review 4 | P1 | Reconcile docs (this ledger, plan corrections, superseded banners) | in progress | review | `docs/plan-reconcile` |
| S4-11 REL | review 4 | P0 | Release `qa` to `main` after R10a fixes and Mac sections 0 and 13 | open | owner | PR #92 (sync), release PR none |
| S4-12 C5 | review 4 | P0 | Split `AppClient.swift` | open | dev | #56, `ui/split-appclient` |
| S4-13 A2b | review 4 | P0 | Monitor gaps: Esc, chime, tool times, ASR and TTS names, cold or warm | fixed in code, Mac check pending | dev | #43, `feat/latency-gaps` |
| S4-14 E4a | review 4 | P1 | Wake endpoint p50 at or under 800 ms | open | dev | #73, `fix/wake-endpoint` |
| S4-15 E6a | review 4 | P0 | Command grammar in shadow mode | open | review | #59, `feat/command-grammar-shadow` |
| S4-16 A3 | review 4 | P0 | YouTube account-frame rule; real Zen must play YouTube with no prompt | open | dev | #50, `fix/youtube-account-frame` |
| S4-17 A4 | review 4 | P0 | open_url redirect residual: owner accepted; docs plus one test | accepted | review | #51, `docs/open-url-residual`, PR #96 |
| S4-18 | review 4 | P0 | ADR-007 conversation store and ADR-008 fast path and gate | open | review | #55, #60, `docs/adr-007-conversation-store`, `docs/adr-008-fast-path` |
| S4-19 | review 4 | P1 | Zen connect message (#89); bot-check facts (A9) | open | dev | #89, #66, `fix/zen-connect-message`, `docs/zen-bot-check` |
| S4-20 A6b | review 4 | P0 | Scorer and baseline v0 | open | review | #48, `feat/replay-scorer` |

## C. Open items named in the plan and older reviews

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| PL-1 | plan 1, review fact 5 | P0 | open_url redirect: a site's own 302 on the `open -a` path cannot be seen by a URL check | accepted | review | #51, `docs/open-url-residual`, PR #96 |
| PL-2 | plan 1, review fact 6 | P0 | YouTube `accounts.google.com` frame counted as a private read (`src/safety/domains.ts:291`) | open | dev | #50, `fix/youtube-account-frame` |
| PL-3 | review fact 39 | Low | VERIFY-2 N4 (shown text arms taint): fixed in code (`docs/DESIGN.md:196`), not recorded as closed | fixed in code | review | none |
| PL-4 | review fact 39 | Low | R7-1 (`serve --instance` lock): fixed in code (`src/serve-args.ts:25-29`), not recorded as closed | fixed in code | review | none |
| PL-5 | review fact 40, plan B3 | P1 | ElevenLabs key was pasted in chat; rotate it | open | owner | #69 |
| PL-6 | review fact 9 | P0 | `src/jobs/runner.ts:192` checks tty `??`, a Mac-only literal | open | dev | #52 |
| PL-7 | review 3.2 | P1 | `ui/chat-title` (F1) deferred to phase 3 | open | dev | #77 |
| PL-8 | review 3.2 | P1 | C2 UI items wait for C5: live steps, section pages, Connected and Permissions, recents | open | dev | #57 |
| PL-9 | plan C1 | P0 | Persist conversations and steps by command id (blocked on ADR-007) | open | dev | #55 |
| PL-10 | plan C4 | P0 | Review 10b and release | open | review | #58 |
| PL-11 | plan C6 | P1 | helper.sock nonce (peer user check already exists, review fact 35) | open | dev | #70 |
| PL-12 | plan B4 | P2 | Memory full: already built (review fact 33); close the issue after a check | fixed in code | dev | #79 |
| PL-13 | issue | P2 | Ask box: multi-line input and longer limit | open | dev | #88 |

## D. Review 10a (`docs/REVIEW-10A.md` on branch `docs/review-10a`)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R10a-1 | R10a | Medium | Action chain shows steps carrying another command's id | fixed in code | dev | #93, `fix/steps-other-command` |
| R10a-2 | R10a | Medium | "Try again" re-sends wake or phone speech as a trusted typed command | fixed in code, Mac check pending | dev | #94, `fix/retry-trust-esc-deny` |
| R10a-3 | R10a | Low | A failed tool call reads as done in the step list | open | dev | none |
| R10a-4 | R10a | Low | Home Allow and Deny delay starts when the view appears, not when the window is shown | open | dev | none |
| R10a-5 | R10a | Low | "Esc in the box means Deny" may not hold while the text field has focus | fixed in code, Mac check pending | dev | `fix/retry-trust-esc-deny` |
| R10a-6 | R10a | Low | `--effort` sent without a probe and saved to config; breaks every command on an old CLI | fixed in code | dev | none (overlaps #65, #67) |
| R10a-7 | R10a | Low | Latency report mixes cancelled and failed commands into p50, p95 and OVER | fixed in code | dev | `feat/latency-gaps` |
| R10a-8 | R10a | Low | At the 300-bubble cap new replies stop scrolling into view | open | dev | none |
| R10a-9 | R10a | Low | `chat.done` waits for an unbounded audit read (up to 5 MB) after every command | open | dev | none |
| R10a-10 | R10a | Info | Limits of "one id joins every log" (listener routes carry no `cmd`) | open | dev | none |
| R10a-11 | R10a | Info | Swift notes: dead "N questions waiting" branch, scroll carry-over, tall question card | open | dev | none |

## E. Review of `fix/mic-stop-f5` (#86, comment of 2026-11-12)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R86-F1 | #86 review | Medium | Esc in the Ask box sends the recording when the key listener is off (should cancel) | open | dev | #86, `fix/mic-stop-f5` |
| R86-F2 | #86 review | Low | A recording the listener drops by itself leaves the helper's press down (next F5 lost once, box still says Listening) | open | dev | none |
| R86-F3 | #86 review | Low | Clicking outside an unpinned Ask box sends the recording | open (decide) | dev | none |
| R10a-5 | R10a, owner Mac check 2026-11-12 | Low | Esc did not dismiss an Allow or Deny question in the main window (fails closed) | fixed in code, Mac check pending | dev | `fix/retry-trust-esc-deny` |

## F. Requests from the dev lane (tracker #10, 2026-11-12)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| DL-1 | tracker #10 | P0 | Review of the #86 fix | done (comment on #86) | review | #86 |
| DL-2 | tracker #10 | P0 | `mac-checks`: key listener check | in review | review | `feat/mac-checks-key-listener` |
| DL-3 | tracker #10 | P1 | Test plan section 0: re-add Input Monitoring after every `install-helper` | in review | review | `docs/mac-test-input-monitoring` |
| DL-4 | tracker #10 | P1 | Design note: keep the Input Monitoring grant across rebuilds | in review | review | `docs/helper-grant-note` |
| DL-5 | tracker #10 | P0 | ADR-008 Mac measurements: steps for the owner; 1 of 4 done | in review, 3 open for the owner | review, owner | `docs/adr-008-measurements` |

## G. Review 10b (`docs/REVIEW-10B.md`, PRs #111, #113 to #117) and the manager's jobs of 2026-11-13

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R10b-1 | R10b | Medium | The "?" guard of #114 never runs for speech: spoken questions save memory | open | dev | #122 |
| R10b-2 | R10b | Medium | `mac-checks` 13.1d false FAIL on the latency fields added by #117 | fixed, in review | review | `fix/mac-checks-latency-fields` |
| R10b-3 | R10b | Low | "don't forget my keys" saves a reminder as a fact | open | dev | #122 |
| R10b-4 | R10b | Low | New openers match video lines; the wake dialog says you said "remember" | open | dev | #122 |
| R10b-5 | R10b | Low | `doctor` problem mark for any Claude Code newer than 2.1.319 | open | dev | #123 |
| R10b-6 | R10b | Low | Shadow tier labels lean to Tier 2 (no site list given to the classifier) | open | review | none |
| LNX-1 | Linux run for #112 | Low | `ps` start time reads 1 s early on Linux; `process-cwd` test still fails; job stragglers may be missed | open | dev | #121 |
| MJ-1 | manager job 1 | P0 | Recorder plan review | waiting for the plan (checklist on tracker #10) | review | none |
| MJ-3 | manager job 3 | P1 | Resume without carrying permissions; click outside the Ask box | resume settled; #107 waits for the owner | review, owner | `docs/adr-007-resume`, #107 |
| MJ-6 | manager job 6 | P1 | Flaky suite research | in progress | review | #109 |
