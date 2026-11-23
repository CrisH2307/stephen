# Findings ledger

Started 2026-11-12 by `docs/plan-reconcile` (review item DOC1). One table of every open or recently closed finding and plan item.

**How to keep it current.** One row per finding. Never delete a row: set Status to `closed` with the PR or commit. Change the row in the same PR as the fix. New findings (a review, an issue, a Mac test) get a row the day they are filed. Issue numbers come from GitHub only; write `none` if there is no issue yet. Reviews and plan items that have their own doc stay summarised here in one line.

Columns. **Source**: where it was found (review = `docs/research/PLAN-REVIEW-2026-11.md`, plan = `PRODUCT-PLAN-2026-11.md`, R10a = `docs/REVIEW-10A.md` on branch `docs/review-10a`). **Severity**: Medium or Low for review findings; P0, P1, P2 for plan items (plan 4.1); Finding for the review's ten findings (not rated). **Lane**: dev (voice, trigger, gate, app code), review (review, docs, design, measurement), owner. **Status** values: open, in progress, fixed in code (not recorded), accepted, closed.

Status below is as of 2026-11-12 from the review and open GitHub issues. Nothing here was re-verified on the Mac.

Refreshed 2026-11-21 for the first `qa` to `main` release: every open row checked against merged PRs (up to #262) and GitHub issues. "Mac check pending" means the code is merged and only the owner's Mac check is left. Mac checks were not re-run for this refresh.

## A. The review's ten findings (section 0)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| RV-1 | review 0.1 | Finding | Reliable trigger has no P0 task; F5 works about 1 in 10, mic cannot be stopped | fixed (#108 merged; issue #86 closed 2026-11-18), Mac check pending (test plan 14.1) | dev | #86, `fix/mic-stop-f5` |
| RV-2 | review 0.2 | Finding | Tier 1 targets need endpointing; about 2.8 s on the wake path with zero model time | open: #240 (Ponytail P1) stops counting the VAD hangover as speech; the 800 ms target is not measured yet | dev | #73, `fix/wake-endpoint` |
| RV-3 | review 0.3 | Finding | A2 mostly done on `qa`; `tier` always null, Esc and chime not recorded; only #44 on `main` | fixed (#117 merged), Mac check pending; issue #43 still open | dev | #43, `feat/latency-gaps` |
| RV-4 | review 0.4 | Finding | "Parakeet expected winner" contradicts `docs/VOICE.md`; 300 ms rule excludes whisper-small | open | owner | #61 |
| RV-5 | review 0.5 | Finding | Several plan tasks already built or smaller than stated (see plan corrections) | closed (#97) | review | `docs/plan-reconcile` |
| RV-6 | review 0.6 | Finding | B1 overstated: non-owner memory origins exist only in the type | closed (#113) | dev | #53, `fix/memory-origin-you` |
| RV-7 | review 0.7 | Finding | Review timing: #32 to #41 and A2 unreviewed; Review 10 too late | closed (#95, Review 10a; Review 10b #124) | review | `docs/review-10a`, PR #95 |
| RV-8 | review 0.8 | Finding | E1 "same gate" has no code path; needs an ADR before code | closed (#101, ADR-008 written); the E1 code is still open on #60 | review | #60, `docs/adr-008-fast-path` |
| RV-9 | review 0.9 | Finding | Prompt-size baseline stale: 39 tools, 42.4 KB, not 29 and 27 KB | closed (#97) | review | `docs/plan-reconcile` |
| RV-10 | review 0.10 | Finding | Accuracy baseline cannot finish in a week; start the recorder, add "that was wrong" | in progress: recorder PR 1 merged (#166), fixes #170, #173 and #238 (#208); PR 2 Settings switch merged (#206); PR 3 label and "that was wrong" mark not started | dev | #48, `feat/replay-recorder` |

## B. Review section 4 items (two-week plan)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| S4-1 T1 | review 4 | P0 | Mic cannot be stopped; F5 fails 9 in 10 | fixed (#108 merged; issue #86 closed), Mac check pending (test plan 14.1) | dev | #86, `fix/mic-stop-f5` |
| S4-2 A7 | review 4 | P0 | "Forget that" same-ms tie; Linux `process-cwd` tty; `runner.ts:192` literal | closed (#112) | dev | #52, `fix/forget-tie-ps-tty` |
| S4-3 R10a | review 4 | P0 | Review 10a over `013696d..qa` | closed (#95) | review | `docs/review-10a`, PR #95 |
| S4-4 A6a | review 4 | P0 | Replay recorder and "that was wrong" mark | in progress: PR 1 (recorder, off by default, F5 only, 30-day purge, `stephen replay delete`) merged (#166), fixes #170, #173 and #238 (#208); PR 2 (Settings switch, owner-only app.sock `replay.set`, "Recording on" sign) merged (#206); PR 3 mark not started | dev | #48, `feat/replay-recorder`, `feat/replay-switch-48` |
| S4-5 A1 | review 4 | P0 | Check script and plain Mac test steps | closed (#98, #99, #105, #276: `mac-checks` and the plain test plan; release #279); the Mac pass itself is #49, owner | review | #91, #49, `feat/mac-checks`, `docs/mac-test-plain` |
| S4-6 B5 B2 | review 4 | P0 | "Remember" needs repeating; memory accuracy set | fixed (#114 merged; issue #90 closed), Mac check pending (test plan 14.4) | dev | #90, #54, #68, `fix/remember-once` |
| S4-7 | review 4 | P1 | Ask Stephen button does nothing | fixed (#118 merged; issue #87 closed), Mac check pending | dev | #87, `fix/ask-button` |
| S4-8 A5 A8 | review 4 | P1 | CLI contract: `--effort` probe, version range, stream-json fixture | closed (#115, #116) | dev | #65, #67, `fix/claude-cli-contract` |
| S4-9 B1 | review 4 | P0 | Owner-only memory origin | closed (#113) | dev | #53, `fix/memory-origin-you` |
| S4-10 DOC1 | review 4 | P1 | Reconcile docs (this ledger, plan corrections, superseded banners) | closed (#97; ledger kept current by #163, #176, #234 and this refresh) | review | `docs/plan-reconcile` |
| S4-11 REL | review 4 | P0 | Release `qa` to `main` after R10a fixes and Mac sections 0 and 13 | in progress: release prepared by the review lane 2026-11-21 (`docs/release-prep`); release PR not opened yet | owner | PR #92 (sync), release PR none |
| S4-12 C5 | review 4 | P0 | Split `AppClient.swift` | closed (#241, five files, no behaviour change); issue #56 still open | dev | #56, `ui/split-appclient` |
| S4-13 A2b | review 4 | P0 | Monitor gaps: Esc, chime, tool times, ASR and TTS names, cold or warm | fixed in code, Mac check pending | dev | #43, `feat/latency-gaps` |
| S4-14 E4a | review 4 | P1 | Wake endpoint p50 at or under 800 ms | open | dev | #73, `fix/wake-endpoint` |
| S4-15 E6a | review 4 | P0 | Command grammar in shadow mode | closed (#100, #126, #157: shadow mode, labels only); the full E6 stays on #59 | review | #59, `feat/command-grammar-shadow` |
| S4-16 A3 | review 4 | P0 | YouTube account-frame rule; real Zen must play YouTube with no prompt | open | dev | #50, `fix/youtube-account-frame` |
| S4-17 A4 | review 4 | P0 | open_url redirect residual: owner accepted; docs plus one test | closed (#96, accepted residual) | review | #51, `docs/open-url-residual`, PR #96 |
| S4-18 | review 4 | P0 | ADR-007 conversation store and ADR-008 fast path and gate | closed (#101 ADR-007 and ADR-008, #119 resume); ADR-007 v1 and v2 built in #257, #258 | review | #55, #60, `docs/adr-007-conversation-store`, `docs/adr-008-fast-path` |
| S4-19 | review 4 | P1 | Zen connect message (#89); bot-check facts (A9) | closed (#179 for #89; #177 and ADR-009 #212, #215 for the A9 facts); the ADR-009 add-on is not built | dev | #89, #66, `fix/zen-connect-message`, `docs/zen-bot-check` |
| S4-20 A6b | review 4 | P0 | Scorer and baseline v0 | open | review | #48, `feat/replay-scorer` |

## C. Open items named in the plan and older reviews

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| PL-1 | plan 1, review fact 5 | P0 | open_url redirect: a site's own 302 on the `open -a` path cannot be seen by a URL check | closed (#96, accepted residual) | review | #51, `docs/open-url-residual`, PR #96 |
| PL-2 | plan 1, review fact 6 | P0 | YouTube `accounts.google.com` frame counted as a private read (`src/safety/domains.ts:291`) | open | dev | #50, `fix/youtube-account-frame` |
| PL-3 | review fact 39 | Low | VERIFY-2 N4 (shown text arms taint): fixed in code (`docs/DESIGN.md:196`), not recorded as closed | closed (fixed in code before this ledger; `docs/DESIGN.md:196`, no PR of its own) | review | none |
| PL-4 | review fact 39 | Low | R7-1 (`serve --instance` lock): fixed in code (`src/serve-args.ts:25-29`), not recorded as closed | closed (fixed in code before this ledger; `src/serve-args.ts:25-27`, no PR of its own) | review | none |
| PL-5 | review fact 40, plan B3 | P1 | ElevenLabs key was pasted in chat; rotate it | open | owner | #69 |
| PL-6 | review fact 9 | P0 | `src/jobs/runner.ts:192` checks tty `??`, a Mac-only literal | closed (#112) | dev | #52 |
| PL-7 | review 3.2 | P1 | `ui/chat-title` (F1) deferred to phase 3 | open | dev | #77 |
| PL-8 | review 3.2 | P1 | C2 UI items wait for C5: live steps, section pages, Connected and Permissions, recents | open: unblocked by #241 (C5); parts landed in UI v4 (#246, #252 to #255); the issue needs a check of what is left | dev | #57 |
| PL-9 | plan C1 | P0 | Persist conversations and steps by command id (blocked on ADR-007) | closed (#257 v1 store, #258 v2 resume; #258 Mac check done before merge) | dev | #55 |
| PL-10 | plan C4 | P0 | Review 10b and release | closed (Reviews 10a #95 and 10b #124, release #279) | review | #58 |
| PL-11 | plan C6 | P1 | helper.sock nonce (peer user check already exists, review fact 35) | open | dev | #70 |
| PL-12 | plan B4 | P2 | Memory full: already built (review fact 33); close the issue after a check | fixed in code | dev | #79 |
| PL-13 | issue | P2 | Ask box: multi-line input and longer limit | fixed (#167 merged), Mac check pending | dev | #88 |

## D. Review 10a (`docs/REVIEW-10A.md` on branch `docs/review-10a`)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R10a-1 | R10a | Medium | Action chain shows steps carrying another command's id | closed (#110; issue #93 closed; release #279) | dev | #93, `fix/steps-other-command` |
| R10a-2 | R10a | Medium | "Try again" re-sends wake or phone speech as a trusted typed command | closed (#111; Mac check passed 2026-11-23; issue #94 closed; release #279) | dev | #94, `fix/retry-trust-esc-deny` |
| R10a-3 | R10a | Low | A failed tool call reads as done in the step list | fixed (#134 merged), Mac check pending | dev | `fix/review-10a-lows` |
| R10a-4 | R10a | Low | Home Allow and Deny delay starts when the view appears, not when the window is shown | open | dev | none |
| R10a-5 | R10a | Low | "Esc in the box means Deny" may not hold while the text field has focus | fixed (#111 merged), Mac check pending | dev | `fix/retry-trust-esc-deny` |
| R10a-6 | R10a | Low | `--effort` sent without a probe and saved to config; breaks every command on an old CLI | closed (#115) | dev | none (overlaps #65, #67) |
| R10a-7 | R10a | Low | Latency report mixes cancelled and failed commands into p50, p95 and OVER | closed (#117) | dev | `feat/latency-gaps` |
| R10a-8 | R10a | Low | At the 300-bubble cap new replies stop scrolling into view | fixed (#134 merged), Mac check pending | dev | `fix/review-10a-lows` |
| R10a-9 | R10a | Low | `chat.done` waits for an unbounded audit read (up to 5 MB) after every command | closed (#134) | dev | `fix/review-10a-lows` |
| R10a-10 | R10a | Info | Limits of "one id joins every log" (listener routes carry no `cmd`) | closed 2026-11-17: limit documented in `src/voice/command-log.ts` and `docs/VOICE.md` | review | #10 |
| R10a-11 | R10a | Info | Swift notes: dead "N questions waiting" branch, scroll carry-over, tall question card | open, in #139 part 1 (card id per question, scrolling card, delete the dead branch); #252 stopped the card fading in on Home mid-chat | dev | #139 |

## E. Review of `fix/mic-stop-f5` (#86, comment of 2026-11-12)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R86-F1 | #86 review | Medium | Esc in the Ask box sends the recording when the key listener is off (should cancel) | closed (#108; Mac check passed 2026-11-23; release #279) | dev | #86, `fix/mic-stop-f5` |
| R86-F2 | #86 review | Low | A recording the listener drops by itself leaves the helper's press down (next F5 lost once, box still says Listening) | fixed (#152 merged), Mac check pending | dev | #106, #152 |
| R86-F3 | #86 review | Low | Clicking outside an unpinned Ask box sends the recording | fixed (#129 merged; owner chose cancel, 2026-11-16), Mac check pending | dev | #107, #129 |
| R10a-5 | R10a, owner Mac check 2026-11-12 | Low | Esc did not dismiss an Allow or Deny question in the main window (fails closed) | fixed (#111 merged), Mac check pending | dev | `fix/retry-trust-esc-deny` |

## E2. Issues filed 2026-11-12 to 17 with no row before (added by the handoff of 2026-11-16)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| I-109 | tracker #10 | Low | Full test suite flaky under CPU load (fixed sleeps in the clicks eval; two suites at once) | in progress: #131, #178, #242, #247 and #262 fixed races; macOS CI had 10 green runs (#195); a new macOS flake on 2026-11-22 is #263 (row I-263) | dev | #109, #131 |
| I-121 | Linux run for #112 | Low | Linux: `ps` start time reads 1 s early; a job's first-second process may be left running | closed (#132 merged; Linux only, Docker: 5 of 5) | dev | #121, #132 |
| I-137 | review of #128 | Medium | By voice, "remember that song" and "remember the milk" still save (older than #128) | closed (#162; Mac check passed 2026-11-23; release #279). Cost: by voice a name or label with no verb ("my daughter Lily") needs "is" or typing. Ad lines with a real verb still need the wake dialog | dev | #137, `fix/remember-fact-shape` |

## F. Requests from the dev lane (tracker #10, 2026-11-12)

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| DL-1 | tracker #10 | P0 | Review of the #86 fix | done (comment on #86) | review | #86 |
| DL-2 | tracker #10 | P0 | `mac-checks`: key listener check | closed (#105) | review | `feat/mac-checks-key-listener` |
| DL-3 | tracker #10 | P1 | Test plan section 0: re-add Input Monitoring after every `install-helper` | closed (#103) | review | `docs/mac-test-input-monitoring` |
| DL-4 | tracker #10 | P1 | Design note: keep the Input Monitoring grant across rebuilds | option A fixed (#104 note, #135 merged), Mac check pending | review | `docs/helper-grant-note`, `feat/install-helper-skip-unchanged` |
| DL-5 | tracker #10 | P0 | ADR-008 Mac measurements: steps for the owner; 1 of 4 done | in progress: #102 merged; 3 of 4 measurements open for the owner | review, owner | `docs/adr-008-measurements` |

## G. Review 10b (`docs/REVIEW-10B.md`, PRs #111, #113 to #117) and the manager's jobs of 2026-11-13

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R10b-1 | R10b | Medium | The "?" guard of #114 never runs for speech: spoken questions save memory | closed (#128; Mac check passed 2026-11-23; release #279) | dev | #122 |
| R10b-2 | R10b | Medium | `mac-checks` 13.1d false FAIL on the latency fields added by #117 | closed (#125) | review | `fix/mac-checks-latency-fields` |
| R10b-3 | R10b | Low | "don't forget my keys" saves a reminder as a fact | fixed (#128 merged), Mac check pending | dev | #122 |
| R10b-4 | R10b | Low | New openers match video lines; the wake dialog says you said "remember" | fixed (#128 merged), Mac check pending | dev | #122 |
| R10b-5 | R10b | Low | `doctor` problem mark for any Claude Code newer than 2.1.319 | fixed (#130 merged), Mac check pending | dev | #123 |
| R10b-6 | R10b | Low | Shadow tier labels lean to Tier 2 (no site list given to the classifier) | fixed (#157 merged 2026-11-17) | review | #157 |
| LNX-1 | Linux run for #112 | Low | `ps` start time reads 1 s early on Linux; `process-cwd` test still fails; job stragglers may be missed | closed (#132 merged; Linux only, Docker: 5 of 5) | dev | #121 |
| MJ-1 | manager job 1 | P0 | Recorder plan review | done: plan accepted with 8 points (#10, 2026-11-17); PR #166 reviewed | review | #166 |
| I-169 | review of #166 | High | Recorder: the owner-only check ignored letter case (`~/.stephen/Replay/...` passed `upload_file`, the answer told whether a clip exists); clips could outlive 30 days while the listener ran; a future start time never expired; the synced-folder check ignored case | closed (#170, #173; release #279). #173 fixed the smaller points: Google Drive and OneDrive folders refused; the boundary scan fails on non-literal `import(`/`require` and on any spelling of "replay"; at most 5 clips wait for the disk and each write has a 30 s limit. Leftovers (Desktop and Documents in iCloud; Fn+Option in the PR 2 switch text) moved to #278 | dev | #169 |
| MJ-3 | manager job 3 | P1 | Resume without carrying permissions; click outside the Ask box | closed (#119 resume; #129, owner chose cancel) | review, owner | `docs/adr-007-resume`, #107 |
| MJ-6 | manager job 6 | P1 | Flaky suite research | in progress: #131, #242, #247, #262 merged; #109 and #263 open | review | #109 |
| UI-149 | #136, UI review P12 | P2 | Home: New chat button, composer focused, shortcut hints | closed (#196 merged), Mac check pending | dev | #149 |
| UI-147 | #136, UI review P10 | P2 | Settings: Cmd+comma on the last pane, one title, captions | closed (#200 merged), Mac check pending | dev | #147 |
| UI-145 | #136, UI review P8 | P2 | Keyboard, VoiceOver, hit targets, text size | in progress: buttons and 24 pt targets merged (#204); VoiceOver announcements, text size, Esc to stop to do | dev | #145 |
| PA-202 | Ponytail audit | Low | Simplify and speed up: dead code, perf, tests | in progress: DEAD, A1, A2, B1, B2, B3, T4, T5, C6, T1 merged (#209 to #211, #217 to #227, #229 to #233); then P1 (#240), H3 (#239), C7 (#243), C1 (#244), C2 (#245); T2 and C8 open | dev | #202 |

## H. Findings filed 2026-11-18 to 22 (added by the release prep of 2026-11-21)

Severity "not rated" means the review named the problem but gave no level.

| ID | Source | Severity | Title | Status | Lane | Issue or branch |
|---|---|---|---|---|---|---|
| R258-1 | Review 10b of #258 | not rated | Planted wrapper head or end lines in an earlier turn could look like Stephen's own wrapper; U+0085, U+2028, U+2029 not folded | closed (#258, cfb405e) | dev | #258 |
| R258-2 | Review 10b of #258 | not rated | Any `chat.send` could take the resume arm, not only one from the window socket | closed (#258, bce6a50, 640fd54) | dev | #258 |
| R258-3 | Review 10b of #258 | not rated | Resume of a conversation that is gone, or too big, could fail silently | closed (#258, b12cb0e: "That conversation is no longer saved.", " [cut to fit]") | dev | #258 |
| R258-4 | Review 10b of #258 | not rated | No test that the resumed serve's taint reaches the next one-shot serve | closed (#258, 4ed012a) | dev | #258 |
| R252-1 | review of #252 | not rated | "Started a job, Open in Jobs" matched jobs by time only, so a phone or routine job could get an ok mark | closed (#252, line removed); follow-up: bring it back once `JobRow` carries a command id | dev | #252 |
| R252-2 | review of #252 | not rated | The question card could fade in on Home mid-chat (#139) | closed (#252, test pinned) | dev | #252 |
| R253-1 | review of #253 | not rated | Sidebar drag started from an unclamped width; NaN width; window min width grew with a collapsed sidebar; old `settingsPane` values; "it proposes, you keep" not always shown | closed (#253) | dev | #253 |
| R253-2 | #253 follow-ups | Low | Grouped Form rows use system colours (Navy, Rose, Sun may look off); sidebar resize has no keyboard way | open | dev | none |
| R254-1 | review of #254 | not rated | A failed job could move to Earlier; Return in the inspector kept a suggestion; Keep on an empty edit | closed (#254, tests pinned) | dev | #254 |
| R255-1 | review of #255 | not rated | VoiceOver label type, what you said not copyable, palette query not cleared by the sidebar and Cmd+2 | closed (#255) | dev | #255 |
| R257-1 | review of #257 | not rated | `finishCommand` could reject and drop the history line; line time; `--text` could hang on an audit read | closed (#257) | dev | #257 |
| I-248 | tester intern, Mac test 0.2 and 0.4 | Medium | `swiftc` cannot find `SwiftUIMacros.StateMacro` on macOS 27.2.1, so `install-helper` fails | closed (#251: fall back to an older SDK; Mac check passed 2026-11-23; issue closed; release #279) | dev | #248 |
| I-249 | tester intern | Low | `npx vitest run` fails on Node 21.5.0 but `doctor` passes it | closed (#250: engines `^20.19.0 \|\| >=22.12.0`, doctor checks the same) | dev | #249 |
| I-262 | macOS CI | Low | Two macOS CI flakes: Zen early exit race, cross-site iframe click read too early | closed (#262) | dev | #109, #262 |
| I-263 | macOS CI on qa `cd8027e` | Low | `test/drivers/review1.test.ts` D4 "defaults to a 60 s Allow wait" got "Not connected." | open (flake, not rerun alone yet) | dev | #263, #109 |
| CI-14 | GitHub, PR #259 | Low | GitHub retired the hosted `macos-14` runner on 2026-11-02; no macOS 14 job is possible | closed (#259: macOS 14 is the minimum, the `macos` job on macos-15 builds the helper for a macOS 14 target; #260 research) | review | #259, #260 |
| I-171 | tracker | Low | Second test suite: the lock message was lost in a vitest TypeError | closed (#178; issue closed; release #279) | dev | #171 |
| I-207 | CI #195 | Low | A click after typing is lost when the Chrome window is not painting (macOS CI) | open; CI uses headless Chrome on macOS as the workaround (#195) | dev | #207 |
| I-208 | review of #206 | Medium | Recording on sign can lag after a hand edit of config.json; a clip can land after off or Delete | closed (#238) | dev | #208 |
| DEC-261 | dev lane decision | Low | A "?" anywhere blocks a typed memory save too, not only a spoken one | closed (#261) | dev | #261 |
| I-205 | issue | not rated | Voice: stop music while it plays (duck on wake, pause by media key) | closed (#216 voice side, #228 Mac media key; release #279) | dev | #205 |
| I-270 | CI on qa | Low | CI failed on qa (warm-claude flake, #109) | closed (#267: the fake serve counts as connected only after its claim line is logged; release #279) | dev | #270, #109 |
| I-278 | review of #169 | Low | Recorder leftovers from #169: Desktop and Documents in iCloud, Fn+Option in the switch text | open | dev | #278 |
