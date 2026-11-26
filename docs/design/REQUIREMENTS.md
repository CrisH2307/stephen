# 1. Requirements

Step one of any system design answer: say what the system must do, and how well. Everything here comes from
the code on `qa` and from [NFR-STEPHEN.md](../NFR-STEPHEN.md). Numbers carry their source. Describes `qa` at commit `5fae967` (2026-11-25).

## 1.1 The problem in one paragraph

Stephen is a voice assistant that runs on one person's Mac. You say "Hey Stephen, what's due on Canvas this week,
and put on some lofi." Stephen hears it, works out what you want, uses your browser and your accounts to do it,
and answers out loud in a sentence or two. The hard part is not speech or the model call. It is giving a language
model real power on your computer while making sure that nothing the model reads (a web page, an email) can turn
that power against you.

**Who uses it.** Cris first, then a small group of friends (the friends beta), then the public. Each person runs
Stephen on their own Mac with their own Claude plan. There is no Stephen server.

## 1.2 Functional requirements

What Stephen does. Each line names where it lives.

| # | Requirement | Where |
|---|---|---|
| F1 | **Start a command three ways:** say the wake word ("Hey Stephen"), hold a key (push to talk, F5 or Fn+Option), or type in the Ask box in the menu bar. | `src/voice/`, `helper/` |
| F2 | **Turn speech into text on the Mac.** Audio never leaves the machine. | `src/voice/` |
| F3 | **Answer simple commands without the model.** "Remember...", "forget...", timers and reminders, job status and "stop" are handled by local rules. They are fast and free. | `src/memory/`, `src/timers/`, `src/jobs/`, `src/voice/grammar/` |
| F4 | **Hand everything else to Claude**, which can call Stephen's tools. | `src/voice/claude.ts`, `src/voice/warm-claude.ts` |
| F5 | **Drive the browser** (Zen or Chrome): list tabs, open, read, find, click, type, fill forms, scroll, upload. 23 browser tools by default (24 if the owner turns on `evaluate`). | `src/server/tools.ts`, `src/drivers/` |
| F6 | **Control the desktop:** open an app or a web address, play media, pause or skip, set the volume. 6 desktop tools. | `src/desktop/index.ts` |
| F7 | **Read the owner's accounts, read only:** Gmail, Google Calendar, Canvas, Notion, the weather. 9 account tools. | `src/accounts/index.ts` |
| F8 | **Ask before anything risky.** Sending, submitting, paying, deleting, uploading, or any action after a private read pauses for an Allow or Deny click. | `src/safety/`, `helper/AppConfirm.swift` |
| F9 | **Speak the answer.** In order of preference: ElevenLabs (only if the owner set a key), Kokoro (a voice that runs on the Mac), then the Mac voice `say`. | `src/voice/tts/` |
| F10 | **Remember things** the owner asked it to remember, and suggest memories the owner can keep or skip. | `src/memory/` |
| F11 | **Run longer background jobs** ("research X while I'm away") in a sandbox, after a click. | `src/jobs/` |
| F12 | **Keep a short history** of conversations, shown in the window. | `src/history/`, `helper/ConversationsPage.swift` |
| F13 | **Talk from the phone** through Claude Code's remote control, only while the owner turns it on. | `src/phone/` |
| F14 | **Set up, check and update itself:** `stephen setup`, `stephen doctor`, `stephen update`. | `src/setup.ts`, `src/update.ts` |
| F15 | **Report a crash without content:** `stephen report` shows an incident file and files it only after the owner types y (or yes). | `src/telemetry/` |

The model can call 38 tools in all (23 + 6 + 9), plus `announce` on the voice path, which only speaks a line. It can
**not** write memory, timers or jobs: no such tool exists. Those writes happen only in the listener, from the owner's own words.

**Out of scope on purpose.** A Stephen cloud service, accounts on our side, a mobile app, Windows (later, see
[ADR-015](../ADR-015-platform-seam.md)), and account tools that write (send mail, post). The model can still send or post through the browser, but
clicks that look like send, submit or post pause for an Allow click (the high-risk click rule, `src/safety/policy.ts`).

## 1.3 Non-functional requirements

How well it must do it. **When two goals fight: safety and privacy first, then speed, then cost**
([NFR-STEPHEN.md](../NFR-STEPHEN.md), top).

| Area | Requirement (target) | Today | Source |
|---|---|---|---|
| **Safety** | Text the model reads never gives orders. Every action and private read goes through the safety gate. Allow and Deny are clicks only. Zero known High findings at each release. | Met for the core gate, with independent reviews REVIEW-1 to REVIEW-10B. Private reads are audited (#307). By design, `announce` checks taint and the rate limit itself instead of calling the gate (#306). Injection items: [INJECTION-COVERAGE.md](../INJECTION-COVERAGE.md). | NFR section 1 |
| **Privacy** | Audio and speech to text stay on the Mac. Secrets stay in the Keychain (older setups may still use a `.env` file), never in the model's environment. Every store has a stated rule: a time limit, a size cap, or "kept until you delete it". One table lists everything that leaves the Mac. | Met, with one gap: no single "what Stephen keeps" view yet. | NFR section 2, [DATA-STORES.md](../DATA-STORES.md) |
| **Latency** | From end of speech to reply ready: local rules p50 1.5 s, p95 2.5 s. Model answers p50 4 s, p95 8 s. The wake word may add 0.8 s. | Push to talk with the model: p50 1.96 s, p95 6.6 s (n=9). Wake word: p50 9.6 s, p95 20.1 s (n=8), **over target**. | `TARGETS`, `TRIGGER_EXTRA_MS` in `src/telemetry/cli.ts`; NFR section 3 |
| **Cost** | A free daily limit, on by default, on the person's own Claude account. Warn at 80%. Stop new model runs at 100%. "Stop", memory, timers and job status are always free. | Built on `qa`, default 1 USD a day (`src/voice/config.ts`). A job's cost counts toward today's spend, but starting a job is not blocked by the limit. Each job has its own cap, 5 USD by default (`src/jobs/config.ts`). | NFR section 6 |
| **Reliability** | 98% of commands end ok or with a clear spoken reason. A crashed listener is back within 10 s. No command runs twice after a crash. | 37 of 39 commands that reached the assistant ended ok (95%, under the 98% target). Jobs are reconciled after a crash. The listener is not restarted on its own yet. | NFR section 4 |
| **Resources** | Idle: under 3% of one core, under 400 MB for all Stephen processes. Disk under 1 GB with speech models. | One idle `serve` is 52 MB. The rest is not measured yet. | NFR section 5, [ADR-008-MEASUREMENTS.md](../ADR-008-MEASUREMENTS.md) |
| **Setup** | 15 minutes from nothing to the first spoken command. | About 8 commands and 3 permission screens. Not timed with a friend yet. | NFR section 7 |
| **Updates** | One command to update, permissions kept, one command to go back. | `stephen update` exists. Permissions are lost when the unsigned helper changes. | NFR section 8, [ADR-012](../ADR-012-updates-sparkle.md) |
| **Observability** | A tester can send one file that explains a crash, with no words, URLs, names or audio in it. | Phase 1 built: incident log and `stephen report`. | NFR section 9 |
| **Portability** | macOS 14 and up. Windows later without rewriting the core. | macOS 14+. Linux CI runs the Node tests. | NFR section 10 |

### What "p50" and "p95" mean

p50 is the median: half of the commands were faster. p95 means 95 of 100 commands were faster. A system can have a
good p50 and a bad p95. That is the wake word's problem today: some commands take many more model turns.

## 1.4 Scale, so the numbers make sense

This is not a web service. The "load" is one person.

- **Users per install:** 1. In the only sample so far, 51 triggers over 30 days on Cris's Mac, about 2 a day
  ([NFR-STEPHEN.md](../NFR-STEPHEN.md)). Heavier use would still be tens a day, not thousands.
- **Data per user:** small. Memory holds at most 30 items, timers at most 20, history 7 days by default.
- **Concurrency:** one conversation at a time, plus background jobs.

So the design spends nothing on horizontal scale. It spends its effort on **trust boundaries**, **latency on one
machine** and **cost per person**. [TRADE-OFFS.md](TRADE-OFFS.md) explains each choice.

Next: [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md), the high-level design.
