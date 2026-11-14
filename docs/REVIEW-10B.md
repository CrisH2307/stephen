# Review 10b: PRs #111, #113, #114, #115, #116, #117 (merged into `qa` without an independent look)

Date: 2026-11-14. Worktree `.claude/worktrees/review-10b`, branch `docs/review-10b` cut from `origin/qa` @ `c7406d9`.
Independent reviewer (did not build this code). The repo was not changed except for this file and the ledger. #117
was read by the review lane's main reviewer (it wires in the classifier the review lane owns); #111 and #113 to
#116 were read by a second independent reviewer (Opus, read only), and every finding rated Low or higher below was
re-run from `dist/` at the tip before it was kept. No Stephen process, browser or helper was started. Swift was
not compiled or run.

## Scope

| PR | Merge | What it claims |
|----|-------|----------------|
| #111 | `98e0605` | Try again only for typed messages; Esc denies a waiting question (R10a-2, R10a-5, #94) |
| #113 | `fba9d01` | Memory proposals have one origin, `you`; any other origin reads as absent (#53) |
| #114 | `34fa19c` | The memory router accepts the natural ways to say "remember" (#90) |
| #115 | `27b804a` | Claude Code version range, stream contract fixture, `--effort` probe, plan-limit message (#65, #67) |
| #116 | `b2ec1fc` | Fix for the three tests #115 broke on `qa` (jobs boundary, two flag probes) |
| #117 | `76478d7` | Latency monitor: Esc to silence, wake to chime, tools, engines, tier and reason (#43, R10a-7) |

## Method

Threat model as in reviews 6 to 10a (`docs/SYSTEM-DESIGN-STEPHEN.md` section 5). Each PR read as
`git diff <merge>^1 <merge>`, files read at the tip. Probes from `dist/` at the tip:

- `parseMemoryIntent` on typed text and on `plainWords(text)`, which is what the listener hands the router for
  speech (`src/voice/listener.ts:745`).
- `claudeVersionCheck('2.1.320 (Claude Code)')`.
- `classify` with the lists the listener gives it (`apps` from the Mac, `sites: {}`).
- `stephen mac-checks` against the owner's real home after #117, and `runChecks` on a record written by the new
  `parseLatencyRecord`.

Tests at the tip: `test/memory`, `test/app`, `test/helper`, `test/jobs`, `test/voice/claude.test.ts`,
`claude-contract.test.ts`, `review4.test.ts`: 37 files, 688 passed, 2 skipped. Router tests
(`memory-flow`, `review5`, `app/listener`, `phone/routers`) and `eval/run.int`: 118 passed.

## Findings

| ID | Severity | PR | Title | File:line |
|----|----------|----|-------|-----------|
| R10b-1 | Medium | #114 | The "a line ending in ? never saves" guard never runs for speech, so a spoken question such as "can you remember my sister's name?" saves a memory | `src/memory/intent.ts:98,102`, `src/voice/listener.ts:745`, `src/voice/assistant.ts:212` |
| R10b-2 | Medium | #117 | `stephen mac-checks` reports a false FAIL on check 13.1d ("no private text in the latency log") for every record the new monitor writes | `src/checks/mac-checks.ts:41,217` (before the fix), `src/telemetry/latency.ts:68-81` |
| R10b-3 | Low | #114 | "don't forget", "note", "keep in mind" plus "my ..." save to-do reminders as facts ("don't forget my keys" saves "my keys") | `src/memory/intent.ts:61,102` |
| R10b-4 | Low | #114 | The new openers match everyday video and podcast lines, and the wake-word dialog still says you said "remember" | `src/memory/intent.ts:53-58`, `src/voice/memory-router.ts:104` |
| R10b-5 | Low | #115 | `doctor` shows a problem for every Claude Code newer than 2.1.319; Claude Code updates itself | `src/voice/claude.ts:500,521` |
| R10b-6 | Low | #117 | The shadow tier labels lean to Tier 2: the classifier gets no site list, so "open YouTube" and every "play ..." is labelled Tier 2 | `src/voice/index.ts:490-495` |
| R10b-7 | Info | #117 | "cold" and "warm" are inferred: the first command of a new warm process counts as warm | `src/voice/index.ts:529` |
| R10b-8 | Info | #115 | The stream fixture was recorded with tools off, so `tool_use`, tool result and `stream_event` lines are not checked | `test/voice/fixtures/claude-stream-2.1.319.jsonl` |
| R10b-9 | Info | #111, #113, #114 | Small notes: Try again can re-send an earlier typed command; an item with another origin is erased on the next memory write; the classifier and the router disagree on a few "remember" phrasings; a code after the new openers goes to Claude instead of being refused | see below |

No Critical or High findings. Nothing found lets anything other than the owner's click approve a gated action, lets
the model or third-party text write memory without the owner's voice or click, or puts content into telemetry.
#111, #113 and #116 hold as claimed.

### R10b-1 (Medium) The question-mark guard never runs for speech

**What.** #114 widened what counts as a save and added one guard for the new openers: a line that ends in "?" never
saves. `parseMemoryIntent` checks the "?" on the text it is given (`intent.ts:98`). For F5 and the wake word that
text is the listener's normalized transcript, and `plainWords` has already removed all punctuation. So the guard
works only for typed text. Probe (voice column is `parseMemoryIntent(plainWords(text))`):

```
"Can you remember my sister's name?" | typed: null | voice: remember "my sister's name"
"Will you remember my birthday?"     | typed: null | voice: remember "my birthday"
"Do you remember my bike?"           | typed: null | voice: null
```

With F5 these save at once. With the wake word they open the dialog.

**Why it matters.** It is the owner's own voice, so no trust line is crossed. But memory must come only from an
explicit save request (fixed constraint 4), speech is the main input, and the junk item then goes into every
later prompt until it is forgotten. The only test for the guard feeds raw text, so it passes even though the guard
never runs in production.

**Fix.** Check the "?" on `opts.raw` (it still has it), or accept "can / could / would / will you remember" only
when "that" follows. Test: the three probe lines through the listener path save nothing.

### R10b-2 (Medium) `mac-checks` fails on the new latency fields

**What.** #117 added `silenceMs`, `asr`, `tts`, `start`, `reason`, `ignored` and `tools` to a latency record.
Check 13.1d in `mac-checks` kept its own list of allowed fields, which #117 did not touch. On the owner's Mac after
#117: `FAIL 13.1d ... (2 of 31 line(s) hold a field that is not a number or a fixed word)`. The log is fine; the
check is wrong. `test/checks` stayed green because its fixtures are old-format records.

**Why it matters.** `mac-checks` is the owner's one test command, and 13.1d is the line that says "nothing you
said is in the log". A false FAIL there costs trust in the check that matters most.

**Fix (review lane, done on `fix/mac-checks-latency-fields`).** 13.1d now passes a line only when the monitor's own
`parseLatencyRecord` gives back exactly the same record, so the check cannot drift from the monitor again. Tests
added for the new fields and for an unknown word in each.

### R10b-3 (Low) To-do reminders saved as facts

For the openers that need a fact, any body starting with my, I, we or our counts as one. "Don't forget my keys."
saves "my keys"; "Don't forget my keys and open YouTube" saves "my keys" and runs the rest. The PR's own must-not-save
example ("don't forget the milk") is one word away. Fix: for these openers require "that", or a verb after the
personal word.

### R10b-4 (Low) Video and podcast lines

"Keep in mind that this video is sponsored by ...", "Don't forget that our sponsor ...", "Note that the views
expressed ..." now parse as saves. They need a wake trigger first, and the wake-word dialog is on by default, so
nothing is saved without a click. But the dialog still reads `You said "remember ..."`, which is not what was
said. Fix: accept the openers without the word "remember" only from F5, the window and the CLI, and quote the real
opener in the dialog.

### R10b-5 (Low) `doctor` false alarm after a Claude Code update

`claudeVersionCheck('2.1.320 (Claude Code)')` returns `ok: false` ("newer than Stephen was tested"). The installed
CLI is 2.1.319 today and updates itself, so `doctor` and the window's Doctor will show a problem on a healthy
install. It does not block voice. Fix: show "newer" as a note; keep the problem mark for older and unknown.

### R10b-6 (Low) Shadow tier labels lean to Tier 2

The listener calls `classify(said, { apps, sites: {} })` (the PR says so under Limits). With no site list and no
default media site, "open YouTube" and "play lofi on YouTube" return `unknown_entity`. So the `tier (shadow)` line
in `stephen latency` undercounts Tier 1, and that line is what will decide how much the fast path is worth. The
grammar acceptance (zero Tier 2 commands labelled Tier 1) is not affected. Fix (review lane): a small code-owned
site list in `src/voice/grammar/` for the sites Stephen's own tools already know, passed by the listener.

### R10b-7 to R10b-9 (Info)

- **R10b-7.** `start` is `warm` whenever the runner returned its own timings or the run was a follow-up. A fresh
  warm process that just started counts as warm. The PR says it is an inference.
- **R10b-8.** The fixture is real 2.1.319 output with no private content, but it has no tool call, so the claim
  "every field Stephen reads is checked" is too wide.
- **R10b-9.** (a) #111: `retryableText` takes the newest said bubble, which can be an earlier typed command when
  the failed one was spoken and its bubble was missed; the text was typed by the owner, so trust is not raised.
  (b) #113: an item dropped for another origin on read is erased from disk on the next memory write; no build ever
  wrote one. The protocol fixture still holds a `canvas` proposal Node can no longer produce. (c) #114: the
  classifier says Tier 1 "remember" for "Can you remember what I said?" where the router refuses, and Tier 2 for
  "Will you remember my X" where the router saves by voice (R10b-1). (d) #114: "don't forget 4417" goes to Claude
  instead of being refused as a code; this was already so for "can you remember 4417".

## What held (verified)

- **#111.** A said bubble is created in two places only: typed (no label) and heard (a label that is never empty;
  an unknown source reads "Not typed here"). The Try again button exists only when the newest said bubble is typed.
  Wake and phone bubbles show their source verbatim. Esc denies the first waiting question in the Ask box, in the
  panel and on the question card used by Home; no key path approves; the 0.75 s delay on Allow and Deny is
  untouched; Esc with a question waiting never closes the box or sends a recording.
- **#113.** Both writers pass `you`. The proposal reader and the memory reader drop any other origin. The usage
  count and the persona read the same parsed list.
- **#114.** Every pattern is anchored at the start, so mid-sentence and reported speech do not save ("do you
  remember", "remember to", "don't remember that", "forget it"). The phone is refused before parsing. One-word
  codes after "remember (that)" are refused. The stored text is the owner's words in their original case. The
  "and then" split sends only the rest to Claude. The secret filter still refuses PINs, gate codes and passwords.
- **#115, #116.** `--effort` is an optional flag and is left out when the help text lacks it (R10a-6 closed), for
  one-shot, warm, eval and jobs. The 9 required lock-down flags are unchanged and still refuse to run when one is
  missing. The plan-limit reset time is limited to digits, `apm`, colon, dot and space. `src/jobs` imports no voice
  code; the boundary test passes.
- **#117.** Every new field is a number or a value from a closed list; an unknown code becomes `other` and an
  unknown reason is dropped (`parseLatencyRecord`). Tool names go through the closed tool list, never arguments.
  The classifier's text outputs never leave the labelling function; only `tier` and the reason code are stored. A
  compile-time check ties the reason list to the classifier's `Reason` type. p50, p95 and OVER use `ok` commands
  only (R10a-7 closed); other outcomes show as counts. The wake target has the +800 ms the owner allowed.

Not verified: every Swift runtime claim (does the hidden cancel button fire while the text field has focus; does
one Esc reach only one handler); a real plan-limit message; `doctor` on the Mac; what the window's Doctor shows for
the version line; the four "Not verified" items in #117's own text.

## Fix status (to be filled when fixed; each fix gets a test named after it)

| ID | Issue | Fix | Test |
|----|-------|-----|------|
| R10b-1 | #122 (with R10b-3, R10b-4) | open (dev) | |
| R10b-2 | none | Fixed by the review lane on `fix/mac-checks-latency-fields` | `test/checks/mac-checks.test.ts` (new fields pass, unknown word fails) |
| R10b-3 | #122 | open (dev) | |
| R10b-4 | #122 | open (dev) | |
| R10b-5 | #123 | open (dev) | |
| R10b-6 | none | open (review lane: site list in `src/voice/grammar/`) | |
