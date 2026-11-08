# Review 9: the 2026-11-08 batch (PRs #11 to #29)

Date: 2026-11-08. Repo `/Users/crishuynh/Documents/SoftwareProject/brower-hub/browser-hub`, the 19 open PR branches as
they are locally (tips listed under Scope). Independent reviewer (did not build this code). The repo was not changed
except for this file. Probes ran on the owner's Mac (macOS 26, Node 24) against the branch worktrees' `dist/` and
`src/`, read only. Probe scripts are in this session's scratchpad (`names-probe.mjs`, `names-probe2.mjs`); their
output is quoted below. No Stephen process, browser, Remote Control or helper was started.

## Scope

| PR | Branch @ tip | Base | Reviewed |
|----|--------------|------|----------|
| #11 | docs/ui-plan-v31 @ 5c354ee | main | phone env fix (`src/phone/setup.ts`), docs |
| #12 | docs/p4-reply-design @ 88f457b | main | ADR-006 design and threat model (no code) |
| #13 | ui/theme @ 02aed46 | main | Swift theme, `src/helper/install.ts` |
| #14 | p7/asr-names @ 76170d8 | main | `src/voice/names.ts`, `listener.ts` |
| #15 | p2/app-control @ 124bd96 | main | `src/app/control.ts`, app.sock control requests, `StephenControl` (Swift), `doctor --json` |
| #16 | p1/click-eval @ 9fc5b42 | main | `src/eval/clicks.ts` |
| #17 | ui/ask-box @ 69d982c | ui/theme | `helper/AskBox.swift`, `main.swift` |
| #18 | p2/app-usage @ 4140a04 | p2/app-control | `src/app/usage.ts`, context usage in `warm-claude.ts` |
| #19 | ui/ask-confirm @ fc17a78 | ui/ask-box | `src/safety/app-confirm.ts`, confirm relay in `src/app/server.ts`, Ask box Swift |
| #20 | p1/click-fixes @ 98f534a | p1/click-eval | settle, verify, re-find (`src/page`, `hub.describeClickTarget`) |
| #21 | fix/zen-iframe-click @ 559d897 | main | `test/helpers/fake-zen.ts` |
| #22 | p6/speed-measure @ 8380af6 | p1/click-fixes | `src/lib/step-timer.ts`, timings |
| #23 | ui/main-window @ e7fb546 | ui/ask-confirm (+ p2/app-usage) | Swift main window, the merge |
| #24 | ui/personal @ f42e1f4 | ui/main-window | `src/app/personal.ts` |
| #25 | p6/speed-cuts @ ad84012 | p6/speed-measure | persona line, dry-run `include_snapshot` |
| #26 | ui/memory-api @ 7d2769d | ui/personal | `src/memory/proposals.ts`, memory.* requests, graph |
| #27 | ui/memory-page @ f469bd9 | ui/memory-api | `helper/MemoryPage.swift` |
| #28 | ui/settings @ 55c8ef1 | ui/memory-page | `settings.set`, `src/voice/talk.ts`, `src/app/talk.ts` |
| #29 | ui/conversations-jobs @ 1be6110 | ui/settings | Swift pages |

## Method

Threat model as in reviews 6 to 8 (`docs/SYSTEM-DESIGN-STEPHEN.md` section 5 on main and each branch's version):
same-user processes are out of scope. A finding counts if it helps a lower-trust actor (web page, email sender, the
model, the person holding the phone, a bystander saying "Hey Stephen") or breaks a promise the design makes to the
owner. Correctness bugs that ship broken behaviour are reported too.

- Each PR read as `git diff <base>...<branch>`, files read at the branch with `git show`.
- **Confirm relay (#19).** Traced every path into `AppServer.settle` and `AppConfirmer.finish`, then traced how the
  listener starts `serve` (`mcpConfig` in `src/voice/claude.ts`) and how `--confirm` reaches `buildConfirmer`
  (`src/serve-args.ts`, `src/cli.ts:135`).
- **Re-find (#20).** Followed `click` from `tools.ts` through `hub.action` → `perform` (re-check) → `engine.click`
  (settle, press, verify). Checked that `gate.evaluate` has no side effects (it only prunes).
- **Name correction (#14).** Ran `correctNames` from `wt-p7/dist` (built after the last `src` change, tree clean) on
  ordinary commands with ordinary memory items.
- **App control (#15).** Read `runPhoneCli on/off`, the listener's exit path and the Swift `StephenControl`.
- **Cross-stack merges.** `git merge-tree` of `ui/conversations-jobs` with `p6/speed-cuts`, `p7/asr-names`,
  `fix/zen-iframe-click`, `docs/*`: all merge without textual conflicts; the merged `src/voice/claude.ts` was read.
- Tests (read-only worktrees): `wt-ui-cj` `npx vitest run test/app test/voice/talk.test.ts test/memory test/helper
  test/safety`: 37 files, 1203 passed. `wt-p7` `test/voice/names.test.ts test/voice/listener.test.ts`: 37 passed.
  `wt-p6` `test/eval test/lib test/server`: 20 files, 275 passed.

## Findings

| ID | Severity | PR | Title | File:line |
|----|----------|----|-------|-----------|
| R9-1 | High | #14 | Name correction blocks ordinary commands ("make a timer", "take a screenshot", "I have a meeting") with "Did you mean Mike?" and silently rewrites words ("page" to "Paige", "email" to "Gmail") | `src/voice/names.ts:12-25,40,79`, `src/voice/listener.ts:645,679` |
| R9-2 | Medium | #19 | The Ask box is never asked for Stephen's own voice or typed chats: the listener starts `serve --confirm dialog`, so the chain is dialog only; the PR's Mac test step 2 will show the dialog | `src/voice/claude.ts:340`, `src/safety/confirm.ts:465-470` |
| R9-3 | Medium | #20 | The new settle wait (up to 2 s, plus bringing the tab to front) runs after the post-approval identity re-check and before the press, so an approved element can change in that window and is clicked anyway | `src/page/index.ts:694,774-777`, `src/server/hub.ts:656-657` |
| R9-4 | Medium | #15 | `phone.on` from the window starts Remote Control as a child of the listener; stopping the listener (helper Stop, SIGKILL) leaves it running with the kill switch marker in place, so the phone link comes back by itself on the next Start | `src/app/control.ts:107`, `src/phone/cli.ts:138`, `src/voice/index.ts:625-629`, `helper/AppClient.swift:1304-1310` |
| R9-5 | Medium | #12 | ADR-006 leaves the process boundary open: `reply_draft` runs in `serve` (model-reachable, one per conversation), the card, send and rate limit in `stephen listen`; recipient, taint flags and limits must be built in the listener, not taken from serve | `docs/ADR-006-reply-by-voice.md:52,79,132` |
| R9-6 | Low | #19 | Ask box buttons are live the instant a question appears, and answering one swaps the next question into the same place: a double click approves a question the owner never saw | `helper/AskBox.swift:34,81-95,281`, `helper/AppClient.swift:1053` |
| R9-7 | Low | #19 | Relay hardening: `confirm.answer` is accepted from any client (not only Ask boxes); the gate's connection receives every broadcast (heard text, replies); the 4096-byte cap is applied to the unsplit buffer | `src/app/server.ts:224,244`, `src/safety/app-confirm.ts:73` |
| R9-8 | Low | #15 | Helper Stop sends the delayed SIGINT/SIGKILL to a bare pid without re-checking it; `listen.pid` is never cleared; `launch.json` is rewritten by whichever checkout last ran `stephen listen` | `helper/AppClient.swift:1304-1310`, `src/voice/index.ts:569`, `src/app/control.ts:150` |
| R9-9 | Low | #12 | ADR-006 says the phone may draft, but phone conversations run `serve --trust wake`, which the same ADR says has no `reply_draft` | `docs/ADR-006-reply-by-voice.md:25,50,129` |
| R9-10 | Low | #25, #28 | Cross-stack red test: #28 pins the default persona by SHA-256, #25 adds a persona sentence; both merge cleanly and the pin then fails | `test/voice/talk.test.ts:11-12` (ui/settings), `src/voice/claude.ts:92` (p6/speed-cuts) |
| R9-11 | Low | #28, #14 | One implementation per concern: `TalkStore.set` copies `updateAccountsConfig`; `names.ts` adds a third Levenshtein | `src/app/talk.ts:32-45`, `src/connect/accounts-cli.ts:57`, `src/voice/names.ts:31`, `src/desktop/resolve.ts:142`, `src/voice/transcript.ts:34` |
| R9-12 | Info | #26, #24, #20, #15 | Docs claims that no longer match the code | see below |
| R9-13 | Info | #15 | `phone.on` from the window: Remote Control inherits the listener's stdio (not verified at runtime) | `src/phone/cli.ts:138-141` |

No Critical findings. Nothing found lets anything other than the owner's click approve a gated action, lets the
model or third-party text write memory, or widens the phone channel. R9-1 is rated High as a correctness break, not a
safety break: it stops the most common commands for any owner whose memory names a short common name, every time.

### R9-1 (High) Name correction blocks ordinary commands and rewrites ordinary words

**What.** `buildNameList` takes every capitalised word of 3+ letters in the memory items as a "name"
(`names.ts:25`; `NOT_NAMES` only lists a few sentence starters). `correctNames` compares every command word (4+
letters, or 2 to 3 joined words) with every name: similarity 0.8 or more to one name rewrites the word, 0.7 to 0.8
stops the command (`listener.ts:679`: nothing runs, Stephen says "Did you mean ...?"). For a 4-letter word one edit
away from a 4-letter name the similarity is exactly 0.75, so the command is blocked. Probe (`names-probe.mjs` on
`wt-p7/dist`, memory "My roommate is Mike", "My brother Jake lives in Toronto", "My friend Dave", "I check my email in
Gmail", "My sister is Paige"):

```
"make a timer for ten minutes" -> unchanged, Did you mean Mike or Jake?
"play songs I like"            -> unchanged, Did you mean Mike?
"take a screenshot"            -> unchanged, Did you mean Jake?
"I have a meeting at noon"     -> unchanged, Did you mean Dave?
"save this page"               -> "save this Paige", Did you mean Dave?
"check my email"               -> "check my Gmail"
"scroll down the page"         -> "scroll down the Paige"
```

`names-probe2.mjs` (memory "Call mom on Sundays", "Gym is Fit4less near home"): names are `Call, Sundays, Gym,
Coffee`; "play fall out boy" asks "Did you mean Call?"; "set a timer to call back" becomes "to Call back".

**Why it matters.** The question is deterministic: repeating the command gets the same question, so with one common
short name in memory, "make", "take", "have", "like", "save", "late", "note" (Nate), "mark" (Mark) commands never
run, by voice, F5 or wake word. Rewrites like "page" to "Paige" change what Claude is asked to do. The tests pass
because they only cover real names (`Maren`/`Marin`).

**Fix.** Never block: drop the "unsure, nothing runs" path (or ask only when the command is about a person, which
today it never is). Only rewrite a word that is not a common English word (reuse `STOPWORDS`/`contentWords` from
`src/memory/intent.ts` plus a small common-word list), require 5+ letters and one edit (the rule `transcript.ts:56`
already uses for wake words), and take names only from capitalised words that do not start the memory text. Add the
probe lines above as tests.

### R9-2 (Medium) The Ask box is never used for Stephen's own chats

**What.** `buildConfirmer` adds the Ask box only for `safety.confirm: "auto"` (`confirm.ts:465`). Every serve the
listener starts gets `--confirm dialog` (or `deny` for the phone) (`claude.ts:340`), and `serve` sets
`cfg.safety.confirm = opts.confirm` (`src/cli.ts:135`), so voice and typed chats use `[dialog]` only. The Ask box is
reached only when another MCP client (a Claude Code or Claude Desktop session using Stephen) runs `serve` with the
default `auto`.

**Why it matters.** The feature does not do what the PR says. Mac test step 2 ("Say or type something that needs
approval ... The Ask box opens") will show the macOS dialog. It fails safe (the dialog still asks), so not a safety
break. R9-6 and R9-7 become relevant once this is fixed.

**Fix.** Give listener-started serves a mode that tries the box first, for example `--confirm app` =
`[AppConfirmer, dialog]` (keep `deny` for the phone; decide whether wake-word runs use the box, it still needs a
click), and add a test on `mcpConfig` args plus `buildConfirmer` for that mode.

### R9-3 (Medium) The settle wait sits between the identity re-check and the click

**What.** `hub.perform` re-describes the target and compares role, name, tag, input type, href, frame URL and form
action with what the gate approved (`hub.ts:656`), then runs `engine.click` (`hub.ts:657`). The new `click` first
calls `settle` (`index.ts:774`): it polls up to 2 s for `readyState`, visibility (bringing a background tab to front)
and an uncovered target, then presses (`index.ts:777`). `clickTarget` hit-tests the point but does not compare
identity again. Before this PR the gap between re-check and press was a few round trips; now it can be 2 s, exactly on
pages that are still changing (still loading, a veil over the target).

**Why it matters.** The design (`SYSTEM-DESIGN-STEPHEN.md:528` on this branch) says the identity re-check "binds the
approval to the element that is clicked". For an approved Send or Delete, a re-render during settle that renames the
button or rewrites its href is clicked without asking again. A hostile page can change behaviour without changing
identity anyway, so the main loss is against honest re-renders, which is what the re-check is for.

**Fix.** Settle before the re-check: let `ActionSpec` carry a `prepare` step that `perform` runs before
`recheckElement` (click: settle), or re-run `recheckElement` after settle inside the click's `run`. Test: an element
whose label changes 300 ms into a covered-target settle must give STALE_REF and no click.

The re-find itself held (see "What held").

### R9-4 (Medium) Remote Control outlives the listener that started it

**What.** `appControl.phoneOn` calls `runPhoneCli(['on'])` inside the listener (`control.ts:107`), which spawns
`claude remote-control` without `detached` (`cli.ts:138`) and writes the marker `{pid: <listener>, rc}`. The marker is
removed only when that child exits. The listener's exit path (`index.ts:625-629`) kills Claude and closes the
sockets but never stops `rc`. The helper's Stop sends SIGINT, then SIGKILL, to the listener pid only
(`AppClient.swift:1304-1310`), not to the process group, so `rc` keeps running and the marker stays. When the listener
is started again, `isPhoneOn` sees the marker and a live `remote-control` pid and serves phone requests again.

**Why it matters.** The owner presses Stop in the window and the phone channel keeps its Remote Control session; on
the next Start it answers phone requests with no new `phone on`, lock-down check or sign-in check. In Terminal, Ctrl-C
reaches the whole group, so this is new with the window. Not probed at runtime.

**Fix.** On listener exit (and in `onSigint`'s exit branch), if the marker's `pid` is this process: remove the
marker, then SIGTERM `rc` (the same code as `phone off`, `cli.ts:113-115`). Test with the fake `phone`/`spawn`: phone
on, run the exit path, expect the marker gone and kill called.

### R9-5 (Medium, design) ADR-006: where the draft lives is not decided

**What.** The ADR puts `src/reply/draft.ts` (stores the draft, `reply_draft`) in model-reachable code, that is in the
`serve` process, and `send.ts`, the card and the Send click in `stephen listen` (app.sock). `serve` is one process per
conversation; the listener is long-lived. The ADR says the listener "recomputes from its own stored copy", derives
the recipient from the original message, flags private reads (taint is in serve's gate), and counts 5 drafts / 3
sends per hour "in memory" (line 132), but never says how a draft gets from serve to the listener or which side
computes each of those.

**Why it matters.** If serve builds the draft and pushes it (as `AppConfirmer` does for questions), the listener
trusts a model-reachable process for the recipient, the taint flags and the hash input; a per-serve counter resets
with every conversation; "expires when the server restarts" means a different thing for each process. These are the
exact points review #9 is told to attack, and they are design decisions, not code details.

**Fix (design text).** State that serve only sends `{message_id, body}` to the listener over app.sock; the listener
re-reads the original message with the read token (outside the reachable graph) to get To/Subject, asks serve's gate
state for the private-read sources (or keeps its own record), computes `H`, holds the one pending draft and the
counters. Add the click delay from R9-6 to the Send button.

### R9-6 (Low) Ask box buttons have no input delay

**What.** A `confirm` push opens the box and makes it key (`AskBox.swift:281`). The question with live Allow and Deny
buttons is drawn at once (`AskBox.swift:34,81-95`). `answerConfirm` removes the question locally right away
(`AppClient.swift:1053`), so a second waiting question is drawn in the same place with the same buttons.

**Why it matters.** A double click on Allow approves the next question unseen; a click aimed near the menu bar icon
as the box opens lands on a button. Two waiting questions need two gated calls in flight (parallel tool calls, or a
second MCP client); not seen in practice, and R9-2 means today only external clients reach the box. Keyboard is
fine: Return is not bound, Esc is Deny, focus starts on Deny.

**Fix.** Disable both buttons for about 0.75 s each time the shown question changes (the usual security-dialog
delay), and show "1 of 2" when more wait.

### R9-7 (Low) Confirm relay hardening

**What.** (a) `confirm.answer` is accepted from any connection except the asker (`server.ts:244`); the design row
says the id only goes to Ask boxes, which holds, but the answerer is not checked to be one. (b) The gate's short
connection is an ordinary client, so `broadcast` (`server.ts:224`) sends it `state`, `heard` (the owner's words) and
`chat.done` (replies) while it waits; the gate discards them, but the model-reachable process now receives listener
data. (c) `AppConfirmer` checks `buf.length > 4096` before splitting lines (`app-confirm.ts:73`), so two or three
broadcasts in one read make it give up with "unavailable" (the dialog then asks: safe, but the question shows twice).

**Fix.** Require `askBoxes.has(sock)` for `confirm.answer`; mark a connection that sent `confirm.ask` (or a hello
without `confirms`) as a gate and skip it in `broadcast`; apply the cap to one line.

### R9-8 (Low) Helper Stop and launch.json trust cached state

**What.** After SIGINT, the 3 s and 10 s follow-ups check `kill(pid, 0)` and signal the same bare pid
(`AppClient.swift:1304-1310`), the R8-5 pattern. `listen.pid` is never removed, so after a reboot a recycled pid
equal to it counts as "ours" if it serves app.sock. `launch.json` is rewritten by every `stephen listen` with an app
socket (`index.ts:569`), so running a listener once from another checkout (a review worktree) makes the helper's Start
run that checkout from then on.

**Fix.** Before the delayed signals, re-check `appSocketPeerPid == pid` or `child.isRunning` for our own child; remove
`listen.pid` in the termination handler; write `launch.json` only from `install-helper`, or only when `cliPath` is
the installed one.

### R9-9 (Low, design) ADR-006 and the phone's trust level

Decision 4 and T8 say a draft may be made from the phone. Phone runs start `serve --trust wake` (`claude.ts:342`,
`trust !== 'trusted'`), and line 50 says a wake session "has no `reply_draft` tool at all". **Fix:** either say the
phone cannot draft in v1, or give the phone its own serve trust and name what it adds.

### R9-10 (Low) The persona pin breaks when #25 and #28 both land

`test/voice/talk.test.ts:11-12` (#28) pins `STEPHEN_PERSONA` to length 7029 and a SHA-256. #25 adds the
`include_snapshot` sentence to the same array (`claude.ts:92`). `git merge-tree ui/conversations-jobs p6/speed-cuts`
merges without conflicts and puts that sentence inside `buildPersona` (merged lines 61, 95, 118), so whichever PR
merges second turns the suite red. **Fix:** pin behaviour, not bytes (`personaFor(null, null, DEFAULT_TALK) ===
STEPHEN_PERSONA` and the casual tone and brief length lines present), or update the pin in the second PR.

### R9-11 (Low) Duplicated helpers

- `TalkStore.set` (`src/app/talk.ts:32-45`) is a copy of `updateAccountsConfig` (`src/connect/accounts-cli.ts:57`)
  for the `voice` section. Make one `updateConfigSection(file, key, change)` outside `CLAUDE_REACHABLE` (the design
  keeps config writers out of `src/lib`) and use it in both.
- `names.ts:31` is the third Levenshtein (`desktop/resolve.ts:142`, `voice/transcript.ts:34`). Move one to `src/lib`.

### R9-12 (Info) Docs that no longer match the code

- #26, `SYSTEM-DESIGN-STEPHEN.md:540`: "No tool reaches src/memory or app.sock". Since #19 the serve process (the one
  behind every tool) connects to app.sock for questions. It still cannot send memory requests (fixed code), so the
  claim should say "no tool can send a memory request on app.sock".
- #24, `src/app/personal.ts:3`: "The home address stays out of the window". `settings.get` already sends the whole
  `voice.aboutMe`, home included (`src/app/settings.ts:33`). The owner's own window, so no leak; fix the comment or
  drop `home` from `settings.get`.
- #20, `SYSTEM-DESIGN-STEPHEN.md:528`: see R9-3.
- #19 PR body, Mac test step 2: see R9-2.
- #15, section 4.14: "Doctor output holds paths and check results, never secret values". The Zen check's detail
  includes the BiDi WebSocket URL (`pid …, <wsUrl>`), which was already printed by `stephen doctor`; same user only.

### R9-13 (Info) Remote Control's stdio when started from the window

`runPhoneCli on` spawns Remote Control with `stdio: 'inherit'` (`cli.ts:138-141`). Started from the window, it gets
the listener's stdio: `/dev/null` in and `listen.log` out when the helper started the listener (the help text says
the first `on` asks to trust the folder by typing `y`, which cannot be answered there), or the listener's terminal,
which the listener also reads for Enter. Not verified at runtime: check on the Mac with a fresh phone folder.

## What held (verified)

- **#19 confirm relay.** An answer settles only the `randomUUID` it names (map lookup), once (`settle` deletes
  first; replays get "no longer waiting"); the asking connection is refused; the id is pushed only to `confirms:
  true` clients and never to the asker; the gate's own hello has no `confirms`, so serve never receives ids. Timeouts
  give "declined" on both sides, never "approved"; "unavailable" only on no box, older listener, error or a dropped
  connection, and then the dialog asks. `app-confirm.ts` imports nothing from `src/app`; `src/safety/` is in
  `CLAUDE_REACHABLE`. The body is built and cleaned once by `buildPrompt` for both surfaces; Swift draws it with
  `Text(verbatim:)`. Esc is Deny, Return is not bound, the box cannot be closed while a question waits.
- **#20 re-find.** `gate.evaluate` is pure (only `prune`). Re-find runs only on STALE_REF, before the gate, needs
  exactly one element with the same role, name (sig), tag and href in the same frame, describes the fresh element and
  evaluates the gate on that description; anything but `allow` keeps the original STALE_REF, so a gated click is
  never re-found. The fresh element then goes through the normal `check` and re-check; the audit records `refound`.
- **#26 proposals.** `checkMemoryText` at propose, at read-back and again in `MemoryStore.add` on Keep (edited text
  too); 20 items, 200 characters, case-insensitive duplicates; 0600 atomic writes; a refused Keep leaves the proposal;
  Keep ends the warm conversation; proposals never reach the persona; `src/memory` is not Claude-reachable. The only
  producer is the Tell Stephen box (origin `you`), so no third-party text can create a proposal yet. Labels are drawn
  verbatim, untrusted origins in the warn colour.
- **#15 app control.** `phone.on/off` call the same `runPhoneCli` (lock-down proof, sign-in check, "already on",
  marker first on `off`); no request field reaches a command line; `launch.json` is refused unless a regular file,
  ours, not group/world-writable, absolute executable node; the Swift client checks the app.sock peer uid; Stop refuses
  a Terminal listener.
- **#28 settings.set.** `checkTalkChanges` takes only own keys of a fixed table (`__proto__` refused), enum values or
  booleans; the persona picks fixed sentences; the safety line is in every tone; config.json is written atomically,
  0600, only the changed keys.
- **#25.** `include_snapshot` is the same gated snapshot as a separate call; no new read, taint or egress path; it
  stays opt-in.
- **#11.** The phone env adds `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS=1` and `disableClaudeAiConnectors`; the lock-down
  check still fails closed on any extra MCP server, so a wrong setting name keeps the link off rather than open.
- **#18, #22, #24.** Usage returns numbers only; step timings record a name and a duration only while a harness
  listens; `personal.summary` leaves out `home`.

Not verified: Swift was not compiled or run (no screen checks of the Ask box, Memory page, Settings); whether Claude
Code issues gated Stephen tool calls in parallel (R9-6); Remote Control's behaviour when started from the listener
(R9-4, R9-13); whether `disableClaudeAiConnectors` is a real Claude Code setting; the full suite was not run (targeted
suites only, all green).

## Fix status (to be filled when fixed; each fix gets a test named after it)

| ID | Fix | Test |
|----|-----|------|
| R9-1 | open | |
| R9-2 | open | |
| R9-3 | open | |
| R9-4 | open | |
| R9-5 | open | |
| R9-6 | open | |
| R9-7 | open | |
| R9-8 | open | |
| R9-9 | open | |
| R9-10 | open | |
| R9-11 | open | |
| R9-12 | open | |
| R9-13 | open | |
