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
