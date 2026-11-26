# 5. Trade-offs and optimizations

Step five of the interview answer: for each big choice, say what we picked, what we did not pick, why, and what it costs.
Describes `qa` at commit `5fae967` (2026-11-25). Terms: see [README.md](README.md#words-used-on-these-pages).

Every number below comes from code or from a measurement, with its source. Measurements are small samples on one
Mac, so treat them as a first reading, not a benchmark.

## 5.1 Local or cloud

**Choice.** Speech, the wake word, voice activity detection and the local routers run on the Mac. The model runs in
Claude Code, under the person's own Claude account.

**Alternative.** Run the model ourselves, on a server we pay for, with our own API key.

**Why.** The owner chose a long-lived `claude -p` over the Agent SDK because there is no API key to hold
([ADR-003](../ADR-003-long-lived-claude.md)). Audio stays on the Mac ([NFR section 2](../NFR-STEPHEN.md)).
A friend's commands never reach a server of ours.

**Cost.** A model run is a round trip to the model. One model turn costs about 1.8 s on the Mac
([ADR-008](../ADR-008-tier1-fast-path.md), Context). Every model run sends the command, the memory block and every tool
result to Anthropic. The full list of what leaves the Mac is in [DATA-STORES.md](../DATA-STORES.md), under
"Everything that leaves the Mac". Stephen needs the network for accounts and the model.

**A local model** for some roles is proposed in [ADR-016](../ADR-016-free-or-local-models.md). It is paper only.

## 5.2 Latency budget

The timed span is "speech to reply", from the end of your speech to the reply being ready. The stages are measured in
the latency record (`src/telemetry/cli.ts:56-65`, `src/telemetry/latency.ts`).

| Stage | Span in code | Target |
|---|---|---|
| endpoint | speech end to capture end (silence wait) | no own target |
| asr | capture end to speech-to-text done | no own target |
| handoff | speech-to-text done to command start (routers, limit) | no own target |
| reply | command start to reply ready (the model, or a router) | no own target |
| output | reply ready to done (speaking) | no own target |

The targets are for the whole span (`TARGETS` in `src/telemetry/cli.ts:73`):

- Local router: p50 1.5 s, p95 2.5 s.
- Model answer: p50 4 s, p95 8 s.
- Wake word: 0.8 s more than the base (`TRIGGER_EXTRA_MS`, `src/telemetry/cli.ts:79`). The code comment says this
  allowance is temporary.

**Measured** (speech to reply, [NFR section 3](../NFR-STEPHEN.md), 2026-11-23, 51 triggers):

| Path | Today p50 / p95 | Target p50 / p95 | Note |
|---|---|---|---|
| F5 key, model (n=9) | 1.96 s / 6.6 s | 4 s / 8 s | inside |
| Wake word, model (n=8) | 9.6 s / 20.1 s | 4.8 s / 8.8 s | **over 2x** |
| Ask box, model (n=14) | 2.4 s / 16.6 s | 4 s / 8 s | p95 over, a few long tool runs |
| Memory router, Ask box (n=5) | 0.09 s / 0.12 s | 1.5 s / 2.5 s | inside |

**Open gap.** Wake word replies are about 5x slower than F5 replies with the same model (9.6 s against 1.96 s at p50). The endpoint alone is 1.5 s
on the wake path, and the reply is 7.4 s at p50 (NFR section 3). The cause is not known yet. The next step is in
the NFR, and it is to compare the turns of the 10 slowest commands.

**Optimizations, and what each one buys:**

1. **Warm Claude, started early.** The listener starts `claude -p` when the wake word fires or the key goes down
   (`prewarm`, `src/voice/conversation.ts:396-410`). Start-up then overlaps with your speech. Measured saving: about
   1.5 s per command, and all start-up is hidden when the process starts 2 s or more before the command
   ([ADR-003](../ADR-003-long-lived-claude.md), Measurements). Cost: a warm Claude process and its serve together hold
   about 265 to 275 MB while idle ([ADR-003](../ADR-003-long-lived-claude.md)).
2. **A cold tool server costs 140 to 210 ms** to answer its first request ([ADR-008 measurements](../ADR-008-MEASUREMENTS.md),
   section 1). ADR-008 still keeps the fast server warm, because a cold one would use about a tenth of the 1.5 s budget.
3. **Routers skip the model.** Memory, timers and jobs run with no model run. Only the memory router is measured, at
   about 0.1 s (n=5, Ask box; [NFR section 3](../NFR-STEPHEN.md)). See [ALGORITHMS.md](ALGORITHMS.md) for the order.
4. **Short silence rule.** The end of your speech is found after 0.8 s of silence, or 1.5 s after 2.5 s of speech
   (`silenceSec` and `longSilenceSec`, `src/voice/config.ts:168` and `:173`). Cost: a long pause can cut you off. The
   continuation rule (4 s, once) joins a sentence that ends in a joining word such as "and", "then" or "um"
   (`continueSec`, `src/voice/config.ts:178`; the word list is `JOINING_WORDS`, `src/voice/listener.ts:140`).
5. **Key up ends a key press.** Push-to-talk does not wait for silence, so the key release is the end
   (`src/voice/listener.ts`, `onPttUp`).

**Known cost of warm mode.** A wake word that is not a command (a video, a false alarm) still starts a process. The
process stops after 60 s if nothing used it (`PREWARM_UNUSED_MS`, `src/voice/conversation.ts:314`).

## 5.3 Daily cost limit

**Choice.** A free default limit of 1 USD of model use a day (`dailyLimit`, `src/voice/config.ts:195-199`). At 80% Stephen
warns once a day. At 100% it starts no new model run until local midnight. Routers, "stop" and job status are never
blocked. If the limit cannot read its numbers, it lets the command run (fail open, `src/voice/daily-limit.ts`).

**Alternative.** No limit, or a limit enforced on a server.

**Why a limit with no server.** Each person pays their own Claude plan, so the limit protects that person from a
surprise bill. We do not hold money or a key, so there is no server to enforce anything
([NFR section 6](../NFR-STEPHEN.md), Cris's decision of 2026-11-23). The default of 1 USD is a guess, to be fixed after
one week of real numbers.

**Jobs.** A background job has its own budget, 5 USD by default (`maxBudgetUsd`, `src/jobs/config.ts:27`). It counts
toward today's total, but starting a job does not check the daily limit. So jobs can take the total past 100%
without a stop. This is a known gap, and it follows from the design: each job is capped on its own.

**Cost of the choice.**

- A wrong total can block a command, so every read fails open (counted as 0 and logged).
- A run whose latency line is never written stays counted until midnight (noted in `src/voice/daily-limit.ts:33`).
- The limit is a number to watch, not a safety control. It does not stop a bad answer, only a big bill.

## 5.4 Wake word trust tiers

**Choice.** Three trust levels, set by where a command came from (`trustOf`, `src/voice/assistant.ts:33-35`):

| Source | Trust | What changes |
|---|---|---|
| F5 key, typed text, app, `cli` | trusted | full memory, timers and email; answers are spoken |
| Wake word (`voice-wake`) | wake | email gives who and when only; memory save asks first in a macOS dialog when `memory.confirmWakeWord` is on (the default; `src/memory/config.ts:10`, `src/voice/memory-router.ts:98-106`); job start, job stop and timer cancel ask in a dialog (`src/jobs/router.ts`, `src/timers/router.ts:130-141`); timer and job lists give a count; a private answer goes on screen, not out loud |
| Phone | phone | every memory change refused; a job starts only through the phone's own Allow tap, 3 a day, with web only if asked on the phone (`src/jobs/router.ts:73, 117-128`, `src/phone/server.ts:135-137`); job stop and timer set or cancel refused (`src/jobs/router.ts:103`, `src/timers/router.ts:88, 95, 114, 129`); timer and job lists give a count only; memory list gives a count (`src/voice/memory-router.ts:118`); answers are spoken to the phone, not the Mac |

The longer table, with the rules for memory, timers and email, is in
[SYSTEM-DESIGN-STEPHEN.md](../SYSTEM-DESIGN-STEPHEN.md), section 4.2.

**Alternative.** One trust level for all voice commands.

**Why.** Anyone in the room can say "Hey Stephen", and so can a video. A wake-word command should not read private
mail out loud, or save a memory, without a click. Only the owner's own key, or a typed request, gets full trust.

**Cost.** More rules to keep right, and each rule has a test. A conversation of one trust is not continued by a
command of another trust (`src/voice/conversation.ts:127-131`, `:275-281`, `:378-380`), so a follow-up can start
fresh. The wake word gets less
done without a click, which is the point.

## 5.5 Why no server

**Choice.** There is no Stephen server. Each person runs Stephen on their own Mac, under their own Claude plan.

**Alternative.** A hosted backend with crash reports, usage data and automatic updates.

**Why.** There is nothing for us to run, pay for or protect, and no central copy of anyone's private data
(the target in [NFR section 2](../NFR-STEPHEN.md)).

**Cost.**

- **No central crash view.** Each report is made by hand. `stephen report` shows the content-free incident file and
  opens a GitHub issue only after the person types "y" (`src/telemetry/report.ts`, see [ALGORITHMS.md](ALGORITHMS.md)).
- **Updates by git.** `stephen update` runs four steps (`git pull --ff-only`, install, build, install the helper).
  If the helper was rebuilt, macOS asks for Input Monitoring again ([NFR section 8](../NFR-STEPHEN.md)).
- **Setup per person.** About 8 commands and 3 macOS permission screens. The target is 15 minutes, not yet timed
  ([NFR section 7](../NFR-STEPHEN.md)).

## 5.6 Two processes, not one

**Choice.** The listener (`stephen listen`) holds what the owner trusts: memory, timers, history, settings. The tool
server (`stephen serve`) is the only thing the model can call, and it holds the safety gate.

**Alternative.** One process that does both.

**Why.** A model that reads a hostile page must not reach the owner's memory or timers. A test scans the tool
server's imports and fails if it loads the memory, history, app or job code (`test/memory/boundary.test.ts`).

**Cost.** Two processes to start and to keep alive, and two socket protocols to keep in step. The warm process ties
them together, so their shutdown order matters (kill the process group, then reset; see 5.8).

**Numbers.** One idle tool server uses 52 MB ([ADR-008 measurements](../ADR-008-MEASUREMENTS.md), section 1).
Messages on `app.sock` are capped at 256 KiB a line (`APP_MAX_LINE_BYTES`, `src/app/protocol.ts:100`). Messages on
`helper.sock` are capped at 4 KiB a line (`src/helper/framing.ts:9`).

**Sockets by file mode, not tokens.** The listener and the helper talk over two Unix sockets, in a folder that only
the owner can enter (0700 folder, 0600 sockets, `src/lib/private-socket.ts:41-48` and `:85`).

- **Alternative.** A shared secret token that both sides read.
- **Why not a token.** A token sits in a file or an environment variable, and the model's tools run on the same
  machine. File modes keep other macOS users out, and there is no secret for a model to read.
- **Cost.** Any program running as the same macOS user can connect. File modes do not stop that. Such a program can
  already read the same files, so the socket adds no new way in.

## 5.7 Files, not a database

**Choice.** Each store is a file. History, latency and incidents are one JSON line per entry, one file per local day.
The audit log rotates by size instead. Memory, timers, settings and job state are JSON files. Modes are 0600 for files and 0700 for
folders ([DATA-MODEL.md](DATA-MODEL.md) for the list).

**Alternative.** SQLite, or another database.

**Why.** One owner, small data, and no server. A file can be opened, read, copied and deleted by hand. Retention is
"delete the files older than N days", which is easy to get right and easy to test
([ALGORITHMS.md](ALGORITHMS.md), retention).

**Cost.**

- No queries or indexes. Reads scan a file. The daily limit reads the last 24 hours of latency records on every
  check, from up to two day files, each capped at 4 MB (`src/voice/index.ts:645`, `src/telemetry/latency.ts:322-336`).
- Locks are by hand. The memory store has its own lock (`src/memory/store.ts:291-417`).
- Rewrites are atomic (write a new file, then rename), but there are no transactions across files.

**Numbers.** Latency day file: 4 MB cap (`src/telemetry/latency.ts:144`). Audit log: rotates at 5 MB and keeps 3 old
files (`src/safety/audit.ts:11-12`). Incidents: 1 MB a day (`src/telemetry/incidents.ts`).

## 5.8 A warm process, not one process per command

**Choice.** One `claude -p` process per conversation, started on the wake word or the key. It ends when the follow-up
window (180 s by default, at most 1800 s) runs out, after 25 commands, after 30 minutes, after 60 s unused, after any
error, or when memory changes. The one-shot runner stays as the test path and the fallback
(`src/voice/claude.ts`, `src/voice/warm-claude.ts`).

**Alternative.** A new `claude -p` for each command (the old way).

**Why.** Saves about 1.5 s per command, and gives a better p90 because there is no process start and no transcript
reload ([ADR-003](../ADR-003-long-lived-claude.md)).

**Cost.**

- State lives across turns: the conversation's taint file, the transcript and the memory snapshot. The kill order
  matters: stop the process group first, then delete the state file. Otherwise an old tool server can write the old
  taint back ([ADR-003](../ADR-003-long-lived-claude.md), decision step 4).
- The control messages (`initialize`, `mcp_status`) are Claude Code's wire protocol, and they are only partly
  documented. A Claude Code update could change them. Mitigation: a probe at start-up falls back to one-shot if the
  protocol fails (`src/voice/index.ts:465-468`).
- An interrupted tool keeps running to the end, so a cancel kills the whole process group and ends the conversation.

## 5.9 What we would change at larger scale (thinking, not plans)

This section is thinking. Nothing here is decided or scheduled. Each point follows from a doc that already exists.

- **Signed app** ([ADR-011](../ADR-011-packaging-signed-app.md), proposed). The helper is ad hoc signed today, so macOS
  asks for permissions again after a rebuild ([NFR section 8](../NFR-STEPHEN.md)). With more people, each rebuild is
  a support cost. Signing needs an Apple Developer ID, which is decision D1.
- **In-app updates** ([ADR-012](../ADR-012-updates-sparkle.md), proposed). Replaces four git steps with one update
  and a rollback. It adds a new dependency, so it needs Cris's yes.
- **Incident loop** ([ADR-014](../ADR-014-incident-agent.md), proposed). Today a person reads each report and sends it
  by hand. At many more reports, grouping and an investigating agent would matter. It adds a CI trigger and a secret,
  so it waits for approval. The strict parser comes first, as it does today ([ALGORITHMS.md](ALGORITHMS.md), incidents).
- **Local models for some roles** ([ADR-016](../ADR-016-free-or-local-models.md), paper only). This would lower the
  cost per person for some work, but never for private data sent to a free cloud service.
- **What would not change.** The file stores assume one listener per Mac, and each person has their own Mac. So the
  local storage does not grow with users, because each Mac is separate. Other parts are not analysed here. Local
  storage would stop being a fair picture only if one machine served many people, with one shared key. That is a
  different product, with a server to protect and a new privacy review. The docs do not cover it.

Next: [ALGORITHMS.md](ALGORITHMS.md).
