# "Hey Stephen" — the voice listener

`stephen listen` lets you say **"Hey Stephen, open YouTube"**. The wake word and speech-to-text run on your Mac.
Only the transcript ("open youtube") goes to Claude Code, which runs headless with **only Stephen's tools**. The
reply is spoken with macOS `say`.

```
mic ─▶ PvRecorder 16 kHz ─▶ sherpa-onnx keyword spotter ("HEY STEPHEN" / "STEPHEN STOP")
        └─ after the wake word: Silero VAD finds the end of the command (0.8 s of silence, max 12 s)
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
- **Cooldown after each command.** For 20 s after a command (`voice.cooldownSec`), "Hey Stephen" is ignored and
  `Ignored "hey stephen" — the wake word is paused…` is printed. **Press Enter** in the listener's terminal to
  talk sooner. See [Tuning false wakes](#tuning-false-wakes) (guard 4) for why.
- **Cancel.** Say **"Stephen stop"** or press Ctrl-C. This kills the whole `claude` process group, including the
  `stephen serve` it started, or cuts the spoken reply short. Press Ctrl-C twice to quit. While Claude is working,
  "Hey Stephen" also cancels the command, but it never starts a new one. Say it again once Stephen is done.

## What Claude is allowed to do

Each command runs Claude Code headless. The command is built as an argv array, never through a shell:

```
claude -p "<transcript>" --output-format json
  --mcp-config <home>/voice/mcp-config.json   # {"mcpServers":{"stephen":{"command":"<node>","args":["<…>/dist/cli.js","serve","--confirm","dialog"]}}}
  --strict-mcp-config                         # ignore every other MCP server you have configured
  --tools ""                                  # NO built-in tools at all (an empty argv element, not a quoted string)
  --permission-mode dontAsk                   # anything not pre-approved is denied, never prompted
  --setting-sources ""                        # ignore your user, project and local settings.json files
  --allowedTools mcp__stephen                 # Stephen's tools run without a prompt
  --disallowedTools Bash,BashOutput,KillShell,Edit,MultiEdit,Write,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent,TodoWrite,Skill,SlashCommand
  --append-system-prompt "<Stephen persona: act only via Stephen's tools, do exactly what was asked, prefer open_url,
                          never work around a refusal, reply in one short spoken sentence>"
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
| `cooldownSec` | `20` | After each command, ignore the wake word for this long (press Enter to re-arm early). `0` = off |
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
4. **The cooldown** (`cooldownSec`, default 20 s). The busy rules end when the reply ends, but a video or page
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
in…", unrelated speech) and 2 lone "Stephen, stop".

| | clean | white noise, SNR 10 dB |
|---|---|---|
| Wake detected | 6/6 | 6/6 |
| False wakes (12 non-wake clips) | 0 | 1 (rejected by `verifyWake`) |
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

## Limits

- **macOS only.** It needs `say` and `afplay`, and Stephen's desktop tools are Mac-only. The listener runs on Linux
  for tests: audio, wake word and ASR work, and replies are printed instead of spoken.
- Runs from a terminal. The terminal app holds the microphone permission. A menu-bar app is phase 2.
- Every command starts a new `claude -p` process, which adds a few seconds of start-up, and a new conversation
  (no follow-ups). A long-lived Agent SDK session with one long-lived Stephen server is phase 3.
- English only. The wake phrase must be plain English words.
- The keyword spotter has no published false-alarm rate, and the test numbers come from synthetic speech.
  Expect to tune `keywordsThreshold` for your room.
- Spoken replies are capped at about 300 characters, with markdown stripped.

## Files

`src/voice/`: `index.ts` (CLI), `listener.ts` (wake → endpoint → ASR loop, busy rules and cooldown), `engine.ts`
(sherpa-onnx adapters), `keywords.ts` (sentencepiece tokenizer and keywords file), `models.ts` (pinned downloads),
`claude.ts` (argv and lock-down flags, MCP config, process-group cancel), `assistant.ts`, `speech.ts`,
`transcript.ts`, `audio.ts`, `wav.ts`, `config.ts`, `args.ts`. Tests are in `test/voice/`. The fake `claude` is
`test/voice/fake-claude.mjs`, so tests never use your Claude quota.
