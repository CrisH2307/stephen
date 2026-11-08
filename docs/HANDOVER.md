# Stephen — handover & progress log

> New chat? Read `docs/PROJECT-CONTEXT.md` first (where the code is, how to sync), then `docs/ROADMAP.md` (what's next).
> The cloud workspace path `/home/claude/browser-hub` below belonged to the first chat and won't exist in a new one.

Read this first if you are picking up the work. Keep it current: update "Status" at the end of every step.

## Where things are
- **Owner's repo (source of truth for the owner):** `~/Documents/SoftwareProject/brower-hub/browser-hub` on their Mac,
  branch `main`, remote `github.com/CrisH2307/browser_hub`. The owner commits/pushes themselves.
- **Build/test copy (cloud workspace):** `/home/claude/browser-hub` (git, `main`). All tests run here (Linux, real
  Chromium via @sparticuz/chromium, real sherpa-onnx models). Sync to the Mac by zipping `git archive HEAD` and
  rsync-ing over the owner's tree **excluding node_modules, dist, .git** (see "Sync" below). Never run `npm install`
  in the device shell (it's a Linux VM; it would install Linux binaries into the Mac's node_modules).
- **Docs:** `docs/STEPHEN.md` (design/ADR-002), `docs/DESKTOP.md`, `docs/VOICE.md`, `docs/RESEARCH-STEPHEN.md`,
  reviews `docs/REVIEW-1..3.md`, `docs/VERIFY-2/3.md`.

## Owner decisions (latest first)
- 2026-10-30 19:49 — Build phase 1.5 (below). ElevenLabs voice id `YEBbZ0itqHW31uoXSBns` ("Noah Yang"). The owner
  pasted an ElevenLabs API key in chat: **never write it into the repo, docs, tests or logs.** It is stored only in
  macOS Keychain by the owner running `stephen voice-key set` (service `stephen-elevenlabs`). Recommend the owner
  rotate it (it appeared in a chat). Xcode is installed on the Mac. Logo change is deferred to the end.
- Push-to-talk = **Fn + Option, hold**. Keep "Hey Stephen" too, without the fixed 20 s cooldown.
- Speak first, then act, for anything that starts audio; stay quiet when sound is playing; talk normally otherwise.
- Order: phase 1.5 (this) → phase 2 cursor control (approved apps, AX-first, Esc stop) → phase 3 Agent SDK + API key.
- Earlier: safe desktop actions first; Claude Code login (`claude -p`) first; attach-only Zen ("Zen for Stephen").

## Phase 1.5 plan
| Track | Branch | Owns | Contract |
|---|---|---|---|
| A. Swift helper | `feat/helper` | `helper/**` (Swift sources, Info.plist), `src/helper/**` (installer `stephen install-helper`, socket client, launch), `test/helper/**`, `docs/HELPER.md` | `src/helper/protocol.ts` |
| B. Listener | `feat/ptt` | `src/voice/**` except `src/voice/tts/**`; `test/voice/**` except tts tests | consumes `HelperClient` from A via an interface + fake |
| C. Voice output | `feat/tts` | `src/voice/tts/**`, `test/voice/tts/**`, the `announce` MCP tool (`src/voice/announce.ts` + one hook line in `src/server/tools.ts`), `stephen voice-key` | `src/voice/tts/types.ts` |

Behaviour:
- **Push-to-talk:** hold Fn+Option → chime + menu-bar "recording"; release → transcribe → Claude. Taps < 250 ms ignored,
  max 30 s. Works while a command runs? No — Esc or a new PTT press cancels the running command first.
- **Wake word gating:** with the helper running, "Hey Stephen" is ignored only while the Mac is playing sound
  (`audio.playing`). Without the helper, the old 20 s cooldown remains as the fallback.
- **Esc** (helper) cancels the running command, like "Stephen, stop".
- **Speak first:** the server registers `announce {text}` only when started with `serve --voice` (the listener passes it).
  The persona tells Claude: before starting music/video/anything that plays sound, call `announce` with ≤ 12 words
  ("Playing Say So by Doja Cat"); `announce` speaks and returns when done; then act. The final reply is spoken only if
  the Mac is not playing sound (else just the done chime).
- **TTS:** `voice.tts` = `elevenlabs` | `kokoro` | `say` (default `elevenlabs` if a key is found, else `kokoro` if its model
  is installed, else `say`). Fallback chain elevenlabs → kokoro → say. ElevenLabs: `POST /v1/text-to-speech/{voice}`,
  model `eleven_flash_v2_5`, play with `afplay`. Key lookup: Keychain (`security find-generic-password -s stephen-elevenlabs -w`)
  → env `ELEVENLABS_API_KEY` → `voice.elevenlabs.apiKeyFile`. `stephen doctor` checks key + voice (GET /v1/voices/{id}).
- **Cannot be tested in the cloud:** Swift compile/run, CGEventTap, CoreAudio, Keychain, ElevenLabs (network blocked), afplay.
  Everything else is unit/integration tested with fakes.

## Sync to the owner's Mac
```
cd /home/claude/browser-hub && git archive --format=zip --prefix=browser-hub/ -o /home/claude/out/stephen.zip HEAD
# SendUserFile it (gets a file_uuid) → device_commit_files to ~/Documents/SoftwareProject/brower-hub/stephen.zip
# device_bash: unzip into $HOME/stage, then
#   rsync -rc --exclude node_modules --exclude dist --exclude .git $HOME/stage/browser-hub/ $HOME/mnt/brower-hub/browser-hub/
# Before syncing, pull any owner edits first (device_stage_files the changed files; compare with `rsync -rcn`).
```

## Status
- 2026-10-30 19:55 — Validation done (repo clean & pushed; voice exists; key/Xcode only verifiable on the Mac).
  Contracts frozen (`src/helper/protocol.ts`, `src/voice/tts/types.ts`). Tracks A/B/C starting.
- 2026-10-30 20:30 — Track C (`feat/tts`) done: `createTts` (src/voice/tts), `announce` (serve --voice), `stephen voice-key`,
  `voice-setup --tts kokoro` (kokoro-int8-en-v0_19, 103 MB, sha256-pinned), doctor "Voice output". Track B still has to:
  use `createTts(cfg, { home, log })` instead of `SaySpeaker` in `voice/index.ts`, add `--voice` to the MCP config args
  in `voice/claude.ts`, and mention `announce` in the persona. Mac-only checks: Keychain, `security -i`, afplay, ElevenLabs.
- 2026-10-30 — Track A (`feat/helper`) done: `IHelperClient` frozen in `src/helper/client.ts` (first commit),
  `HelperClient`, `stephen install-helper`, doctor lines, `docs/HELPER.md`. Swift core type-checked, compiled and
  run on Linux (Swift 5.10.1); `helper/main.swift` (AppKit/CGEventTap/CoreAudio) only type-checked against stubs —
  first real compile is `stephen install-helper` on the Mac.
- 2026-10-30 — Track B (`feat/ptt`) done: push-to-talk, Esc, wake-word gating on `audio.playing` (20 s cooldown
  only without the helper), `voice.wakeWord` / `--ptt-only` / `--no-helper`, quiet-while-playing replies, menu-bar
  states, `serve --confirm dialog --voice` + announce persona. Listener talks to the helper through
  `src/voice/helper-link.ts` (`HelperLink` ≅ `IHelperClient`; real client loaded lazily via
  `createHelperClient({ home })`). TTS plugs in at `speaker` in `src/voice/index.ts` (marked). Merge after C:
  `serve --voice` is rejected by `parseServeArgs` until track C adds it.
- 2026-10-30 21:45 — Integrated A+B+C on `main`: listener uses `createTts(cfg, {home, log})` (warmed at start),
  `createHelperClient` exported from `src/helper/client.ts`. Full suite 1838 passed / 10 skipped (Swift full-app
  compile is Mac-only; the 9 Swift core tests pass with the scratch Linux swiftc). Next: sync to the owner's Mac,
  owner runs `npm install && npm run build && stephen install-helper && stephen voice-key set && stephen doctor --network`,
  then a bounded security review of voice-key / ElevenLabs / announce / helper socket.
- 2026-10-30 22:30 — Review #4 (docs/REVIEW-4.md) fixed: aborted synthetic ptt_up is discarded (#1); helper drop
  arms the remaining cooldown and unknown audio state fails closed (#2); `announce` refuses steering words (#3);
  TTS temp dirs removed on exit (#4); ELEVENLABS_API_KEY stripped from claude's env (#7). Open (documented, phase 2):
  helper socket authentication (#6 — hello nonce + lock file), Keychain item readable by same-user processes (#5).
  Synced to the owner's Mac. Owner's next steps: see README "Voice" + docs/HELPER.md.
- 2026-10-31 12:20 — Owner feedback round (phase 1.6): (1) ASR mishears names ("one car away charlie pool") →
  bigger default ASR + persona says transcripts may contain recognition errors; (2) 10–20 s to play a YouTube song →
  `play_media` fast path (resolve the video server-side, open the watch URL) + faster `claude --model` default for voice;
  (3) Stephen said it "can't click a result" → play_media + persona "don't give up, say what failed"; (4) wake variants
  "hey/yo/ok stephen" + bare "stephen"; (5) casual Gen-Z tone for spoken replies (dialogs stay plain). The owner put
  "Stephen Helper.app" in the Dock — keep its path `~/Applications/Stephen Helper.app` when rebuilding.
- 2026-10-31 — `fix/media` (feedback 2, 3, 5): new desktop tool `play_media {query, service?, browser?, intent}`
  (`src/desktop/media.ts` resolver: server-side GET of www.youtube.com/results only, no cookies/redirects, 4 s, 3 MB;
  `src/desktop/play.ts`: opens the watch URL via `Desktop.openParsed` = open_url's path and gate, presses `k` if
  paused when attached, search-results fallback). Persona rewritten (ASR-tolerant names, announce + one play_media,
  don't give up, Gen-Z tone, serious on safety). `voice.claudeModel` defaults to `haiku` ("default" = no flag).
  Lock-down gains `--no-chrome` (Claude in Chrome tools survived `--strict-mcp-config`) and
  `--no-session-persistence`. Each command logs `claude: … (start-up + MCP, model, tools)`. Timing study and
  proposed next wins: docs/VOICE.md "Where the time goes". Mac-only: real YouTube page shape / consent redirect,
  player button labels, that the owner's `claude` accepts `--no-chrome`.
- 2026-10-31 — Phase 1.6 merged (fix/asr + fix/media): default ASR whisper-small.en (636 MB, `stephen voice-setup`;
  falls back to tiny with a hint), wake variants hey/yo/ok/bare "Stephen" (bare one stricter), `play_media`
  (server-side YouTube resolve → open watch URL via the open_url gate path), persona: fix misheard names, use
  announce+play_media, don't give up, casual Gen-Z tone; `voice.claudeModel` default "haiku"; `--no-chrome` and
  `--no-session-persistence` added to the lock-down but dropped automatically if the owner's `claude --help` lacks
  them (required lock-down flags missing → listen refuses with "update Claude Code"). No Swift changes → no helper rebuild.
- 2026-10-31 15:30 — Owner report: "play One Call Away" opened YouTube but didn't play. Audit log on the Mac showed
  play_media resolved the right video but used `open -a` although "Zen for Stephen" was running: each voice command
  is a fresh server, never "already attached". Fix: `Desktop.tryAttach` attaches on demand to an attach-only Zen
  (real + launch "never" — never launches; Chrome and agent mode never auto-attach), then ensurePlaying presses k.
  play_media reuses an open YouTube / YouTube Music tab (`REUSE_HOSTS`) instead of opening a new one. The `open -a`
  fallback now says honestly it may not start (Zen blocks autoplay with sound). Voice model default → "sonnet"
  (the owner's choice). The Mac's audit log is at ~/.browser-hub/audit.log (legacy home), readable via device tools.
- 2026-10-31 15:45 — Owner: Stephen works well. Next = phase 2a "read my stuff" (Gmail, Canvas, Notion, Calendar,
  Maps), read-only, recommended via connectors/APIs + `serve --assume-private-read`. Plan in docs/ROADMAP.md.
  Wrapping up this chat; added docs/PROJECT-CONTEXT.md for a new chat / Claude Project.
- 2026-10-31 — `fix/reuse`: tabs are reused instead of piling up (audit log: 4 Maps tabs, a new Gmail tab per
  "check my email"). One implementation, `src/server/tab-reuse.ts` (`siteKey`, `findReusableTab`, `openPage`),
  used by `open_url`, `play_media` (`REUSE_HOSTS`/`findTabOnHosts` removed) and `tab_open` (`new_tab: true` forces
  a new tab). Exact page → focus (no reload); same site → navigate (kind navigate via hub.perform); gate decision
  unchanged. Setting `desktop.reuseTabs` = site | exact | never. See DESKTOP.md "Tab reuse".
- 2026-10-31 17:40 — Merged fix/reuse + fix/followup (2099 tests green). Tab reuse: ONE implementation in
  `src/server/tab-reuse.ts` (`siteKey`, `findReusableTab`, `openPage`) used by open_url, play_media and tab_open
  (`new_tab: true` forces a new tab; `desktop.reuseTabs` site|exact|never). Follow-ups: commands within
  `voice.followUpWindowSec` (180 s) resume the Claude session AND reload the gate's taint/approvals from
  `<home>/voice/conversation-state.json` (`serve --session-state`), so review #3 finding 1 stays closed; state and
  session id are deleted when the conversation ends (window, error, cancel, Esc/stop). Open decision: a reused tab is
  gated as a new tab (target URL), not against the page it replaces.
- 2026-10-31 20:45 — Phase 1.8 step 1 "one shot" small fixes (plan: docs/PLAN-1.8-ONE-SHOT.md; owner: prefers
  Fn+Option, wants best guesses over questions, fix small things first). Listener: `longSilenceSec` 1.5 (after
  2.5 s of talking a thinking pause no longer ends the command), `continueSec` 4 (a transcript ending in "and/then/um…"
  keeps listening once and joins the parts; audio said during transcription kept from the ring), `maxCommandSec`
  12 → 25. Persona: do every part in one run, best guess over asking (say what was picked), name the part it can't
  do, reply covers every part, one announce per request, Google Maps directions via open_url. `voice.aboutMe`
  (name/home/school/work/notes, owner-written only) appended to the persona so "from my home" needs no question.
  `open_url new_tab: true` (several routes side by side; same gate). `maxTurns` 15 → 25. Tests:
  test/voice/oneshot.test.ts (+ reuse.test.ts new_tab). Owner to do: add `voice.aboutMe` to ~/.browser-hub/config.json,
  `npm run build`, try "routes from my home to two stations". Not yet: the eval harness (`stephen eval`, plan track D),
  media/volume tools (track C), anything that writes (Docs, Discord) — phase 2b+.
- 2026-10-31 21:30 — Phase 1.8 step 2 (owner: "separate mini subtasks"). D1 `serve --dry-run --record <abs file>`
  (src/eval/dry-server.ts: the real registerTools through a shim that drops every real handler; calls appended as
  JSONL, neutral fake results; flag pair can't be combined with any other serve flag). D2 `src/eval/cases.ts`
  (39 cases: single, misheard, multi, routes, vague, cant-yet, careful, media; EVAL_ABOUT_ME) + `score.ts`.
  D3 `stephen eval [--only x] [--jobs N] [--model m] [--timeout s]` (src/eval/run.ts, cli.ts): real `claude -p`
  argv/persona, dry-run tools, report in <home>/eval/<stamp>/report.json; tested with test/eval/fake-claude-eval.mjs
  which really starts the dry-run server. C `volume` + `media_control` (src/desktop/sound.ts; fixed JXA, argv only;
  Spotify/Music only if running; YouTube → browser tools). Mac-only: JXA setVolume, Automation prompt. Owner next:
  `npm run build && node dist/cli.js eval` and send the summary; then try "turn it down and play the next song".
- 2026-10-31 21:45 — Eval round 1 on the owner's Mac: **37/39** (sonnet, median 4.5 s; report
  ~/.browser-hub/eval/2026-11-01T01-27-16). Both failures were can't-yet cases (`cant-discord-msg`, `cant-canvas-doc`):
  Stephen browsed Discord/Canvas for 11–12 calls (~16 s) and then replied honestly in words the scorer didn't accept.
  Fixes, each tested in test/eval/cant-yet.test.ts (replays the two real runs): (1) `CANT` regex in cases.ts also
  accepts couldn't/didn't send/…/yet; (2) can't-yet cases allow at most 3 calls (`CANT_MAX_CALLS`), so slow browsing
  fails the eval; (3) dry-run snapshot/read_text return a loaded page (the old "still loading" made the model poll);
  (4) persona: can't-yet parts are said right away, no browsing/reading/screenshots to try anyway (one open is OK);
  "don't give up early" now only covers things Stephen can do. New case `cant-owner-canvas-doc-discord` (the owner's
  own request from PLAN-1.8) → 40 cases. Owner next: `npm run build && node dist/cli.js eval --only cant`.
- 2026-10-31 23:30 — Validated with real `claude -p` (sonnet) in the cloud workspace (claude CLI works there; it uses
  the cloud plan, not the Mac's). Round 2: 3/4 cant — the owner's own request still browsed Canvas (6 calls) because
  "reading the user's accounts" was too abstract. Persona now names them ("Canvas assignments, emails, Notion pages,
  calendar, chats"); test in cant-yet.test.ts. Then `--only cant` 4/4 twice, and the **full eval 40/40**. Synced to the
  Mac (owner had committed 1.8 as desktop/evel/test; this fix is uncommitted). Design note: reading those accounts
  stays can't-yet on purpose until phase 2a (APIs/connectors + `--assume-private-read`), not by screen-reading.
- 2026-11-01 09:30 — Owner: `eval --only cant` 4/4 on the Mac; committed as `eval` (3d00bed). Jev key replaced and
  working (sized this task "large → opus"). Task 3 done as **design only**: docs/PLAN-1.9-MEMORY-DASHBOARD.md (memory
  only from the owner's own "remember …", routed by deterministic code before Claude, no memory tool, import-boundary
  tests; history 0600 + retention; `stephen dashboard` on 127.0.0.1 with fragment token, Host/Origin checks, strict CSP,
  loopback blocked in `serve --voice`; 16 subtasks; 4 open questions with defaults). Verified in `claude --help` 2.1.316:
  `--system-prompt-snapshot` defaults on (so a memory change must end the conversation) and
  `--append-system-prompt-file` exists but only in the `--bare` help line (needs a real probe). Still pending from the
  owner: task 2 Mac checks (volume, Spotify/Music Automation prompt, pause timing) and answers to PLAN-1.9 §12.
- 2026-11-01 13:30 — **Phase 1.9 built (except the security review).** Owner answers (PLAN-1.9 §12): wake-word
  remember asks in a dialog, Fn+Option stays the trusted backup; history default 1 day (trial, up to 30); "remember X
  and play Y" is split deterministically; **native app instead of a browser dashboard** (§13: Stephen window in
  Stephen Helper.app over `<home>/run/app.sock`); task 2 = YouTube Music first. Work split by Jev (all "large → opus"
  except two "self") across 8 subagent branches, merged and checked by the lead:
  - `src/memory/` store (0600, lock, caps, secret refusal: secret words, lock/login codes, 6+ digit runs; course codes
    and years save), intent parser (anchored remember/forget/list, split), `stephen memory`, boundary test (Claude-
    reachable code can't import src/memory or src/app; no memory-like tool).
  - Persona: `<user_memory>` block framed as data + "you can't save memories" line; persona moved to
    `--append-system-prompt-file` (`voice.personaFile` auto|on|off; 2.1.316 reads it, checked with a real call).
  - `stephen listen`: memory router before Claude (0 claude spawns for memory commands), split, wake dialog,
    any change ends the follow-up conversation (system-prompt snapshot), history per command
    (`src/history/`, `stephen history`), `serve --tool-log` (tool names only).
  - App: `src/app/` app.sock server (protocol v1, fixture test/fixtures/app-protocol-v1.jsonl), `stephen app`;
    Swift `helper/AppClient.swift`, `helper/AppWindow.swift` (Chat/Memory/History/Settings/Audit), menu "Open
    Stephen…", `open_window`; install argv adds `-framework SwiftUI`. **Never compiled** (no swiftc in the cloud).
  - `media_control`: YouTube Music tab first (Space / j / k or the player buttons, through the gate), then YouTube,
    then Spotify/Music. play_media no longer presses `k` on YouTube Music (it's "previous" there).
  - Eval: memory (3) and inject (3) categories; `--fake-page`; scorer `forbid` / `replyNot`. Real claude (sonnet, cloud):
    mem 3/3, inject 3/3 twice.
  Full suite green: 2473 passed, 11 skipped (cloud). Owner next: `npm install && npm run build && node dist/cli.js install-helper`
  (Swift compile; send errors if any), then `stephen listen`, "remember my gym is goodlife on king st",
  `stephen app`, `node dist/cli.js eval`. Open: independent security review #5 (agent usage limit hit; after reset),
  then phase 2a.
- 2026-11-01 15:20 — Owner's Mac: rebuilt helper compiled and runs (the Stephen window opened via `stephen app`),
  but helper.log says "Input Monitoring not granted yet" (a rebuilt binary loses the permission), so Fn+Option sent
  nothing; the wake word was ignored because the helper reported sound playing (fail-closed sound gate, by design).
  Fix is on the owner's side: re-enable Stephen Helper in Privacy & Security → Input Monitoring, quit the helper from
  the menu bar, restart `stephen listen`. Eval on the Mac 45/46 (mis-lofi: "low fly girl" searched as heard): persona
  now says an unknown name was probably misheard → use the closest well-known one. Cloud: `--only mis` 6/6 ×3,
  full eval 46/46.
- 2026-11-01 17:00 — **Security review #5 done and fixed** (docs/REVIEW-5.md). Fresh opus subagent that didn't build
  1.9 (Jev couldn't size it: openrouter.ai is blocked from both the Mac VM shell and the cloud, 403; used Jev's earlier
  "large → opus"). No Critical/High: nothing Claude, a page, an email or a tool result does can write memory; app.sock
  is safe from lower-trust actors. Fixed, each with tests (test/voice/review5.test.ts, transcripts.test.ts):
  R5-1 Claude Code's own session transcripts (`~/.claude/projects/<voice workdir slug>/`) deleted when a conversation
  drops a session, purged with the history window, all on `history clear` (src/voice/transcripts.ts);
  R5-2 conversation.json keeps a memory-list hash, a change from anywhere (CLI, hand edit) starts fresh;
  R5-3 persona.txt exists only during a claude run; refused secrets stored as "remember [refused: …]";
  R5-4 secret check: NFKC, spoken digit groups/lists, pin's, pass word, "code for the door", one-word "remember 4417"
  refused locally; R5-5 wake-word forget asks, wake-word list/tie say only the count; R5-6 history is a rolling window
  (same time N days ago), purged at listen start / list / `stephen history`; R5-7 src/history is a boundary, cli.ts
  loads voice/index.js on demand (serve start-up graph test); R5-9/10 dialog shows the split part and mentions the
  voice service. Open: R5-8 (= review 4 #6, helper.sock nonce, Swift/Mac). Suite: **2498 passed, 11 skipped**; real
  eval (sonnet, cloud) inject 3/3, memory 3/3. No Swift changed (no install-helper needed). Owner next: `npm run build`,
  then the Mac checks (Fn+Option after Input Monitoring, gym memory → directions, the window, YouTube Music).
- 2026-11-01 19:50 — Owner: Fn+Option still didn't work on the Mac → **hold F5 to talk** added (Fn+Option kept as a
  backup). helper/Core.swift `PushToTalk`: F5 (kVK_F5 = 96) key-down starts a press, F5 key-up ends it, auto-repeat
  ignored, modifier changes don't end an F5 press (so Fn+F5 works), max-hold/Esc as before; helper/main.swift taps
  keyUp too and only looks at Esc/F5 key codes. Mirrored in test/helper/ptt-model.ts (+6 scenarios) and the Swift
  harness (`keyup <code>`). Cloud: helper model tests green; Swift not compiled here. Owner: `npm run build &&
  node dist/cli.js install-helper`, re-grant Input Monitoring, then `npx vitest run test/helper/swift.int.test.ts`.
  Mac keyboards send F5 as a media/Dictation key unless "Use F1, F2, etc. keys as standard function keys" is on;
  otherwise press Fn+F5. User-facing text still says Fn+Option (not changed yet).
- 2026-11-01 21:10 — Owner: **hold F5 works** on the Mac. Next: owner checks the Stephen window (chat / memory /
  history / settings / audit) before anything new; then phase 2a. Still to do later: change the "Hold Fn+Option" text
  in replies/docs to F5.
- 2026-11-01 21:20 — Owner checked the Stephen window: all fine. **Phase 2a started** (plan: docs/PLAN-2A-READ-MY-STUFF.md).
  Findings: headless `claude -p` has no claude.ai connectors (cloud probe; Stephen's `--strict-mcp-config` blocks
  them anyway, and the gate couldn't see their reads) → Stephen's own read-only API tools inside its MCP server.
  Taint: a read tool calls `gate.notePrivateData(source)` when it returns data (synthetic host
  `<source>.private.stephen.invalid`, prompts say "your Canvas"), saved in session state; `serve --assume-private-read`
  arms it from the start (for later). **Subtask 1 built + tested** (test/safety/private-data.test.ts; safety/server/
  cli/memory/eval suites 1180 green). Grapuco (owner asked to use it) isn't reachable: api.grapuco.com is blocked
  (403) from the cloud and there's no grapuco tool/CLI here. Waiting on the owner's answers (plan §5: Canvas URL +
  token, which email account, Notion to-do page, calendar) before subtasks 2–7.
- 2026-11-01 22:50 — **Phase 2a: Canvas built.** Owner answers in PLAN-2A §6 (Canvas token in repo `.env` as
  CANVAS_API; personal Gmail first; Notion full access; Google Calendar; order Canvas → Calendar → Notion → Gmail).
  New `src/accounts/`: `secrets.ts` (Keychain `stephen-<name>` → repo `.env`, known keys only, owner-only file),
  `http.ts` (ApiClient pinned to one origin: https, GET, no redirects, timeout, byte cap, same-origin Link paging),
  `result.ts` (`<untrusted_account_data>`, HTML→text, links→host, codes masked, caps), `canvas.ts`
  (`canvas_due` = planner items, `canvas_announcements`), `index.ts` (registered from server/tools.ts; secret read on
  first call; `gate.notePrivateData('canvas')` before returning), `cli.ts` (`stephen accounts`,
  `stephen accounts test canvas`). Config `"accounts"` (enabled, timeZone, canvas.url; default learn.ontariotechu.ca).
  Persona: Canvas via the tools (emails/Notion/calendar still can't-yet). Eval: `read` category (3) +
  `inject-canvas-announcement`; cant-canvas cases now expect canvas_due. Real eval (sonnet, cloud): read 3/3, cant 4/4,
  inject 4/4. src/accounts is in CLAUDE_REACHABLE (boundary). New docs/SYSTEM-DESIGN-STEPHEN.md (showcase doc).
  learn.ontariotechu.ca is blocked from cloud + VM shell, so the owner runs `node dist/cli.js accounts test canvas`.
  Next: Google Calendar (secret iCal URL → `GOOGLE_CALENDAR_ICS` in .env), then Notion, then Gmail (OAuth).
- 2026-11-01 23:30 — **Phase 2a: Google Calendar built.** `src/accounts/calendar.ts`: RFC 5545 subset parser
  (unfold, quoted params, unescape), DATE/UTC/TZID/floating times (wall clock → UTC by fixed-point offset iteration),
  RRULE DAILY/WEEKLY+BYDAY/MONTHLY+BYMONTHDAY/YEARLY with INTERVAL/COUNT/UNTIL expanded on the event zone's wall
  clock (DST-correct, tested across 2026-11-01), EXDATE, RECURRENCE-ID overrides, CANCELLED, bounded expansion.
  Tool `calendar_events {range: today|tomorrow|week}`; secret `GOOGLE_CALENDAR_ICS` (the calendar's "Secret address in
  iCal format", webcal ok) in .env or Keychain `stephen-calendar-ics`; `stephen accounts test calendar`. Persona:
  calendar via the tool (sentence placed after the Maps block: placed earlier it made mis-lofi fail more often).
  Eval: read 5/5, cant 4/4, inject 4/4; full eval 50/52 (open-spotify asked a trailing question once, passes on
  rerun; mis-lofi is borderline: "low fly girl" → "Low" by Flo Rida in 2 of 3 runs). Suite 2534 passed / 11 skipped
  (fixed a 1-in-1000 flake in audit.test.ts: a timestamp ending in 999). Owner: add GOOGLE_CALENDAR_ICS to .env, run
  `npm run build`, `node dist/cli.js accounts test canvas` and `… test calendar`, then try "what's due this week" and
  "what's on my calendar today". Next: Notion (NOTION_API integration token), then Gmail (OAuth, personal accounts).
- 2026-11-02 00:10 — Owner: Notion/Gmail later; "move on". Done: (1) user-facing "Hold Fn+Option" → "Hold F5" (docs/
  doctor/install say "F5 or Fn+Option"). (2) **Timers and reminders** (src/timers/: intent.ts grammar, store.ts 0600
  `<home>/timers.json` + scheduler, router.ts replies, notify.ts osascript argv notification), routed before Claude in
  Assistant (`timers` option), fired only while `stephen listen` runs; persona says Claude can't set them; boundary
  `src/timers/` vs CLAUDE_REACHABLE; eval case `timer-no-time`. Time-zone math moved to src/util/zone.ts.
  (3) **Security review #6** (fresh opus; docs/REVIEW-6.md): no Critical/High. Fixed R6-2…R6-10 with tests
  (test/accounts/review6.test.ts): linear HTML stripping + input cut, zone formatter cache, RRULE skip-ahead + BYDAY
  dedupe + iteration/feed caps, wake-word timer trust (count-only list, cancel dialog, 5-item cap), alerts through
  listener.submit/Assistant.announce, secret value checks + fixed network error words, `*.stephen.invalid` blocked,
  more link/code shapes cleaned, account env names stripped from claude's env, .env parser fixes. R6-1 not an issue
  (Mac .gitignore has .env). Full eval before the review fixes: 52/53 (mis-lofi borderline). Owner's Mac already has
  commits through calendar ("src"); timers + review-6 fixes are new and uncommitted.
- 2026-11-02 12:40 — Owner: all looks good; handing over to the owner's personal account (cloud session). New
  requirements recorded: jobs while away ("go cook" mode: documents, papers, code, research, homework, vibe-coding
  with no hands on the Mac), phone → Stephen remote control, a UI pass with design skills at the end of every phase,
  simple code that scales. Agreed order: morning briefing → speed (phase 3) → Notion/Gmail → jobs → phone. Wrote
  docs/HANDOFF-PROMPT.md (paste into the new session) and the order at the top of docs/ROADMAP.md.
- 2026-11-02 18:30 — New cloud session (repo crish2307/stephen, branch claude/nifty-johnson-yk4hv6). Plan and agent
  split: docs/PLAN-WORK-SPLIT.md (Jev unreachable: no Remote Control folders shared, openrouter blocked; sized by
  hand, no Fable). **Item 1 morning briefing built:** `weather_now` (src/accounts/weather.ts, Open-Meteo pinned
  origin, location from `accounts.weather`, default Toronto 43.6532/-79.3832, no taint), `stephen accounts weather
  [set <lat> <lon> [label]]`, `stephen accounts test weather`; persona line (three tools in one step, 3–4 sentences);
  eval `brief-day`, `inject-brief-day`: real sonnet 2/2. Research docs: ADR-004 (jobs: local `claude -p --restricted`
  + strict sandbox), ADR-005 (phone: Remote Control + small bridge MCP), RESEARCH-MARKET.md. Running: Notion tools,
  ADR-003 speed probe. Mac checks: `npm run build`, `node dist/cli.js accounts test weather`, say "what's my day".
- 2026-11-02 18:45 — **Notion built** (pulled forward from item 3): `notion_todos` (configured `accounts.notion.todoDatabase`
  or the first shared database titled like to-do/task; status/checkbox/select "done" rule, filtered server-side and
  locally; 3 pages cap), `notion_search` (titles only), `stephen accounts test notion`, Notion-Version 2022-06-28,
  taint `notion`, persona line. Eval `read-notion-todos`, `inject-notion-todo`: real sonnet 4/4 (`--only notion`).
  Merged with weather (conflicts were additive). Full suite **2601 passed, 11 skipped**. Owner: put NOTION_API in .env,
  share the to-do database with the integration, run `node dist/cli.js accounts test notion`; answer the database
  questions (done property name/type and option names, title, due-date property).
- 2026-11-02 — **Stephen window UI pass** (branch worktree-agent-a5ae9da0f62adfcdd). New **Accounts** tab: protocol request
  `accounts.status` → `accounts` (src/app/accounts-status.ts, built on `lookupSecret` + `parseAccountsConfig`, no network, never a
  value; rows for Canvas, Calendar, Notion, Weather and Gmail labels if `accounts.gmail.accounts` exists; state connected / not_set
  / off, source keychain or .env, one-line hint). **Today card** on Chat: button sends "what's my day?" through the normal
  `chat.send`. Empty states (memory, history, audit, accounts) and one-line offline state with Retry. Protocol v1 stays
  compatible (additive; fixture lines a20). Swift was NOT compiled here (no swiftc): first compile is on the Mac.
  **Mac check steps:**
  1. `npm run build && node dist/cli.js install-helper` (watch for any swiftc error; paste it back if there is one).
  2. System Settings, Privacy & Security, Input Monitoring: remove and re-enable Stephen Helper (the rebuild changes its signature).
  3. `stephen app` (with `stephen listen` running in another terminal).
  **What to look at:** (a) sidebar has Accounts with a key icon; rows show Canvas/Calendar/Notion/Weather with the right state, the
  source (Keychain or .env) and a hint, and no secret anywhere; Weather shows your place label. (b) Chat tab: Today card at the top;
  **What's my day?** puts "what's my day?" in the chat as your bubble and gets a reply; the button greys out while a command runs.
  (c) Stop `stephen listen`: one line "Can't reach Stephen. Run `stephen listen`." and Retry; start it again and the window recovers
  in about 3 s. (d) Memory, History, Audit with nothing in them show a symbol and one line. (e) Dark mode: switch System Settings,
  Appearance, Dark; text, cards and the status colours stay readable.
- 2026-11-02 19:40 — **Gmail built** (PLAN-2A subtask 7). `gmail_search` (fields → Gmail `q` built in code, values
  reduced to plain words and quoted, fixed `-in:sent -in:drafts -in:chats`; sender as name + domain; snippets
  cleaned; up to 10) and `gmail_read` (only ids gmail_search returned in this process, per account; text/plain
  preferred, HTML via result.ts with style/script/head dropped linearly; 3000 chars). Taint `gmail`. Accounts:
  `accounts.gmail.accounts` labels (first = default), `accounts.gmail.clientId`. Owner-only `stephen connect gmail
  <label>` / `stephen disconnect gmail <label>` in new src/connect/gmail-oauth.ts (only src/cli.ts loads it, dynamic;
  boundary test): loopback 127.0.0.1 random port, PKCE S256, state, 3 min timeout, scope exactly gmail.readonly
  (anything else is not stored), refresh token → Keychain `stephen-gmail-<label>` via the voice-key `security -i`
  stdin path (now shared: `keychainStore` / `keychainDelete` in src/voice/tts/keys.ts), disconnect revokes at Google.
  ApiClient got `postForm` (token endpoint). Client secret optional: `GOOGLE_OAUTH_CLIENT_SECRET` (.env) or Keychain
  `stephen-google-oauth`. Access tokens in memory only. `stephen accounts` lists Gmail labels. Persona: Gmail in the
  accounts sentence; reading email no longer can't-yet (sending/replying still is). Eval: `read-mail-prof`,
  `read-mail-unread`, `inject-email` (dry-server fakes respect --fake-page); not yet run against the real model.
  Tests: test/accounts/gmail.test.ts (23), gmail-oauth.test.ts (18). Full suite 2644 passed / 11 skipped; one real
  Chromium timing test (page/review2 #15) failed once under load and passes alone. Owner setup: PLAN-2A §7.
- 2026-11-02 20:20 - **Phase 3 built: one warm Claude Code per conversation** (docs/ADR-003, subtasks 1 to 3).
  `src/voice/warm-claude.ts` drives one long-lived `claude -p --input-format stream-json --output-format stream-json
  --verbose` with the one-shot lock-down argv (`buildWarmArgs`): initialize, persona deleted, `mcp_status` until
  `stephen` is connected, one `JSON.stringify` line per command, per-command differences of the cumulative cost and
  api time, `kill()` waits until the whole process group is gone. `WarmConversationRunner` (conversation.ts) owns the
  lifetime: pre-warmed on the wake word / F5 down; ends on window expiry, memory change, any cancel, any error, an
  unused pre-warm after 60 s, 25 commands, 30 minutes, listener exit; always kill, wait, then reset (session id,
  state file, transcript). Config `voice.warm` (default true); the listener checks `initialize` at start and falls
  back to one `claude -p` per command with a note; `--text` and `--dry-run` stay one-shot. The rate limiter needed
  no change (already a sliding 40 actions / 60 s); new tests show a 25-command / 30-minute chain passes and a
  runaway loop is held at 40 per minute. `formatTiming` warm line: `claude: 1.9 s (warm, spawned 3.0 s ahead;
  start-up + MCP 0.0 s, model …, tools + overhead …)` or `(warm, follow-up 2 on this process; …)`. Fake claude has a
  stream mode (test/voice/fake-claude-stream.mjs). Opt-in real probe: `STEPHEN_REAL_CLAUDE=1 npx vitest run
  test/voice/warm-claude-real.test.ts` (passed here: ready 1.4 s). Real headless run here: `listen --wav
  wake-onebreath.amy.wav` with the real claude printed `claude: 9.1 s (warm, spawned 1.6 s ahead; start-up + MCP
  0.1 s, model 8.9 s in 4 turns, …)` (WAV audio runs faster than real time, so the lead is short). Full suite **2660
  passed, 12 skipped**. Docs: SYSTEM-DESIGN §4.12 (new) and §4.1, STEPHEN.md follow-ups row, VOICE.md, ADR-003
  "Implementation". Owner: measure on the Mac, one-shot (`"warm": false`) vs warm, with the `claude:` lines.
- 2026-11-02: Review 7 R7-2 fixed (owner decision "summary only" for the wake word). Trust follows the conversation:
  `trusted` (F5 / Fn+Option, typed text, app chat, `--text`) or `wake` (wake word), `trustOf(source)` in
  `src/voice/assistant.ts`. A command of the other trust always starts a fresh conversation (kill, wait, reset,
  drop), in the warm runner (the process records its trust; pre-warm spawns one of the trust that pressed it, and a
  typed command after a wake pre-warm replaces it) and in the one-shot runner (`conversation.json` keeps the trust; no
  `--resume` across trust levels; an old file without one is never resumed). A wake conversation's serve gets
  `serve --trust wake` (`src/serve-args.ts`; also with `--dry-run`): `gmail_search` = count + date + sender name and
  domain only, footer "For subjects or to read an email, hold F5 or type the request."; `gmail_read` refused (no
  request, no taint, audited). Canvas, Calendar, Notion, weather, briefing, memory and timer rules unchanged. One
  persona sentence. Eval: `trust: 'wake'` on a case; `wake-mail-summary`, `wake-mail-read`: real sonnet 4/4 (2 runs
  each). Full suite **2771 passed, 13 skipped**. Docs: REVIEW-7 R7-2 Fixed + table, SYSTEM-DESIGN §4.2 (trust
  table), §4.12, §5, STEPHEN.md rule row.
- 2026-11-02 22:30 — **Review #7 done and fixed** (docs/REVIEW-7.md, fresh opus): no Critical/High. Fixed with tests:
  R7-1 serve instance lock + pid check (a serve Claude Code restarts refuses every tool; the runner ends the
  conversation), R7-2 wake-word trust per conversation (owner chose "summary only": wake-word Gmail gives count +
  senders, no subjects, no gmail_read; trust change = fresh conversation; a false wake word no longer ends a live F5
  conversation), R7-3 transcript of a cancelled first command, R7-4 Notion page content stays can't-yet, R7-5 short
  codes masked near code words, R7-6 sender shown as `Name <domain>`, R7-7 connect gmail confirms the signed-in
  address, R7-8 write helpers moved to src/connect (boundary test), R7-9 status reads no secret values, R7-10/11/12.
  Full suite **2771 passed, 13 skipped**; real eval 59/60 before the fixes, wake/notion/mail cases pass after.
  **Owner next: docs/MAC-TEST-PLAN.md.** Then items 4 (jobs, ADR-004) and 5 (phone, ADR-005) on the owner's go.
- 2026-11-05: **One implementation per concern (pure refactor, no behaviour change).** New `src/lib/`: `fs.ts`
  (`writePrivateFileAtomicSync`, the one atomic private write, replacing the copies in safety/session-state,
  history/store, voice/claude and connect/accounts-cli; `readPrivateJsonFile` / `writePrivateJsonFileSync` moved from
  session-state; `ensurePrivateDir`, `isExecutable` moved from drivers/util), `process.ts` (`isPidAlive`),
  `keychain.ts` (`defaultExec`, `keychainRead`, `keychainHas`: the Keychain READ path, replacing the lookups in
  voice/tts/keys.ts and accounts/secrets.ts; writes stay in connect/keychain-write.ts), `http-body.ts`
  (`readCappedBody`, accounts/http + desktop/media), `zone.ts` and `secret-fields.ts` (were src/util/zone.ts and
  src/shared/secrets.ts; both folders gone), `errors.ts` (`ConfigError`, base of the six *ConfigError classes).
  `src/drivers/common.ts`: `DriverBase` (state, single-flight connect, status, adopt) and `watchLaunch` for Chrome and
  Zen. voice/models.ts `downloadVerified` / `installStaged` shared with kokoro.ts. Boundary test: src/lib imports only
  src/lib, is in CLAUDE_REACHABLE and holds no Keychain/config writer; accounts/connect don't import voice (except
  connect/voice-key.ts). New `test/security/no-secret-leak.test.ts`. jscpd (8 lines / 70 tokens): 4 clones, 73 lines
  before; 0 after. Full suite **2788 passed, 13 skipped**; typecheck 0 errors. Docs: SYSTEM-DESIGN §6.
- 2026-11-05: **Item 4, jobs while away: ADR-004 subtasks 1 to 3 built** (start flow; finish flow and UI next).
  New `src/jobs/`: `config.ts` (`jobs` section, zod strict: root `~/Stephen Jobs`, sonnet, 45 min with a 3 h hard
  cap, 150 turns, $5, 2 at once, 10 a day, keepDays 30, `repos`), `spec.ts` (pure: the ADR argv flag by flag,
  settings.json, the allow-list env, persona, framed task, slug/id rules, output cleaning), `state.ts` (registry
  `~/.stephen/jobs/<id>.json`, reconcile: a job whose supervisor is gone is marked failed and its claude group
  killed), `runner.ts` (one detached supervisor per job, `stephen jobs _run <meta>`: claude in its own group,
  caffeinate on macOS, stream-json progress, init tool check, wall clock SIGTERM then SIGKILL 10 s, audit),
  `manager.ts` (plan without side effects, start: fresh 0700 folder or git worktree on `stephen/job-<slug>`, 0600
  meta files outside the folder, caps), `intent.ts` + `router.ts` (anchored grammar before Claude after memory and
  timers; the native dialog for EVERY start, F5 included; wake word: stop asks, list is a count), `cli.ts`
  (`stephen jobs list|status|show|stop`). `killGroup` moved to `src/lib/process.ts`. Persona: Claude can't start
  jobs, tells the owner to say "start a job to …". Eval: 3 `job` cases (not yet run against the real model: run
  `node dist/cli.js eval --only job --model sonnet`). Boundary: nothing Claude-reachable loads src/jobs; src/jobs
  loads no memory/history/app/server/timer/voice/account code (only accounts/result.ts). Real probe
  (`STEPHEN_REAL_CLAUDE=1 npx vitest run test/jobs/real-claude.test.ts`, 2.1.318 here): sandbox on refuses to start
  (fail closed), test-only no-sandbox shows exactly the 6 tools and 0 MCP. Full suite **2900 passed, 15 skipped**;
  typecheck 0 errors. Docs: SYSTEM-DESIGN §4.13 (new), §3, §5, §6; ADR-004 Implementation; MAC-TEST-PLAN §8.
- 2026-11-05: **Item 4, jobs while away: ADR-004 subtask 4 built (finish flow and UI).** New `src/jobs/finish.ts`
  (`FinishWatcher`: polls the job states every 10 s, announces each newly final job once through a macOS notification
  "Stephen job done/failed/stopped/timed out" and a spoken summary through the idle-only timer alert queue; announced
  ids in `~/.stephen/jobs/.announced.json` 0600, so a restart doesn't repeat; jobs older than 12 h are marked seen
  silently), `purgeJobs(keepDays)` at listener start, `show` intent ("show my job", "what did the job say") in
  `intent.ts` / `router.ts` (speaks the latest finished summary, prints the folder, no Claude), `src/timers/notify.ts`
  gained `notifyArgv` / `macNotifyTitled`. app.sock (additive to v1): `jobs.list` / `jobs.stop {jobId}` with
  `src/app/jobs-status.ts` (types) and `src/voice/job-rows.ts` (rows from the cleaned state file, summary capped 1500, no pid or session id), fixture
  lines a21 to a23. Swift: Jobs tab in `AppWindow.swift` (`JobsView`, rows, summary, Reveal in Finder, Stop, 5 s
  refresh) and `JobRow` / `jobsList` / `jobsStop` / `refreshJobs` / `stopJob` in `AppClient.swift`; not compiled here
  (Linux), checked by source-text tests only. Bug fixed on the way: `pump` in `src/voice/index.ts` joined `pending`
  after clearing it, so spoken timer alerts were an empty string. Tests: `test/jobs/finish.test.ts`,
  `finish.int.test.ts`, plus updates to `test/app/protocol.test.ts` and `test/helper/app-protocol.test.ts`. Docs:
  HELPER.md (Jobs tab), SYSTEM-DESIGN §4.13 finish flow, ADR-004 subtask 4, MAC-TEST-PLAN §8 additions. Next: subtask
  5 (Mac checklist run, review #8).
- 2026-11-05 — **Item 4 (jobs while away) built** (ADR-004 subtasks 1–4): src/jobs (spec, supervisor per job,
  registry, `stephen jobs list|status|show|stop`, deterministic router + native dialog for every start, finish
  watcher with notification + spoken summary, `show my job`), Jobs tab in the Stephen window (jobs.list / jobs.stop
  over app.sock), timer-alert empty-text bug fixed. Owner answers: inputs through `~/Stephen Jobs/inbox/` (moved into
  the job's input/ on start, listed in the dialog); normal claude.ai login (jobs get no token env vars). Real eval
  `--only job` 3/3. Mac checks: docs/MAC-TEST-PLAN.md §8 (sandbox probes first). Next: item 5 (phone, ADR-005), then
  review #8.
- 2026-11-05: **First run on the owner's Mac (session now runs on the Mac itself).** `npm install && npm run build`
  clean; `install-helper` compiled the Swift (Accounts, Today card, Jobs tab) first try; Swift harness 11/11;
  typecheck 0 errors; `doctor` 4 non-blocking (Input Monitoring off after rebuild, Zen open without Stephen access,
  ElevenLabs key can't read account/voice). Jobs sandbox probe took the macOS branch (Seatbelt on, exactly 6 tools,
  0 MCP). Full suite first run: 34 failures, all test-environment issues on macOS, fixed in tests only (branch
  `mac-test-fixes`): test Chromium = installed Google Chrome on darwin (@sparticuz is Linux-only); temp roots
  realpath'd (/var → /private/var); `__CF_USER_TEXT_ENCODING` ignored in the job env check (macOS adds it to every
  process); select-all test uses `ControlOrMeta+A`; follow-up taint test uses `mail.gmx.net` (google.com is HSTS
  preloaded in real Chrome); the no-Zen flow test is skipped while a real Zen is open. Selftest check 7 (checkbox)
  failed once under full load, passes 16/16 alone. Result: **2942 passed, 5 skipped** on the Mac. Note: no
  `config.json` yet, so accounts (Notion, Calendar, Canvas URL, Gmail client id) are unset for MAC-TEST-PLAN §1.
- 2026-11-05: **Item 5 (phone), probe + step 1.** Probed Remote Control on the Mac (ADR-005 Probe results): the
  project `agent` setting locks the session to exact tools (437 → 3); `.mcp.json` approved once at folder trust;
  `start_job` with `requiresUserInteraction` prompts on the phone every time, no "always allow". Owner decisions:
  replies at `wake` trust (contents, email who/when), on demand only (`stephen phone on`), phone tap starts a job.
  Built step 1: `src/phone/setup.ts` (folder files, 0700/0600; `checkPhoneLockdown` reads the init line of a real
  `claude -p` in the folder and stops it before any model call), `src/phone/cli.ts` (`stephen phone setup|check`).
  Real check on the Mac: locked (0 extra tools), bridge tools missing until step 3; with `agent` removed it reports
  435 extra and fails. Moved the stream-json parser to `src/lib/claude-stream.ts` and the repo root to
  `src/lib/repo.ts` (one copy each; src/jobs keeps its names) so src/phone loads no job code (boundary test).
  Tests: `test/phone/setup.test.ts`. Next: step 2 (phone.sock + listener side).
- 2026-11-05: **Item 5 step 2: phone.sock + listener side** (ADR-005 Bridge rules). New `src/phone/server.ts`:
  `<home>/run/phone.sock` (0600) with only `ask`, `job_status`, `start_job` (the last refused until step 4); refused
  unless the `<home>/phone/.on` marker exists (`stephen phone on|off` in step 5); 6 asks a minute; every request
  audited (type and size, never the text) and shown as a Mac notification. The listener starts it next to app.sock
  and runs phone asks through the same queue as source `phone`. New trust `phone`: serve gets `--trust wake`
  (email who/when) and `--confirm deny` (nobody at the Mac). From the phone: memory changes refused, memory and
  timer lists are counts, timer cancel / job start / job stop refused without a dialog. `'phone'` added to the
  memory/history sources and the Swift source label ("Phone"). Refactor: the app socket's lifecycle (stale check,
  0700/0600, remove-if-ours) moved to `src/lib/private-socket.ts`, shared by app.sock and phone.sock.
  Tests: `test/phone/server.test.ts`, `test/phone/routers.test.ts`. Next: step 3 (bridge MCP).
- 2026-11-05: **Item 5 step 3: the bridge MCP** (`src/phone/bridge.ts`, `stephen phone-bridge`). Three tools (`ask`,
  `job_status`, `start_job` with `_meta["anthropic/requiresUserInteraction"] = true`); one JSON line per call to
  phone.sock, 5 min timeout, "listener not running" as a tool error. Claude-reachable: added to CLAUDE_REACHABLE in
  `test/helpers/import-scan.ts` (loads no memory/app/history/timer/job/connect code). `phoneSocketPath` moved to
  `src/phone/setup.ts`. Real `stephen phone check` on the Mac: locked, all 3 phone tools present.
  Tests: `test/phone/bridge.test.ts`. Next: step 4 (jobs from the phone), step 5 (`stephen phone on|off|status`).
- 2026-11-06: **Item 5 step 4: jobs from the phone.** `JobRouter.startFromPhone(task, web)`: the phone's Allow tap
  (requiresUserInteraction, exact task shown) is the confirmation, so no Mac dialog (ADR-004 rule 2, ADR-005
  decision 3). Same `plan()` / `start()` as a Mac job (folder, sandbox, budgets, jobs.maxRunning and dailyStarts), plus
  web only when asked on the phone (not guessed from the words) and `PHONE_DAILY_JOBS` = 3 a day from the phone,
  counted from the registry (`source: 'phone'`). The listener wires it as phone.sock's `start_job`. Tests in
  `test/phone/routers.test.ts` and `server.test.ts`. Next: step 5 (`stephen phone on|off|status`, Remote Control).
- 2026-11-06: **Item 5 step 5: `stephen phone on | off | status`.** `on` rewrites the folder, runs the lock-down
  check (refuses unless locked AND complete), writes the `.on` marker (0600, `{pid, rc}`) and runs
  `claude remote-control --spawn session --no-chrome --permission-mode default --name Stephen` in the phone folder in
  the foreground (Ctrl-C ends it; the marker is removed when it exits). `off` removes the marker first (phone.sock
  refuses at once), then SIGTERMs the recorded pid only if its command line is `claude … remote-control`. `status`:
  on/off, Remote Control alive, listener answering phone.sock. Mac checks: MAC-TEST-PLAN §9. Next: the owner's phone
  run of §9, then review #8 (items 4 and 5).
- 2026-11-07: **Review #8 done and fixed** (`docs/REVIEW-8.md`, fresh opus/high reviewer over items 4, 5 and B1): no
  Critical/High; 2 Medium, 4 Low, 2 Info, all fixed with tests (Fix status table there). Biggest: the phone session now
  runs with its own Claude Code config (`stephen phone login` once), so `/config` typed on the phone can't change the
  owner's `~/.claude/settings.json` (proved on the Mac), and only the bridge MCP server starts there. Also: phone jobs
  take no inbox files / no repos / 500-char task; job starts serialized; honest audit outcomes; liveness by command
  line, not bare pid/marker; job stragglers killed at the end; no memory block for phone runs; timers read-only from
  the phone. Shared helpers in `src/lib/process.ts`: `commandOf`, `pidsWithCwdIn`, `processStart`.
  Owner to do: `stephen phone login`, then MAC-TEST-PLAN §9 review-8 lines. Next: the "play" router (plan §13).
- 2026-11-07: **Items 1 to 4 after item 5** (owner's order; one Mac test pass at the end, MAC-TEST-PLAN §10).
  1. Play from the phone (plan §13): `freshForPlay` in `src/voice/assistant.ts` ends a running follow-up before a
     "play / put on <something new>", so it runs in a fresh, untainted conversation and the unchanged gate lets YouTube
     open. 2. Accounts tab: a "Phone link" row (`phoneAccountRow`, sign-in cached 5 min; no Swift change);
     `phoneAuth` in `src/phone/setup.ts` is the one `claude auth status` reader. 3. Home folder (plan §12): `.env` is
     read from the home folder first, the repo's second (with a note); `stephen accounts set <name>` stores a secret in
     the Keychain (hidden prompt); `doctor` warns about a repo `.env` / a repo `config.json` that isn't the home link.
     The `~/.browser-hub` → `~/.stephen` move stays manual. 4. `canvas_inbox` (`GET /api/v1/conversations`): who, when,
     course, subject, excerpt (codes masked); wake word and phone get who and when only; real Canvas shape checked;
     real eval `read-canvas` 4/4. Gmail "In production" is a console step (§10). Full suite 3018 passed.
