# Review 10a: `013696d..qa` (PRs #32 to #41 and the A2 latency monitor)

Date: 2026-11-12. Repo worktree `.claude/worktrees/review-10a`, branch `docs/review-10a` cut from `origin/qa` @
`de73d22`. Independent reviewer (did not build this code; no memory of the project before 2026-11-05). The repo was
not changed except for this file. Probes ran on the owner's Mac (macOS, Node from the checkout) against `dist/` built
from the tip, read only. No Stephen process, browser, Remote Control or helper was started. The Swift side was read by
a second independent reviewer (Opus, read only) and every Swift finding below was re-read at the tip before it was
kept.

Review 10 is split in two (plan review, finding 7). This is 10a: everything that reached `qa` since Review 9 with no
independent review. Review 10b comes after the gate changes that are still to be built (YouTube account frame, the
Tier 1 fast path).

## Scope

`git diff 013696d..origin/qa`: 71 files, +5,761 / -402. Code: `src` 26 files (+1,105), `helper` 10 files (+710).

| PR | Branch | Reviewed |
|----|--------|----------|
| #32, #34, #35, #37, #38, #40 | ui/chat-thread, ui/sidebar-spacing, ui/home-chat, ui/chat-fixes, ui/chat-fixes-2, ui/transitions | the 10 changed files under `helper/` (Ask box as a chat thread, Home chat, sidebar, transitions) |
| #33 | docs/ui-plan-v32 | docs only |
| #36 | ui/model-effort | `src/app/model.ts`, `model.set` in `src/app/protocol.ts` and `server.ts`, `src/voice/config.ts`, `lockedArgs` in `src/voice/claude.ts`, `helper/SettingsPage.swift` |
| #41 | ui/action-chain | `src/app/steps.ts`, `commandDone` in `src/app/server.ts`, `chat.done.steps`, `helper/AppClient.swift`, `ChatThread.swift` |
| #44 | feat/latency-monitor (A2 PR 1) | `src/telemetry/latency.ts`, `src/voice/listener.ts`, `src/voice/index.ts`, `src/voice/assistant.ts` |
| #46 | feat/latency-serve-id (A2 PR 2) | `src/lib/command-id.ts`, `src/safety/audit.ts`, `src/safety/index.ts`, `src/serve-args.ts`, `src/server/tool-log.ts`, `src/server/index.ts`, `src/cli.ts`, `src/voice/command-log.ts`, `src/voice/conversation.ts` |
| #47 | feat/latency-cli (A2 PR 3) | `src/telemetry/cli.ts`, `latency.get` |
| #84 | feat/latency-turns (A2 PR 4) | `src/voice/warm-claude.ts`, `--include-partial-messages`, `src/voice/tts/index.ts`, Settings > Speed |
| #42, #45, #85, #92, docs merges | docs only | not reviewed for content (the plan review covers them) |

## Method

Threat model as in reviews 6 to 9 (`docs/SYSTEM-DESIGN-STEPHEN.md` section 5): same-user processes are out of scope.
A finding counts if it helps a lower-trust actor (web page, email sender, the model, the person holding the phone, a
bystander saying "Hey Stephen") or breaks a promise the design makes to the owner. Correctness bugs that ship broken
behaviour, and measurement bugs that would mislead the plan's decisions, are reported too.

- The whole `src` diff was read line by line; files were read at the tip where the diff alone did not show the path.
- **Command id (#46).** Traced the id from `Listener` (`newHistoryId` at the trigger) through `Assistant.handle`,
  `ToolLogRunner.run` (file cleared at run start, written in `beforeSend`), both runners' `beforeSend` call sites
  (`conversation.ts:268,424`), `serve --command-file` (`serve-args.ts`, `checkCommandFilePath`), `withToolLog` and
  `AuditLog.append`. Checked that `createSafety` builds the gate without the id and that `withSessionState` passes
  `deps` through.
- **Audit log (#46).** Read `sanitizeEntry` and `append` for any way a caller, a tool or the model can set `cmd`.
- **Action chain (#41).** Read `commandSteps` and ran it from `dist/` on a made-up audit list (output under R10a-1).
- **Model picker (#36).** Followed `model.set` from the request check to `--model` / `--effort` in the Claude argv;
  checked who can send it (app.sock clients only; nothing under `src/phone` reaches app requests).
- **Latency (#44, #47, #84).** Checked every field a record can hold against the privacy rule (plan Q20), the file
  modes, retention, and how each stage time is taken; read `buildReport` for what the p50, p95 and OVER flag mean.
- Checks at the tip: `npm run build` and `npm run typecheck` clean. Affected suites (`test/app`, `test/telemetry`,
  `test/safety`, `test/server/command-id.test.ts`, `test/server/tool-log.test.ts`, `test/voice/latency-id.test.ts`,
  `test/voice/warm-claude.test.ts`, `test/voice/claude.test.ts`): 33 files, 1,116 passed. Full suite
  (`npx vitest run`, 3,193 tests) twice: run 1, 3,187 passed, 5 skipped, 1 failed (name not captured); run 2, 3,186
  passed, 5 skipped, 2 failed (`test/selftest/selftest.int.test.ts` real Chromium checks 11 to 14, and
  `test/voice/ptt.test.ts` "no fresh answer within ~300 ms"). Both files pass alone (28 of 28). They are timing
  tests that fail under a loaded machine, and the set that fails changes between runs. This branch changes no
  code. The suite is not "0 known-flaky" (plan 7.3).

## Findings

| ID | Severity | PR | Title | File:line |
|----|----------|----|-------|-----------|
| R10a-1 | Medium | #41, #46 | The action chain shows a step under a command even when the audit entry carries another command's id: a refusal caused by command A (or by a background job) appears under command B | `src/app/steps.ts:44`, `src/app/server.ts:217-224` |
| R10a-2 | Medium | #32, #35 | "Try again" re-sends the last heard text as a typed command, so words that arrived with wake or phone trust run with full trust after one click; the bubble says "You" with no source | `helper/Components/ChatThread.swift:46-49,65-72`, `helper/AppClient.swift:1064-1067`, `src/voice/assistant.ts:33-35` |
| R10a-3 | Low | #41 | A failed tool call reads as done: the line says "Used gmail_search", only a 6 pt dot colour differs, and the folded summary counts refused steps but not failed ones | `src/app/steps.ts:59`, `helper/Components/ChatThread.swift:110-114,133-136` |
| R10a-4 | Low | #35 | Home is a new Allow/Deny surface; its 0.75 s delay (R9-6) starts when the view appears, not when the window is shown, and the window is kept alive when closed, so Allow may be live the moment the window comes back | `helper/HomeView.swift:105`, `helper/Components/ChatThread.swift:22-23`, `helper/AppWindow.swift:126-131` |
| R10a-5 | Low | #32 | "Esc in the box means Deny" may no longer hold while the text field has focus: the field now stays below the question | `helper/AskBox.swift:111,152,212-213,257,299-307` |
| R10a-6 | Low | #36 | `--effort` is sent without a probe and is saved to config.json: on a Claude Code that lacks the flag every command fails until the owner sets effort back to default | `src/voice/claude.ts:330-333`, `src/app/model.ts:60-70` |
| R10a-7 | Low | #47 | The latency report mixes outcomes: cancelled and failed commands are inside the p50, p95 and the OVER check of each group, so a target can pass because commands were cancelled early | `src/telemetry/cli.ts:98-116`, `src/voice/index.ts:497-502` |
| R10a-8 | Low | #32 | At the 300-bubble cap `thread.count` stops changing, so new replies no longer scroll into view and the usage refresh stops | `helper/Components/ChatThread.swift:34`, `helper/AskBox.swift:110`, `helper/AppClient.swift:1143` |
| R10a-9 | Low | #41 | `chat.done` (the reply shown in the window) now waits for an audit read with no time limit: the whole `audit.log` (up to 5 MB) is read and split after every command; `state` idle can reach the helper before `chat.done` | `src/app/server.ts:217-224`, `src/safety/audit.ts:175-205` |
| R10a-10 | Info | #46, #44 | Limits of "one id joins every log": entries the listener writes itself (memory, timer and job routes) carry no `cmd`; jobs and other MCP clients never do; a spoken timer or a second speak can take `firstAudio` of the running command | `src/voice/index.ts:486-496`, `src/voice/command-log.ts:13-17` |
| R10a-11 | Info | #35, #40 | Swift notes: Home's "N questions waiting" branch is dead; the question card keeps one identity so the details scroll position carries to the next question; a full-size question nearly fills the 340 pt thread | `helper/HomeView.swift:31,45,114`, `helper/Components/ChatThread.swift:23,150-172` |

No Critical or High findings. Nothing found lets anything other than the owner's click approve a gated action, lets
the model or third-party text write memory, timers or jobs, puts content into telemetry, or lets the command id
change a gate decision. The two Mediums are a wrong record (R10a-1) and a trust step that one owner click crosses
(R10a-2). Both have small fixes.

### R10a-1 (Medium) A step is shown under a command that provably did not cause it

**What.** `commandSteps` keeps an audit entry when it carries this command's id **or** when its time is inside the
command's window plus 1 s on each side (`steps.ts:44`). The id only adds. So an entry that carries a different,
valid command id is still shown when its time fits. Probe on `dist/` (command `h_aaaa...`, window 10:00:00 to
10:00:05, one entry labelled `h_bbbb...`, one with no id):

```
[{"text":"Refused: click Send. Stephen's safety rules","status":"refused"},{"text":"navigate","status":"ok"}]
```

Both lines appear under `h_aaaa...`. Real ways to get there: a push-to-talk press cancels command A and command B
starts within a second (A's last entries fall in B's slack); a background job or another MCP client using Stephen
acts while a chat command runs (same `audit.log`, no `cmd`).

**Why it matters.** The window is the record (must-have 8), and the 1.9c exit says every step maps to one audit
record by id. A "Refused" line under the wrong command tells the owner Stephen tried something it did not try in
that command. No action is taken from it, so this is a wrong record, not a gate bypass. The code comment explains
the choice (a refusal must never go missing because of a wrong label), and that goal can be kept.

**Fix.** Drop entries whose `cmd` is a valid id other than this command's. Keep the time match only for entries with
no `cmd`. Then give job serves a marker (or their own id) so their entries can be told apart too. Test: the probe
above returns only the unlabelled line.

### R10a-2 (Medium) "Try again" turns wake or phone speech into a trusted typed command

**What.** Every voice or phone command is added to the thread as a `.said` bubble; its source goes into `detail`,
which the thread never shows for said bubbles (`ChatThread.swift:65-72`, read aloud as "You: ..."). After a problem
bubble, `retry()` takes the last `.said` text and calls `model.sendChat` (`ChatThread.swift:46-49`). That is
`chat.send`, source `app`, and `trustOf('app')` is `trusted` (`assistant.ts:33-35`). The original command may have
been `wake` (email shows who and when only, "remember" asks in a dialog) or `phone` (every confirmation denied).

**Trigger.** A video or a bystander says "Hey Stephen, ..." or someone holding the phone sends a command, and it
ends in an error (timeout, Claude failure). The owner sees a "You" bubble and a Try again button. One click runs
those words with full tools, full email text and working confirmations.

**Why it matters.** Trust per source is one of the gate's inputs. The click is the owner's, and the text is on
screen, which is why this is Medium and not High. But the bubble claims the owner said it, and nothing tells them
the retry is stronger than the original. The old Ask box already did this; #32 moved it into the shared thread and
#35 brought it to Home.

**Fix.** Show Try again only when the said bubble was typed (empty `detail`), and show the source label under said
bubbles from voice and phone. Or keep the button and send the retry with the original source. Test: a helper source
test that `retry` is unreachable for a bubble with a source label.

### R10a-3 (Low) A failed tool call reads as done

`steps.ts:59` writes "Used X" for a tool-log call with `isError`, with status `failed`. The folded summary counts
only refused steps ("3 steps · 9.8 s"), and the open list marks a failed step by dot colour alone (hidden from
VoiceOver). Browser actions that fail do say "Tried X, it failed". Fix: the same wording for tool-log calls and
"N failed" in the summary.

### R10a-4 (Low) Home's Allow button may already be live when the window comes back

Before #35 Home only linked to the Ask box. Now `ChatThreadView` puts `ConfirmMessage` with live buttons in the
main window. The 0.75 s delay runs from `.task(id: question.id)`; the window is not released when closed
(`AppWindow.swift:126-131`), so the delay may run out while nobody can see the question. The question text is next
to the button, so this does not reopen R9-6. Needs a Mac check: does `.task` run in a closed window, and does a
first click on an inactive window reach the button. Fix: restart the delay when the window becomes key.

### R10a-5 (Low) Esc may not deny while the text field has focus

SYSTEM-DESIGN section 5 promises Esc in the box means Deny. Since #32 the field stays under the question and keeps
focus (`show(focus: true)`), and Esc in a focused field is usually taken by the field editor. If it reaches
`AskPanel.cancelOperation`, that calls `close()`, which is refused while a question waits. Either way nothing
happens, so it fails closed. Needs a Mac check. Fix: drop focus from the field when a question arrives, or deny
the first question in `cancelOperation`.

### R10a-6 (Low) `--effort` is not probed

`lockedArgs` adds `--effort` whenever an effort is set (`claude.ts:330-333`; the comment says so). `model.set`
saves it to config.json, so the failure survives a restart. Recovery is the same picker ("default"). Already
queued as part of `fix/claude-cli-contract` (plan review item 8); listed here so it gets a test.

### R10a-7 (Low) Latency groups mix outcomes

`onDone` marks `replyReady` for every report, including cancelled and failed ones, and `buildReport` groups by
trigger and route only. A command cancelled after 300 ms lowers the group's p50 and can clear an OVER flag. These
numbers decide E4a and the Tier 1 targets. Fix: compute the spans and the target check over `outcome: ok` and show
cancelled and error counts beside them (belongs with `feat/latency-gaps`).

### R10a-8 (Low) No auto-scroll at the bubble cap

`addBubble` appends and then removes the first, so at 300 bubbles the count is constant and
`onChange(of: model.thread.count)` never fires. Voice replies then land below the fold. A waiting question still
scrolls into view (keyed on its id). Fix: watch `model.thread.last?.id` in both places.

### R10a-9 (Low) `chat.done` waits for an untimed audit read

`commandDone` sends `chat.done` only after `audit.recent(100)`, which reads the whole current log file (up to
5 MB) and splits it, after every command that ran. A failed read is handled; a slow one is not bounded. The helper
copes with `state` idle arriving first (the reply is still added; "Working…" ends a moment early). Fix: read the
tail of the file, or send `chat.done` after a short timeout without steps.

### R10a-10 (Info) Where the command id does not reach

Entries the listener writes with its own `AuditLog` (memory changes and other local routes) have no `cmd`, so
"one id joins history, latency, tool log and audit" holds only for model runs. With the one-shot runner a dying
serve can label an entry with the next command's id (documented in `command-log.ts`). `firstAudio` is taken from
the first player start while a command is marked as speaking, so a timer that speaks in that moment can set it.
None of this affects a decision; the plan-reconcile docs should state the limits.

### R10a-11 (Info) Swift notes

See the table. Worth one screen check on the Mac: a full-size question (3-line title, 160 pt details) in the
340 pt thread, and the nested details scroll view keeping its height.


## What held (verified)

- **The gate never sees the command id.** `createSafety` passes `commandId` to `AuditLog` only; `SafetyGate` is built
  without it (`src/safety/index.ts:26-31`). No tool reads the file. The id decides nothing.
- **A caller cannot label an audit entry.** `append` drops any `cmd` on the entry and takes it only from its own
  reader; `sanitizeEntry` deletes a `cmd` that is not `h_<16 hex>` (`src/safety/audit.ts:89,126-135`). The same shape
  check is applied when writing and when reading the tool log (`src/server/tool-log.ts` `toLine`).
- **The command file cannot be pointed elsewhere.** `--command-file` takes only a `.json` name directly inside
  `<home>/voice/` (`checkVoiceFilePath`), is refused with `--dry-run`, and is read with `O_NOFOLLOW`, owner and mode
  0600 checks and a 256-byte cap. Reading never throws. The argv is written by the listener, never by the model.
- **A cancelled command does not get the next command's id (warm runner).** The file is removed when a run starts and
  written in `beforeSend`, which the warm runner calls only after every earlier process group is gone
  (`conversation.ts:400-424`). The one-shot runner has no such promise; the code says so (`command-log.ts:13-17`).
- **`--text` does not relabel a running listener's command** (`src/voice/index.ts:364`: no command file for `--text`).
- **Latency records hold no content.** A record is rebuilt field by field from fixed code words, an id and bounded
  numbers (`parseLatencyRecord`); unknown fields are dropped on write and on read. Day files are 0600 in a 0700
  folder, opened with `O_NOFOLLOW`, capped at 4 MB a day and purged after 30 days at listener start.
- **`latency.get` returns only what `stephen latency` prints** (ids, code words, numbers), and `days` is checked
  against 1, 7, 30 before the handler runs.
- **`--include-partial-messages` adds timing only.** A `stream_event` line is used for its arrival time and its
  `event.type`; its text is never read (`src/voice/warm-claude.ts:399-406`). The flag is passed only when
  `claude --help` lists it.
- **The model name cannot become a flag.** `CLAUDE_MODEL_RE` requires a letter or digit first and allows only
  `[A-Za-z0-9._\-[\]]`; effort is one of five fixed words. The value goes to argv as its own element, no shell.
- **`model.set` is owner only.** It exists on app.sock; the phone server does not route app requests. It ends the
  warm conversation the same way a memory change does (after the running command when one is running).
- **Step lines carry nothing new.** `commandSteps` uses only `kind`, `tool`, `element`, `error` and `outcome`, which
  the audit log already redacts, cuts each line to 160 characters and a command to 40 lines; nothing goes back to
  the model.

- **R9-6 holds through #32 to #41.** `ConfirmButtons` is live only when `armed == question.id`, set 0.75 s after
  `.task(id: question.id)`; the Ask box and Home both use it. Deny comes first, Allow has no keyboard shortcut, and
  Return in the field sends chat.
- **The question cannot be pushed out of view by a long reply.** It is always the last thing in the thread and
  scrolls into view when it changes; `close()` is refused while a question waits; a click that dismisses the ⋯ menu
  is used up by the menu.
- **Page and model text is shown verbatim.** Every `Text` with a variable in the 10 Swift files is
  `Text(verbatim:)` (replies, heard text, step lines, chat title, question title and body, Speed report). No
  `AttributedString(markdown:)`, `Link` or `openURL`.
- **Decoding is safe on a bad line.** `steps` is decoded with `try?` and falls back to tool names; no new force
  unwraps or indexing; callbacks are on the main thread with `[weak self]`.
- **Swift and TypeScript agree on the protocol**: `model.set`, `latency.get`, `chat.done.steps` match
  `protocol.ts` and the fixture. The effort menu is exactly `EFFORTS` plus "default"; a free-text model name is
  checked on the server.

Not verified: Swift was not compiled or run, so every screen claim is from reading (R10a-4, R10a-5, R10a-11 need
the Mac: `.task` in a closed window, first click on an inactive window, Esc with the field focused, the height of
a full-size question). No real `claude -p` run: the `stream_event` shape and `--effort` behaviour on an old Claude
Code are from the code and fixtures. Docs in the range were not checked for stale claims (that is
`docs/plan-reconcile`).

## Fix status (to be filled when fixed; each fix gets a test named after it)

| ID | Issue | Fix | Test |
|----|-------|-----|------|
| R10a-1 | #93 | open (dev team) | |
| R10a-2 | #94 | open (dev team) | |
| R10a-3 | none (Low) | open | |
| R10a-4 | none (Low, needs Mac check) | open | |
| R10a-5 | none (Low, needs Mac check) | open | |
| R10a-6 | folds into `fix/claude-cli-contract` | open | |
| R10a-7 | folds into `feat/latency-gaps` | open | |
| R10a-8 | none (Low) | open | |
| R10a-9 | none (Low) | open | |
