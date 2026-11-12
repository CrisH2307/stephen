# ADR-008: Tier 1 fast path: the listener calls Stephen's own tools in a second `serve`, behind the same gate

**Status:** Proposed. Paper only; no code ships with this ADR. E1 may start only after the owner accepts it, the
command grammar has run in shadow mode on the labelled set (E6a), the Mac measurements below are in, and
Review 10b has read the build.
**Date:** 2026-11-12
**Deciders:** Cris (owner), Claude (designer)
**Reviewed:** 2026-11-12, one independent read-only design review. It found three blockers in the first draft
(the fast serve could re-create a deleted state file, "missing file is clean" failed open on a bad file, and the
fast path skipped the conversation reset the model path does). Decisions 5 to 7 and the test section are the
result.

Sources: PRODUCT-PLAN-2026-11 section 2.5 (two tiers), E1 and Q4; PLAN-REVIEW-2026-11 finding 8, section 3.5 "E1"
and owner answer Q7 (keep the targets; wake gets +0.8 s until E4a lands); REVIEW-3 finding 1; REVIEW-7 R7-1, R7-2;
REVIEW-10A; the read code in `src/voice/assistant.ts`, `src/voice/conversation.ts`, `src/voice/command-log.ts`,
`src/safety/session-state.ts`, `src/safety/gate.ts`, `src/serve-args.ts`, `src/desktop/`, `src/voice/claude.ts`.

## Context

- One model turn costs about 1.8 s on the Mac, so a Tier 1 command (open, play, pause, resume, next, volume, mute,
  timer, stop, remember, forget) cannot use the model and meet the plan's targets.
- The plan says the fast path uses "the same gate, trust and audit". Today that has no code path: the gate and its
  taint live inside `stephen serve`, a stdio child of `claude`. The listener cannot call it.
- The listener already answers three kinds of command with 0 model turns: memory, timer and job
  (`assistant.ts:203-216`). They do not act on the browser or the desktop and have their own rules. They stay.
- The gate's conversation memory is a file, `<home>/voice/conversation-state.json`. A serve imports it once at
  start and merges it again only when it writes; import only ever adds (`session-state.ts:124-137`,
  `gate.ts:250-252`). The rate limiter is per process and not in the file.
- The file's life is the conversation's life. The listener deletes it whenever a model run starts a new
  conversation: no follow-up, another trust (R7-2), the window ran out, memory changed
  (`conversation.ts:116-131,260-263,404-407`). The rule "kill the old process before resetting" protects it.
- A fresh "play X" ends any follow-up conversation before it runs (`assistant.ts:238-241`), so the gate does not
  ask in an empty room.
- Of the Tier 1 tools, `open_app` and `volume` send the gate a request with no URL: only the rate limit applies,
  and taint cannot change their verdict. `open_url`, `play_media` and `media_control` go through the browser gate
  and can read tabs (`src/desktop/media-tab.ts`, `play.ts`), which can note a read.
- `--trust wake` changes only the account tools. No Tier 1 tool reads it.

## Decision

1. **The fast path is a second `stephen serve`, started and owned by the listener, spoken to over MCP stdio.**
   The listener sends an ordinary `tools/call` for one of Stephen's existing tools. The handler, the gate, the
   confirmer and the audit log are the same code the model path runs. There is no second gate and no second
   implementation of any verb.
2. **Verb to tool, closed table, enforced by the serve.** Open app: `open_app`. Open site (owner-written alias
   only): `open_url`. Play: `play_media`. Pause, resume, next: `media_control`. Volume and mute: `volume`. Timer,
   remember, forget: the existing local routers. With `--fast` the serve registers only these five tools, so
   "nothing else is ever sent" does not rest on the listener alone.
3. **Argv.** The fast serve gets what `mcpConfig` gives the model's serve for `--confirm`, `--session-state` and
   `--command-file`, plus `--fast`. It does not get `--voice` (only adds `announce`), `--instance` (only the
   restart refusal), `--tool-log` (the listener records the one tool name itself) or `--trust` (no Tier 1 tool
   reads it). `--fast` is refused together with `--dry-run`. A unit test pins this list.
4. **One fast serve. No fast path on phone trust in v1.** A wake command keeps the transcript check, the
   sound-is-playing check and the cooldown; the fast path starts after them, not instead of them.
5. **The gate memory is replaced from the state file before every fast call, and it fails closed.** Only a
   missing file (ENOENT) is a clean conversation. A file that is unreadable, invalid, oversized, a link or has the
   wrong mode refuses the call. This needs a new gate method (replace, where today there is only add) and
   reverses the documented "only adds" rule for this one process; both comments are updated and Review 10b reads
   the change.
6. **A fast call follows the conversation's life, exactly as a model run does.** Before each fast call the
   listener asks the same question the runner asks (`peek(trust)`): if a conversation of the same trust is live,
   the call uses its file; otherwise the listener ends the conversation and deletes the file first, as the model
   path would. A fresh fast "play X" always deletes the file first. So a fast command never reads the taint or the
   approvals of a conversation of another trust, or of one that already ran out.
7. **The fast serve can never bring a deleted file back.** The listener treats a fast call in flight like a
   running command: ending a conversation, a prewarm and a new spawn wait for it or kill it before they reset the
   file. As a second lock, the file carries a conversation generation and the fast serve refuses to write when
   the generation changed under it.
8. **Audit and ids.** The handlers write the same audit entries as on the model path. The listener writes this
   command's id to the command file before the call (today only the model runner does), so `cmd` is right.
   `--fast` adds `path: "fast"` to each entry, set by the audit log itself like `cmd`, never by a caller. The
   command report gains the route `fast`.
9. **Rate limit: no new cap.** The fast serve has the normal limiter. The real bound per minute is the model
   serve's limit plus the fast serve's, and each fast action needs its own spoken or typed command, with the wake
   cooldown between wake commands. The first draft's listener cap is dropped: sending the 11th command to the
   model would not have stopped anything.
10. **Confirmations work as today, with an honest label.** If the gate says confirm, the Ask box or the dialog
    asks; a spoken "yes" confirms nothing; a confirmed command has no speed target. On the fast path the prompt
    says "Heard: open Safari", not "Claude says", and never "owner said": on wake trust the speaker may be a
    video. The intent text is built from the grammar's output, never the raw transcript.
11. **Replies come from a fixed table.** There is no model to turn a tool result into speech. Each verb and
    outcome (done, nothing to do, refused, failed, not connected) has a fixed sentence. Tool result text is never
    spoken or stored: it can carry app or page text.
12. **Fall back before, never after, with one exception.** If the fast serve is not ready or the grammar is in
    doubt, the command goes to the model (and still counts against Tier 1 targets). Once the `tools/call` is sent,
    a failure is reported and not retried through the model, so no action runs twice. The exception: a fixed
    result code that proves nothing acted (for example "more than one media tab, not chosen") may go to the model.
13. **Tab choice is not guessed.** Which media tab is "current" lives in each serve's own memory, so after a model
    "play X" the fast serve does not know that tab is the recent one. In v1 a fast pause, resume or next acts only
    when exactly one media tab exists; otherwise it returns the nothing-acted code of decision 12.
14. **Cancel.** Esc or "Stephen, stop" during a fast call sends an MCP cancel and then kills and restarts the fast
    serve. Today's cancel does not reach it (the runner is not busy and the serve is outside Claude's process
    group), so this is new code.
15. **Classification is binding here.** Only an exact match against owner-controlled lists (installed apps,
    owner-written site aliases) is Tier 1. Tab titles, page text and memory text are never entity lists. A fuzzy
    match goes to Tier 2.

## Options considered

| Option | For | Against | Verdict |
|---|---|---|---|
| A. Second serve owned by the listener (chosen) | Same handlers, gate, confirmer and audit; no gate code moves into the listener | A warm process; two browser clients; needs decisions 5 to 7 to stay equal to the model path | Chosen |
| B. Run the tool code and a gate inside the listener | No extra process, fastest | Two gates to keep equal by hand; pulls `src/safety` and the browser stack into the listener; resets the review evidence | Rejected |
| C. Ask the model's serve to do it | One gate | That serve is a stdio child of `claude`; a side door into it is a new control channel into the gate | Rejected |
| D. Keep the model, pick a faster one | No new path | Still at least one model turn (first token alone is 1.1 to 1.3 s on the Mac) | Not Tier 1; the owner can still A/B it for Tier 2 |
| E. Listener acts directly with `open` and key events, no gate | Simplest | The plan forbids it; no taint, no audit, no confirm | Rejected |
| F. Fast path only for `open_app` and `volume` (no browser verbs) | Taint cannot change their verdict, so decisions 5 to 7 and 13 are not needed; no second browser client | "Play" and "pause" stay slow, and music is the owner's first priority | The fallback if the Mac measurements go badly; a smaller, safer first PR either way |

**Build order that follows from F.** Ship `open_app` and `volume` first: they need decisions 1 to 4, 8 to 12, 14
and 15 only. Add the browser verbs in a second PR with decisions 5 to 7 and 13 and the full test matrix.

## Threat model

Same-user processes stay out of scope (SYSTEM-DESIGN section 5).

| Threat | Rule that answers it |
|---|---|
| A video says "Hey Stephen, open ..." and there is no model as a second reader | Wake checks unchanged (4); exact match on owner lists only (15); the verbs are ones a bystander can already trigger through the model |
| The conversation read private mail; a fast "open <site>" or "play ..." leaves without a prompt | Fresh state per call (5), same file, same gate; a fresh "play" resets first (6) |
| A fast command uses the taint or approvals of a conversation of another trust (R7-2) | Same lifecycle question as the model path (6) |
| The fast serve writes an old conversation's taint or approvals into a new one | In-flight call blocks the reset, plus the generation check (7) |
| A broken state file is read as "clean" | Only ENOENT is clean; anything else refuses (5) |
| A page names itself like an app or an alias to win a match | Lists are owner-controlled only (15) |
| A wrong rewrite of the transcript becomes a wrong action at once | Fixed variant table, exact match, shadow mode first with zero Tier 2 commands labelled Tier 1 (E6a) |
| An action runs twice (fast, then model) | Fall back before, never after (12) |
| A fast "pause" pauses the wrong tab | One media tab or no fast action (13) |
| The fast path is used to skip a confirmation, or the prompt lies about who asked | Same confirmer; honest label (10) |
| App or page text is spoken as Stephen's own words | Fixed reply table (11) |
| A fast "pause" on a signed-in YouTube tab notes a private read and taints the conversation | Same on the model path today (the A3 account-frame rule); measured and compared in the tests |
| Phone commands gain a faster, less watched path | No fast path on phone trust in v1 (4) |
| A fast action is missing from the record or carries another command's id | Listener writes the id first; `path: "fast"` (8) |
| The fast serve cannot be stopped | Cancel kills and restarts it (14) |

## Tests (must exist before the matching PR merges)

Harness: the in-process server (`buildServer`) with the existing fakes for the matrix, plus one smoke test that
starts both real serves with their real argv.

**Equality matrix.** For every Tier 1 verb that reaches a tool, in each conversation state below, run the same
call on a serve set up as the model path sets it up and on the fast serve. Assert equal: verdict, prompt count,
audit entries (every field except `ts`, `cmd`, `path` and the prompt label), the state file after the call, and
the target tab. The trust axis is not in the matrix because it changes no Tier 1 tool; phone is covered by "the
listener never sends a fast call".

| Conversation state | What it proves |
|---|---|
| No conversation, no file | Clean start |
| Live, same trust, clean | Join without change |
| Live, same trust, private read noted | Taint carries (5) |
| Live, same trust, a host approved after a read | Approvals carry and are not widened |
| Live, other trust | Reset first, as the model path does (6) |
| Window ran out, file still on disk (one-shot runner) | Reset first (6) |
| File invalid, wrong mode or a link | The fast call is refused (5) |

**Also required.**

- Stale state: start the fast serve, let another serve note a private read, then a fast `open_url` to a
  first-seen host asks. Delete the file: the next one does not.
- No resurrection: a fast call waits on a confirmation, the conversation ends, the owner approves; the file is
  not re-created and the next conversation trusts nothing (7).
- Sequences: model read then fast action; fast approval then model action.
- Argv: the fast serve's argv is exactly the list in decision 3; `--fast` with `--dry-run` is refused; a `--fast`
  serve lists only the five tools.
- A caller cannot set `path`, like `cmd` (`test/server/command-id.test.ts` shape); a fast audit entry carries
  this command's id.
- No double action: a fast call that fails after it was sent is not followed by a model run; the nothing-acted
  code is.
- Two media tabs: a fast pause acts on neither.
- Cancel: Esc during a fast call leaves no fast serve running the old call.
- Reply table: no tool result text reaches speech or history.
- Latency record: `tier` is 1 and `route` is `fast`.

## What must be measured on the Mac before the browser verbs are built

| Question | Why it matters |
|---|---|
| Warm fast serve: idle memory and cold start | Plan 5.4 footprint trigger; a cold fast serve (about 0.4 to 0.5 s) eats the budget |
| Two clients on the same Zen and Chrome debug port at once | The browser verbs need the browser while the model's serve is attached |
| Does pause, next or play on real YouTube and YouTube Music change the state file? | `accounts.google.com` is in the private-source list; a signed-in tab may arm taint (ties to A3) |
| F5 "open Safari" end of speech to action done, 20 runs | The target is p50 1.5 s, p95 2.5 s |

## Open questions (default taken)

| # | Question | Default |
|---|---|---|
| 1 | Does a chime count as the first audible response for Tier 1? | Yes (plan review Q7 default) |
| 2 | Ship option F first (`open_app`, `volume`), browser verbs second? | Yes |
| 3 | Should a fast "play" be allowed without resetting the conversation, since no model text is in the query? | No in v1: equality first. Revisit with Review 10b |
| 4 | Do fast commands appear to the model as context ("what did I just open?") | No in v1 |
| 5 | Does "stop" on the fast path mean anything beyond the listener's cancel? | No: it stays the existing cancel, plus decision 14 |
