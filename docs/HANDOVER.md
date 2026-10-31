# Stephen — handover & progress log

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
