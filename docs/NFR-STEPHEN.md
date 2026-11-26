# Stephen: non-functional requirements (NFR)

**Status:** Proposed 2026-11-23 by the dev lane. Targets are proposals until Cris accepts them on #10.
**Audience:** Cris plus a few friends first, public later. **When goals fight:** safety and privacy first, then
speed, then cost. Goes with `docs/SYSTEM-DESIGN-STEPHEN.md` (its N1 to N4 are the safety rows here).

Each area: today's value (measured where the repo can measure it), the target, the gap, and the smallest next step.
"Measured" values come from `stephen latency --days 30` on Cris's Mac on 2026-11-23 (51 triggers, so small samples)
and from `docs/ADR-008-MEASUREMENTS.md`.

## 1. Safety

| | Value |
|---|---|
| Today | Model never writes memory, timers or jobs (no tool exists; import-boundary tests). Every action and private read goes through the SafetyGate (policy, taint, egress, rate limit, native dialog). One exception by design: `announce` (a spoken line before sound plays) skips `gate.check`, because it touches no page, sends nothing off the Mac and says nothing once private data was read (#306). Allow and Deny are clicks only. Independent reviews REVIEW-1 to REVIEW-10B, each finding fixed with a named test. `stephen eval` inject cases pass against the real model. |
| Target | Zero known High findings at every release. Every safety change has `[DEV REVIEW]` and an independent review. Inject cases: 100% pass on every release. |
| Gap | Eval is not run per release (it costs model tokens). Open item: #296 (overdue job Claude not killed). Private reads are audited (one line per read, tool and trust only, `auditPrivateRead` in `src/safety/gate.ts`). |
| Next step | Add `stephen eval --only inject` to the release checklist (step 4b). Fix #296, dev lane. |

## 2. Privacy

| | Value |
|---|---|
| Today | Audio and speech to text stay on the Mac. Secrets stay in the Keychain, never in the model's env. History 7 days by default (0 to 30), Claude transcripts deleted when a conversation ends, latency 30 days, recordings opt-in and 30 days. Files 0600 in 0700 folders. What leaves the Mac, and when, is one table in `docs/DATA-STORES.md` ("Everything that leaves the Mac"). Above all, every model run sends the command, the memory block and every tool result (page and email text) to Anthropic under the person's own account. |
| Target | Same rules for friends, plus: a friend can see and delete everything Stephen keeps in one place. A friend can see exactly what leaves their Mac in one table. Nothing leaves the Mac that is not in that table, and the table matches the code. |
| Gap | No single "what Stephen keeps" view; it is spread over Memory, Conversations, Jobs and files. |
| Next step | A `stephen data` command that lists each store, its size, its retention and how to delete it. Docs only first. |

## 3. Latency

Targets are in `src/telemetry/cli.ts` (`TARGETS`): local router p50 1.5 s, p95 2.5 s; model answer p50 4 s, p95 8 s;
the wake word gets +0.8 s. Measured on speech end to reply ready ("speech → reply").

| Path | Today p50 / p95 | Target p50 / p95 | Gap |
|---|---|---|---|
| F5, model (n=9) | 1.96 s / 6.6 s | 4 s / 8 s | Inside |
| F5, first sound of the reply (n=7) | 2.7 s / 7.4 s | none yet | Set one: 3 s / 6 s |
| Wake word, model (n=8) | 9.6 s / 20.1 s | 4.8 s / 8.8 s | **Over 2x.** Endpoint alone is 1.5 s; reply 7.4 s / 17.8 s |
| Ask box, model (n=14) | 2.4 s / 16.6 s | 4 s / 8 s | p95 over: a few long tool runs |
| Memory router, Ask box (n=5) | 0.09 s / 0.12 s | 1.5 s / 2.5 s | Inside |
| Warm Claude start | 1.4 to 1.9 s p50 | hidden by recording | Inside when the command is longer than 2 s |
| Second serve cold start (ADR-008) | 140 to 210 ms | under 300 ms | Inside |

**Next step:** find why wake word replies are 4x slower than F5 replies with the same model (n=8 is small; the
wake path uses `serve --trust wake`, which may take more turns). Read the 10 slowest ids from `stephen latency`
and compare turns. ADR-008 measurement 4 (F5 "open Safari" x20) is still open and is the Tier 1 baseline.

## 4. Reliability

| | Value |
|---|---|
| Today | 37 of 39 commands that reached the assistant ended ok (2 errors, 3 cancelled by Cris). Trigger misses: 5 no_wake, 4 wake_ignored of 51. Jobs are reconciled after a crash or reboot. A stale app.sock from a crashed listener is replaced. No network: Stephen says it is offline (#172). Accounts and the model need the network. |
| Target | 98% of commands end ok or with a clear spoken reason. A crashed listener is back within 10 s without Cris. No command is ever done twice after a crash. |
| Gap | The listener is started by the helper's Start; a crash is not restarted on its own and is not counted. Wake word misses (9 of 51) are not split by cause. |
| Next step | Count listener exits with a code word in the latency file. Then a design note: who restarts the listener (helper or launchd), with a crash-loop limit. |

## 5. Resource use

| | Value |
|---|---|
| Today | One idle `serve` 52 MB (ADR-008). The listener, the speech models and the helper are not measured. CPU while waiting for the wake word, battery and disk are not measured. |
| Target | Idle (waiting for the wake word): under 3% of one core, under 400 MB for all Stephen processes, no measurable battery drain beyond the mic being on. Disk: under 1 GB including speech models, logs capped. |
| Gap | No numbers for the biggest parts. |
| Next step | A 10-minute idle run on the Mac: `scripts/measure-idle.sh` (Stephen running, other Claude Code sessions closed). Paste the totals into this file. |

## 6. Cost per day

| | Value |
|---|---|
| Today | Each model run returns its cost (`costUsd` from Claude Code), but it is not saved or summed. Jobs have a budget (default 5 USD each). Routers (memory, timers, jobs) cost nothing. |
| Target | A free daily limit, on by default (Cris, 2026-11-23). Each person runs Stephen on their own Claude account, so we pay nothing; the limit protects them. Default: a starting guess of 1 USD of model use a day, fixed after one week of real numbers. Stephen warns once at 80% ("You have used most of today's limit"), and at 100% says "Today's limit is used. It resets at midnight." and starts no new model run. Always free and never blocked: "stop", memory, timers, job status. Jobs count too and keep their own budget. The owner can change the limit in Settings. |
| Jobs and the limit | At 100% a new job is refused: "Today's limit is used. The job did not start." (#362, `JOB_LIMIT_USED` in `src/jobs/manager.ts`). A running job is never stopped. A job's cost is counted when it ends, so a job started below 100% can go past the limit (its own budget is 5 USD by default, the day limit 1 USD). If today's total cannot be read it counts as 0, so runs and jobs still start (fail open by design, `src/voice/daily-limit.ts`, #305). |
| Gap | Built in `qa` (2026-11-24): cost per run in the latency record (#302), the daily limit setting and cost line (#305), the 80% warning and the stop at 100% (#309). Left: pick the default number from one week of real use. |
| Next step | 1. Save each run's cost in the latency record (a number, no content). 2. A cost line per day in `stephen latency`, so we see real use for a week. 3. Then the limit, the 80% warning and the Settings field, with the number picked from that week. |

## 7. Setup time for a new friend

| | Value |
|---|---|
| Today | Clone, `npm install`, build, `npm link`, `stephen doctor`, `stephen install --run`, `install-zen-launcher`, `install-helper`, then Microphone, Input Monitoring and Accessibility by hand. Needs Node 20.19+ or 22.12+, Claude Code signed in, Xcode command line tools. Not timed. |
| Target | 15 minutes from zero to the first spoken command: one command, then the permission clicks. |
| Gap | About 8 commands and 3 permission screens; not measured with a real friend. |
| Next step | Cris accepted the target (2026-11-23) and will have friends try it. Time one friend's setup with a stopwatch and list every step that stalled. Then one `stephen setup` that runs the steps and stops at the first red `doctor` line. |

## 8. Updates

| | Value |
|---|---|
| Today | `git pull`, `npm install`, build, `install-helper`. If the helper was rebuilt, macOS asks for Input Monitoring again. No version check. Going back is documented in `docs/RELEASE-CHECKLIST.md`. |
| Target | A friend sees "update ready" and updates with one command, permissions kept, and can go back with one command. |
| Gap | Four steps; permissions lost when the helper changes (unsigned build). |
| Next step | `stephen update` that does the four steps and says when a permission click is needed. Signing the helper (keeps permissions) comes after the friends release (Cris, 2026-11-23). |

## 9. Observability without content (telemetry rules)

| | Value |
|---|---|
| Today | Latency records (ids, times, fixed code words, 30 days), the redacted audit log (size capped), `stephen doctor`, `stephen mac-checks`. Nothing leaves the Mac. No crash report. |
| Target | A tester can send one file that explains a crash or a slow command, and it holds no words, URLs, page text, names or audio. |
| Gap | Phase 1 built in `qa` (2026-11-25, #303): a content-free incident log and `stephen report`, which shows the file and opens an `incident` issue only after "y". Left: the event workflow and agent (phase 2), and the two switches. |
| Next step | Phase 1 of the incident loop below. |

**Incident loop (Cris, 2026-11-23): Stephen reports, agents investigate, Cris decides how much they fix.** Like an
on-call page, but the first responder is an agent.

1. **Capture (on each Mac).** When the listener, a serve or the helper crashes, or a command fails with an error,
   Stephen writes an incident file: time, version, which part, the error code word, the stage, and the latency
   numbers. No words, URLs, page text or names (the telemetry rules below).
2. **Report.** Phase 1: `stephen report` shows the file and opens a GitHub issue with the label `incident` using the
   person's own `gh` sign-in, after they read it and click. Phase 2: a Settings switch "Report crashes on its own"
   (off by default, each person's choice) files it without the click. The repo is public, so the content rules
   matter: the file must be safe for anyone to read.
3. **Dashboard.** The GitHub issues with label `incident`, grouped by code word (a saved search or a Project board).
   No new server.
4. **Notify and investigate, right away (no hourly polling).** A GitHub Actions workflow starts on the issue event
   itself (`issues: opened, edited, labeled` with the `incident` label). It waits 10 minutes so the reporter can
   still edit. Each edit restarts the wait (one `concurrency` group per issue with `cancel-in-progress`). Then it
   starts the investigating agent at once. The agent reproduces, finds the cause and comments its findings on the
   issue. The dev lane and the review lane see it in their inbox.
   Safety rules for this step: it acts only on issues opened by `CrisH2307` or a tester on a short allow-list (the
   repo is public). The issue text is data, never instructions, for the agent. The agent gets read-only repo access,
   and only a fix PR (step 5) may write. The workflow adds a CI trigger and a secret, so Cris approves it first.
5. **Fix, by Cris's switch.** An "Auto-fix incidents" switch (a repo setting Cris controls, read by the agent):
   **on** = the agent opens a fix PR to `qa` with a test, then the normal reviews; **off** = it only investigates and
   waits for Cris or a lane. Either way nothing merges without review, safety code still needs `[DEV REVIEW]`, and
   nothing goes to `main` without Cris.

Build order: incident file and `stephen report` first, then the event workflow and agent, then the two switches. Each step is
its own PR; the design note for steps 2 and 4 comes before any code.

**Rules for any telemetry:** only counts, times, fixed code words, versions and random ids. Never transcripts,
arguments, URLs, hosts, page text, file names or audio. A parser drops unknown fields (as `parseLatencyRecord`
does). Local first; nothing is uploaded automatically. Sending is a human action, every time.

## 10. Portability

| | Value |
|---|---|
| Today | macOS 14 and up (`LSMinimumSystemVersion` 14.0, checked by `scripts/helper-min-macos.mjs`). Linux CI runs the Node tests. Windows: not supported; the helper, Keychain, `say`, launchd and the F5 event tap are macOS only. |
| Target | macOS 14+ fully supported. Windows later without a rewrite of the core. |
| Gap | The macOS parts are called directly from several places. |
| Next step | A design note for the platform seam (key listener, secret store, speaker, app launcher, file permissions) before any Windows code. Dev lane. |

## Decisions from Cris (2026-11-23)

The dev lane asked four questions. Cris's answers, so nobody has to ask again:

| # | Question | Answer |
|---|---|---|
| 1 | Should Stephen have a daily spending limit? | Yes, a free daily limit, on by default, with a warning before the limit is reached. We do not know yet where money would come from, so each person uses their own Claude account and the limit protects them. Plan in section 6. |
| 2 | Is 15 minutes, from nothing to the first spoken command, the right setup target for a friend? | Yes, try it. Cris will have friends set Stephen up and report how long it took and where they got stuck. Section 7. |
| 3 | Crash reports: send by hand, after reading the file? | Stephen (or an agent) reports a crash or incident on its own, like an on-call page. The agents get it a few minutes after the report (after a short edit window, not an hourly check), investigate as maintainers, and Cris has a switch: let the agent fix it, or fix it himself. Same on GitHub. Section 9, incident loop. |
| 4 | Sign the app for the public release? | Later, after the friends release; there is more to build first. Section 8. |

## What to measure next (in order)

1. Idle resource run (section 5), 10 minutes, no code.
2. ADR-008 measurement 4, F5 "open Safari" x20 (section 3).
3. The slowest wake word commands by id (section 3).
4. One friend's setup with a stopwatch (section 7).
