# Stephen product plan (2026-11)

What to build, in what order, and how to tell it worked. A Claude Code session starts here; Fable owns the technical design.

**Snapshot.** `main` @ `29b0a7d`, `qa` @ `719c512`, identical trees, through PR #42 (2026-11-10). **Revised 2026-11-10 with owner answers** (sections 3 and 8). Facts come from the 2026-11-10 inventory, the research pass, repo spot checks and `STEPHEN-DOSSIER.md`. Targets marked as proposals are not measurements. No secrets. No em dashes.

---

## 1. Status as of 2026-11-10

- **Built fast, verified lightly.** 250 commits from 10-30 to 11-09, nine security reviews, release #39 merged. Mac-only paths (Seatbelt, CGEventTap, CoreAudio, Keychain, TCC) reviewed by reading only; every box in `docs/MAC-TEST-PLAN.md` is unticked.
- **Safety core is the strongest part:** deterministic gate, taint on read, trust per conversation, no spoken confirmations. Two P0 findings open (severity is this plan's call; REVIEW-3 #5 rated the redirect gap Low-Med): open_url redirect gaps (VERIFY-3 #5, PARTIAL) and the YouTube `accounts.google.com` frame counted as a private read.
- **Tests green on the Mac, not Linux.** Mac 11-09: 3,143 passed, 0 failed. Linux 11-10: 2 failures (`process-cwd` platform difference; `memory-flow.test.ts:197` "forget that" same-millisecond tie). No Swift unit tests; `AppClient.swift` about 1,790 lines.
- **Speed is unmeasured where it matters.** No Mac end-of-speech to first-audio number. On the Mac: request median 3,407 ms, model 1,774 ms per turn. Warm conversations cut spawn overhead from 1.3-1.6 s to 0.01-0.03 s. The owner calls 3 s bad.
- **Accuracy is the owner's biggest complaint.** By his estimate about 6 of 10 spoken commands are done right. Nothing in the repo measures this. Known weak numbers: whisper-small.en 77.4% on accented speech; YouTube click success about 7 in 10 before the P1 click fixes (not re-measured); bare "Stephen" wakes on 33 of 180 negatives.
- **Phase 1.9 was built, not closed.** Open: memory proposals accept `chat`, `email`, `canvas`, `web` origins (`src/memory/store.ts:47`); the transcript is lost on restart; Conversations matches steps to audit lines by time.
- **Next queue drifts to UI:** five of six build items in `docs/HANDOFF-NEXT.md`. No daily-use evidence (first Mac run 11-05).
- **Verdict:** the engineering is ahead of the product. The next two weeks should produce measurements (latency monitor, accuracy baseline) and closed findings, not features.

---

## 2. Product decisions

### 2.1 Positioning

**One-liner.** Stephen is a voice agent for my own Mac that does real work in my browser and my school and work accounts, and that cannot take an action I did not allow, because a deterministic gate decides, not the model.

**30-second pitch.**

> Every big assistant can now click around your Mac. None of them can prove what it will not do. Stephen is my voice assistant: I say "Hey Stephen", it hears me on-device, and Claude does the work through tools I wrote, in my own browser, across Canvas, Gmail, Notion and Calendar. Every action passes a gate that tracks what private data was read and blocks it from leaving. A spoken "yes" can never approve anything. I test it with injected emails and web pages, and I publish the pass rate. One person's assistant, built to be trusted, measured, and fast.

"Fast" is a goal, not yet a fact (section 7.1).

### 2.2 Must-haves (priority order)

1. Reliable trigger: wake phrase and F5 always work, rare false wakes, Esc always cancels.
2. Commands done right: command success rate is the top metric (section 7.0).
3. Fast commands (Tier 1, section 2.5) clearly under the 3 s the owner calls bad.
4. YouTube Music at 10/10.
5. Browser work in Zen and Chrome with honest step reporting.
6. Read-only briefing across Canvas, Calendar, Notion, Gmail, weather.
7. Owner-only memory from explicit "remember", visible and editable in the app.
8. The native Stephen window as the record: transcript, steps, refusals, approvals, memory, settings.
9. Safety gate with audit and a published injection result.
10. Self-check: `doctor`, `selftest` and the latency monitor say what is broken or slow.

### 2.3 Non-goals (this plan cycle)

- Sending or writing anything: mail, replies, calendar, Notion (U5; ADR-006 stays Proposed; revisit only if a task becomes urgent).
- Cursor, keyboard or Accessibility control; desktop screenshots (U8).
- Authentication, authorization, multi-user, distribution, notarization (U7: later, after the functions are finished). They are now dated decisions, not open-ended ones (U9; order in `IDEAS-RESEARCH-2026-11.md` 9.4).
- Any Windows code or cross-platform UI work (U9: Mac first). Allowed and proposed: keeping macOS-only calls behind one platform layer (F10).
- Browser dashboard; model-written memory, timers or jobs.
- API key or Agent SDK (U6).
- Competing with Siri or ChatGPT on general knowledge, dictation, full-duplex chat.
- New channels, integrations, phone features, internship pipeline (P5).

### 2.4 Fixed owner constraints (verbatim; do not reopen without a stated reason)

1. Native Stephen window in helper app.
2. Finish 1.9 before 2a.
3. YouTube Music first.
4. Memory only from explicit "remember".

Constraint 2 reading: 1.9 was built before 2a but not finished; 2a stays frozen while 1.9 closes.

### 2.5 Two-tier latency policy (owner decision U2)

| | Tier 1: commands | Tier 2: work |
|---|---|---|
| What | One action, closed set: open, play, pause, resume, next, volume, mute, timer, stop, remember, forget | Assignments, research, building, briefings, multi-step browser work, any question needing reasoning |
| Goal | Speed | Quality; may "think like a human" |
| First audible response | p50 1.0 s, p95 1.8 s | Spoken acknowledgement p50 1.0 s, p95 2.0 s |
| Action done | p50 1.5 s, p95 2.5 s | No fixed limit; progress in the window as live steps, a spoken update if silent over 15 s |
| Path | Deterministic fast path, 0 model turns, same gate, trust and audit | Model, full or escalated tool profile |

All times run from end of speech (F5: key release). Targets are proposals until the monitor has a baseline.

**Why these numbers.** The owner calls Alexa's 3 s to open Spotify bad, so even the slow tail (p95 2.5 s) must sit under 3 s, and the typical case at half of it. One model turn costs 1.77 s on the Mac, so Tier 1 cannot use the model: the budget is endpointing (about 0.5 s on wake, 0 on F5) plus ASR (0.2 to 0.5 s) plus routing and action.

**Classification** (deterministic, before the model, recorded on the command id). A request is Tier 1 only if the normalized transcript parses fully against the command grammar (known verb plus an entity that resolves to exactly one app, site, or media query). Anything else, anything ambiguous, and any utterance with words left over is Tier 2. A wrong fast action is worse than a slow right one, so doubt always goes to Tier 2. A Tier 1 request that falls back to the model still counts against Tier 1 targets. Typed text uses the same rule.

---

## 3. Owner decisions (2026-11-10)

All eight defaults are now decided by Cris. Labels U1 to U8 are used across this plan.

| # | Question | Owner decision |
|---|---|---|
| U1 | Language or runtime change? | Keep TypeScript as advised, while no problem shows. Audio to Swift only on the section 5.4 triggers. |
| U2 | What latency is fast enough? | Simple commands must reply fast; 3 s feels bad. Work tasks may be slower. Adopted as the two-tier policy (2.5). Nobody has measured, so build a latency monitor first (A2). |
| U3 | Memory proposals from untrusted origins? | Agreed: only origin `you`; remove `chat`, `email`, `canvas`, `web`. A more general design may come later. |
| U4 | What comes next? | Wanted a scored task table so the order is explicit. Delivered as section 4.1; it governs the order. |
| U5 | Should Stephen ever send (ADR-006)? | Read-only for now. Revisit if a task becomes urgent during building; Claude raises it, Cris decides. Order when revisited (2026-11-11): reply drafts (ADR-006) first; business calls are a distant bet. Messaging the owner himself (away report) is allowed; "call me" is for alerts or very urgent items only, later. |
| U6 | Subscription `claude -p`? | Yes, if better for the product. Stay on ADR-003; add pin and probe (A8). |
| U7 | Single user forever? | No: Stephen is an ongoing product. Finish the functions first, add authentication and authorization later. Do not build it now, and do not block it (keep owner data under one root; no hard-coded user). |
| U8 | Desktop control beyond safe verbs? | Out of scope. Agreed. |
| U9 | Which platforms and users? (2026-11-11) | Mac first, then Windows. Target regular users; students are a small segment. Scheduled runs are a user opt-in setting. Owner hardware: MacBook Pro 14-inch, M5 family, RAM to confirm (base M5 ships with 16 GB); plan: Claude Pro. |

Also open: the YouTube account-frame rule (assumed: non-private for play, pause, seek keys only); handing generic questions to Siri AI after macOS 27; English-only ASR; a public phase 3 report.

---

## 4. Prioritized task table and roadmap

### 4.1 Prioritized task table (U4)

Scoring: priority = user impact weighed against risk if skipped, then effort breaks ties (small first).
P0 = blocks the phase exit or fixes something the owner feels daily; P1 = expected in the phase; P2 = may slip.
Dependencies override priority: a task never starts before the tasks it depends on. Effort: S under 1 day, M 1 to 3 days, L about a week.

| ID | Task | Impact | Risk if skipped | Effort | Depends on | Pri | Phase |
|---|---|---|---|---|---|---|---|
| A2 | Latency monitor: one command id, per-stage timings, p50/p95 per tier | H | Every speed decision stays a guess | M | none | P0 | 1.9a |
| A6 | Accuracy baseline: labelled replay set of 100 real commands, errors split by stage | H | The 6/10 problem is fixed blind | M | A2 | P0 | 1.9a |
| A1 | Mac test pass, sections 0 to 12; file every fail | H | Mac-only safety paths stay unverified | M | none | P0 | 1.9a |
| A3 | YouTube account-frame taint rule; measure play and pause | H | Music, the first priority, keeps failing | S | A1 | P0 | 1.9a |
| A4 | GitHub issue for open_url redirect gaps; Claude verifies the fix (Q11) | M | Open finding on a no-prompt path | S | none | P0 | 1.9a |
| A7 | Fix "forget that" same-ms tie; platform-aware `process-cwd` test | M | Wrong item deleted; red suite on Linux | S | none | P0 | 1.9a |
| B1 | Memory: only origin `you`; remove other origins and end-of-chat proposals | M | Untrusted text can reach memory | S | none | P0 | 1.9b |
| B2 | Memory accuracy test set (7.4) | M | Memory regressions unseen | S | B1 | P0 | 1.9b |
| C1 | Persist conversations and steps by command id | H | Transcript lost on restart | M | A2 | P0 | 1.9c |
| C5 | Split `AppClient.swift` into small files (Q13) | M | Every UI change is risky and slow to review | M | none | P0 | 1.9c |
| C2 | UI items 1 to 4: live steps, section pages, Connected and Permissions, recents | H | Window is not a trustworthy record | L | C1, C5 | P0 | 1.9c |
| C4 | Review 10 (diff plus code analysis), then release PR | H | Unreviewed security changes ship | M | all 1.9 | P0 | 1.9c |
| E6 | Transcript normalization: command grammar, fuzzy entity match, custom vocabulary | H | Misheard names keep breaking commands | M | A6 | P0 | 2b |
| E1 | Tier 1 fast path through the same gate, trust and audit | H | Tier 1 targets unreachable | L | A2, E6 | P0 | 2b |
| E2 | ASR model choice on the replay set (accuracy first, then speed) | H | Accent errors stay at the source | M | A6 | P0 | 2b |
| D1 | Gmail consent to "In production"; token refresh monitoring | M | Re-auth every 7 days | S | none | P0 | 2a |
| D3 | Eval categories per source with injection cases | H | Safety claim has no number | M | none | P0 | 2a |
| F2 | Docs sync to one source of truth | M | Stale docs mislead agents | M | none | P0 | 3 |
| A8 | Pin the Claude Code CLI; `doctor` contract probe (Q7) | M | A CLI update silently breaks the core loop | S | none | P1 | 1.9a |
| A9 | Zen bot detection: reproduce, confirm cause, pick a path (Q14) | H | Owner's browser loops on "are you a bot" | S | A1 | P1 | 1.9a |
| A5 | `fix/model-everywhere`; probe `--effort` | L | Jobs and eval ignore the model picker | S | none | P1 | 1.9a |
| B5 | Memory recall investigation and fix (Q15) | M | "Stephen forgets" stays unexplained | M | B2 | P1 | 1.9b |
| B3 | Move owner data to `~/.stephen`; rotate the ElevenLabs key | L | Leaked key stays live | S | none | P1 | 1.9b |
| C6 | Authenticate helper.sock (Q10) | L | Blocks any later Swift audio move | S | none | P1 | 1.9c |
| C3 | Minimum Swift test layer | M | UI regressions unseen | M | C5 | P1 | 1.9c |
| E7 | False-wake prevention (Q12) | M | Stephen acts when not addressed | M | A6 | P1 | 2b |
| E4 | Endpointing tuning; F5 release as hard end of speech | H | About 0.5 s wasted on every command | S | A2, A6 | P1 | 2b |
| E3 | Smallest voice tool profile that keeps the eval rate | M | Slow turns, more wrong tool picks | M | A6 | P1 | 2b |
| D4 | Implement the Zen sign-in path chosen in A9 | H | Account work blocked in Zen | M | A9 | P1 | 2a |
| D2 | Briefing as a timed, first-class flow | M | Daily value stays ad hoc | M | A2 | P1 | 2a |
| F1 | Haiku chat titles and UI polish | L | Cosmetic | S | C2 | P1 | 3 |
| F3 | Eval and latency report, OWASP mapping, demo | M | No published evidence | M | D3 | P1 | 3 |
| B4 | Behaviour when the memory budget is full | L | Silent drop of the 31st item | S | B1 | P2 | 1.9b |
| E5 | Fold announce into play; acknowledgement policy | M | 0.7 to 1.5 s lost on media | S | E1 | P2 | 2b |
| E8 | Lazy imports and Node compile cache (Q16) | L | Cold starts stay about 0.9 s | S | A2 | P2 | 2b |
| F4 | MCP SDK v1 to v2 behind a tool-schema contract test (Q17) | L | A forced, rushed migration later | M | C4 | P2 | 3 |
| F5 | TTS choice for a market version (Q3) | L | Cost and licence unknown at launch | S | A2 | P2 | 3 |
| F10 | **Proposed, owner to approve.** Portability seam: every macOS-only call (`osascript`, `open`, `security`, `afplay`, `say`, TCC checks, Mac paths) behind one platform layer, with a lint; no behaviour change, no Windows code | M | Windows later means untangling Mac calls from product logic | S to M | C5, B3 | P2 | 3 |
| G7 | **Proposed, owner to approve.** Windows feasibility spike (throwaway, no UI): core starts, voice addons load, ASR and Tier 1 latency on a plain Windows laptop, `claude -p` stays warm, one gated Chrome task | M | The Windows decision is made on guesses | M | F10, Phase 3 exit | future bet | late (4 gate) |

### 4.2 Roadmap

Scope per ID is in 4.1. **Freeze:** no new tools, channels or integrations until the 1.9 exit passes. Phase 2b now runs before 2a work that is not already built, because speed and accuracy are the owner's top complaints.

**Phase 1.9a: Truth pass (about 1 week, no new features).** A2, A6, A1, A3, A4, A7 (P0); A8, A9, A5 (P1).

*Latency monitor (A2), product requirement.* A local "watching monitor" in the Stephen window and as `stephen latency`. For each command id it records the time of each stage: wake or key down, end of speech (endpoint), ASR done, each model turn (start, first token, end), each tool (start, end), TTS first audio, action done. It shows p50 and p95 per tier, per trigger and per stage, for today, 7 days and 30 days, lists the slowest commands, and flags a tier over target. Privacy (Q20): it stores ids, timestamps, tier, trigger, tool names, outcome codes and sizes only; no transcript, argument, URL, page text or audio. Data stays on the Mac, owner-readable only, 30-day retention.

*Accuracy baseline (A6).* See 7.0.

Exit: every Mac test box ticked or filed; monitor running with at least 50 real commands; accuracy baseline table produced; YouTube Music 10/10 scripted; zero open High findings; suite green on Mac and Linux.

**Phase 1.9b: Memory close (about 3 days).** B1, B2 (P0); B5, B3 (P1); B4 (P2). Exit: memory accuracy targets met; a test proves no non-owner origin reaches the store; the Memory page shows exactly what the store holds; the cause of "Stephen forgets" is written down with a fix or a decision.

**Phase 1.9c: Stephen app close (about 1.5 weeks).** C5 first ("make it small first"), then C1, C2, C4 (P0); C6, C3 (P1). Exit: transcript survives restarts; every step maps to one audit record by id; replayed turns have defined trust and taint (Q9); every page seen on screen by Cris; Review 10 has no open High or Medium; release merged by Cris.

**Phase 1.9 exit = 1.9a + 1.9b + 1.9c exits, plus 7 days of daily use with a reliability log (7.3).**

**Phase 2b: Fast and right (about 1.5 weeks).** E6, E1, E2 (P0); E7, E4, E3 (P1); E5, E8 (P2). Exit: Tier 1 targets met over at least 100 logged commands; command success rate at or above 90% on the replay set and in 7 days of real use.

**Phase 2a: Read accounts, hardened (about 1 week; already built).** D1, D3 (P0); D4, D2 (P1). Exit: 14 days with no manual re-auth; Zen sign-in path works without bot loops; injection attack success rate 0; per-source task success at or above 95%.

**Phase 3: Polish and publish (about 1 week).** F2 (P0); F1, F3 (P1); F4, F5 (P2). Exit: docs pass a stale-claim checklist; report written with real numbers.

**Phase 4: Decision gate (not scheduled).** ADR-006 drafts (first when U5 is revisited), Accessibility control, authentication and authorization (U7), how users reach Claude and who pays, Mac signing and onboarding, then the Windows spike (G7, proposed), P5. Each needs an owner decision and its own threat model. Entry: phases 1.9 to 3 exits met and 30 days of reliability data.

---

## 5. Language and runtime

### 5.1 Verdict

**Do not change language** (U1 agreed). Keep TypeScript on Node for the listener, serve, gate and tools, and Swift for the helper and window. Spend the effort on fewer model turns, a better ASR model, and endpointing.

Why: on a warm conversation Node's share (routing, gate, IPC, tool handlers) is tens of ms in a 3.4 s request, under about 2% (inferred from measured stages). Tier 1 speed comes from skipping the model, not from a faster language.

### 5.2 Per-component table

| Component | Language gain | Main facts | Verdict |
|---|---|---|---|
| Voice front end (capture, wake, VAD, ASR), Node | Only plausible gain, from the model not the language | whisper-small 1.50 s vs Parakeet 0.48 s per 4 s clip (Linux); ASR already decodes off the main thread (8.1) | Stay; swap ASR first; Swift on trigger |
| `stephen listen` orchestrator, Node | Tens of ms | Max 8 clients, 1 conversation, 2 jobs | Stay |
| `stephen serve` MCP tools, Node | Cold start only (0.9 s, once per warm conversation) | Best MCP SDK; puppeteer has no equal elsewhere | Stay; least movable |
| Safety gate, TS inside serve | None | Porting resets 9 reviews of evidence | Never port for speed |
| Native UI, Swift | n/a | One 1,790-line file, no unit tests | Stay; split (C5), add tests (C3) |

Rejected: Rust core; Python; Bun or Deno (cheap to probe later).

### 5.3 Criteria for moving any component (all four must hold)

1. Measured by the monitor on the owner's Mac, the component costs at least 300 ms or 15% of p50.
2. The cheaper in-language fix was tried and measured.
3. The target language gives a capability the current one cannot, not only speed.
4. Migration fits in about one week with test parity and does not weaken a trust boundary.

### 5.4 Triggers that would change the verdict

- **Audio front end to Swift** if Mac ASR p50 stays above 300 ms after the model swap; or Apple's SpeechAnalyzer beats every sherpa-onnx model on the replay set (8.2); or speaker-caused false wakes stay above target (echo cancellation needs Swift); or U8 flips. Precondition: helper.sock authenticated (C6).
- **Bun runtime** if cold starts exceed about 30% of real commands and serve start stays above 500 ms after E8.
- **Rust or Swift for serve or gate** only if distribution (U7) or a direct API (U6) arrives.
- **Anything** if idle total RSS exceeds about 1 GB or idle CPU about 2% of a core, measured.

**Effect of the Windows decision (U9).** Mac first, Windows later strengthens this verdict. The parts that carry Stephen's value (gate, taint, MCP tools, routing, audit, evals) are TypeScript and run on both systems; rewriting the core in Swift would lock it to the Mac, and in Rust would reset the review evidence for no user-visible gain. It also raises the bar for the "audio front end to Swift" trigger: a Swift voice stack would have to be rebuilt for Windows, so that move now needs a gain worth a platform fork. The working rule is thin platform code: the Swift helper holds only what must be native (window, hotkey, dialogs), and macOS-only calls sit behind one layer (F10, proposed). The Windows shell (one cross-platform UI, or a separate native Windows app) is not chosen here; criteria and options are in `IDEAS-RESEARCH-2026-11.md` section 9.

### 5.5 Measure first (all through the monitor, phase 1.9a)

Per-stage p50 and p95 by tier and trigger; ASR decode time per model; event-loop delay during decode; warm vs cold share; time to first token and turns per command; idle and peak RSS and CPU; cold start of listener and helper; TTS first audio (ElevenLabs, Kokoro, `say`); prompt size per turn (42 KB today); battery cost of always-on wake word.

---

## 6. Market summary (Nov 2026)

| Product | Does better | Stephen's opening |
|---|---|---|
| Siri AI, macOS 27 beta [[iClarified]](https://www.iclarified.com/102225/apple-launches-siri-ai-beta-with-personal-context-onscreen-awareness-and-app-actions) | Personal context, on-screen awareness, app actions; beta with daily usage limits | Needs macOS 27 (Stephen targets 26); no Canvas, Zen or owner gate |
| ChatGPT desktop Voice (GPT-Live) [[iThinkDiff]](https://www.ithinkdiff.com/chatgpt-voice-returns-mac-gpt-live-july-2026/) | Full-duplex; steers agents and Computer Use | No wake word in coverage; cloud audio; model-judged safety |
| Claude desktop Cowork, computer use, Dispatch [[VentureBeat]](https://venturebeat.com/technology/anthropics-claude-can-now-control-your-mac-escalating-the-fight-to-build-ai) | Whole-desktop control, connectors, scheduled tasks | One reviewer saw about half of Dispatch tasks succeed; no always-listening voice |
| Claude Code `/voice` [[dev.to]](https://dev.to/raxxostudios/claudes-biggest-week-yet-computer-use-channels-and-voice-mode-1nli) | Built-in dictation into the same engine | Terminal-bound, no wake word, no spoken replies |
| Gemini for Mac [[TestingCatalog]](https://www.testingcatalog.com/google-tests-live-mode-with-screen-sharing-for-gemini-desktop.md), [[Android Authority]](https://www.androidauthority.com/gemini-mac-app-magic-pointer-gemini-live-voice-dictation-3681280/) | First-party Google account depth | Mac agent actions unclear; Stephen adds Canvas and Notion under taint |
| Perplexity Personal Computer [[MacRumors]](https://macrumors.com/2026/05/07/perplexity-mac-app-personal-computer/) | Hotkey voice, multi-step workflows, audit and reversal | Paid tier; work leaves the Mac; no user-owned policy |
| Raycast AI [[changelog]](https://www.raycast.com/changelog/macos-beta/0-57) | Launcher speed, built-in AI, dictation | Keyboard-first, no gate; learn its speed feel |
| Wispr Flow, Superwhisper [[dupple]](https://dupple.com/learn/wispr-flow-vs-superwhisper) | Dictation quality, custom vocabulary | They type, not act; lesson: vocabulary hints matter (E6) |
| OpenClaw [[dev.to]](https://dev.to/zacvibecodez/openclaw-voice-assistant-voice-wake-and-talk-mode-setup-2fki) | Wake word, talk mode, many integrations | Mic permission is the only access control named |

**Where Stephen wins.** Not on timers, weather or "open Safari" (free and faster elsewhere), which is exactly why Tier 1 must stop feeling slow. It wins on a deterministic gate between a voice and real accounts, the owner's actual stack (Canvas, Notion, multi-account Gmail, Zen), local speech and data, no extra subscription, and being measurable: none of the products reviewed publishes an injection pass rate.

Not verified: Gemini desktop Live after May 2026; competitor latency (none published in sources read).

---

## 7. Success metrics

All targets are proposals until the 1.9a baselines exist.

### 7.0 Command success rate (top metric, P0)

**Definition.** Share of spoken commands where Stephen did what the owner meant, first try. Today: about 60% by owner estimate, unmeasured. Target: 90% at the 2b exit, 95% after 30 days of use.

**Likely causes, from the inventory (to be confirmed, not assumed):**

| Stage | Suspect | Evidence |
|---|---|---|
| Trigger | Start or end of speech clipped; false or missed wake | Recall 82/90 clean, 74/90 noisy; endpoint silence 0.8 to 1.5 s |
| Hearing (ASR) | whisper-small.en on accented English; no hotwords possible in this stack | 77.4% accented vs 97.3% clean; `docs/VOICE.md` |
| Hearing (names) | App, site, song and people names misspelled | Name fix exists only for names in memory, one edit away (`src/voice/names.ts`) |
| Understanding | Model reads a noisy transcript literally; 27 KB of tool schemas to choose from | No eval uses noisy transcripts |
| Action | Right tool, failed click or wrong tab | YouTube about 7 in 10 before P1 fixes |

**Measurement plan (A6).** With the owner's opt-in, record 100 real commands (audio kept locally in an owner-only folder, separate from telemetry, deletable). The owner labels each: what he said, what he wanted. Then score three ways: (1) replay the audio through each ASR model, intent preserved or not (hearing errors); (2) type the correct text into Stephen, right tool and arguments or not (understanding errors); (3) right call but failed outcome (action errors). Trigger failures are counted from the monitor. Output: one table of error share per stage. The largest share is fixed first; the set becomes a regression suite.

**Owner's idea: text normalization and NLP post-processing (E6).** Honest evaluation:

| Option | Fixes | Does not fix | Cost | Verdict |
|---|---|---|---|---|
| Command grammar plus fuzzy entity match against closed lists (installed apps, site aliases, open tabs, playlists, memory names) | "open you tube", "play on youtube musics", misspelled app and site names | Open vocabulary (new song titles), clipped audio, wrong understanding | M; deterministic, about 0 ms | Do it. It is also the parser the Tier 1 fast path needs, so one piece of work serves speed and accuracy |
| Custom vocabulary inside ASR (hotwords) | Names at the source | Not available for Whisper or Moonshine here; Parakeet attempt failed | Unknown | Retest only with the model chosen in E2 |
| Better ASR model | All hearing errors, including accent | Understanding and action errors | M | Do it (E2); root cause if hearing dominates |
| Model-side repair (tell Claude the text is a noisy transcript, give the entity list) | Tier 2 misreads | Tier 1 (no model) | S | Do it for Tier 2 |
| Low-confidence "say that again" | Wrong actions | Adds a round trip | S | Do it when no entity resolves; never guess |

Risk of normalization: over-correction (a real word turned into an app name). Rule: correct only on a unique match above a threshold; otherwise leave as heard and go to Tier 2. If the baseline shows hearing errors are a minor share, E6 shrinks to the grammar the fast path needs.

### 7.1 Latency (owner's Mac, from end of speech)

| Metric | Target | How measured |
|---|---|---|
| Tier 1 first audible response | p50 1.0 s, p95 1.8 s | Latency monitor, per command id |
| Tier 1 action done | p50 1.5 s, p95 2.5 s | Same |
| Tier 2 spoken acknowledgement | p50 1.0 s, p95 2.0 s | Same |
| Tier 2 read-only account question, full answer | p50 4 s, p95 8 s (reported, not a gate) | Same |
| Esc to silence | p50 150 ms, p95 300 ms | Same |
| Wake phrase to listening chime | p50 300 ms, p95 600 ms | Same |

A Tier 2 acknowledgement is reported separately from first useful audio.

### 7.2 Task success

| Metric | Target | How measured |
|---|---|---|
| Real-model eval pass rate | at least 95% overall, no category under 90% | `stephen eval`, 3 runs |
| YouTube Music play, pause, resume | 10/10 scripted; at least 95% real use | Scripted set plus daily log |
| Click fixtures | 20/20 on real Zen (Gecko) | `eval-clicks` |
| Injection attack success rate | 0 (mail, Canvas, web) | Injection categories, with and without the gate |
| Tier 1 served by the fast path | at least 90% of Tier 1 requests | Monitor |

### 7.3 Reliability

| Metric | Target | How measured |
|---|---|---|
| Daily-use command success | see 7.0 | "That was wrong" mark plus failure codes |
| False wakes | under 1 per day; 0 false commands executed | Monitor; speaker-playback test |
| Wake recall | at least 95% clean, 90% noisy | Recorded set in owner's voice and room |
| Transcript accuracy, owner's voice | at least 95% intent preserved | Replay set |
| Crash or hang needing restart | under 1 per week | Restart counters |
| Re-auth prompts; bot-check loops in Zen | 0 per 14 days | Account status log |
| Test suite | 0 failing, 0 known-flaky, Mac and Linux | Before each release |
| CLI drift | contract probe passes on every Claude Code update | Pin plus `doctor` probe |

### 7.4 Memory accuracy

| Metric | Target | How measured |
|---|---|---|
| "Remember" stored verbatim, correctly scoped | 100% of 30 phrasings, typed and spoken | Deterministic test set plus replay audio |
| "Forget that" removes the intended item | 100%, incl. same-ms tie | Test set |
| Recall when relevant | at least 95% of 20 prompts | Real-model eval category |
| No leak into unrelated or tainted flows | 100% | Eval with wake and phone trust |
| Non-owner writes | 0 by construction | Test that only origin `you` reaches the store |

### 7.5 Footprint and product

| Metric | Target | How measured |
|---|---|---|
| Idle footprint | RSS under 1 GB, CPU under 2% of a core | Process sampling |
| Prompt size, voice turns | 50% cut (schemas 27 KB toward 8 KB) | Monitor |
| Subscription limits | no rate-limit hits in a normal day | Run log |
| Owner use | at least 10 voice commands a day for 14 days | Monitor; if Cris does not use it, the plan is wrong |

---

## 8. Open technical questions: owner answers and recommendations

The owner asked for trade-offs and a decision on each. Where an answer is unclear, Claude Code investigates the code before building. Research blocks 8.1 to 8.5 give sources (fetched 2026-11-10).

| # | Question | Owner answer | Recommendation (pros, cons) and decision |
|---|---|---|---|
| 1 | Where do the seconds go on the Mac? | Speed means how fast Stephen responds and acts; commands fast, work may be slow | **Decision: build the monitor (A2) before any optimization.** Pro: ends guessing. Con: a few days with no visible speed-up |
| 2 | Does ASR decoding block the event loop? | Research it | **Decision: keep the current design, verify by measurement.** The repo already decodes off the main thread. See 8.1 |
| 3 | Which ASR model for the owner's voice? | Read as the speaking voice: ElevenLabs is "for fun"; pick the cheapest good one for market | A small clarification: this question is about hearing (speech-to-text), not speaking. Both answered. **ASR decision: choose on the replay set; Parakeet is the expected winner** (8.2). **TTS decision: keep ElevenLabs now; decide at F5** (8.2) |
| 4 | Which commands can skip the model? | Fast path only for single commands | **Decision: fast path = Tier 1 (2.5).** Pro: only route under 3 s. Con: a second code path; it must call the same gate, trust and audit, with a test that proves it |
| 5 | Endpointing; F5 release as hard end? | If cheapest, yes | **Decision: yes (E4).** F5 release ends speech at once. Wake path: lower silence toward 0.5 s only if the replay set shows no extra clipping. Con: a speaker who pauses mid-sentence gets cut off, so tune on his own recordings |
| 6 | Smallest voice tool profile? | Smallest if fine. Real problem: about 6 of 10 commands right | **Decision: two profiles (E3):** a small voice profile, the full set on escalation. Pro: faster turns, fewer wrong tool picks. Con: a missing tool fails a task, so keep only if the eval rate holds. The real problem is now the top metric (7.0) |
| 7 | Pin and probe the Claude Code CLI? | Take time and search | **Decision: exact version pin plus a contract probe in `doctor` (A8).** See 8.3 |
| 8 | One command id across conversations, steps and audit? | Suggested NLP or text mining | A small clarification: this is about giving each command one id so its records join exactly. **Decision: the listener mints one id at the trigger; every stage, audit line, step and monitor row carries it (A2, C1).** The NLP idea is adopted where it fits: accuracy work (E6, 7.0) |
| 9 | Trust and taint of replayed turns? | Cares about accurate text, taint and trust | **Decision: resumed history is shown as stored; if it re-enters the model it is quoted as untrusted data, with the conversation's highest taint restored and the lower of the original and current trust.** Pro: no laundering. Con: some resumed chats cannot act without a fresh request |
| 10 | Authenticate helper.sock now? | If cheap, yes | **Decision: yes (C6):** peer user check plus a per-launch nonce. Pro: about a day; unblocks a Swift audio move. Con: does not stop a same-user attacker (out of scope until U7) |
| 11 | Complete fix for open_url redirects? | Make it a GitHub issue assigned to Claude to verify the fix | **Decision: file the issue (A4)** with the three cases (site 302, `?u=//host`, bare host) as failing tests; Claude verifies each is closed |
| 12 | Cut false wakes? | Try to prevent them | **Decision (E7): make bare "Stephen" opt-in, off by default** (33 of 180 false wakes); keep the transcript check and the audio-playing gate. Pro: cheap. Con: one more syllable. Echo cancellation needs Swift: only on the 5.4 trigger |
| 13 | Swift tests; split the client file? | Make it small first; research later | **Decision: split first (C5), no behaviour change, then tests (C3)** |
| 14 | Zen (Gecko) vs Chromium BiDi; owner's browser | Zen is detected as a bot; sign-in to Claude or Gmail loops. Research it | **Decision: confirm the cause (A9), then split sign-in from automation and route bot-checked sites away from the debug port (D4).** See 8.4 |
| 15 | "Forget that" tie; timestamp order | If Stephen forgets, that is a memory problem; find out how to improve it | Two things: the tie bug (A7: order by a sequence counter, not the clock) and recall (B5). **Decision: investigate with the failure list in 8.5 before changing design** |
| 16 | Lazy imports or compile cache? | Fable recommends | **Decision: do both, small (E8), P2.** Pro: about 0.3 s off cold start. Con: helps only cold commands; the monitor shows how many those are |
| 17 | MCP SDK v2? | Move when easy | **Decision: phase 3 (F4), after Review 10,** behind a test that pins the tool list and schemas. Pro: unforced. Con: none if v1 keeps getting fixes; recheck at phase 3 |
| 18 | Docs vs code truth? | Unsure; fall back and clarify | **Decision: code wins; when code and docs disagree and intent is unclear, Claude Code stops and asks.** Generate tool and message lists from code; stale-claim checklist (F2) |
| 19 | What must Review 10 re-check? | Diff plus code analysis | **Decision: the diff of #32 to #41 plus 1.9 work, plus whole-code checks:** gate reachability from the fast path, VERIFY-2 N4, R7-1 on the Mac, origin removal, helper.sock auth, replay taint |
| 20 | Acceptable local telemetry? | Private content only request-scoped, tighter, so Stephen stays in scope | **Decision: telemetry never stores content (A2 privacy rule). Private content is readable only inside the request that fetched it.** The replay set is a separate, opt-in, owner-only store |

### 8.1 Q2: ASR decode and Node's event loop

Spot check: `src/voice/engine.ts` calls `rec.decodeAsync(stream)`, and sherpa-onnx-node 1.13.8 implements it as a native async worker ([sherpa-onnx PR 3049](https://github.amrom.workers.dev/k2-fsa/sherpa-onnx/pull/3049)). So the long decode already runs on a libuv pool thread, not the main thread. The earlier claim ("no `worker_threads`, may block") was incomplete. Still synchronous: wake-word and VAD frame decodes, which are short.

| Option | Pros | Cons |
|---|---|---|
| Native async worker (today) | No copy, no new process, done | Shares the 4-thread libuv pool with file and DNS work |
| `worker_threads` | Isolates all audio work | Model loaded in a second isolate, message copies, more code |
| Child process | Crash isolation, own priority | IPC latency, lifecycle, more memory |
| Swift (helper) | Echo cancellation, system ASR | New hop, needs C6, resets pipeline tests |

**Decision:** keep the async worker. The monitor records event-loop delay (Node `perf_hooks`) and Esc-to-silence during decodes. Act only if p99 loop delay exceeds 50 ms; first step is then moving wake-word and VAD into one worker thread. Swift only on the 5.4 triggers.

### 8.2 Q3: ASR for an accented English speaker on Apple Silicon; TTS

No source read measured English with the owner's accent, so public numbers only shortlist.

- **Parakeet TDT 0.6b** (v2 English, already wired; v3 multilingual): 6.3% average WER vs 7.8% Whisper large-v3-turbo and 8.6% Whisper small.en on the Open ASR sets; on accented VoxPopuli 6.1% vs 9.3 to 11.9% for turbo ([arXiv 2604.14493](https://arxiv.org/html/2604.14493v2)). About 3x faster than whisper-small in Stephen's Linux test.
- **Apple SpeechAnalyzer (macOS 26):** 2.1% and 4.6% on LibriSpeech clean and other vs 3.7% and 8.0% for Whisper small, in about a third of the time ([Gigazine](https://www.gigazine.net/gsc_news/en/20260714-apple-speech-analyzer-benchmark/)). Accents untested; needs Swift.
- **Moonshine:** fastest in Stephen's test (0.42 s); accent accuracy not in the sources.
- **Nemotron streaming:** 7.3% WER at 0.56 s delay (same paper); streaming could shrink endpoint wait later.
- **Whisper large-v3-turbo:** described as coping well with accents ([Spokenly](https://spokenly.app/blog/parakeet-vs-whisper)), but 1.6 GB and slowest.

**Decision (E2):** score small.en, Parakeet v2 and v3, and Moonshine on the replay set; pick the highest intent accuracy with Mac decode p50 under 300 ms. Test SpeechAnalyzer only if none reaches 95%.

**TTS.** ElevenLabs Flash v2.5 costs about 50 USD per 1M characters; its free plan is non-commercial. Cheaper: OpenAI tts-1 15, Inworld TTS-2 Flash 15, Azure HD 22, Deepgram Aura-2 30 ([Gradium, Sept 2026](https://gradium.ai/content/how-to-compare-tts-pricing-across-providers-2026)); local Kokoro and macOS `say` are free. **Decision:** keep ElevenLabs now. For market (F5): Kokoro if Mac first audio is under 300 ms (private, free), otherwise the cheapest cloud voice that passes a listening test.

### 8.3 Q7: pin and probe the Claude Code CLI

Findings: the documented settings are a release channel (`autoUpdatesChannel`: stable or latest) and `minimumVersion`; `DISABLE_AUTOUPDATER=1` and `autoUpdates: false` circulate, but users report they are not always honoured on native installs ([claude-code issue 56723](https://github.com/anthropics/claude-code/issues/56723), [issue 13213](https://github.com/anthropics/claude-code/issues/13213)). Releases land several times a week ([changelog](https://code.claude.com/docs/en/changelog.md), not fetched here). Stephen has seen 2.1.314 to 2.1.319 and has no version check today (repo grep).

| Option | Pros | Cons |
|---|---|---|
| Trust auto-update | Zero work | A protocol change breaks voice with no warning |
| Settings and env switches only | Easy | Reported unreliable |
| Stephen-owned exact-version install, called by absolute path | Updates happen only when Stephen bumps the pin | Must be verified on the Mac: login sharing, and that this copy does not self-update |
| Contract probe | Catches drift whatever the install | Costs one short model turn |

**Decision (A8):** do the last two together. (1) Record a tested version range; `doctor` and listener start compare `claude --version` to it. (2) Contract test: a recorded stream-json exchange (initialize, MCP status, one trivial turn) checked for every message type and field Stephen parses; run in `doctor` and once per new version. (3) On failure: warn in the window, fall back to one-shot mode. (4) Upgrade ritual: bump the pin on a branch, run probe plus eval, then merge. Claude Code must confirm exact install commands against the live setup docs.

### 8.4 Q14: Zen detected as a bot

Cause, high confidence: Firefox sets `navigator.webdriver` to true whenever its remote agent is on, which is what `--remote-debugging-port` does; there is no supported switch, and limiting it to an active session is still an open bug ([Bugzilla 1719505](https://bugzilla.mozilla.org/show_bug.cgi?id=1719505)). Google, Claude and Cloudflare read that flag. A 2026 benchmark found bot gates detect the automation protocol itself, so patched fingerprints do not help, and plain system Chrome over CDP passed the most gates ([Paterson](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/)).

| Option | Pros | Cons |
|---|---|---|
| Stealth patches or prefs | Small | Arms race; hides automation from sites; weakens Stephen's trust story. Rejected |
| Split modes: sign in using normal Zen, automate in "Zen for Stephen" (same profile) | No new code | Checks return mid-session on protected sites |
| Route bot-checked sites to Chrome over CDP (owner's Allow) or to APIs (Gmail API exists) | Chrome is not expected to set the flag for a user-enabled debug port (confirm in A9); APIs skip pages | Two browsers; owner prefers Zen |
| Extension bridge in everyday Zen (no remote protocol) | Flag stays false; real profile | New component and threat model; reverses ADR-001; synthetic clicks. Largest |
| Playwright | none here | Same protocol, same flag |

**Decision:** A9 confirms the flag and the loop on the Mac, and tests whether sessions from normal Zen survive into the debug launch. D4 then ships: never sign in while the debug port is on; Stephen detects a challenge page, stops and says so; Gmail through the API; protected sites through Chrome. The extension bridge becomes an ADR only if loops persist after D4.

### 8.5 Q15: why Stephen forgets, and how to improve recall

Stephen's store is tiny (30 items of 200 characters) and every item is placed in the system prompt on each run (`src/voice/claude.ts`). So the usual cause, retrieval miss (about 70% of wrong answers in retrieval systems, per [Hyperspell](https://www.hyperspell.com/blog/memory-failure-modes)), mostly does not apply. Likely causes, in order to check (B5):

1. **Never stored.** Only an explicit, correctly heard "remember" writes. A misheard trigger, a wake-word "remember" waiting on a dialog, or a fact said in passing leaves nothing.
2. **Not delivered.** Phone trust gets no memory; a warm conversation may hold an older copy; the 31st item is dropped.
3. **Delivered but unused.** Models use the middle of a long prompt worst: about 55% accuracy mid-context vs 75% at the start ([Mem0](https://mem0.ai/blog/memory-retrieval-strategies-for-ai-agents)); memory sits after 42 KB of prompt.
4. **Not memory at all.** Conversation history is lost on restart (C1 fixes this).

Patterns that fit a small personal store: keep everything in context (no vector database needed at this size); put memory near the end of the prompt with a line telling the model to use it; confirm each save aloud and show it in the Memory page; resolve conflicts by newest wins; log a "should have remembered" mark so each miss is classified 1 to 4. Add retrieval (keyword plus embeddings) only when the store outgrows the budget. **Decision:** classify real misses first, then fix the largest class; do not let the model write memory (fixed constraint 4).
