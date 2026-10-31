# Stephen Helper — push-to-talk, Esc and "is the Mac playing sound?"

**Stephen Helper.app** is a tiny menu-bar app (no Dock icon) that `stephen listen` uses for three things:

| What | How | Sent to `stephen listen` as |
|---|---|---|
| **Push-to-talk:** hold **Fn + Option** while you talk, let go to send | listen-only `CGEventTap` on modifier-key changes | `ptt_down`, then `ptt_up` with `heldMs` |
| **Esc** cancels the running command | the same tap, Esc key-downs only | `esc` |
| **Is sound playing?** "Hey Stephen" is ignored while it is; the reply is only spoken when it isn't | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default output device | `audio {playing}` |

It also shows Stephen's state in the menu bar: ○ idle · ● listening · red ● recording ·
◐ working · 🔈 speaking. A `!` after the glyph means Input Monitoring is not granted (or the helper hit an error;
open its menu to see which).

It does **not** use the microphone (that stays with `stephen listen`) and never sees what you type (see
[Privacy](#privacy)).

## Install

You need Apple's Swift compiler: Xcode, or just the command line tools (`xcode-select --install`).

```
stephen install-helper            # builds ~/Applications/Stephen Helper.app and opens it
stephen install-helper --dry-run  # prints the exact commands; builds nothing
```

What it does (every program runs with an argv array, no shell):

1. Finds `swiftc` with `xcrun --find swiftc` (and the SDK with `xcrun --sdk macosx --show-sdk-path`), else `swiftc`
   on PATH. If neither exists it says to run `xcode-select --install`.
2. Compiles `helper/Core.swift` + `helper/main.swift` in a temporary folder:
   `swiftc -O -swift-version 5 [-sdk …] -o "Stephen Helper" Core.swift main.swift -framework AppKit -framework CoreAudio -framework CoreGraphics`
3. Assembles `~/Applications/Stephen Helper.app/Contents/{MacOS/Stephen Helper, Info.plist}` (`LSUIElement`,
   bundle id `dev.stephen.helper`) and signs it ad hoc:
   `codesign --force --sign - --identifier dev.stephen.helper "…/Stephen Helper.app"`.
   It only ever replaces an app with that bundle id; a running helper is asked to quit first.
4. Opens it once: `open -a "…/Stephen Helper.app" --args --home ~/.stephen`.

Then:

1. **Grant Input Monitoring.** macOS shows *"Stephen Helper" would like to receive keystrokes from any
   application* → **Open System Settings** → turn **Stephen Helper** on under **Privacy & Security › Input
   Monitoring**. (No prompt? Go there yourself; if it isn't listed click **+** and pick
   `~/Applications/Stephen Helper.app`.) The menu then says *Input Monitoring: granted* — the helper notices within
   2 s, no restart needed.
2. **System Settings › Keyboard › "Press 🌐 key to" → "Do Nothing".** Otherwise holding Fn opens the emoji picker,
   switches input source or starts dictation.
3. `stephen listen` — it starts the helper when needed (`open -a … --args --home <stephen home>`).

`stephen doctor` shows: helper installed, Xcode tools, helper running, Input Monitoring granted (read from the
helper's `hello`). Note: the helper serves one client at a time, so `stephen doctor` briefly takes the connection
from a running `stephen listen`, which reconnects by itself within a second.

### Rebuild

Run `stephen install-helper` again (after updating Stephen, for example). **Rebuilding changes the app's code
signature, so macOS may ask for Input Monitoring again**, or list it as granted while silently ignoring it. If
Fn+Option stops working after a rebuild: Input Monitoring → select Stephen Helper → **−**, then **+** and add it
again (or turn it off and on).

## Files

| Path | What |
|---|---|
| `~/Applications/Stephen Helper.app` | the app (`stephen install-helper`) |
| `<stephen home>/run/helper.sock` | the socket (folder 0700, socket 0600, only your user may connect) |
| `<stephen home>/logs/helper.log` | its log (rotated at 1 MB) |
| `helper/Core.swift` | platform-neutral core: push-to-talk logic, JSON framing, socket server |
| `helper/main.swift` | macOS layer: menu bar, event tap, CoreAudio |
| `src/helper/protocol.ts` | the wire contract (frozen); `src/helper/client.ts` is the Node side |

`<stephen home>` is `~/.stephen` (or what `STEPHEN_HOME` / config say; `stephen listen` passes it with `--home`).

## Behaviour details

- **Push-to-talk** starts when Fn and Option are both held **and neither Command nor Control is** (so Fn+Option+⌘/⌃
  shortcuts never start a recording; Shift is allowed). It ends when Fn or Option is released, or ⌘/⌃ is added.
  After it ends, Fn or Option must be released before the next press can start. Short taps are still sent;
  `stephen listen` ignores presses under 250 ms. At 30 s the helper sends `ptt_up` itself.
- **Esc** is listen-only: the key still reaches the front app.
- **Audio** is the default output device's "running somewhere" flag: true while any app has an output stream open
  (including Stephen's own speech, and some apps that keep a silent stream open). The helper follows default-device
  changes (headphones, AirPlay…).
- **One client at a time:** a new connection replaces the old one. When the client leaves, the menu goes back to ○.
- **The tap** is re-enabled if macOS disables it (`tapDisabledByTimeout` / `…ByUserInput`; a press in progress is
  ended with `ptt_up`), and recreated by a 2 s watchdog if it stays disabled.
- Quit from the menu, by `{"type":"quit"}`, or `killall "Stephen Helper"`; it removes its socket. A stale socket
  from a crash is replaced on the next start; a live one is never stolen.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing happens when you hold Fn+Option | Input Monitoring not granted (menu shows *not granted*, glyph shows `!`, `stephen doctor` says so). Grant it as above. After a rebuild, remove and re-add the app. |
| Holding Fn opens the emoji picker / dictation | Keyboard › "Press 🌐 key to" → "Do Nothing" (and check Dictation's shortcut isn't Fn). |
| Works, then stops after a while | The event tap was disabled. The helper re-enables/recreates it and logs `event tap disabled …` in `helper.log`. If it keeps happening, quit and reopen the helper. |
| Nothing while typing a password | macOS Secure Input blocks event taps while a password field has focus. Click elsewhere. |
| `stephen listen` says the helper did not answer | Look at `<stephen home>/logs/helper.log`. If the helper is already running for a different home folder, quit it from its menu and let `stephen listen` start it. |
| `install-helper`: no Swift compiler | `xcode-select --install`, then run it again. With full Xcode, `sudo xcode-select -s /Applications/Xcode.app` if `xcrun` points elsewhere. |
| "already exists and was not made by Stephen" | Something else is at `~/Applications/Stephen Helper.app`; move it away. |
| Two `stephen listen` running | They take turns stealing the helper connection. Run one. |

## Privacy

- The event tap is **listen-only** and subscribes to modifier-key changes and key-downs. From key-downs the helper
  reads only the key code, and only to recognise Esc (53). It never reads characters, never stores or logs keys, and
  sends Node nothing but `ptt_down`/`ptt_up`/`esc` with timestamps.
- From CoreAudio it reads only whether the output device is running — no audio data.
- It does not record from the microphone and makes no network connections. Its socket is reachable only by your user.

## Testing

No Mac is needed for most of it: `helper/Core.swift` builds on Linux too. `test/helper/swift.int.test.ts` compiles it
with the harness in `test/helper/swift/main.swift` and drives the real socket server and push-to-talk logic through
`HelperClient`, using the same scenarios as the TypeScript model in `test/helper/ptt-model.ts`. It runs when
`swiftc` is on PATH or `STEPHEN_TEST_SWIFTC` points at a compiler; on macOS it also compiles the full app.
The AppKit / CGEventTap / CoreAudio layer (`helper/main.swift`) can only be built and tried on a Mac.
