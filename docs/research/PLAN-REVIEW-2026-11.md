# Independent review of the 2026-11 product plan

Date: 2026-11-12. Reviewer: independent (did not write the plan or the code). Nothing under `src/` or `test/` was changed.

**Reviewed.** `PRODUCT-PLAN-2026-11.md` (revision of 2026-11-11, with U9, F10, G7; newer than the repo copy) and `IDEAS-RESEARCH-2026-11.md` (revision 3, not in the repo). Code and docs: `origin/qa` @ `1b6eb8c`, `origin/main` @ `425608a`. GitHub issues #43 to #91 read through the REST API on 2026-11-12.

**Method.** Read the code at the cited lines, grep, one build, one full test run on Linux, one size measurement over MCP `tools/list`, one run of `redirectSignals` on the three redirect cases.

**Limits.** No Mac here: Swift, TCC, audio, Keychain and real `claude -p` runs are unverified. External sources in the plan (market table, 8.1 to 8.5 links) were not re-fetched; those claims are out of scope. Where a verdict is inference, it says so.

## 0. Ten findings that change the plan

1. **Must-have 1 (reliable trigger) has no P0 task, and the first Mac data says it is the worst stage.** Owner Mac test 2026-11-11: F5 worked about 1 time in 10 after the mic was started from the app and the mic could not be stopped (#86); 5 of 9 wake triggers never became a command (#43 comment: 4 ignored for sound or cooldown, 1 not confirmed; some may be correct ignores). This goes first.
2. **Tier 1 targets cannot be met by skipping the model alone.** Measured on the Mac (#43 comment): wake endpoint wait 1,500 ms, ASR 0.6 to 0.7 s, first audio 0.6 to 0.7 s after the reply text. That is about 2.8 s on the wake path with zero model time. E4 (endpointing) is on the Tier 1 critical path and is P1 in the plan.
3. **A2 is mostly done on `qa`** (PRs #44, #46, #47, #84), but `tier` is always null, "action done", Esc to silence and wake to chime are not recorded, and only its first PR (#44) is on `main`.
4. **"Parakeet is the expected winner" contradicts the repo's own test.** On accented speech whisper-small.en scored 77.4%, Parakeet v2 73.2%, v3 75.4% (`docs/VOICE.md:584-586`). The E2 rule "decode p50 under 300 ms" would also exclude whisper-small (0.6 to 0.7 s measured on the Mac).
5. **Several tasks are already built or smaller than stated:** F5 release as hard end of speech (E4), two of the three redirect cases (A4), the "memory full" reply (B4), the peer user check on helper.sock (C6), a misheard-transcript eval and persona hint (7.0), per-command history on disk (C1).
6. **B1's risk is overstated.** The four non-owner origins exist only in the type; the one writer passes `you` (`src/app/server.ts:403`). B1 is a tiny hardening, not an open hole.
7. **Review timing is wrong twice.** PRs #32 to #41 are on `main` with no independent review, A2 changed `src/safety/audit.ts` with none on record, and Review 10 (C4) sits at the end of 1.9c. Q19 asks Review 10 to check the fast path, which is built later (2b).
8. **E1 "same gate" has no code path today.** The gate and its taint live inside `stephen serve`, a child of `claude`. The listener's existing zero-turn routers (memory, timer, job) do not pass through it. E1 needs an ADR before any code.
9. **The prompt-size baseline is stale.** Today `serve --voice` lists 39 tools and 42.4 KB of tool definitions (measured), not 29 tools and 27 KB.
10. **The accuracy baseline cannot finish in the planned week.** 100 real commands at the plan's own use target (10 a day) is 10 days, and missed triggers leave no record to replay. Start the recorder now; add a "that was wrong" mark.

## 1. Fact check

Verdicts: confirmed, wrong, stale, partly, unverifiable here.

| # | Plan claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `main` @ `29b0a7d`, `qa` @ `719c512`, identical trees | stale | `qa` @ `1b6eb8c` is 13 commits ahead; `main` @ `425608a` has PR #85 (Mac test plan section 13) that `qa` lacks; sync PR #92 is open |
| 2 | 250 commits from 10-30 to 11-09 | partly | 232 commits reachable from `719c512`; first commit dated 2026-10-31 |
| 3 | Nine security reviews | confirmed | `docs/REVIEW-1.md` to `REVIEW-9.md` |
| 4 | Every box in `MAC-TEST-PLAN.md` unticked; Mac paths reviewed by reading only | partly | 87 `[ ]`, 0 ticked. But real Mac checks are recorded: `docs/HANDOVER.md:419` (first Mac run), `:436` and `:487-490` (phone lock checks on the Mac), `docs/REVIEW-9.md:5` (probes on the Mac), issue #49 comment (sections 11 to 13 run 11-11) |
| 5 | open_url redirect gaps open: site 302, `?u=//host`, bare host | stale | `//host` and bare host are flagged since 10-31: `src/desktop/url.ts:122-124,141-145`, `test/desktop/redirect-bare.test.ts`. Run on `dist`: both return a signal. Only the site's own 302 returns none, and no URL check can see it |
| 6 | YouTube `accounts.google.com` frame counts as a private read | confirmed in code | `src/safety/domains.ts:291` (sensitive list); `docs/MAC-TEST-PLAN.md:201-202`. Behaviour on YouTube unverifiable here |
| 7 | Mac 11-09: 3,143 passed, 0 failed | unverifiable here | `docs/HANDOFF-NEXT.md:25` says 3143 passed, 5 skipped; host not stated |
| 8 | Linux: 2 failures (`process-cwd`, `memory-flow.test.ts:197`) | partly | Full run on `qa`, Linux, 2026-11-12: 3,193 tests, 3,175 passed, 17 skipped, **1 failed**: `test/lib/process-cwd.test.ts:26` (`ps` prints tty `?`, test expects `??`). `memory-flow` passed there and in 8 more runs. The tie is real: `newestWithin` uses strict `>` on millisecond times (`src/memory/intent.ts:182`), so equal times keep the older item. It is flaky, not steady |
| 9 | (not in plan) same Mac literal in product code | new | `src/jobs/runner.ts:192` checks `p.tty === '??'`. A test-only fix leaves this check dead on Linux |
| 10 | No Swift unit tests | partly | `test/helper/swift.int.test.ts` compiles `helper/Core.swift` with a harness and drives it (runs only where `swiftc` exists). No tests for the UI files |
| 11 | `AppClient.swift` about 1,790 lines | confirmed | 1,801 lines now; A2 added 12. `helper/` total 6,381 |
| 12 | "On the Mac: request median 3,407 ms, model 1,774 ms per turn" | host unverified | Source is PR #22 (`STEPHEN-DOSSIER.md:713`), from the 11-08 away batch (`HANDOVER.md:492-495`). `MAC-TEST-PLAN.md:205` still lists the speed eval as not run |
| 13 | Warm conversation: overhead 1.3 to 1.6 s down to 0.01 to 0.03 s (listed under "On the Mac") | numbers confirmed, host wrong | "Linux cloud box": `docs/SYSTEM-DESIGN-STEPHEN.md:371`; "The Mac numbers are still to be measured": `:381` |
| 14 | whisper-small.en 77.4% accented vs 97.3% clean | confirmed, with a caveat | `docs/VOICE.md:584`. Synthetic TTS voices, 240 clips, set not committed (`:570-580`). Not the owner's voice |
| 15 | Parakeet is the expected ASR winner (8.2) | contradicted in repo | Accented: Parakeet v2 73.2%, v3 75.4%, whisper-small 77.4%. Noisy: 77.5, 77.7, 82.9 (`VOICE.md:584-586`). `VOICE.md:603-608` chose whisper-small for accents and names. Parakeet wins on speed only |
| 16 | whisper-small 1.50 s vs Parakeet 0.48 s per 4 s clip (Linux); Moonshine 0.42 s | confirmed | `VOICE.md:584-590`. Mac times in that table are estimates. Mac measured ASR: 0.6 to 0.7 s (#43 comment) |
| 17 | No hotwords for Whisper or Moonshine; Parakeet attempt failed | confirmed | `VOICE.md:611-618` |
| 18 | Bare "Stephen" wakes on 33 of 180 negatives | misattributed | 33/180 is the spotter with all four phrases on look-alike sentences (`VOICE.md:664`). End to end 3 of 360 became a command and "No bare-Stephen wake became a false command" (`:671-674`) |
| 19 | Wake recall 82/90 clean, 74/90 noisy | confirmed | `VOICE.md:659`, synthetic. Same row: 52 and 59 before the bare and "okay" spellings were added |
| 20 | Endpoint silence 0.8 to 1.5 s | confirmed | `src/voice/config.ts:168-173`; the 1.5 s applies after 2.5 s of speech (`src/voice/listener.ts:115,590-595`). Mac wake commands waited 1,500 ms (#43) |
| 21 | F5 release as hard end of speech is to be built (E4, Q5) | wrong, already built | `src/voice/listener.ts:522-533`; `config.ts:176`. Mac: F5 waits 11 ms (#43) |
| 22 | ASR decodes off the main thread | confirmed | `src/voice/engine.ts:335` (`decodeAsync`); wake and stop spotter decodes are sync (`engine.ts:199,223`) |
| 23 | No Claude Code version check | confirmed, incomplete | No `claude --version` compare in `src/`. A flag probe exists: `claude --help` is checked for 9 required lock-down flags (`src/voice/claude.ts:757-793`). `--effort` is not probed (`claude.ts:332`) |
| 24 | Stephen has seen 2.1.314 to 2.1.319 | confirmed | grep over `src`, `test`, `docs`; also 2.1.302 |
| 25 | 27 KB of tool schemas, 42 KB per turn | stale | Source `VOICE.md:408` (29 tools, October). Measured on `qa`: `serve --voice` 39 tools, 42,410 bytes of `tools/list` JSON; plain `serve` 38 tools, 41,652 bytes. Persona 7.3 KB, 13.6 KB with 30 full memory items |
| 26 | Memory proposals accept `chat`, `email`, `canvas`, `web` (`store.ts:47`) | confirmed in the type only | `src/memory/store.ts:47`. The only writer passes `'you'` (`src/app/server.ts:403`). End-of-chat proposals are not built (`HANDOFF-NEXT.md:71`) |
| 27 | The transcript is lost on restart | partly | The window's chat is in memory. Each command's said, reply and tools are on disk by the same `h_` id in `<home>/history/` (`src/history/store.ts:2-8,73`), default retention 1 day |
| 28 | Conversations matches steps to audit lines by time | partly fixed by A2 | Lines with the command's `cmd` are added; the time window stays; "the id is a label and can be wrong" (`src/app/steps.ts:10-13`) |
| 29 | Name fix only for names in memory, one edit away | confirmed | `src/voice/names.ts:37-64`; also 5+ letters, unique match, common words skipped |
| 30 | No eval uses noisy transcripts | wrong | Category `misheard`, 6 cases (`src/eval/cases.ts:73-79`). The persona already says names are misheard (`claude.ts:64-67`) |
| 31 | 30 items of 200 characters, all in the prompt each run | confirmed | `store.ts:31-33`; `claude.ts:141-142,159-168`. Memory is already the last block of Stephen's prompt, with "use them when relevant" |
| 32 | A warm conversation may hold an older memory copy (8.5) | wrong | A memory change ends the conversation: `src/app/server.ts:368-369`, `src/voice/assistant.ts:222`, `src/voice/conversation.ts:323` |
| 33 | Silent drop of the 31st item (B4) | wrong | `add` returns `full` and says "My memory is full. Forget something first." (`store.ts:95,240`; `test/memory/store.test.ts:140,151`) |
| 34 | Phone trust gets no memory | confirmed | `claude.ts:173-175` |
| 35 | helper.sock is not authenticated (C6) | partly | The helper rejects a peer of another user (`helper/Core.swift:705`) and checks app.sock's owner (`helper/AppClient.swift:806`). No nonce |
| 36 | Five of six build items in `HANDOFF-NEXT.md` are UI | confirmed | `HANDOFF-NEXT.md:39-57` |
| 37 | Serve cold start 0.9 s; E8 saves about 0.3 s | partly | 0.9 s is `claude` spawn to serve up (`ADR-003:27-28`, Linux). Serve alone: 420 to 500 ms (`VOICE.md:404`); 361 ms measured here |
| 38 | IDEAS: 39,700 TS lines, 6,300 Swift, 8 files with `osascript`, 3,148 tests | partly | 40,575 and 6,381 now; 8 confirmed. But macOS-only commands (`open`, `security`, `afplay`, `say`, `ps`, `lsof`) are spawned directly from at least 13 files (more go through variables); 3,193 tests now |
| 39 | VERIFY-2 N4 and R7-1 need a re-check (Q19) | both have fixes in code | N4: `docs/DESIGN.md:196`. R7-1: `serve --instance` lock (`src/serve-args.ts:25-29`). No doc records them as closed |
| 40 | ElevenLabs key leaked (B3) | confirmed | `HANDOVER.md:22`, `ROADMAP.md:159`. Still an owner action |

## 2. Status update (as of `qa` @ `1b6eb8c` and issues on 2026-11-12)

Every plan task has a GitHub issue (#43, #48 to #83). The owner ran Mac test sections 11 to 13 on 2026-11-11 and filed #86 to #91.

| Task | Status | What exists | What is left |
|---|---|---|---|
| A2 | Mostly done on `qa`; only PR #44 is on `main`; #43 open | One `h_` id from trigger through history, tool log and audit (`src/lib/command-id.ts`); 7 stages; rows for triggers that never became a command; loop p99; model, tools and first-token times; first audio; `stephen latency` for 1, 7, 30 days by trigger and route; slowest 10; OVER flag; Settings > Speed; 30-day retention, 0600 | `tier` always null (`src/telemetry/latency.ts:182`); no "action done" stage; Esc to silence and wake to chime not logged (`src/telemetry/cli.ts:11-12`); no per-tool names and times in the record; no ASR model, TTS engine, cold or warm code word; no tokens, prompt size, RSS; no independent review on record |
| A1 | Partly run | Sections 11, 12, 13 run 11-11; fails filed | Sections 0 to 10; plain-language steps and a check script (#91) |
| A3 | Not started | Behaviour seen again on the Mac (11.2) | Owner decision, gate change, review |
| A4 | Two of three cases closed in October | See fact 5 | Decide the 302 residual; no failing test is possible for it |
| A5 | Not started | `claude.ts:332` notes the gap | |
| A6 | Not started | `misheard` eval cases; latency outcomes count some trigger failures | Recorder, labels, scorer |
| A7 | Open | 1 steady Linux failure, 1 flaky tie | Also `src/jobs/runner.ts:192` |
| A8 | Not started | Flag probe and a recorded help fixture exist | Version range, stream contract test |
| A9 | Not started | #89 covers the message only | |
| B1 | Not started | No producer of non-owner origins | Narrow the type, drop on read |
| B4 | Already correct | See fact 33 | Close #79 or reduce to a Memory page hint |
| B5 | Evidence arrived | #90: "remember" had to be repeated | Classify with the latency route (`memory` or `model`) |
| C1 | Base exists | History store by command id | Conversation grouping, steps, retention, `chat.history`, replay rule |
| C5 | Not started | File grew to 1,801 lines | |
| C6 | Half exists | Peer user check | Nonce only; low value under the stated threat model |
| E1 | Prefigured | Memory, timer and job routes run with 0 model turns (`src/voice/assistant.ts:203-207`); Mac app/memory p50 89 ms (#43) | Open, play, pause, resume, next, volume, mute, stop; gate access design |
| E4 | F5 half built | See fact 21 | Wake endpoint only |
| E6 | Small base | `names.ts`, persona hint, 6 eval cases | Grammar, aliases, shadow classifier |
| D2, D3 | Partly built | `brief-day` case; 7 `inject-*` cases and 9 `read-*` cases in `src/eval/cases.ts` | Per-source counts, a no-gate baseline, 3 runs |
| HANDOFF-NEXT items 1 to 6 | None started | The team switched to the plan's table after #42 | See 3.2 |
| Review 10 | Not started | | Unreviewed since Review 9 (`013696d..qa`): `src` 26 files, +1,105 lines; `helper` 10 files, +710 lines |

First real numbers (owner Mac, 25 triggers, #43 comment): ptt/model speech to reply p50 2.1 s, p95 6.6 s; wake/model p50 10.2 s, p95 20.1 s (n of 4); first model token 1.1 to 1.3 s on every path; slow commands are slow in the model (up to 13 s) and in tools (3.5 to 5 s).

## 3. Plan critique

### 3.1 Ordering and dependency errors

| # | Error | Why | Fix |
|---|---|---|---|
| 1 | No task for trigger reliability | Must-have 1; #86; 5 of 9 wake triggers lost. A6 replays recorded commands, so it cannot see a press or wake that never fired | New P0 first: fix #86, then measure triggers |
| 2 | A6 gates E6, E2, E7, E4, E3 but needs about 10 days of use | 1.9a is "about 1 week" | Split: A6a recorder now, A6b scorer at 30 labels (baseline v0), final at 100 |
| 3 | E4 is P1 and after E1 in priority | Tier 1 floor on wake is endpoint 1.5 s + ASR 0.65 s + audio 0.65 s | E4 (wake) becomes P0 and precedes any Tier 1 target check |
| 4 | Review 10 at the end of 1.9c; fast path built after it | Q19 lists "gate reachability from the fast path" for Review 10 | Review 10a now (`013696d..qa`), 10b at the 1.9 exit, Review 11 after E1 |
| 5 | E1 depends only on A2, E6 | It also needs a gate-access design (3.5) and E4 | Add ADR-008 as a dependency |
| 6 | E5 depends on E1 | After E1, "play" has no model turn, so there is no announce turn to fold | Drop the fold; keep "acknowledgement policy" as its own task (3.3 item 4) |
| 7 | E2 after E6 in the table; E2 rule "p50 under 300 ms" | Fuzzy thresholds tuned on one model's errors go stale when the model changes; the rule contradicts "accuracy first" and fact 15 | E2 before E6b. Choose by end-to-end success on the replay set; speed breaks ties within 2 points |
| 8 | A3 depends on all of A1 | It needs only section 11.2, which ran on 11-11 | A3 is blocked only by the owner decision |
| 9 | C2 depends on C1 | Only item 4 (recents) needs persistence | Items 1 to 3 depend on C5 only |
| 10 | F10 depends on C5; G7 depends on F10 | F10 is TypeScript only. A throwaway spike does not need the seam; it tells what the seam must cover | Remove both dependencies |
| 11 | E9 depends on E1 | Routing light Tier 2 turns needs A2 numbers and the eval, not the fast path | Depends on A2, D3 |
| 12 | Key rotation hidden inside B3 (P1, 1.9b) | A leaked key is live now | Owner action today, outside the queue |
| 13 | Phase names collide | `docs/ROADMAP.md:140-149` uses 2b for "careful actions", 3 for "follow-ups and speed", 4 for "cursor control" | Rename in the plan or fix ROADMAP now, not in phase 3 (F2) |
| 14 | Branch rule vs reality | `BRANCHING.md` says cut from `main`; A2 PRs #46, #47, #84 are only on `qa`, so A6, C1 and E6 cannot be cut from `main`. PR #85 also went straight to `main` after the rule changed | Release the A2 batch, or allow "cut from `qa` when the work needs unreleased code" |

### 3.2 HANDOFF-NEXT against the plan: one order

`docs/HANDOFF-NEXT.md` is superseded in practice by `docs/research/HANDOFF-PROMPT-CLAUDE-CODE.md`, but both are in the repo and they disagree (who merges into `qa`, who pushes, what comes first). Mark HANDOFF-NEXT as superseded.

| HANDOFF-NEXT item | Plan ID | Verdict | Where it goes |
|---|---|---|---|
| 1 `ui/live-steps` | C2.1 | Keep. Cheapest step toward "the window is the record"; uses the command id | First UI branch after C5 (week 3) |
| 2 `ui/section-pages` | C2.2 | Keep, visual only | After live steps |
| 3 `ui/connected-permissions` | C2.3 | Keep. Also covers the "visible safety" idea (F11) | After section pages |
| 4 `ui/recents` | C2.4, C1 | Blocked on ADR-007 (retention, replay rule). Ship view-only first | After C1 |
| 5 `ui/chat-title` | F1 | Defer. A model call per chat on a Pro plan for a cosmetic gain | Phase 3 |
| 6 `fix/model-everywhere` | A5 | Do now, merged with A8 (both touch the CLI flag probe) | Week 1 |
| 7 Review 10 | C4 | Split into 10a now and 10b later | Week 1 |
| 8 Release | C4 | One release after 10a, so branches can be cut from `main` again | Week 1 |

### 3.3 Missing tasks

1. **Trigger reliability (T1).** Fix #86. Then a recorded wake set in the owner's voice and room (7.3 names it; no task builds it).
2. **"That was wrong" mark.** 7.0 and 7.3 measure real-use success with it. No task builds it. It is also the only way to count a missed wake.
3. **Findings ledger.** One page listing every High and Medium from Reviews 1 to 9 and VERIFY 2 and 3 with status and evidence. The 1.9a exit says "zero open High" and nothing can show it today.
4. **Tier 2 spoken acknowledgement.** Target p50 1.0 s. First token is 1.1 to 1.3 s plus 0.65 s to first audio, so the model cannot do it. It needs a local, fixed line or an earcon, and a rule for when it plays.
5. **Review 11** after E1 and E6.
6. **Monitor gaps (A2b).** See section 2, A2 row.
7. **Schema baseline refresh.** E3's target ("27 KB toward 8 KB") starts from a number that is 15 KB too low.
8. **Mac check script (#91).** The owner cannot run section 13 as written.
9. **Plan and ideas files into the repo.** The repo copy lacks U9, F10, G7; IDEAS-RESEARCH is absent.

### 3.4 Over-scoped or under-specified

| Task | Problem | Change |
|---|---|---|
| B1 | Framed as a live risk | Size S to tiny: narrow `PROPOSAL_ORIGINS`, drop other origins on read, one test |
| B4 | Describes behaviour that does not exist | Close |
| C6 | Peer check exists; a nonce in a file does not stop a same-user process, which the threat model excludes anyway | Defer until a Swift audio move is real; note for Review 10b |
| A4 | "Three failing tests" | One residual; it is a policy choice, not a test |
| E4 | Half is built | Wake endpoint only; acceptance on recorded clips |
| A8 | "Stephen-owned exact-version install" is unproven on the Mac (login sharing, self-update) | Ship the version range and contract test first; the pinned install is a separate, later step |
| C1 | Conflicts with Q20 ("private content readable only inside the request that fetched it"): replies and steps hold private and page text, and C1 keeps them longer | ADR-007 first: retention, what is stored, replay rule |
| C5 | No acceptance | No file over about 400 lines, zero protocol fixture changes, Swift compile on the Mac, `HELPER_SOURCES` updated |
| D2 | "Timed, first-class flow" is undefined; the briefing is built | State the trigger, the trust tier and the time budget, or drop |
| E3 | Target from a stale baseline | Re-baseline (39 tools, 42 KB), then set the target |
| E7 | "Bare Stephen off by default" lists one cost ("one more syllable") | Second cost: the bare and "okay" spellings lifted "Hey Stephen" recall from 52 to 82 of 90 (fact 19). Measure recall with and without before changing the default |
| F10 | Effort "S to M" | 13+ files, including the trust-critical confirm dialog (`src/safety/confirm.ts`). See 3.7 |
| 7.0 | "Model-side repair" listed as new | The persona hint exists; only the entity list is new |

### 3.5 Risks to the safety model

**E1, Tier 1 fast path "through the same gate".**
- Fact: the gate and its taint state live in `stephen serve`, a stdio child of `claude` (`src/safety/session-state.ts:1-19`). The listener cannot call it. The listener's own routers act without it.
- Fact: a second serve with the same instance id refuses every call (`src/serve-args.ts:25-29`), and the rate limiter is not shared across serves (`session-state.ts:9`). So "start another serve for the fast path" has side effects.
- Fact: "play X" already ends a conversation that read private data so the gate will not ask (`src/voice/assistant.ts:233-240`). A fast path changes when that happens.
- Required before code (ADR-008): which gate instance decides; how conversation taint is read; one audit entry per action with the command id and a `fast` marker, written before the action; a rate limit at least as strict; no fast path on phone trust in v1; wake trust keeps the transcript check and cooldown.
- Required test: for every Tier 1 verb, each trust (trusted, wake, phone) and each taint state (clean, private read), the fast path and the model path give the same verdict and the same audit shape.

**E6, normalization over-correction.**
- With no model turn there is no second reader. A wrong rewrite becomes a wrong action at once.
- The plan's entity lists include open tabs and playlists. Tab titles are page text, so a page could name itself to win a match. Tier 1 lists must be owner-controlled only (installed apps, owner-written aliases).
- Rule: Tier 1 requires an exact match after a fixed variant table ("you tube" to "youtube"). A fuzzy hit never acts; it goes to Tier 2 as a hint.
- "Remember" text stays outside normalization (7.4 says verbatim).
- Ship the grammar in shadow mode first (label only). Acceptance: zero labelled Tier 2 commands classified Tier 1 on the replay set.

**C1, replayed turns (Q9).**
- History has no trust or taint fields beyond `source`; the gate's state file is deleted with the conversation. "Restore the highest taint" has nothing to restore from.
- Deterministic default: any resumed conversation starts its serve with `--assume-private-read` (already built) and the lower trust. Approvals are never restored.
- v1 of recents is view-only. Resume into the model is a second PR after ADR-007 and review. Stored text is shown with `Text(verbatim:)` and never treated as instructions.

**A9 and D4, browser routing.**
- If a detected challenge page (page text) makes Stephen switch browsers by itself, a page can steer Stephen into the browser that holds the owner's sessions. Rule: challenge detection only stops and reports. Routing comes from an owner-written list.
- Two browsers mean two cookie stores and one taint state. D4 needs a test that a private read in one browser still gates egress in the other.
- Keep "no stealth patches". Agreed with the plan.

**A3, YouTube frame rule.** A gate change. Scope it to: top-level host `youtube.com` or `music.youtube.com`, sub-frame host `accounts.google.com`, media keys only. Any read, click or typing in that frame still counts. Goes into Review 10b.

**A6, recorder.** Wake-path audio can hold other people's voices. Off by default, visible state in the window, only clips that passed the trigger, delete command, never read by a model-reachable module (boundary test).

### 3.6 Are the targets measurable with what exists?

| Target | Measurable today? | Gap |
|---|---|---|
| Tier 1 first audio, action done (7.1) | No | `tier` is null; no "action done" stage. Local routes stand in for Tier 1 today |
| Tier 1 p50 1.0 s first audio on wake | Not reachable now | Floor about 2.8 s (1.5 + 0.65 + 0.65). On F5 about 1.3 s. Split targets by trigger; decide whether an earcon counts |
| Tier 2 acknowledgement | No | No acknowledgement exists |
| Esc to silence, wake to chime | No | Not logged |
| Command success 90% on the replay set | Weakly | At n of 100, an observed 90% has a 95% interval of about 83 to 94%. Report the interval |
| YouTube Music 10/10 | Weakly | 10 of 10 only shows the true rate is above about 72%; 30 of 30 shows above about 89%. State the bound with the result |
| False wakes under 1 a day | Yes | `wake_ignored` and `no_wake` rows exist |
| Wake recall, owner's voice | No | No recorded set |
| Injection attack success 0 | Partly | 7 cases; no run without the gate for comparison |
| Prompt size, idle footprint, plan limit hits | No | Not sampled |
| CLI drift | No | A8 |

### 3.7 IDEAS-RESEARCH section 10, F10 and G7

| ID | Verdict | Reason |
|---|---|---|
| A10 plan-rule watch | Change | "Report billing pool" is their own open question 6 and may be unknowable. Keep only a clear "plan limit reached, resets at" state; fold into A8 |
| D5 scheduled briefing | Keep, after the 1.9 exit | Must state the trust of an unattended run: lowest tier, confirmations denied, owner-set schedule only |
| D6 assignment tracker | Keep, P2 | A view over `canvas_due`; after C2 |
| E9 model routing | Change, move earlier | The Mac data says slow commands are slow in the model. The model picker exists (#36), so the owner can A/B Haiku for a day with no code. Drop the E1 dependency |
| F6 away report | Keep, with an ADR | A new path for private text to leave the Mac (same class as R8-8). Default: a "ready, open Stephen" notice with no content. Their question 1 (can Remote Control push at all) is unanswered |
| F7 reviewer pass on jobs | Keep, P2 | Cheap; costs one model run per job on Pro |
| F8 disposable browser profile | Keep, raise | It is the real fix for the 302 residual in A4. Drop the D4 dependency |
| F9 meeting prep | Drop this cycle | Worker persona; mixes private sources; no owner demand |
| F10 portability seam | Change, split | F10a now: an allow-list test that fails when a new file calls a macOS-only command (like `test/memory/boundary.test.ts`). Size S, stops growth. F10b later: move the calls behind one layer; it is M to L, touches the confirm dialog, and needs review |
| F11 safety mode and pause | Change | The pause half is #86 and is P0 now. The "mode" half duplicates the Permissions page (C2.3); a visible ask/auto switch invites an "auto" setting. Show fixed rules, add no switch |
| F12 memory undo | Keep, P2 | Small; memory changes are already audited |
| G1 business-call ADR | Drop from the table | Not scheduled until U5 is revisited; ADR-007 as a number will be taken |
| G2 call me, G3 routines, G5 VM rig | Keep as future bets | G3 needs an answer on "dialog per start". G5 is low value until mic and key tap in a guest are known |
| G4 research job mode | Drop while on Pro | Their own analysis: one job can use a five-hour session |
| G6 council | Drop | Against U6 and the privacy position; no persona needs it |
| G7 Windows spike | Keep at the phase 4 gate, change | Remove the F10 dependency. Note the cheap signal already here: the Linux run found a Mac-only literal in product code (fact 9) |
| G8 "how users reach Claude" paper | Keep, do before F10b or G7 | It decides whether "regular users" is viable at all. Paper only |

One wider point. U9 (regular users, Mac then Windows) was added, but 2.1 still says "my own Mac" and "one person's assistant". With success near 6 in 10, U9 should change nothing in the next six weeks except G8 and F10a.

## 4. Recommended plan for the next two weeks

Rules: one branch per PR, PR targets `qa`, owner pushes and merges (`docs/BRANCHING.md`). Sizing: haiku tiny, sonnet everyday, opus hardest, Fable for design review only. The owner's Mac time is the bottleneck, so items that need his hands are marked **Mac**.

| # | ID | Work | Acceptance check | Depends on | Branch | Agent |
|---|---|---|---|---|---|---|
| 1 | T1 (#86) | Mic cannot be stopped; F5 fails 9 in 10 | **Mac**: 20 of 20 F5 holds record and send; a mic started from the window stops by the window control, F5 and Esc, 10 of 10; no `aborted` rows in that run; one test covers "started from app, then F5" | none | `fix/mic-stop-f5` | opus |
| 2 | A7 | Tie and tty | Linux suite 0 failed; test saves two items in one frozen millisecond and "forget that" removes the higher id; `runner.ts:192` accepts the Linux tty value | none | `fix/forget-tie-ps-tty` | haiku |
| 3 | R10a | Review 10a | `docs/REVIEW-10A.md` in REVIEW-9 format over `013696d..qa` (#32 to #41, A2); every High and Medium fixed on its own branch | none | `docs/review-10a` | opus, fresh |
| 4 | A6a | Replay recorder and "that was wrong" mark | Off by default; opt-in in config, state visible in the window; saves audio, command id, trigger in `<home>/replay/` (0700, 0600); label and delete commands; boundary test: no model-reachable import; telemetry unchanged | owner Q1 | `feat/replay-recorder` | sonnet; Fable reviews the one-page store design |
| 5 | A1, #91 | Check script and plain steps | One command prints pass or fail for each technical check of section 13; sections 0 to 13 rewritten as "do, see", each marked hands or scripted. Then **Mac**: owner runs 0 to 10 | none | `feat/mac-checks`, `docs/mac-test-plain` | sonnet, haiku |
| 6 | B5, B2 (#90) | "Remember" needs repeating | Research note names the cause from the owner's latency rows (`memory` or `model` route); 30 typed phrasings pass as a test; spoken set waits for A6a | none | `fix/remember-once` | sonnet |
| 7 | #87 | Ask Stephen button | **Mac**: every "Ask Stephen" entry opens the Ask box; a TS mirror test if a message is involved | none | `fix/ask-button` | sonnet |
| 8 | A5, A8 | CLI contract | `--effort` probed like the optional flags (old help fixture runs without it); jobs and eval follow the picker; `doctor` prints the CLI version against a tested range; a recorded stream-json fixture checks every field Stephen parses; "plan limit reached" has its own message | none | `fix/claude-cli-contract` | sonnet |
| 9 | B1 | Owner-only origin | `PROPOSAL_ORIGINS` is `['you']`; a proposals file or memory item with another origin reads as absent (test); SYSTEM-DESIGN 4.15 marked not built | none | `fix/memory-origin-you` | haiku |
| 10 | DOC1 | Reconcile docs | HANDOFF-NEXT marked superseded; ROADMAP phase names fixed; revised plan and IDEAS-RESEARCH in `docs/research/`; stale facts from section 1 corrected; findings ledger added | none | `docs/plan-reconcile` | haiku |
| 11 | REL | Release | Owner merges #92, then `[release] qa → main` after R10a fixes and sections 0 and 13 pass | 3, 5 | release PR | owner |
| 12 | C5 | Split `AppClient.swift` | No file over about 400 lines; no behaviour change; fixtures unchanged; **Mac** compile; `HELPER_SOURCES` and its test updated | 1, 7 merged (no open Swift branch) | `ui/split-appclient` | sonnet, opus review |
| 13 | A2b | Monitor gaps | Record Esc to silence, wake to chime, tool names with times, ASR model, TTS engine, cold or warm as code words; test proves no free text; report splits targets by trigger and splits `wake_ignored` by reason | none | `feat/latency-gaps` | sonnet |
| 14 | E4a | Wake endpoint | On at least 30 recorded wake clips no command is cut; monitor shows wake endpoint p50 at or under 800 ms for commands under 4 s | 4, 13 | `fix/wake-endpoint` | sonnet |
| 15 | E6a | Grammar in shadow mode | `tier` filled on every record; no action taken; on the labelled set zero Tier 2 commands labelled Tier 1, reported with n | 4 | `feat/command-grammar-shadow` | sonnet; Fable reviews the grammar scope |
| 16 | A3 | YouTube frame rule | Gate tests for the scope in 3.5; **Mac**: `eval-clicks --youtube --runs 30` passes with no prompt | owner Q2 | `fix/youtube-account-frame` | opus |
| 17 | A4 | Redirect residual | DESKTOP.md states the limit; a test shows a first-seen host asks after a private read; #51 closed or retitled | owner Q3 | `docs/open-url-residual` | haiku |
| 18 | ADR-007, ADR-008 | Conversation store and replay rule; fast path and the gate | Two ADRs with threat model, options, the tests named in 3.5. Paper only | owner Q6, Q7 | `docs/adr-007-conversation-store`, `docs/adr-008-fast-path` | Fable |
| 19 | #89, A9 | Zen message; bot-check facts | Clear message when a normal Zen is open; **Mac**: 30-minute note confirming `navigator.webdriver` and whether sessions survive the debug launch | none | `fix/zen-connect-message`, `docs/zen-bot-check` | haiku |
| 20 | A6b | Scorer, baseline v0 | Error share per stage (trigger, hearing, understanding, action) at 30 labelled commands, with intervals | 4 | `feat/replay-scorer` | sonnet |

Order: 1 to 10 in week one (2, 3, 8, 9, 10 need no Mac time and can run in parallel). 11 closes week one. 12 to 20 in week two.

Not in these two weeks: C1 build, C2 (starts with `ui/live-steps` in week three), E1, E2, E6b, E3, E7, B3 (except the key), C3, C6, #88 (after C5), all D and F tasks.

## 5. Owner questions (only what blocks work)

| # | Decision | Blocks | Recommended default |
|---|---|---|---|
| Q1 | May Stephen save the audio of your commands on the Mac for the accuracy baseline? | A6a, E4a, E6a, A6b | Yes. Only commands that passed the trigger, kept 30 days, one delete command, off switch in Settings |
| Q2 | YouTube account-frame rule | A3 | On `youtube.com` and `music.youtube.com`, the `accounts.google.com` sub-frame does not count as a private read for media keys only. Everything else unchanged |
| Q3 | The remaining redirect gap (a site's own 302 on the `open -a` path) | A4 | Accept and document for conversations with no private read. Long-term fix: disposable profile (F8) |
| Q4 | Branch base while `qa` is ahead of `main` | A6a, E6a, C1 | Allow "cut from `qa` when the work needs unreleased code"; release after Review 10a |
| Q5 | Review 10a now (one Opus run against your Pro limits) | REL | Yes |
| Q6 | How long may command text and replies stay on disk (today 1 day)? | ADR-007, C1, recents | 7 days; recents view-only first; resume into the model only after the ADR and a review |
| Q7 | Tier 1 targets | ADR-008, E4a | Keep the plan's numbers for F5. For wake, add 0.8 s until E4a lands. A chime counts as the first audible response |
| Q8 | F10 and G7 | F10a | Approve F10a (the test only). Defer F10b. G7 stays at the phase 4 gate with no F10 dependency |

Owner actions that are not questions: rotate the ElevenLabs key today; merge PR #92; run Mac test sections 0 to 10 once item 5 lands.

### 5.1 Owner answers (2026-11-12)

| # | Answer | Effect |
|---|---|---|
| Q1 | Yes, the simplest version | A6a: opt-in recorder, 30 days, delete command, off switch. TTS stays ElevenLabs (owner has credits); key rotation is the owner's call |
| Q2 | Yes, and real Zen must connect and open YouTube | A3 acceptance adds: on the Mac, "Zen for Stephen" attaches and plays a YouTube video with no prompt |
| Q3 | Accept | A4 is docs plus one test |
| Q4 | Cut from `qa` freely. Everything lands in `qa`; `main` is production and the owner handles releases | Branch base question closed |
| Q5 | Yes | Review 10a now, by an agent that did not write the code |
| Q6 | 7 days | Command text and replies kept 7 days; recents view-only first |
| Q7 | Keep the targets. The dev team is already fixing F5 (#86) | E4a and ADR-008 use the plan's numbers, wake gets +0.8 s until E4a lands |
| Q8 | Approve | F10a (allow-list test) now, F10b deferred, G7 stays at the phase 4 gate |

## 6. Team handoff message (paste-ready)

```
Plan review is in docs/research/PLAN-REVIEW-2026-11.md (independent, 2026-11-12). Read sections 0, 3 and 4.

What changes in the queue, and why:
1. Trigger first. #86 (mic cannot be stopped, F5 works 1 in 10) is a privacy bug and blocks
   everything measured by voice. 5 of 9 wake triggers also never became a command (#43).
2. A2 is treated as done except the gaps in section 2 (tier null, no action-done stage, Esc and
   chime not logged). They become A2b, week two. Close #43 after the Mac check.
3. A6 splits: A6a recorder now (100 commands take about 10 days), A6b scorer at 30 labels.
4. Review 10 splits: 10a now over 013696d..qa (#32 to #41 and A2 are unreviewed), 10b at the 1.9 exit,
   Review 11 after the fast path.
5. Facts to stop repeating: F5 release already ends speech; two of three redirect cases are fixed;
   "memory full" already answers; no code writes a non-owner memory origin; Parakeet scored below
   whisper-small on accents in docs/VOICE.md; tool schemas are 42 KB for 39 tools, not 27 KB.
6. E4 (wake endpoint) moves up to P0. Mac numbers: endpoint 1.5 s, ASR 0.65 s, first audio 0.65 s.
   Skipping the model alone leaves wake commands near 2.8 s.
7. E1 needs ADR-008 first. The gate lives inside serve; the listener cannot reach it today.
   E6 ships as a shadow classifier first. Tier 1 entity lists are owner-controlled only.
8. C1 needs ADR-007 first (retention, replay rule). Recents ship view-only.
9. HANDOFF-NEXT is superseded. Its UI items start after C5: live-steps, section-pages,
   connected-permissions. chat-title moves to phase 3. model-everywhere merges into A8.
10. B4 closes. C6 is deferred. F10 becomes a small allow-list test (F10a).

Rules unchanged: one branch per PR, PR targets qa, Cris pushes and merges, RPI with a stop after
Research, no em dashes. While qa is ahead of main, cut from qa when the work needs A2 code (pending Q4).

First three branches to start now:
- fix/mic-stop-f5 (opus). Research first: which path starts the mic from the window, which stops
  it, and whether the helper sees F5 at all (check short_press and aborted rows in the latency log).
- fix/forget-tie-ps-tty (haiku). Tie-break "forget that" by item id; accept the Linux tty value in
  the test and in src/jobs/runner.ts:192. Linux suite must show 0 failed.
- docs/review-10a (opus, fresh context, did not write the code). Scope 013696d..qa, REVIEW-9 format.

In parallel, no Mac time needed: fix/claude-cli-contract (A5 plus A8), fix/memory-origin-you (B1),
docs/plan-reconcile.

Waiting on Cris: Q1 (record command audio), Q2 (YouTube frame rule), Q3 (redirect residual),
Q4 (branch base), Q5 (Review 10a now). Defaults are in section 5.
```
