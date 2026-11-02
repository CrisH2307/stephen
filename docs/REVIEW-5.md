# Review 5: phase 1.9 (memory, history, Stephen app over app.sock, YouTube Music control)

Date: 2026-11-01. Repo `/home/claude/work/browser-hub` @ `ec2f7b1`. Independent reviewer (did not build this code).
The repo was not changed except for this file. Nothing was built or installed. Mac-only parts (Swift window,
osascript dialog, CoreAudio, TCC) were checked by reading the code only. One small regex probe was run outside the repo.

## Scope

PLAN-1.9 sections 12 and 13 (native app replaces the browser dashboard). Code: `src/memory/`, `src/history/`,
`src/app/`, `src/voice/` (assistant, listener, memory-router, claude persona / `--append-system-prompt-file`,
command-log, index wiring), `src/helper/` (protocol, framing, install), `helper/AppClient.swift`,
`helper/AppWindow.swift`, `helper/main.swift`, `src/desktop/media-tab.ts`, `media_control` / `play_media`,
`src/safety/confirm.ts` (dialog), `src/eval` inject cases, `test/memory/boundary.test.ts` + `test/helpers/import-scan.ts`.

## Method

Followed every path that ends in `MemoryStore.add/update/forget/clear` back to its source. Looked for any path from
Claude, page text, tool results, the reply, TTS, follow-up resume or app.sock. Read the socket setup line by line
(dir, umask, stale socket, framing, caps, peer checks). Read the persona file writer and every place memory text
lands. Ran the memory secret regex against realistic ASR output.

Threat model: same-user processes are out of scope (ROADMAP #5). A finding counts if it helps a lower-trust actor
(web page, email, Claude, a video or bystander, another user) or breaks a promise the plan makes to the owner.

## Findings

| ID | Severity | Title | File:line |
|----|----------|-------|-----------|
| R5-1 | Medium | `history clear` and the 1-day retention don't cover Claude Code's own session transcripts (full prompts, replies, tool results kept ~30 days) | `src/voice/claude.ts:239`, `src/voice/config.ts:131`, `src/history/store.ts:208` |
| R5-2 | Low | `stephen memory forget/clear/add` (CLI) does not end the follow-up conversation, so the next resumed command still sees the old memory | `src/memory/cli.ts:87-116`, `src/voice/claude.ts:513-517` |
| R5-3 | Low | Forgotten or refused memory text stays on disk: `voice/persona.txt` is only rewritten on the next Claude run; history keeps the `said` of refused secrets | `src/voice/claude.ts:513-517`, `src/voice/command-log.ts`, `src/history/store.ts:149` |
| R5-4 | Low | Secret refusal is easy to miss: comma-separated digits, full-width digits, "pin's", "pass word"; "remember 4417" falls through to Claude; comment says 4+ digits, code is 6+ | `src/memory/store.ts:13,101-112`, `src/memory/intent.ts:485,491` |
| R5-5 | Low | A wake-word "forget …" / "forget that" deletes with no dialog; a wake-word "what do you remember" reads every item aloud | `src/voice/memory-router.ts:73-78,108-129` |
| R5-6 | Low | Retention "1 day" keeps up to ~48 h, and old files are only purged when a new command is recorded | `src/history/store.ts:150,219-223` |
| R5-7 | Info | Boundary test gaps: `src/history/` is not a boundary; the `stephen serve` process loads `src/memory` and `src/app` through `src/cli.ts` | `test/memory/boundary.test.ts:17-21`, `test/helpers/import-scan.ts:78`, `src/cli.ts:6` |
| R5-8 | Info | Fn+Option is now a memory trust signal, but helper.sock still has no peer proof (review 4 #6 open) | `src/voice/listener.ts:675`, `src/helper/client.ts`, `helper/Core.swift` |
| R5-9 | Info | Wake-word split: the dialog shows only X, but Allow also runs "play Y"; misplits run an unintended command | `src/voice/memory-router.ts:86-98`, `src/memory/intent.ts:452-463` |
| R5-10 | Info | Memory text also goes to ElevenLabs (spoken "saved: X" and the spoken list); the dialog only mentions Claude | `src/voice/memory-router.ts:89,98,105` |

No Critical or High findings. I found no path from Claude, a page, an email, a tool result or the reply to a memory write.

### R5-1 (Medium) Claude Code keeps its own copy of every command

**What.** Follow-ups are on by default (`followUpWindowSec` 180, `config.ts:131`). Then `--no-session-persistence` is
left out (`claude.ts:239`). Claude Code saves each session as a transcript under
`~/.claude/projects/<slug of <home>/voice/workdir>/<session>.jsonl`. That file holds the prompt (what the owner said),
every tool result (page text, read_text output, later email bodies in phase 2a) and every reply. It is kept by Claude
Code's own cleanup (default about 30 days), not by `history.retentionDays`. `history clear` (`store.ts:208`) and the
app's "clear" only delete `<home>/history/*.jsonl`.

**Why it matters.** The owner picked a 1-day trial for privacy (PLAN 12.2) and the app says "Every saved command and
reply is deleted". A much richer copy (with tool results) stays for weeks. Anyone or anything that later reads the
home folder (backup, sync tool, a support bundle) gets it. Phase 2a makes it worse (private email text).

**Fix.** When a conversation ends (`Conversation.end`), delete that session's transcript file (the session id is
known). On `history clear` and on purge, also delete transcripts in that one project folder older than the cutoff.
Document it in VOICE.md. Option: offer `voice.followUpWindowSec: 0` as the "no copies" mode.

**Test.** Fake `HOME` with a fake transcript file named after the session id: ending the conversation removes it;
`history clear` removes all files in the Stephen project folder and nothing outside it; a symlinked folder is refused.

### R5-2 (Low) CLI memory changes don't end the conversation

**What.** The app (`server.ts:333-337`) and the voice router (`assistant.ts:283`) end the follow-up conversation after
a change. `stephen memory add/forget/clear` (`memory/cli.ts:87-116`) only changes `memory.json`. The listener's
conversation file is untouched. With `--system-prompt-snapshot` (PLAN section 3), the next command inside the window
resumes with the old system prompt.

**Why it matters.** The owner runs `stephen memory forget m3` and the very next voice command still uses the fact.
That breaks the "a memory change ends the conversation" promise. No attacker gain; it is a privacy surprise.

**Fix.** Simplest: the runner records a hash of the memory list used by the current session and ends the
conversation in `Conversation.begin` when the current list hashes differently. That covers CLI, hand edits and any
future writer. Or: the CLI deletes `<home>/voice/conversation.json` after a change.

**Test.** Start a conversation with memory [A]; change memory to [] outside the router; the next run's argv has no
`--resume`.

### R5-3 (Low) Forgotten or refused text stays on disk

**What.** `persona.txt` (0600, in a 0700 folder; written well, see "Checked, OK") holds the persona, `aboutMe` and the
memory list. It is written only right before a Claude run (`claude.ts:513-517`) and never deleted. After "forget
everything", or a CLI/app forget while nothing else runs, the forgotten items stay in `persona.txt` until the next
command, possibly for days. Separately, a refused memory command ("remember my door code is …") is still recorded in
history (`said`) and pushed to the app (`heard`).

**Why it matters.** The owner believes "forgot" means gone. Low because the files are owner-only.

**Fix.** Delete `persona.txt` when `stephen listen` exits and after every memory change (it is rebuilt before each
run anyway). For refused `secret` memory commands, store `said` as `remember [refused: looks like a secret]`.

**Test.** After `forget-all` via router and via app, `persona.txt` does not exist or has no `<user_memory>` block.
A refused secret leaves no digits in the day file.

### R5-4 (Low) Secret refusal gaps

**What.** `MEMORY_SECRET_RE` + `DIGIT_RUN_RE` (`store.ts:101-112`). Probe results (all saved, all would be sent to
Anthropic with every command):
- `my visa is 4512, 3456, 7890, 1234` (Whisper often puts commas between spoken digit groups)
- `code for the door: 1, 2, 3, 4, 5, 6`
- `visa ４５１２３４５６７８９０` (full-width digits; JS `\d` is ASCII only; typed or pasted in the app)
- `my pin's 4417`, `my pass word is hunter2`, `the garage opens with 4417`

Also: `remember 4417` or `remember hunter2` has a one-word body, so `parseMemoryIntent` returns null
(`intent.ts:491`) and the whole line, secret included, goes to Claude and into its transcript (see R5-1). The file
header (`store.ts:13`) and PLAN section 2 say "4+ digits"; the code refuses 6+.

**Why it matters.** This is a guard against the owner's own mistakes, not a security boundary. But the stated reason
for it (memory goes to Anthropic every time) holds, and the gaps are the common ASR shapes.

**Fix.** NFKC-normalize first. Count digits with up to two separator characters between them (`[\s,.\-/]{0,2}`).
Accept `pin'?s` and `pass\s?word`. When a line starts with "remember" but the router rejects it AND it looks secret,
refuse locally ("I don't save codes") instead of sending it to Claude. Fix the comment to say 6+.

**Test.** A table in `test/memory/store.test.ts` with the strings above (refused) next to `sofe 3980`, `class at 9`
and `2026` (saved). `parseMemoryIntent`/router: `remember 4417` is answered locally, 0 Claude spawns.

### R5-5 (Low) Wake-word forget and list have no dialog

**What.** Only wake-word "remember" asks (`memory-router.ts:86`) and "forget everything" asks (`:135`). A wake-word
"forget my gym" or "forget that" deletes at once (`:108-129`). A wake-word "what do you remember" speaks every item.

**Why it matters.** A bystander, or a video in a gap where the sound gate is open (no helper, cooldown done), can
delete memories or make Stephen read them out loud. Deletion is only a nuisance. The read-out is a small privacy
leak to whoever is in the room.

**Fix.** With `confirmWakeWord` on, also ask before a wake-word forget (same dialog, Deny default). For a wake-word
list, say the count only ("I remember 5 things; hold Fn+Option or open the Stephen app to hear them").

**Test.** `memory-flow.test.ts`: wake-word forget with a declining confirmer changes nothing; PTT forget still
deletes; wake-word list reply contains no item text.

### R5-6 (Low) Retention is looser than "1 day"

**What.** `cutoff()` keeps files dated `today - retentionDays` and later (`store.ts:219-223`). With 1, yesterday's
file stays all of today: up to about 48 h. Purge runs only inside `append` (`:150`). `list`, `stephen history`,
listener start and the app never purge. Set `retentionDays: 0` or stop using Stephen, and old files stay on disk.

**Fix.** Purge on `HistoryStore` construction (listener start), in `list()` and in the history CLI. Either document
"N days = today plus N-1 previous days" or use `getDate() - retentionDays + 1`.

**Test.** Fake clock: files for today, yesterday and two days ago; `new HistoryStore({retentionDays:1})` leaves only
what the documented rule says; `retentionDays:0` plus `list()` deletes all.

### R5-7 (Info) Boundary test gaps

**What.** `BOUNDARIES` covers `src/memory/` and `src/app/` against `CLAUDE_REACHABLE` (good, and the transitive scan
is sound). Two gaps:
1. `src/history/` is not a boundary. History holds every reply and is promised "never sent to Claude". A future
   `src/server` import of `history/store.ts` (to "show recent commands") would pass the tests.
2. `stephen serve` (the MCP server Claude talks to) runs `src/cli.ts`, which statically imports
   `./voice/index.js` (`cli.ts:6`), which imports `MemoryStore` and `AppServer`. The code-level boundary holds (no tool
   references them), but the Claude-facing process does load the memory and app modules.

**Fix.** Add `{ target: 'src/history/', importers: CLAUDE_REACHABLE }`. In `cli.ts`, load `runListen` with
`await import('./voice/index.js')` only for `listen`, and add a test that the module graph from `serve()` never
reaches `src/memory`, `src/app`, `src/history`.

**Test.** The two new boundary cases; a sentinel test that fails if `src/server/tools.ts` imports `src/history`.

### R5-8 (Info) Push-to-talk is now a trust signal

**What.** `source: ptt ? 'voice-ptt' : 'voice-wake'` (`listener.ts:675`). PTT saves memory with no dialog. The PTT
signal is `ptt_down`/`ptt_up` on helper.sock, which still has no proof of who serves it (review 4 #6: no nonce, a new
client replaces the old). The Node side never sees a field it could trust beyond the socket.

**Why it matters.** Only a same-user process can fake it, so it is out of scope. But a faked press now gives a direct
memory write of whatever the mic hears, not just a command. That raises the value of fixing review 4 #6.

**Fix.** As review 4 #6: nonce in a 0600 file checked in `hello`, and `flock` around probe/unlink/bind.

### R5-9 (Info) Split behaviour

**What.** In "remember X and play Y" by wake word, the dialog body names only X (`memory-router.ts:89`). Allow saves X
and then runs Y through Claude. Deny or no answer runs nothing (good, `:91-93`). Misplits run commands the owner did
not mean: "remember I go to the gym then check my email" saves "I go to the gym" and asks Claude to "check my email".

**Why it matters.** No escalation: a wake-word "play Y" alone would run without any dialog, and Y still has no path to
memory and still passes the gate. The rest is never secret-checked, but it is a normal command anyway.

**Fix.** Add `Then: "<rest>"` to the dialog body. Consider dropping `check`, `find`, `go`, `show` from
`COMMAND_VERBS` (they appear in ordinary facts).

### R5-10 (Info) Memory text reaches ElevenLabs

**What.** "Bet, saved: X", "Done, forgot: X" and "I remember N things: …" are spoken. With ElevenLabs as TTS, the
memory text goes to ElevenLabs. The dialog says only "it is sent to Claude with every command".

**Fix.** Say "Saved." without repeating the text when TTS is a cloud provider, or mention it in VOICE.md.

## Fix status (2026-11-01, lead; each fix has tests)

| ID | Status | What changed | Tests |
|----|--------|--------------|-------|
| R5-1 | Fixed | `src/voice/transcripts.ts`: Claude Code's transcript of a voice session is deleted when the conversation drops it (end, expiry, new id, failed run); history purge deletes older ones (rolling window), `history clear` all of them and ends the conversation. Only the voice workdir's project folder; symlinks refused; the live session is kept. | `test/voice/transcripts.test.ts` |
| R5-2 | Fixed | `conversation.json` stores a hash of the memory list the session was built with; `begin()` starts fresh when it differs (CLI, app, hand edit) or can't be read. | `review5.test.ts` R5-2 |
| R5-3 | Fixed | `persona.txt` is deleted after every run and on listener exit; a refused secret is stored in history as `remember [refused: looks like a secret]`. (The live `heard` push to the open window is display-only and not stored.) | `index.test.ts` persona, `review5.test.ts` R5-3 |
| R5-4 | Fixed | NFKC before the check; 8+ digits in spoken groups; comma lists of 4+ single digits; `pin's`, `pass word`, `code for the door`, `opens with 4417`; one-word "remember 4417/hunter2" refused locally; comment says 6+. | `review5.test.ts` R5-4 |
| R5-5 | Fixed | Wake-word forget asks ("Forget this?", Deny default, unavailable keeps it); wake-word list and tie replies give only the count. | `review5.test.ts` R5-5 |
| R5-6 | Fixed | Rolling window (same time N days ago, DST-safe); expired lines trimmed from the boundary day file; purge at listener start, in `list()` and in `stephen history`. | `review5.test.ts` R5-6, `history/store.test.ts` |
| R5-7 | Fixed | `src/history/` is a boundary; `src/cli.ts` loads `voice/index.js` on demand, and a test checks `stephen serve`'s start-up graph has no memory/app/history code. | `test/memory/boundary.test.ts` |
| R5-8 | Open (Info) | Same-user only; still review 4 #6 (helper.sock nonce + flock). Needs Swift, so it is a Mac task. | — |
| R5-9 | Fixed (dialog) | The wake-word dialog shows `Allow also runs: "<rest>"`. COMMAND_VERBS unchanged. | `review5.test.ts` R5-9 |
| R5-10 | Fixed (docs + dialog) | Dialog says memory is also read out through the voice service; VOICE.md says so. | `review5.test.ts` R5-10 |

## Checked, OK

- **No memory write path from Claude.** Memory is written only by `MemoryRouter` (user transcript or typed text,
  `assistant.ts:279`), the app socket and the CLI. Claude's reply is never parsed. Split `rest` goes straight to
  `runner.run` and is not routed again. No MCP tool is named like memory (boundary test).
- **Page / email / tool text, TTS echo, follow-ups.** Wake hits during `busy` (speaking) are ignored; the spotter
  is restarted after each command; a wake-word remember always asks. Resume carries no write path.
- **Fail closed dialog.** `DialogConfirmer` passes text on argv (no AppleScript injection), Deny is default and cancel,
  timeout returns "gave up" = declined, no GUI (-1713) or non-Mac = unavailable = not saved. Over-long body = declined.
  Claude is never running while the dialog is up (the router awaits it before any spawn).
- **`<user_memory>` escaping.** `<` `>` become `‹` `›` twice (store and `cleanMemoryItem`), control, bidi and
  zero-width characters removed, one line, 200 chars, 30 items. Hand-edited `memory.json` is re-checked on read.
  (Look-alike brackets such as `＜` are not mapped; only owner-chosen text gets in, so I left it out of the table.)
- **app.sock.** Folder created 0700, `lstat` must be a real folder owned by us, re-chmodded to 0700 *before*
  `listen()`, so the umask window before `chmod 0600` cannot be used by another user. A symlink or non-socket at the
  path is refused; a live socket is not replaced; unlink on close only if the inode is ours. Lines capped at 256 KiB
  with resync; 8 clients; 8 MiB output queue per client. Ids validated (1 to 64 chars) and JSON-encoded. Unknown types
  ignored. `chat.send` checks busy and goes through `listener.submit`. Memory changes from the app end the
  conversation, also after a running command (`endAfterCommand`). The Swift client checks `getpeereid` UID.
- **What the socket shows.** `settings.get` is an allow-list (no key paths, no ElevenLabs settings, no Claude path).
  It does show `aboutMe` and the config path, which is fine for same-user. `audit.recent` entries are sanitized at
  write time (URLs redacted, typed text as length only, memory ops as length only).
- **Lower-trust access to app.sock.** Other users: blocked by the 0700 folder. Web pages: no way to reach a Unix
  socket. Claude: no shell or file tools, `open_url` refuses `file:`, there is no native typing or clicking, and
  `open_app` of Stephen Helper only opens a window.
- **Swift window.** Every untrusted string uses `Text(verbatim:)` (no Markdown links). "Open config file" opens only an
  absolute `.json` path. No "run again" on history items, so a denied wake-word line can't be replayed as `app`.
- **Persona file.** Random temp name with `O_EXCL|O_NOFOLLOW`, 0600, fsync, rename into a checked 0700 folder. If it
  can't be written, the run fails instead of falling back to argv. (Lifetime: R5-3.)
- **History store.** Folder 0700, files 0600 with `O_NOFOLLOW` and fchmod, one `O_APPEND` write per entry, caps on
  said/reply/tools/5 MB, bad lines skipped, `retentionDays` validated 0 to 30 at config and constructor. Tool names
  only, never arguments. `clear` unlinks the files.
- **Memory store.** `O_EXCL` lock with pid and token, stale lock handling, atomic 0600 write, audit has length only.
- **media_control.** Goes through `gateRead` and `hub.action` (gate, identity and focus re-check, audit). Keys are
  sent by CDP to that tab only, so a focused Gmail compose in another tab or app can't receive them. No key when
  focus is editable or unknown; Space only when nothing has focus. Host match is exact via `siteKey`:
  `music.youtube.com.evil.com`, other ports, `http:` and subdomains don't match. `youtube.com` needs `/watch`.
- **play_media.** Host allow-list unchanged; on YouTube Music it clicks Play and never presses `k` (which means
  "previous" there).
- **Eval.** Inject cases run with a fixed `EVAL_MEMORY` and the dry-run server; `--fake-page` only with `--dry-run`.
