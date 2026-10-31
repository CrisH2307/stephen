# "Hey Stephen" — the voice listener

`stephen listen` lets you say **"Hey Stephen, open YouTube"**, or **hold Fn+Option** while you say "open YouTube"
(push-to-talk, with [Stephen Helper](#stephen-helper-push-to-talk-esc-and-the-menu-bar)). The wake word and
speech-to-text run on your Mac.
Only the transcript ("open youtube") goes to Claude Code, which runs headless with **only Stephen's tools**. The
reply is spoken with ElevenLabs, the local Kokoro voice, or macOS `say` (see [Voice output](#voice-output)).

```
mic ─▶ PvRecorder 16 kHz ─▶ sherpa-onnx keyword spotter ("HEY STEPHEN" / "STEPHEN STOP")
        ├─ after the wake word: Silero VAD finds the end of the command (0.8 s of silence, max 12 s)
        └─ or push-to-talk (helper: Fn+Option held): the audio between press and release, edges VAD-trimmed
           └─ Whisper tiny.en (sherpa-onnx, offline) ─▶ "open youtube"
              └─ claude -p "open youtube" --tools "" --strict-mcp-config (only `stephen serve`) … ─▶ reply
                 └─ say "Opened YouTube in Zen."  (Tink on wake, Pop when done)
```

## Setup

1. Build Stephen (`npm install && npm run build`) and make sure `claude` works in your terminal. You need to be
   logged in to Claude Code.
2. Download the speech models (about 140 MB, one time):
   ```
   stephen voice-setup          # or: stephen listen --setup
   ```
   This saves them in `<stephen home>/models` (`~/.stephen/models`). Each archive is a pinned GitHub release of
   k2-fsa/sherpa-onnx. Its sha256 is checked before it is unpacked, and files the listener doesn't need are
   deleted. Models are never downloaded twice. If they are missing, the first `stephen listen` downloads them.
3. Grant the microphone. macOS asks the first time `stephen listen` opens the mic. The permission goes to
   your **terminal app** (Terminal, iTerm, Ghostty…), not to Stephen. If you clicked "Don't Allow", turn it on
   under **System Settings → Privacy & Security → Microphone**, then restart the terminal. When the mic is
   blocked, macOS sends silence instead of an error. Stephen notices this after about 3 s and tells you.

## Usage

```
stephen listen                      # listen until Ctrl-C
stephen listen --once               # handle one command, then exit
stephen listen --text "open youtube"            # skip audio; send this to Claude and speak the reply
stephen listen --text "open youtube" --dry-run  # print the exact claude command line; nothing runs
stephen listen --wav command.wav --dry-run      # test the audio pipeline on a recording
stephen listen --list-devices       # microphones and their numbers
stephen listen --device 2           # or --device "USB" (part of the name)
stephen listen --no-speak --no-chimes
stephen listen --ptt-only           # push-to-talk only, no wake word (needs Stephen Helper)
stephen listen --no-helper          # don't use Stephen Helper (wake word with the 20 s cooldown)
```

What you'll see:

```
Listening for "hey stephen" on MacBook Pro Microphone… (Ctrl-C to quit)
Wake word heard — listening…
Transcribing…
Heard: "open youtube"
Working…
Stephen: Opened YouTube in Zen.
Done (3.2 s)
Listening for "hey stephen" again in 20 s, so a page or video I just opened can't command me (press Enter to re-arm now)…
Listening for "hey stephen"…
```

- **Say it in one breath or with a pause.** "Hey Stephen open YouTube" works, and so does "Hey Stephen …
  open YouTube". Audio from just before the wake word is kept, and the wake phrase is removed from the transcript.
- **Every command is a fresh conversation (no follow-ups in phase 1).** "Hey Stephen, now search for lo-fi" does
  not know about the YouTube you just opened; say the whole thing ("search YouTube for lo-fi"). Why: each command
  is a new `claude -p`, and each one starts a new Stephen server. The safety gate's memory lives in that server:
  which private pages were read (that taints later sends to other sites), which destinations you approved, and
  the rate limit. Resuming the Claude session (`--resume`) would keep Claude's memory of the earlier command,
  including private page text or instructions injected by a page, while the gate started from nothing. Data read
  in one command could then be sent out in the next without a prompt. So Stephen never passes `--resume`.
  Follow-ups return in phase 3, when one long-lived Agent SDK session talks to one long-lived Stephen server.
  `voice.followUpWindowSec` is still accepted in config.json so old configs load, but it is ignored, and
  `stephen listen` prints a note saying so.
- **Cooldown after each command (without the helper).** For 20 s after a command (`voice.cooldownSec`), "Hey
  Stephen" is ignored and `Ignored "hey stephen" — the wake word is paused…` is printed. **Press Enter** in the
  listener's terminal to talk sooner. See [Tuning false wakes](#tuning-false-wakes) (guard 4) for why. With Stephen
  Helper running there is no fixed cooldown (see below).
- **Cancel.** Say **"Stephen stop"**, press **Esc** (with the helper) or press Ctrl-C. This kills the whole `claude` process group, including the
  `stephen serve` it started, or cuts the spoken reply short. Press Ctrl-C twice to quit. While Claude is working,
  "Hey Stephen" also cancels the command, but it never starts a new one. Say it again once Stephen is done.

## Stephen Helper: push-to-talk, Esc and the menu bar

`stephen install-helper` builds **Stephen Helper.app**, a small menu-bar agent (docs/HELPER.md). It holds the
Input Monitoring permission for the keys and watches whether the Mac is playing sound. It never records audio: the
microphone stays with `stephen listen`, exactly as before. `stephen listen` connects to it at start-up; if it isn't
there, the listener prints one line, `Install the helper for push-to-talk and no wake-word cooldown: stephen
install-helper`, and works as before.

- **Push-to-talk: hold Fn+Option.** Pressing plays the Tink, shows "recording" in the menu bar, and keeps the mic
  audio from that moment. Releasing sends it to speech-to-text (no wake word needed; silence at the start and end
  is trimmed by the VAD), then to Claude as usual. Presses shorter than 250 ms are ignored (`Ignored a … ms tap`).
  Recording stops at 30 s even if you keep holding. A press while Claude is working or Stephen is talking
  **cancels that first**, then records. "Hey Stephen" said while holding the keys is just removed from the command.
- **Wake-word gating.** With the helper connected, "Hey Stephen" has no fixed cooldown. It is ignored only while
  the Mac is **playing sound** (`Ignored "hey stephen" — sound is playing…`), which is when a video or page could be
  saying it; in silence it works straight away. "Stephen stop" works at any time. The busy rules are unchanged:
  ignored while Stephen speaks, and it cancels a running command. If the helper disconnects, the listener falls back
  to the 20 s cooldown until it is back.
- **Push-to-talk only.** `"wakeWord": false` in the `voice` config (or `stephen listen --ptt-only`) turns "Hey
  Stephen" off completely. This needs the helper; without it `stephen listen` exits with a message. The stop
  phrase still works.
- **Esc** cancels the running command or cuts the spoken reply short (the same as "Stephen stop"). When Stephen is
  idle it does nothing. In phase 1.5 the key still reaches the app in front.
- **Quiet while playing.** When a command finishes, the listener asks the helper whether the Mac is playing sound
  (a fresh check, waiting at most ~300 ms). If it is (the music or video Claude just started), the reply is only
  printed in the terminal and the done chime plays. Otherwise the reply is spoken as usual. Without the helper,
  replies are always spoken.
- **Speak first, then act.** The MCP server is started with `serve --voice`, which adds the `announce` tool. The
  persona tells Claude to announce what it is about to play ("Playing Say So by Doja Cat", ≤ 12 words) before
  starting music, a video or a podcast, and to keep the final reply very short after that.
- **Menu-bar state.** The listener sends `listening` (idle and armed), `recording` (push-to-talk held, or after the
  wake word), `working` (transcribing / Claude running), `speaking`, and `idle` when it quits.

Notes: the helper sees *any* sound on the default output, including Stephen's own chimes and voice. The wake word
is ignored anyway while Stephen speaks, and the chimes are short. Sound that plays through a device other than the
default output is not seen.

## What Claude is allowed to do

Each command runs Claude Code headless. The command is built as an argv array, never through a shell:

```
claude -p "<transcript>" --output-format json
  --mcp-config <home>/voice/mcp-config.json   # {"mcpServers":{"stephen":{"command":"<node>","args":["<…>/dist/cli.js","serve","--confirm","dialog","--voice"]}}}
  --strict-mcp-config                         # ignore every other MCP server you have configured
  --tools ""                                  # NO built-in tools at all (an empty argv element, not a quoted string)
  --permission-mode dontAsk                   # anything not pre-approved is denied, never prompted
  --setting-sources ""                        # ignore your user, project and local settings.json files
  --allowedTools mcp__stephen                 # Stephen's tools run without a prompt (announce included)
  --disallowedTools Bash,BashOutput,KillShell,Edit,MultiEdit,Write,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent,TodoWrite,Skill,SlashCommand
  --append-system-prompt "<Stephen persona: act only via Stephen's tools, do exactly what was asked, prefer open_url,
                          never work around a refusal, reply in one short spoken sentence, announce before playing sound>"
  --max-turns 15  [--model <voice.claudeModel>]
```

There is never a `--resume`: every command is a fresh session (see "Every command is a fresh conversation" above).

**The lock-down is an allow-list.** `--tools ""` gives the session zero built-in tools, so the only tools Claude
has are Stephen's (`mcp__stephen__*`). A deny-list alone is not enough: with only `--disallowedTools`, Claude Code
2.1.314 still offered 13 built-ins, including `SendMessage` and `ListAgents`, which reach other Claude sessions on
the Mac (and those may have Bash). The deny-list stays as a second layer.

**Your own settings don't apply.** Without `--permission-mode` and `--setting-sources`, the `defaultMode` and
`allow` rules in `~/.claude/settings.json` (or a project's `.claude/settings.json`) applied to voice runs too, for
example `acceptEdits` or `bypassPermissions`. `--setting-sources ""` loads none of the user, project or local
settings files, and `--permission-mode dontAsk` denies anything that isn't pre-approved instead of prompting.
Managed (enterprise policy) settings still apply; they can only make things stricter. Two side effects:

- Your Claude Code login still works: OAuth/keychain credentials and `ANTHROPIC_API_KEY` in your shell are not
  settings files.
- Anything you set *in* settings.json is ignored for voice runs, including an `env` block, `apiKeyHelper`, a
  default `model`, and hooks. If you authenticate through settings.json, export `ANTHROPIC_API_KEY` in the shell
  that runs `stephen listen` instead, and use `voice.claudeModel` for the model.

Claude also runs in an empty private folder (`<home>/voice/workdir`), so no project `CLAUDE.md` applies.

**Verifying the lock-down** (done for Claude Code 2.1.314, without using any model quota). Run the exact argv
from `stephen listen --text "x" --dry-run` with `--output-format stream-json --verbose`, a throw-away `HOME` and
`ANTHROPIC_BASE_URL` pointing at a dead or fake local server, and read the `init` message:

| Check | Result |
|---|---|
| Tools offered to the model | only `mcp__stephen__*` (the MCP server shows `connected`) |
| `permissionMode`, with `defaultMode: "bypassPermissions"` and `allow: ["Bash","SendMessage"]` in the user's settings.json | `dontAsk` |
| A `deny` rule for a Stephen tool in the user's and the project's settings.json | ignored (the tool is still offered). Without `--setting-sources ""` the same rule removes it, which shows the flag is what stops settings from loading |
| A fake local Messages API that asks for `mcp__stephen__ping` | the tool runs (allowed by `--allowedTools`, not blocked by `dontAsk`) |
| The same fake API asking for `Bash` / `SendMessage` | `No such tool available` |

**The MCP config file.** `<home>/voice/mcp-config.json` is rewritten at every start: the folder is set to 0700, the
JSON goes to a new temp file in that folder (created with `O_EXCL|O_NOFOLLOW`, mode 0600) and is renamed into
place. A symlink at the destination is replaced, never written through. A `voice` folder that is itself a symlink
is refused.

**Confirmations.** A headless `claude -p` can't show MCP elicitation prompts. Stephen's safety gate asks for
confirmation in a **macOS dialog** instead. Click Allow or Deny there. A spoken "yes" is **never** treated as a
confirmation. The listener starts Stephen's server with `serve --confirm dialog`, so this holds whatever
`safety.confirm` says in config.json (the flag only accepts `dialog` or `deny`; it can't skip confirmation).

## Privacy

- **Audio never leaves the Mac.** Wake-word spotting, end-of-speech detection and speech-to-text all run locally
  (sherpa-onnx / ONNX Runtime on the CPU). No audio is written to disk.
- **Only the transcript of a command** goes to Claude (Anthropic), the same as typing it into Claude Code. Speech
  without the wake phrase is never transcribed or sent anywhere.
- macOS shows its orange microphone dot while `stephen listen` runs.

## Configuration (`"voice"` in config.json)

| Key | Default | |
|---|---|---|
| `wakePhrase` | `"hey stephen"` | 2–4 plain English words. Tokenized at start-up from the model's own `bpe.model`; "Stephen"/"Steven" spellings are both added because they sound the same |
| `stopPhrase` | `"stephen stop"` | Cancels the running command or the reply |
| `device` | system input | Index or part of the name (`--list-devices`) |
| `asrModel` | `"whisper-tiny.en"` | `whisper-base.en` (better in noise, 210 MB), `moonshine-base` (faster, 250 MB), `moonshine-tiny` |
| `keywordsThreshold` | `0.3` | Higher = fewer false wakes, more misses (see below) |
| `keywordsScore` | `1.0` | Boost for the keywords. Raising it makes false wakes much more likely |
| `verifyWake` | `true` | Drop the command if the transcript doesn't contain the wake phrase |
| `claudePath` | `"claude"` | Path to the Claude Code CLI |
| `claudeModel` | Claude Code's default | e.g. `"sonnet"`, `"haiku"` (faster) |
| `maxTurns` | `15` | Cap on agent turns per command |
| `cooldownSec` | `20` | Without the helper: after each command, ignore the wake word for this long (press Enter to re-arm early). `0` = off. With the helper the wake word is gated on playing sound instead |
| `wakeWord` | `true` | `false` = push-to-talk only (needs Stephen Helper); same as `--ptt-only` |
| `followUpWindowSec` | — | **Ignored in phase 1** (every command is a fresh session). Still accepted so old configs load; a note is printed |
| `speak` / `voice` / `rate` | `true` / system / system | `say` voice name (`say -v ?`) and words per minute |
| `chimes` | `true` | Tink on wake, Pop when done |
| `silenceSec` / `maxCommandSec` / `noSpeechTimeoutSec` | `0.8` / `12` / `5` | Endpointing |

## Tuning false wakes

"Stephen" is a common name, so some false wakes will happen. Stephen has four guards:

1. **The keyword spotter threshold** (`keywordsThreshold`). On the synthetic test set, every value from 0.1 to
   0.45 caught all 6 wake phrases and none of the 12 negatives. At 0.55 it missed half. Raising `keywordsScore`
   to 2 let "Hey Steve, open YouTube" through.
2. **The transcript check** (`verifyWake`). After a wake, the command audio is transcribed with the wake phrase
   still in it. If the recognizer didn't hear "hey stephen" (or "stephen"/"steven"/"stefan"…), the command is
   dropped and `Ignored — …` is printed. With noise added, the spotter woke once on "Hey, step in and open
   YouTube". Whisper heard "Hey Stepping…", so nothing was sent to Claude.
3. **Busy rules.** While Claude is working, "Hey Stephen" cancels the command (it never starts a new one). While
   Stephen is speaking its reply, the wake word is ignored, so Stephen's own voice can't trigger it.
4. **The cooldown** (`cooldownSec`, default 20 s; only without Stephen Helper — with it, the wake word is ignored
   whenever the Mac is playing sound instead, and push-to-talk needs no wake word at all). The busy rules end when the reply ends, but a video or page
   Stephen just opened keeps talking. If it says "Hey Stephen, open …", nothing in the audio tells it apart from
   you. So after every command that reached Claude, the wake word is ignored for 20 s. Press **Enter** in the
   listener's terminal to re-arm sooner (when the terminal isn't interactive, just wait). It applies after every
   command, not only after ones that opened something, because Claude Code's JSON result doesn't say which tools
   ran. A cancelled command counts too, since it may have opened something before it was stopped.

   What this does **not** do: a video that says "Hey Stephen…" more than 20 s later, or after you pressed Enter,
   still becomes a command. It then runs as its own fresh session, so it can't see anything from your earlier
   commands, and the tool rules still apply (hard-blocked apps stay blocked, risky steps need a click in the macOS
   dialog). An `https` link it speaks can still open. A stricter wake threshold during the cooldown was considered
   and rejected: a video's clear "Hey Stephen" scores as well as yours. Real fixes are echo cancellation (macOS
   voice-processing I/O) or speaker verification, in a later phase. Pause media before you walk away from a
   listening Stephen.

If false wakes happen too often (TV, podcasts): raise `keywordsThreshold` in steps of 0.05, toward 0.4. If Stephen
misses you: lower it toward 0.2, move closer to the mic, or pick a quieter `device`. Use `--wav` with a recording
of your room to test settings without talking.

## Measured here (Linux CI box, 2 vCPU Xeon; a Mac will be faster)

The test set is synthetic speech from two Piper voices: US female, and UK male at 0.9× speed
(`test/voice/fixtures`, regenerated by `generate.mjs`). It has 6 wake commands (one breath, with a pause,
"What's on my screen?"), 10 negatives ("Hey Steve…", "Stephanie said…", "Even Stephen agreed…", "Hey, step
in…", unrelated speech), 2 lone "Stephen, stop" and 2 push-to-talk "Open YouTube." (no wake phrase).

| | clean | white noise, SNR 10 dB |
|---|---|---|
| Wake detected | 6/6 | 6/6 |
| False wakes (14 non-wake clips) | 0 | 1 (rejected by `verifyWake`) |
| Commands sent to Claude correctly | 6/6 | 6/6 |
| False commands | 0 | 0 |
| "Stephen stop" detected | 2/2 | — |

Speech-to-text on the audio after the wake word (6 commands, 16 words):

| Model | Download | Word accuracy | ASR time per command |
|---|---|---|---|
| **whisper-tiny.en** (default) | 118 MB | 16/16 | 0.3–0.7 s |
| whisper-base.en | 209 MB | 16/16 | 0.5–0.8 s |
| moonshine-base | 251 MB | 15/16 ("you tube") | 0.2–0.3 s |
| moonshine-tiny | 108 MB | 14/16 ("you tube", "you jube") | 0.1–0.2 s |

At SNR 5 dB, every model got only about half the commands right. Use a closer or better microphone rather than
a bigger model. After you stop talking, Stephen waits 0.8 s of silence plus about 0.4 s of ASR before Claude
starts. Most of the rest of "Done (x s)" is Claude Code's own start-up, MCP connection and model time.

## Voice output

Stephen's spoken lines (replies, and `announce` lines before music or video starts) go through one of three
voices. It tries them in this order:

| Provider | Where it runs | Setup | Sound |
|---|---|---|---|
| `elevenlabs` | ElevenLabs cloud (`POST /v1/text-to-speech/{voice}`, model `eleven_flash_v2_5`, mp3 played with `afplay`) | `stephen voice-key set` | the owner's chosen voice (`YEBbZ0itqHW31uoXSBns`, "Noah Yang") |
| `kokoro` | on the Mac (sherpa-onnx, Kokoro int8 English v0.19, WAV played with `afplay`) | `stephen voice-setup --tts kokoro` (one-time ~103 MB download, ~153 MB on disk, Apache-2.0, sha256-pinned) | neural voice, 11 speakers |
| `say` | on the Mac (built in) | nothing | the macOS system voice |

**Which one is used.** `voice.tts` defaults to `"auto"`: ElevenLabs if a key is found, otherwise Kokoro if its
model is installed, otherwise `say`. If you set `"tts": "elevenlabs"` or `"kokoro"` and it is not available (no
key, model not installed), Stephen uses the next one and prints why once. `"tts": "say"` uses only `say`.

**Fallback while speaking.** If ElevenLabs fails, Stephen says the **same text** with the next voice and prints
the reason once per session, for example `Voice output: ElevenLabs is out of credits (HTTP 401) — using the
local Kokoro voice.` Reasons: bad key (401), out of credits (`quota_exceeded`) or a paid plan needed (402), voice
not found or not on your plan (404), rate limited (429), network error, no answer within `timeoutSec` (8 s). A
bad key, no credits or a missing voice turns ElevenLabs off for the rest of that session. Network errors and
timeouts are retried on the next reply. Kokoro failing (or `afplay` missing) falls back to `say` the same way.

### Setup

```
stephen voice-key set          # paste the key at the hidden prompt (or: pbpaste | stephen voice-key set)
stephen voice-key status       # where it was found, last 4 characters only
stephen doctor --network       # checks the key, your remaining credits and the voice
stephen voice-setup --tts kokoro   # optional: the local fallback voice
stephen voice-key delete
```

**If your API key was ever pasted into a chat, an issue, a file or a terminal history, rotate it** (ElevenLabs →
Developers → API keys: create a new key, delete the old one), then run `stephen voice-key set` again. You can
restrict a key to text-to-speech only. `doctor --network` also needs the "user read" and "voices read"
permissions, and it says so if they are missing; speech still works.

**Where the key is looked up**, in order:

1. macOS Keychain, generic password, service `stephen-elevenlabs`, account = your user name
   (`security find-generic-password -s stephen-elevenlabs -a <you> -w`). This is what `voice-key set` writes.
2. `$ELEVENLABS_API_KEY`.
3. `voice.elevenlabs.apiKeyFile`: a file holding only the key. It is refused unless it is yours and mode `0600`
   (or stricter): `chmod 600 <file>`.

Stephen never prints, logs or audits the key. Messages show `sk_…` plus the last 4 characters.

**How `voice-key set` stores it.** `security add-generic-password … -w <key>` would put the key on the command
line, where any process on the Mac can read it with `ps` while `security` runs. `-w` as the *last* argument
makes `security` prompt for the key, but that prompt reads from the terminal, so a piped key wouldn't work.
Stephen instead starts `security -i` (interactive mode) and writes the `add-generic-password -U …` command to its
**stdin**. The key only travels through a pipe between the two processes. Then Stephen reads the item back to
confirm it was stored, since `security -i` exits 0 even when a command inside it fails. The trade-off: the key
is in Stephen's memory for a moment (it has to be, to send it to ElevenLabs anyway). The Keychain item is
readable by `security` without a prompt for your user, like any login-keychain password created by a command-line
tool.

### Configuration (`"voice"` in config.json)

```json
"voice": {
  "tts": "auto",
  "elevenlabs": { "voiceId": "YEBbZ0itqHW31uoXSBns", "modelId": "eleven_flash_v2_5", "timeoutSec": 8, "apiKeyFile": null },
  "kokoro": { "speaker": "am_michael", "speed": 1.0 },
  "voice": null, "rate": null
}
```

| Key | Default | |
|---|---|---|
| `tts` | `"auto"` | `auto`, `elevenlabs`, `kokoro` or `say` |
| `elevenlabs.voiceId` | `"YEBbZ0itqHW31uoXSBns"` | any voice in your ElevenLabs "My Voices" |
| `elevenlabs.modelId` | `"eleven_flash_v2_5"` | Flash v2.5 has the lowest latency (~75–100 ms) and costs half as much per character as `eleven_multilingual_v2`. `eleven_turbo_v2_5` is deprecated |
| `elevenlabs.timeoutSec` | `8` | then the next voice is used |
| `elevenlabs.apiKeyFile` | — | see above |
| `kokoro.speaker` | `"am_michael"` | `af`, `af_bella`, `af_nicole`, `af_sarah`, `af_sky`, `am_adam`, `am_michael` (US), `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis` (UK), or 0–10 |
| `kokoro.speed` | `1.0` | 0.5–2 |
| `voice` / `rate` | system | `say` voice and words per minute |

### Privacy

- `elevenlabs`: **only the text being spoken** (a reply of at most ~300 characters, or an `announce` line) goes
  to ElevenLabs, with your API key. No audio from your microphone and no transcript of what you said. ElevenLabs
  keeps generated audio in your account's history (only enterprise plans can turn that off).
- `kokoro` and `say`: nothing leaves the Mac.
- The audio file is written to a new private temp folder (0700, file 0600), played, and deleted.

### Free plan limits

The ElevenLabs Free plan includes **10k credits per month** ([pricing](https://elevenlabs.io/pricing)). Flash
v2.5 uses half the credits per character of the multilingual model
([models](https://elevenlabs.io/docs/overview/models)), so that is roughly 20,000 characters, or a few hundred
short replies a month. The free plan has no commercial license, and voices from the Voice Library may need a
paid plan over the API (you'd get a 402 or 404; `stephen doctor --network` shows it). When the credits run out,
Stephen switches to Kokoro or `say` until they reset.

### `announce` (speak before playing sound)

The listener starts `stephen serve --voice`, and only then does the server register the `announce` tool:
"Say a short line out loud BEFORE doing something that will play sound (music, a video), e.g. 'Playing Say So by
Doja Cat'. Don't use it for anything else." It takes `{text}` (at most 120 characters; control characters and
markdown are removed). It returns only once the line has been spoken, or after 8 s at most (then it stops
talking), so the voice never talks over the music. Each server allows 3 a minute, and every call is in the audit
log (`tool: "announce"`, the text, the voice used). A normal Claude Code session (`stephen serve` without
`--voice`) never has this tool.

### Measured here (Linux, 2 shared vCPU)

Kokoro int8: about 1.7 s to load the model, then 6–11 s to synthesize a 10-word sentence (3.2–3.6 s of audio,
real-time factor 1.7–3.5 depending on load). That is too slow for this box. Apple Silicon should be several
times faster; check on the Mac before relying on it. ElevenLabs, `afplay`, `say` and the Keychain can't be tested
here; they are covered by fakes.

Push-to-talk clips (`ptt-open.*.wav`, "Open YouTube." with no wake phrase) go through the same VAD and Whisper.
whisper-tiny tends to loop on such short clips ("open youtube open youtube …"); the transcript clean-up keeps one
copy of a repeated phrase, so both voices give "open youtube".

## Limits

- **macOS only.** It needs `say` and `afplay`, and Stephen's desktop tools are Mac-only. The listener runs on Linux
  for tests: audio, wake word and ASR work, and replies are printed instead of spoken.
- Runs from a terminal. The terminal app holds the microphone permission. Stephen Helper shows the state in the
  menu bar, but the listener itself still runs in the terminal.
- Every command starts a new `claude -p` process, which adds a few seconds of start-up, and a new conversation
  (no follow-ups). A long-lived Agent SDK session with one long-lived Stephen server is phase 3.
- English only. The wake phrase must be plain English words.
- The keyword spotter has no published false-alarm rate, and the test numbers come from synthetic speech.
  Expect to tune `keywordsThreshold` for your room.
- Spoken replies are capped at about 300 characters, with markdown stripped.

## Files

`src/voice/`: `index.ts` (CLI), `listener.ts` (wake → endpoint → ASR loop, push-to-talk, Esc, busy rules, gating
and cooldown), `helper-link.ts` (the listener's view of Stephen Helper: `HelperLink`, `HelperBridge`), `engine.ts`
(sherpa-onnx adapters), `keywords.ts` (sentencepiece tokenizer and keywords file), `models.ts` (pinned downloads),
`claude.ts` (argv and lock-down flags, MCP config, process-group cancel), `assistant.ts`, `speech.ts`,
`transcript.ts`, `audio.ts`, `wav.ts`, `config.ts`, `args.ts`. Tests are in `test/voice/`. The fake `claude` is
`test/voice/fake-claude.mjs`, so tests never use your Claude quota; `test/voice/fakes.ts` has a fake helper.
