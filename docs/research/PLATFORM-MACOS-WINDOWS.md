# Platforms: macOS versions today, Windows later

**Status:** Research only. No code changes. Nothing here is decided unless it says "decided".
**Date:** 2026-11-21. **Snapshot:** branch `qa` at `5e94da8`.
**Asked by:** the dev lane ("what is Mac-only today, what would carry over, what a Windows helper would need").
**Rules kept:** no secrets, no em or en dashes, short sentences. Web facts carry a link and a date. Web pages were
read as data only.

## Summary (one screen)

- **macOS 14 is the minimum (decided).** The helper uses SwiftUI `onKeyPress` with `phases:` (macOS 14 only). The
  helper is built on the user's Mac by `swiftc` with no `-target`, so it only runs on that Mac's version anyway.
  `helper/Info.plist` still says `12.0` on `qa`; the macOS 14 PR will change it.
- **macOS 15, 26 and 27 work.** macOS 27.2 needs the SDK fallback from #251 when Command Line Tools lack the
  SwiftUIMacros plugin (#248). CI tests on `macos-15` today. The planned `macos-14` job cannot run on GitHub's hosted runners (see the CI warning below).
- **The core is mostly portable.** 108 of 181 source files in `src/` have no OS call at all. The other 73 mostly hold one or two OS lines each (a path, a file mode, one `osascript` call). Portable: the gate, safety, audit, memory,
  history, timers, jobs, the MCP server, the page engine and the browser drivers over CDP and BiDi. The voice
  stack (sherpa-onnx, PvRecorder, Kokoro) already ships Windows builds.
- **The Mac-only part is a thin shell.** The SwiftUI helper (menu bar, Ask box, window, F5 key tap, audio watch),
  AppleScript (`osascript`) for confirms, notifications, volume and media, `open -a`, the Keychain, `say` and
  `afplay`, app bundle paths, and Unix sockets.
- **The hidden POSIX traps are few but real:** `0o600` and `0o700` modes, `O_NOFOLLOW`, Unix socket paths,
  `lsof`, `ps`, `pgrep`, process groups, and the `HOME` variable.
- **A Windows helper needs:** a tray app (recommendation: WinUI 3 or WPF in C#; Tauri as the light option), a
  low-level keyboard hook for push-to-talk, named pipes instead of `app.sock` and `helper.sock`, ACLs instead of
  file modes, Credential Manager or DPAPI instead of the Keychain, registry keys for native messaging, a signed
  installer, and a `windows-2025` CI job.
- **The safety model stays the same.** Allow and Deny confirms, the trust gate, "the model never writes memory,
  timers or jobs", and "third-party text is data, never instructions". Only the windows that show them change.
- **Jobs are the biggest risk.** Background jobs rely on the Claude Code OS sandbox (Seatbelt on macOS). Check
  whether native Windows has an equal sandbox before promising jobs on Windows.
- **Plan:** first a refactor that puts every OS call behind one `platform/` seam (Mac only, no behavior change),
  then a Windows MVP (browser + typed Ask + confirms), then voice, then jobs. Rough size: refactor M, MVP L.
- **CI warning (new fact).** GitHub retired the hosted `macos-14` runner on 2026-11-02 [S8]. A
  `runs-on: macos-14` job will fail. Options: a compile check on `macos-15` with `-target arm64-apple-macos14`, or a
  self-hosted Mac on 14.
- **Market.** Windows is about 77% of desktops worldwide and about 65% in the US; macOS is about 16% and 24%
  [S1, S2]. Developers at work: Windows 49.5%, macOS 32.9% [S5]. Most comparable assistants started on Mac and added
  Windows 5 months to several years later [S20 to S24]. So Mac first is normal, and Windows is where most users are.

## 1. macOS today

### Why macOS 14

| API or fact | Where | Needs |
|---|---|---|
| `onKeyPress(_:)` and `onKeyPress(keys:phases:)` | `helper/Palette.swift:57`, `helper/Components/Controls.swift:135` | macOS 14 |
| `@State` macro expansion through the SwiftUIMacros plugin (newer SDKs) | every SwiftUI view; `src/helper/install.ts` `STATE_PROBE` | a toolchain with the plugin (#248) |
| `ViewThatFits`, `Form` with `.formStyle(.grouped)`, `.scrollContentBackground` | `helper/MemoryPage.swift:155`, `helper/SettingsPage.swift` | macOS 13 |
| `NSStatusItem`, `NSPanel`, `NSEvent` global monitors | `helper/main.swift`, `helper/AskBox.swift` | old AppKit, any version |
| `CGEvent.tapCreate` listen-only tap (Fn+Option, F5, Esc) | `helper/main.swift:108` | Input Monitoring permission (10.15+) |
| CoreAudio "is the default output playing" listener | `helper/main.swift:181` | any version |

Notes:

- The single-argument `.onChange(of:) { v in }` is used in many views. It is deprecated since macOS 14 but still
  works. It is a warning, not a blocker. Moving to the two-argument form is a small cleanup.
- `helper/Info.plist` has `LSMinimumSystemVersion` `12.0`. That is wrong today: `onKeyPress` would not exist on
  12 or 13. The decided macOS 14 PR should set it to `14.0`.
- The helper is compiled on the user's own Mac by `stephen install-helper` (`src/helper/install.ts`), with
  `swiftc -O -swift-version 5` and no `-target`. So a binary is never copied between Macs. The minimum matters
  for two things: the SDK must have the APIs, and doctor must say clearly when the Mac is too old.
- `src/helper/install.ts` `buildWithSdkFallback` (#251): when the default SDK fails with the SwiftUIMacros error,
  it tries the other `MacOSX*.sdk` folders in `/Library/Developer/CommandLineTools/SDKs`, newest first.
  `src/helper/doctor.ts` runs the same choice with a one-second typecheck probe.

### Per version

| macOS | Status (2026-11-21) | What works | What needs care | CI |
|---|---|---|---|---|
| 13 and older | Not supported (decided) | Nothing: `onKeyPress` is missing, the helper will not build | Doctor should say "macOS 14 or later" in plain words | none |
| 14 Sonoma | Minimum (decided). Apple usually patches only the newest three versions (now 27, 26, 15), so 14 likely gets no more security fixes (not confirmed by Apple) | Everything, if the Command Line Tools are current | Oldest Swift toolchain we support; Intel Macs too | No hosted runner since 2026-11-02 [S8]. Only a compile check with `-target` on macos-15, or a self-hosted Mac |
| 15 Sequoia | Supported | Everything | none known | `macos-15` job today (arm64, Xcode 16.4 default) [S9] |
| 26 Tahoe | Supported. Last macOS for Intel Macs [S7] | Everything | New look (Liquid Glass) changes some system controls; check the Ask box panel and menu bar icon by eye | `macos-26` runner exists (Xcode 26.6 default) [S10]; not used yet |
| 27 | Current (released 2026-09-14, Apple silicon only) [S6] | Everything, after #251 | Command Line Tools on 27.2 lack the SwiftUIMacros plugin. `install-helper` falls back to an older SDK (#248, #251). Cris's Mac runs 27.2 | none (no hosted runner yet) |

The CI matrix today (`.github/workflows/ci.yml`) is `ubuntu-24.04` and `macos-15`. Suggestion for the dev lane: add
`macos-26` (closer to Cris's Mac), and test 14 with a `-target arm64-apple-macos14` build on `macos-15`. The
macOS 27 SDK problem can only be caught on a real 27 Mac for now, which the Mac test plan already does.

## 2. Mac-only inventory

Every piece below is Mac-only today. "Windows" is the closest equivalent.

| Piece | Files | Why Mac-only | Windows equivalent |
|---|---|---|---|
| SwiftUI helper app (menu bar item, Ask box, main window, pages) | `helper/*.swift`, `helper/Components/*` | AppKit and SwiftUI | Tray app: WinUI 3, WPF, Tauri, Electron or Avalonia (section 4) |
| Helper build and install | `src/helper/install.ts`, `src/helper/doctor.ts` | `xcrun`, `swiftc`, `.app` bundle, `codesign` | Ship a prebuilt signed binary in an installer (no compile on the user's PC) |
| Push-to-talk keys (Fn+Option, F5, Esc) | `helper/main.swift` (`CGEventTap`), `helper/Core.swift` key codes | CGEventTap, Input Monitoring, macOS virtual key codes | `SetWindowsHookEx(WH_KEYBOARD_LL)`; Fn is not visible to Windows, so pick another chord |
| Audio playing watch (auto-pause, duck) | `helper/main.swift` `AudioWatcher` | CoreAudio | WASAPI `IAudioMeterInformation` or audio session events |
| Media keys (play/pause, next) | `helper/main.swift:509`, `src/desktop/media-key.ts` | `NSEvent.otherEvent` system-defined events | `SendInput` with `VK_MEDIA_PLAY_PAUSE`, or `GlobalSystemMediaTransportControlsSessionManager` |
| `helper.sock`, `app.sock`, `phone.sock` | `src/helper/paths.ts`, `src/lib/private-socket.ts`, `src/app/server.ts`, `src/phone/server.ts`, `helper/Core.swift`, `helper/AppConnection.swift` | Unix sockets with 0700 folder and 0600 file | Named pipes `\\.\pipe\stephen-<user>-app` with a DACL for the current user only |
| Confirm dialogs (Allow / Deny) outside the app | `src/safety/confirm.ts:344` | `osascript` dialog | The helper's own dialog over the pipe (already the path when the app is open: `src/safety/app-confirm.ts`) |
| Notifications (timers, jobs) | `src/timers/notify.ts` | `osascript display notification` | Toast notifications (Windows App SDK `AppNotificationManager`) |
| Volume and media apps | `src/desktop/sound.ts` | JXA through `osascript`, Spotify and Music scripting | Core Audio `IAudioEndpointVolume`; media through SMTC |
| Open apps and URLs | `src/desktop/system.ts`, `src/desktop/apps.ts`, `src/desktop/play.ts`, `src/connect/gmail-oauth.ts:301` | `/usr/bin/open -a`, `plutil`, `codesign --verify` | `ShellExecuteEx` / `start ""`, App Paths registry, Authenticode check |
| Spoken replies and chimes | `src/voice/speech.ts`, `src/voice/tts/say.ts`, `src/voice/tts/player.ts` | `say`, `afplay`, `/System/Library/Sounds` | `System.Speech` / `Windows.Media.SpeechSynthesis`; play WAV with a small player |
| Secrets (accounts, ElevenLabs key, Gmail tokens) | `src/lib/keychain.ts`, `src/connect/keychain-write.ts`, `src/accounts/secrets.ts`, `src/voice/tts/keys.ts` | `/usr/bin/security` generic passwords | Credential Manager (`CredWrite`/`CredRead`) or DPAPI files |
| Browser paths | `src/config.ts:54` (`~/Library/Application Support/Google/Chrome`, `.../zen`), `src/drivers/macos.ts:130`, `src/desktop/browsers.ts:15` | `/Applications/*.app`, Library paths | `%LOCALAPPDATA%\Google\Chrome\User Data`, `%APPDATA%\zen`, `Program Files` |
| Process discovery | `src/drivers/macos.ts:148` (`pgrep`), `src/lib/process.ts` (`ps`, `lsof`) | BSD tools | `tasklist` / WMI / `Get-CimInstance Win32_Process`; Restart Manager for "who holds this folder" |
| "Zen for Stephen" launcher app | `src/zen-launcher.ts` | `osacompile` makes an AppleScript `.app` in `~/Applications` | A Start menu shortcut with `--remote-debugging-port` |
| Jobs sandbox | `src/jobs/spec.ts:171`, `src/jobs/runner.ts` | Claude Code sandbox is Seatbelt on macOS; process groups and `SIGTERM` | Open question (section 5, risks). Job objects can kill a tree |
| Permissions and checks | `src/checks/mac-checks.ts`, `src/cli.ts:228` | TCC: Microphone, Input Monitoring, Automation | Windows mic privacy switch only; no Input Monitoring prompt; SmartScreen at install |
| Page engine "is Mac" key choice | `src/page/index.ts:931` | Cmd vs Ctrl shortcuts | Already handled: it asks the page for `navigator.platform` first |

Not Mac-only (good news): the microphone (`@picovoice/pvrecorder-node`), wake word, VAD and speech to text
(`sherpa-onnx-node`) and Kokoro TTS. These libraries publish Windows x64 builds (see section 4.3).

No launchd is used today. `stephen listen` starts from the helper or a terminal.

## 3. What carries over

These modules have no OS calls (or only the POSIX traps listed after the table).

| Area | Modules |
|---|---|
| Trust gate and safety | `src/safety/gate.ts`, `policy.ts`, `classify.ts`, `domains.ts`, `egress.ts`, `text.ts`, `session-state.ts`, `audit.ts`, `app-confirm.ts` |
| Memory, history, timers | `src/memory/*`, `src/history/*`, `src/timers/store.ts`, `router.ts`, `intent.ts` |
| Jobs logic | `src/jobs/spec.ts`, `intent.ts`, `router.ts`, `state.ts`, `finish.ts` (the runner and sandbox are the exception) |
| MCP server and tools | `src/server/*` (`hub.ts`, `tools.ts`, `locks.ts`, `tab-reuse.ts`, `dialogs.ts`, `instructions.ts`) |
| Browser engines | `src/page/*` (DOM walker, refs, frames), `src/drivers/chrome.ts` (CDP), `src/drivers/zen.ts` (BiDi), `manager.ts`, `common.ts` |
| Zen add-on plan | ADR-009 add-on and `stephen zen-host`: the add-on is a WebExtension and works the same on Windows Zen; only the host registration and the socket change |
| Voice pipeline | `src/voice/engine.ts`, `listener.ts`, `keywords.ts`, `grammar/*`, `transcript.ts`, `conversation.ts`, `models.ts`, `tts/kokoro.ts`, `tts/elevenlabs.ts` |
| Accounts | `src/accounts/*` HTTP clients (Gmail, Calendar, Canvas, Notion, weather); only secret storage changes |
| App protocol | `src/app/protocol.ts`, `src/helper/protocol.ts`, `src/helper/framing.ts` (newline JSON, frozen wire contract) |
| Telemetry, eval, selftest | `src/telemetry/*`, `src/eval/*`, most of `src/selftest/*` |
| Swift core | `helper/Core.swift` already builds on Linux (Darwin or Glibc). It is the push-to-talk state machine and framing. A C# helper would port it, not reuse it |

### Hidden POSIX assumptions

| Assumption | Where | On Windows |
|---|---|---|
| `0o600` files and `0o700` folders mean "only me" | `src/lib/fs.ts:36,155`, `src/safety/audit.ts`, `src/memory/store.ts`, about 20 files | `chmod` is mostly a no-op (only read-only bit). Need an ACL helper (owner-only DACL), or trust the per-user profile folder |
| `O_NOFOLLOW` against symlink swaps | `src/lib/fs.ts:30`, `src/memory/store.ts`, `src/history/store.ts`, about 10 files | Not defined on Windows (`fs.constants.O_NOFOLLOW` is undefined). Use `lstat` checks plus reparse point checks |
| Unix socket path limit (104 bytes) and socket files | `src/lib/private-socket.ts` | Node `net` uses named pipes on Windows; no file, no mode, ACL via the pipe security descriptor |
| Stale socket cleanup by inode | `src/lib/private-socket.ts` | Pipes vanish with the server; the inode logic is not needed |
| `HOME` and `~/.stephen` | `src/config.ts:223` | `%USERPROFILE%` is set; `HOME` usually is not. `os.homedir()` already falls back. Better: `%LOCALAPPDATA%\Stephen` |
| `/` in paths and `.replace(/\/+$/, '')` | `src/lib/process.ts`, path checks in `src/lib/owner-only.ts` | Use `path.sep`, case-insensitive compare, and `path.win32` in tests |
| `process.getuid()` | `src/lib/process.ts:66` | Undefined on Windows; code already returns `[]` |
| Process groups, `kill(-pid)`, `SIGTERM` then `SIGKILL` | `src/jobs/runner.ts`, `src/voice/speech.ts:94` | No signals. Use Job Objects or `taskkill /T /F` |
| `lsof`, `ps`, `pgrep` | `src/lib/process.ts`, `src/drivers/macos.ts` | Not present. Replace per call |
| `execFile` with argv (never a shell) | everywhere | Still good. Avoid `.cmd` shims, which need a shell on Windows (`claude.cmd` from npm is one) |

## 4. What a Windows helper would need

### 4.1 UI stack options

| Option | Language | Size and speed | Native feel (tray, toasts, hotkeys) | Team fit | Main risk |
|---|---|---|---|---|---|
| **WinUI 3** (Windows App SDK 2.x [S11]) | C# / XAML | Small, fast, native | Best: Fluent look, app notifications, all Win32 APIs one P/Invoke away | New language for the team | Packaging and tooling are heavy; tray icon needs a helper library |
| **WPF** | C# / XAML | Small, fast | Very good; mature tray libraries; looks older without a theme library | New language | Old UI framework, but stable and well known |
| **Tauri 2** (2.12 [S12]) | Rust shell, web UI (TypeScript) | Small (uses WebView2, no bundled browser) | Good: tray, global shortcut and notification plugins | UI in TypeScript, like the core | Rust for any native piece (keyboard hook, audio watch); WebView2 must be present |
| **Electron** (45.x [S12]) | TypeScript | Large (bundles Chromium, about 100 MB+) | Good tray and shortcut APIs | Same language as the core | Size and memory; a second Chromium next to Chrome and Zen |
| **Avalonia** (12.x [S12]) | C# / XAML | Small | Good; cross-platform | New language | Could also replace the Mac helper, but SwiftUI already works there |

Trade-offs in one line each:

- **One UI codebase for both OSes** (Tauri, Electron, Avalonia) saves UI work but throws away the working SwiftUI
  helper or keeps two anyway.
- **A native helper per OS** (SwiftUI on Mac, WinUI 3 or WPF on Windows) costs two UIs but each one is small, if
  the logic stays in TypeScript. This is the shape Stephen already has.
- **Recommendation (for discussion):** keep the helper thin and native. WPF or WinUI 3 in C# for Windows. Pick
  Tauri instead only if the team wants the Windows UI in TypeScript and accepts a little Rust.

ADR-style summary of the C# option:

| Dimension | Assessment |
|---|---|
| Complexity | Medium. Same pages as the Swift helper; protocol is frozen |
| Cost | Free tools (Visual Studio Community or `dotnet` CLI) |
| Team familiarity | Low today |
| Security fit | Good: direct Win32 for pipe ACLs, hooks and DPAPI |

### 4.2 Global hotkey and push-to-talk

- `RegisterHotKey` only reports key down, never key up, and fails if another app holds the combination [S14]. It
  cannot do hold-to-talk.
- Push-to-talk needs a low-level keyboard hook (`SetWindowsHookEx(WH_KEYBOARD_LL)`) in the helper. It sees key
  down and key up for all apps. It needs no permission prompt (unlike macOS Input Monitoring), so the helper must
  hold itself to the same rule as `helper/main.swift`: look only at the push-to-talk keys and Esc, never log or
  forward other keys.
- The Fn key is handled by the keyboard firmware and is not visible to Windows. Fn+Option cannot carry over. F5
  hold can. Note: F5 is "reload" in browsers, so the hook must swallow F5 only while it means push-to-talk.
- Hooks do not reach elevated (admin) windows from a normal process. Push-to-talk will not work while an admin
  app has focus. That is acceptable; say it in doctor.
- The Swift push-to-talk state machine (`helper/Core.swift`: min hold 250 ms, max hold 30 s, Esc cancels) ports
  as is. Keep the same constants.

### 4.3 Speech

- **Today's stack already runs on Windows.** Microphone: `@picovoice/pvrecorder-node` (Windows x64 build).
  Wake word, VAD and speech to text: `sherpa-onnx-node` with the pinned models in `src/voice/models.ts`. Kokoro TTS
  and ElevenLabs are plain Node. So the voice pipeline needs no rewrite. Check Windows on Arm builds before
  promising Arm.
- **What changes:** `say` becomes `System.Speech` or `Windows.Media.SpeechSynthesis` (a "Windows voice" choice in
  Settings), and `afplay` becomes a small WAV player (in the helper, or a Node addon).
- **Windows built-in recognition** (`Windows.Media.SpeechRecognition`) still exists, but some grammars use a web
  service, and the old Speech Recognition app is replaced by Voice Access [S13]. `System.Speech` (SAPI) gets no new
  features [S13]. Neither is better than the local sherpa-onnx models Stephen already uses.
- **Cloud speech** (Azure Speech, free tier 5 hours a month [S13]) is possible but sends audio off the PC. Keep it
  opt-in, like ElevenLabs today.
- **Microsoft Copilot** has its own "Hey Copilot" wake word, opt-in and English only [S24]. Stephen's wake word
  should not clash; "Hey Stephen" is fine.

### 4.4 IPC instead of app.sock

- Keep the wire contract (`src/app/protocol.ts`, `src/helper/protocol.ts`, newline JSON). Only the transport
  changes.
- Node: `net.createServer().listen('\\\\.\\pipe\\stephen-<sid>-app')`. Node's `net` speaks named pipes on Windows
  with the same `Socket` API, so `listenPrivateSocket` becomes one function with two branches.
- Security: create the pipe with a DACL that allows only the current user SID, and set
  `FILE_FLAG_FIRST_PIPE_INSTANCE` so another process cannot squat the name first. Node does not expose the security
  descriptor, so this may need a tiny native addon, or a check of the client's process owner on connect
  (`GetNamedPipeClientProcessId`). This is the one IPC piece that needs care.
- Put the user SID (not the user name) in the pipe name, so two users on one PC never meet.

### 4.5 File permissions

- The default `%LOCALAPPDATA%` and `%USERPROFILE%` folders already deny other standard users. Admins can read
  them; that is the same as root on macOS.
- Put the Stephen home under `%LOCALAPPDATA%\Stephen` and set an explicit owner-only DACL once at create time
  (`icacls /inheritance:r /grant:r "%USERNAME%":F`, or the Win32 API).
- Make `src/lib/fs.ts` the one place that knows. It already is the "one implementation of private files", so this
  is a contained change.

### 4.6 Installer, signing and updates

- **Ship a prebuilt helper.** On Mac the helper is compiled on the user's Mac. On Windows, ship a signed `.exe`.
  Most Windows users have no compiler.
- **Installer choices:** MSIX (clean install and uninstall, Store ready, but sandbox rules can get in the way of
  hooks and pipes), WiX v7 (MSI, maintenance fee since v6) or Inno Setup 6.7 (simple, commercial license since
  6.5) [S16]. For a per-user install with no admin, Inno Setup or MSIX are the simplest.
- **Signing:** unsigned apps get SmartScreen warnings. Azure Artifact Signing (renamed from Trusted Signing) is
  about USD 10 a month and gives a base reputation [S17]. Sign from the first public build.
- **Node runtime:** bundle a pinned Node (inside `^20.19.0 || >=22.12.0`) or ask for an installed one. Bundling is
  easier for students.
- **Updates:** start manual (download a new installer). Later: MSIX auto update, or a simple signed update check.
  Never auto-run downloaded code that is not signed by the same certificate.
- **Start at login:** a per-user Run registry key or a Startup shortcut (the Windows side of a LaunchAgent; Stephen
  uses none on Mac today).

### 4.7 Native messaging registration (ADR-009)

- macOS: a host manifest JSON in `~/Library/Application Support/Mozilla/NativeMessagingHosts/` (and Zen's own
  folder).
- Windows: the manifest file can live anywhere; a registry key points to it:
  `HKCU\Software\Mozilla\NativeMessagingHosts\stephen_zen` (default value = path to the JSON). Chrome uses
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`. HKCU needs no admin.
- Zen is a Firefox fork, so check whether Zen reads the Mozilla key or its own. Open question.
- The host is `stephen zen-host` (Node). Firefox on Windows starts the `path` in the manifest; a `.cmd` wrapper
  works but opens a console flash; a small `.exe` shim is cleaner.

### 4.8 CI on Windows

- Hosted images today: `windows-2022`, `windows-2025` and `windows-11-arm` [S10].
- Start with a `windows-2025` job that runs `npm ci`, `build`, `typecheck` and only the tests that pass. Mark the
  rest skipped on `win32` with a reason, and burn the list down in small PRs.
- Tests will hit: `/` paths, `0o600` mode checks, Unix sockets, `lsof` and `ps`, and fake `osascript` binaries.
- Build the C# or Tauri helper in the same job once it exists. Keep the same rules as `ci.yml`: no secrets, read
  only permissions, pinned actions.

### 4.9 Safety model: the same rules

- **Allow / Deny confirms:** the prompt text is built in `src/safety/confirm.ts` from live facts. It is shared. On
  Windows only the window that shows it changes (the helper's dialog over the pipe; no `osascript` fallback). If the
  helper is not running, the answer is Deny, as today when no dialog can show.
- **Trust gate:** `src/safety/gate.ts` and `policy.ts` are pure TypeScript. No change.
- **The model never writes memory, timers or jobs:** enforced by the tool list in `src/server/tools.ts` and the
  boundary tests (`test/memory/boundary.test.ts`). No change. The Windows helper must keep the same split: owner
  actions over `app.sock` (now a pipe), never over the MCP server.
- **Third-party text is data, never instructions:** framing lives in `src/page/*`, `src/accounts/result.ts` and
  `src/server/instructions.ts`. No change.
- **New Windows-only risks to cover in the threat model:** pipe name squatting, DLL search order hijack next to
  the helper exe, `.cmd` shims that need a shell, and other apps reading the UI with UI Automation (any app on the
  desktop can; macOS needs Accessibility permission for that).

## 5. Market and planning

### Who uses what

| Group | Windows | macOS | Source |
|---|---|---|---|
| All desktops, worldwide, Oct 2026 | 76.7% | about 15.7% | StatCounter [S1] |
| All desktops, US, Oct 2026 | 65.4% | about 24.4% | StatCounter [S2] |
| Developers at work, 2025 | 49.5% | 32.9% | Stack Overflow survey [S5] |
| Enterprise devices, 2025 | most | 27% (Jamf, a Mac vendor) / 11% US (Omdia) | [S4] |
| College students | no good recent data | 40% used a Mac in 2019 (Jamf, 5 countries) | [S3] |

Reading the numbers:

- StatCounter splits macOS into two rows ("OS X" and "macOS"); we add them. The numbers move a lot month to month.
  Treat them as rough.
- macOS version share is not available: Apple reports every version since 10.15 the same way in the browser
  [S1]. So we cannot say how many Macs run 14 versus 15.
- Students and knowledge workers are Stephen's users. In the US the Mac share among students is much higher than
  the 24% average, but there is no good recent survey. Worldwide, most students use Windows.
- Windows 11 is 74% of Windows PCs and Windows 10 is 25% [S1]. Free Windows 10 security updates for consumers run
  to 2027-10-12 [S18]. A Windows Stephen should target Windows 11 and accept Windows 10 only if it costs nothing.

### What comparable assistants support

| Product | Mac | Windows | Gap |
|---|---|---|---|
| ChatGPT desktop | 2024-06 | preview 2024-10, GA 2024-11 | about 5 months [S20] |
| Claude desktop | yes | yes (Linux beta too) | shipped on both [S21] |
| Wispr Flow (voice dictation) | 2024-09 | 2025-03 | about 6 months [S22] |
| Superwhisper (voice) | about 2023 | beta 2025-02, GA 2025-12 | about 2 years [S22] |
| Raycast (launcher) | about 2020 | beta 2025-11, v2.0 2026-08 | about 5 years [S23] |
| Perplexity Comet (AI browser) | 2025-07 | beta soon after | months [S23] |
| Opera Neon (agent browser) | yes | yes | both in beta [S23] |
| Microsoft Copilot | n/a | built in, "Hey Copilot", Vision | Windows only [S24] |
| Siri and Apple Intelligence | built in | n/a | Mac only [S6] |

Takeaways:

- Mac first, Windows later is the normal path for small teams. The fast followers (5 to 6 months) had funded
  teams. Small teams took years.
- On Windows, Stephen competes with Copilot, which is built in and free. Stephen's edge is the same as on Mac: it
  drives the user's own browsers with a visible Allow / Deny gate and local memory the user controls.
- Voice dictation apps (Wispr Flow, Superwhisper) prove Windows users pay for voice. Their hard parts were the
  same as ours: global push-to-talk and a tray app.

### Effort (rough)

| Piece | Size | Notes |
|---|---|---|
| Refactor: one `src/platform/` seam (Mac only, no behavior change) | M | Move `osascript`, `open`, `security`, `say`, `afplay`, `lsof`, `pgrep`, paths behind one interface. Tests already inject deps (`src/desktop/system.ts`) |
| Private files and folders on Windows (`src/lib/fs.ts`, ACLs, no `O_NOFOLLOW`) | M | One module, but security sensitive |
| Named pipes for app, helper and phone sockets | S to M | S for the transport; M with the client-owner check |
| Secrets in Credential Manager | S | Read and write split stays (serve reads only) |
| Paths for Chrome, Zen, home | S | |
| Browser drivers on Windows (CDP Chrome, BiDi Zen) | S | Libraries are cross-platform; mostly paths and launch |
| Tray helper app (Ask box, window, pages, confirms) | L | The biggest piece. The Swift helper is 22 files |
| Push-to-talk hook and audio watch | M | |
| TTS player and voices | S | Kokoro and ElevenLabs already work; need a WAV player |
| Notifications, volume, media | S | |
| Installer, signing, update channel | M | Plus SmartScreen reputation time |
| Native messaging host registration | S | After ADR-009 ships on Mac |
| Jobs on Windows | L or blocked | Depends on an OS sandbox for the job's shell |
| CI `windows` job and Windows test fixes | M | Many tests assume `/` paths and POSIX modes |

### Phased plan

1. **Phase 0, now: nothing.** Release from `qa` to `main` after the Mac test plan. No code until then (dev lane).
2. **Phase 1, refactor (Mac only).** Add `src/platform/` with one Mac implementation. Move every OS call there.
   Add a lint or boundary test: no `osascript`, `/usr/bin/`, `security` or `0o600` outside `src/platform/`. Add a
   `windows-2025` CI job that only runs `build`, `typecheck` and the pure unit tests. Exit: Mac behavior unchanged,
   the Mac test plan still passes.
3. **Phase 2, Windows MVP (no voice).** `stephen serve` with Chrome over CDP, the MCP tools, the gate, memory and
   history; the tray app with the Ask box, the chat thread and Allow / Deny confirms over a named pipe; Credential
   Manager; an unsigned dev build for Cris to test. Exit: a Windows test plan like `docs/MAC-TEST-PLAN.md` passes.
4. **Phase 3, voice.** Push-to-talk hook, wake word, Kokoro or system TTS, audio watch. Signed installer.
5. **Phase 4, Zen add-on and jobs.** Native messaging registration (after ADR-009 ships on Mac). Jobs only if
   the sandbox question has a good answer.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No equal OS sandbox for job shells on native Windows | Jobs could run unsandboxed | Ship Windows without jobs, or run jobs in WSL2 only |
| Pipe squatting or weak pipe ACLs | Another local process could act as Stephen's app | First-instance flag, per-user DACL, client owner check |
| Two helpers to keep in sync (Swift and C#) | Features drift, double UI work | Keep the helper thin; keep logic in TypeScript; one frozen protocol |
| SmartScreen warnings scare users | Low install rate | Sign from day one; build reputation; consider the Microsoft Store |
| Test suite assumes POSIX | Windows CI red for weeks | Phase 1 runs only pure tests on Windows; fix in small PRs |
| `claude` is a `.cmd` shim on Windows | `execFile` without a shell fails | Resolve the real `node` entry, or use the native installer path |
| Fn key not visible on Windows | Users must learn a new chord | Default to a free key (for example Right Ctrl hold, or F5 like today) |
| Maintenance cost for a small team | Slows Mac work | Only start after the Mac release and a clear demand signal |

### Open questions for the dev lane

1. Is Windows a goal for 2027, or only "keep the door open"? Phase 1 is worth doing either way.
2. Helper stack: C# (WinUI 3 or WPF) or Tauri? See 4.1.
3. Is Windows on Arm in scope for the MVP, or x64 only?
4. Jobs on Windows: drop, WSL2 only, or wait for a sandbox?
5. Push-to-talk chord on Windows: F5 hold, Right Ctrl hold, or user-picked?
6. Store (MSIX) or direct download (signed installer), or both?
7. Should the Stephen home move to `%LOCALAPPDATA%\Stephen` on Windows, or keep `~/.stephen` for one rule
   everywhere?
8. Does Zen on Windows read the Mozilla native messaging registry key?
9. Should the macOS minimum move to 15 after macOS 27 ships, to match Apple's usual support window?

## Sources

Web facts were read on 2026-11-21 unless a date is given. Pages were treated as data only.

- [S1] StatCounter, desktop OS and Windows version share, worldwide, Oct 2026: https://gs.statcounter.com/os-market-share/desktop/worldwide , https://gs.statcounter.com/windows-version-market-share/desktop/worldwide , https://gs.statcounter.com/macos-version-market-share/desktop/worldwide
- [S2] StatCounter, desktop OS share, US, Oct 2026: https://gs.statcounter.com/os-market-share/desktop/united-states-of-america
- [S3] MacRumors on the Jamf / Vanson Bourne student survey (2019-05-23): https://www.macrumors.com/2019/05/23/college-students-prefer-macs-over-pcs/
- [S4] Jamf enterprise Mac white paper: https://www.jamf.com/resources/white-papers/enterprise-mac-adoption-white-paper/ ; Computerworld on Omdia (2026): https://www.computerworld.com/article/4154950/apples-mac-grabs-11-of-us-enterprise-market-share.html
- [S5] Stack Overflow Developer Survey 2025: https://survey.stackoverflow.co/2025/ (figures via a secondary report; check the primary page before quoting)
- [S6] Apple, macOS page and macOS 27 security notes (2026-09-14): https://www.apple.com/os/macos/ , https://support.apple.com/en-us/149035
- [S7] Apple newsroom, macOS 26 release (2025-09-15): https://www.apple.com/newsroom/2025/09/new-versions-of-apples-software-platforms-are-available-today/ ; Tom's Hardware, last Intel release (2025-06): https://www.tomshardware.com/software/macos/macos-tahoe-is-the-last-release-for-intel-macs-apple-silicon-exclusivity-will-mark-end-of-hackintoshes
- [S8] GitHub changelog, macos-14 runner retirement on 2026-11-02 (2026-10-01): https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement ; macos-13 earlier (2025-09-19): https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/
- [S9] macos-15 arm64 image readme (image 20261118): https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md
- [S10] Runner images list and macos-26 readme (image 20261117): https://github.com/actions/runner-images , https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md
- [S11] Windows App SDK release channels (2.4.0, 2026-08-13): https://learn.microsoft.com/windows/apps/windows-app-sdk/release-channels
- [S12] Tauri, Avalonia and Electron releases (Nov 2026): https://github.com/tauri-apps/tauri/releases , https://github.com/AvaloniaUI/Avalonia/releases , https://releases.electronjs.org/
- [S13] Windows speech: https://learn.microsoft.com/en-us/uwp/api/windows.media.speechrecognition.speechrecognizer , https://www.nuget.org/packages/System.Speech/ , https://azure.microsoft.com/pricing/details/speech/
- [S14] RegisterHotKey (2024-06-11): https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey
- [S15] Node.js `net` (named pipes on Windows): https://nodejs.org/api/net.html ; native messaging hosts: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging , https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests
- [S16] WiX release notes: https://docs.firegiant.com/wix/whatsnew/releasenotes/ ; Inno Setup 6.7 (2026-01): https://groups.google.com/g/innosetup-announce/c/7DJl-rwo2sQ
- [S17] Azure Artifact Signing: https://azure.microsoft.com/products/artifact-signing
- [S18] Windows 10 ESU extension to 2027-10-12 (2026-06, secondary): https://www.bleepingcomputer.com/news/microsoft/microsoft-quietly-extends-free-windows-10-esu-support-to-october-2027
- [S19] SwiftUI `onKeyPress` (macOS 14): https://developer.apple.com/documentation/swiftui/view/onkeypress(_:action:)
- [S20] TechCrunch, ChatGPT on Windows (2024-10-17): https://techcrunch.com/2024/10/17/chatgpt-comes-to-windows
- [S21] Claude desktop install: https://support.claude.com/en/articles/10065433-install-claude-desktop
- [S22] Wispr Flow for Windows (2025-03): https://www.speechtechmag.com/Articles/News/Speech-Technology-News/Wispr-Launches-Wispr-Flow-for-Windows-168459.aspx ; Superwhisper for Windows (2025-12): https://alternativeto.net/news/2025/12/ai-powered-transcription-tool-superwhisper-has-officially-launched-a-windows-version
- [S23] Raycast Windows 2.0 (2026-08-25): https://www.raycast.com/changelog/windows/2-0 ; Comet on Windows (2025): https://www.engadget.com/ai/perplexitys-ai-powered-browser-opens-up-to-select-windows-users-180629870.html ; Opera Neon (2025-12-11): https://9to5mac.com/2025/12/11/opera-neon-mac-generally-available-download/
- [S24] Microsoft, Hey Copilot (updated 2026-10): https://support.microsoft.com/topic/copilot-wake-word-hey-copilot-82c2259e-8ca9-4518-97cf-a83b0f3a643e ; Windows blog (2025-10-16): https://blogs.windows.com/windowsexperience/2025/10/16/making-every-windows-11-pc-an-ai-pc/

Code facts cite files on `qa` at `5e94da8`. Method: read `helper/`, `src/`, `.github/workflows/ci.yml`, ADR-009 and
PRs #248 and #251; grep for OS calls; web research for current facts; options compared in ADR style.
