# Stephen — design (phase 1)

"Hey Stephen, open YouTube." Stephen is browser-hub grown into a voice-driven assistant for the user's Mac.
Research: `docs/RESEARCH-STEPHEN.md`. Decisions the owner made (2026-10-30): **safe actions first, mouse
control later**; **Claude Code (the user's login) first, API key later**.

## ADR-002 — what phase 1 is (and is not)

**Decision.** Phase 1 adds three things to browser-hub and renames it:
1. **Rename** to *Stephen* (CLI `stephen`, MCP server `stephen`, home `~/.stephen`, launcher "Zen for Stephen").
2. **Safe desktop actions** — `open_app`, `open_url`, `desktop_status`. No mouse, no keyboard injection,
   no screenshots.
3. **"Hey Stephen" listener** — `stephen listen`: local wake word → local speech-to-text → Claude Code
   headless (`claude -p`) with only Stephen's MCP tools → spoken reply.

**Why no mouse yet.** Screen-reading agents follow injected on-screen instructions often (RedTeamCUA: a
screen-driving frontier model executed 83 % of injected high-risk tasks). High-level actions never read the
screen, so on-screen text can't steer them; "open YouTube" is one `open` call, not a click sequence.
Phase 2 adds click/type in approved apps, off by default, with tiers and a swallowed stop key.

**Why `claude -p` first.** Uses the user's existing Claude Code login at no extra cost. Trade-off: a few
seconds of start-up per command. Phase 3 moves to the Agent SDK + Console API key (Anthropic requires API-key
auth for SDK products) for a long-running, faster session.

**Rejected for phase 1:** Peekaboo / macos-automator MCP connected directly to Claude (would bypass the
safety gate; `execute_script` is shell access); Picovoice Porcupine (free tier ended 2026-06-30);
a Swift menu-bar app (can't be built or tested in CI; phase 2 owns microphone/Accessibility permissions).

## Architecture

```
 mic ──▶ stephen listen (Node) ──────────────────────────────────────────────────────────────┐
         PvRecorder 16 kHz ─▶ sherpa-onnx KWS "HEY STEPHEN" ─▶ Silero VAD ─▶ sherpa-onnx ASR      │
                                                         transcript ─▶ claude -p (headless)     │
                                                                         --strict-mcp-config    │
                                                                         only mcp__stephen__*   │
                                                                              │ stdio           │
                                                                              ▼                 │
                                                stephen serve (MCP) = browser-hub + desktop     │
                                                  safety gate · confirmations (macOS dialog)    │
                                                  browser tools · open_app/open_url/status      │
         reply text ◀── final message ◀──────────────────────────────────────────────────────────┘
         `say` (spoken reply), afplay chimes
```

## Safety rules (phase 1)

| Rule | Behaviour |
|---|---|
| App hard-block (built in, not overridable) | Terminals (Terminal, iTerm2, Warp, Ghostty, kitty, Alacritty, WezTerm), script/automation (Script Editor, Automator, Shortcuts), IDEs/editors (Xcode, VS Code, Cursor, Zed), System Settings, Keychain Access, Passwords, password managers (1Password, Bitwarden, Dashlane, KeePassXC, LastPass), Activity Monitor, Disk Utility, Installer, Migration Assistant, remote-control apps (TeamViewer, AnyDesk, Screens), Claude apps and Stephen itself → **deny** |
| App allow-list (default + `desktop.allowedApps`) | Browsers, Music, Spotify, Podcasts, TV, Notes, Reminders, Calendar, Mail, Messages, Maps, Weather, Clock, Calculator, Photos, Preview, Slack, Discord, Notion, Figma, Zoom, Teams, Obsidian, Linear → **open** |
| Any other app | **confirm** with the human (same confirmer as the browser gate) |
| Apps are matched by **bundle id**, resolved from the real `.app` | Renaming an app can't dodge the block list |
| `open_url` | `https:` only (`http:` → confirm); every other scheme (file, javascript, data, custom app schemes, mailto, tel…) → **deny**; host checked by the existing safety gate as `tab_open` (blocked/sensitive domains, cross-site egress rules) |
| Locked screen | All actions refused |
| No shell | Everything via `execFile` with argv arrays (`open -b`, `osascript -l JavaScript` with fixed scripts) |
| Rate limit + audit | Shared with the browser gate; every desktop action audited |
| Voice | While Claude is acting, the wake word **cancels** the run (never starts a new one); while Stephen is speaking it is ignored; for `voice.cooldownSec` (20 s) after each command it is ignored (Enter re-arms), because a page or video Stephen opened may say "Hey Stephen". This does not stop a video that talks later; see docs/VOICE.md. A spoken "yes" is never a confirmation (risky actions use the macOS dialog); "Stephen stop", Esc or Ctrl-C cancels the running command and ends the follow-up conversation |
| Claude headless | `--tools ""` (no built-in tools at all), `--permission-mode dontAsk`, `--setting-sources ""` (the user's/project's settings.json can't widen it), `--strict-mcp-config`, only `mcp__stephen__*` allowed, Bash/Edit/Write/WebFetch etc. also disallowed as a second layer, `--max-turns` cap |
| Follow-ups: memories live and die together | A command within `voice.followUpWindowSec` (180 s) of the previous one's end `--resume`s its Claude session, and every server of that conversation runs with `serve --session-state <home>/voice/conversation-state.json`: it imports the earlier servers' private reads and approved hosts and writes each change (atomic, 0600) before the data or approved action reaches Claude. Window expired, error, cancel, Esc or "Stephen stop" → the listener deletes the state file and the session id before the next run. So Claude never remembers what the gate forgot (review #3 finding 1). **Phase 3 (`voice.warm`, default on):** the live listener keeps one warm `claude -p --input-format stream-json` and one serve per conversation, spawned on the wake word or F5 down, with the same lock-down argv. It also ends on a memory change, any error, an unused pre-warm after 60 s, 25 commands, 30 minutes or listener exit, always in the order kill the process group, wait until it is gone, then delete the session id and the state file. The rate limit (a sliding window, 40 actions in any 60 s) now counts per conversation. If the stream check fails at start, one `claude -p` per command as before. `followUpWindowSec: 0` = every command fresh |

## Workstreams (parallel worktrees)

| Worktree | Branch | Owns |
|---|---|---|
| wt-rename | `feat/rename-stephen` | all existing files (names, strings, paths, README, docs) — NOT `src/desktop/**`, `src/voice/**`, `test/desktop/**`, `test/voice/**`, `docs/STEPHEN.md`, `docs/DESKTOP.md`, `docs/VOICE.md` |
| wt-desktop | `feat/desktop` | `src/desktop/**`, `test/desktop/**`, `docs/DESKTOP.md`; minimal additive hooks in `src/server/hub.ts` if unavoidable (reported) |
| wt-voice | `feat/voice` | `src/voice/**`, `test/voice/**`, `docs/VOICE.md`, dependency entries in `package.json` |

Hook points already on `main`: `registerDesktopTools(mcp, hub, names)` (end of `registerTools`),
`stephen listen` → `runListen(argv)`, raw config sections `cfg.desktop` / `cfg.voice` (each module validates its own).

## Later phases
- **Phase 2:** signed Swift menu-bar app (owns Microphone / Accessibility / Input Monitoring), swallowed stop key,
  click/type in approved apps (tiers like Claude's own computer use: browsers view-only, terminals blocked),
  secure-input and frontmost-app checks before every input.
- **Phase 3:** Agent SDK + API key, one long-lived session talking to one long-lived Stephen server (no per-command
  start-up; the gate's memory then needs no state file), `onElicitation` → spoken/visual confirmation UI.
