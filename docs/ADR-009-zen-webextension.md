# ADR-009: Control the normal Zen through a Stephen add-on and native messaging

**Status:** Proposed. Paper only; no add-on code ships with this ADR. Build starts after the dev lane reviews this
ADR and Cris (owner) OKs the new browser permission.
**Date:** 2026-11-18
**Deciders:** Cris (owner), dev lane (picked option A), review lane (this write-up)
**Sources:** `docs/research/ZEN-REAL-BROWSER-2026-11.md` (#177), `docs/ADR-001-browser-control-stack.md`,
`docs/PLAN-WORK-SPLIT.md` section 14 (bot check), issue #205 (stop while music plays), the code in
`src/drivers/zen.ts`, `src/zen-launcher.ts`, `src/desktop/index.ts` (`tryAttach`, `openParsed`), `src/safety/`,
and the Zen 1.24.1b source in `omni.ja` (read on 2026-11-18). Option B facts were measured on a throwaway test
profile on Cris's Mac; his real profile was never opened.

## Context

- Today Stephen can drive Zen only when Zen was **started** with `--remote-debugging-port` (the "Zen for Stephen"
  app). A Zen opened the normal way cannot be attached to. Then `play_media` falls back to `open -a`, and Stephen
  cannot press play, pause or read the page (#177).
- Cris wants Stephen to work in his normal Zen: his usual windows, his logins, and no bot checks.
- With `--remote-debugging-port`, pages see `navigator.webdriver = true` and some sign-in pages show a bot check.
  Measured again today: `true` in that mode.
- The port opened by "Zen for Stephen" has no password. Any local process can drive the signed-in browser,
  outside Stephen's gate.
- The dev lane chose option A: a small Zen add-on (WebExtension) that talks to Stephen through Firefox native
  messaging. This ADR records how to do it safely, and the facts that rule option B in or out.

## Decision

Build a Stephen add-on for Zen and a native messaging host. The add-on is a **hand** only. Every decision stays
in `stephen serve`, behind the same gate, the same approval prompts and the same audit as today.

### Parts

1. **The add-on** (`stephen@stephen.local` or a final id chosen at signing; fixed in code). Manifest V3.
   - Permissions: `nativeMessaging`, `tabs`, `scripting`. Host access `<all_urls>` as an **optional** permission,
     asked once at install time in Zen's own dialog.
   - No `cookies`, `history`, `bookmarks`, `downloads`, `webRequest`, `management`, `privacy`, `proxy` or
     `debugger`. It never reads saved passwords or form data. Stephen does not need them, so the add-on does not
     ask for them.
   - Background script: one `runtime.connectNative("stephen_zen")` port. It turns a small set of commands into
     tab calls and content-script calls, and sends results back.
   - Content script: the same injected DOM walker the page engine already uses (snapshot, find, describe, click,
     type, key, scroll). It is injected on demand with `scripting.executeScript`, never declared for all pages.
2. **The native messaging host** (`stephen zen-host`, a Node entry in `dist/`). Zen starts it when the add-on
   connects, and stops it when the add-on disconnects. It talks to the add-on over stdin and stdout (Firefox's
   length-prefixed JSON). It talks to Stephen over a **Unix socket** at `<stephen home>/run/zen-ext.sock`
   (folder 0700, socket 0600), the same pattern as `helper.sock`.
3. **A new Zen transport in Stephen.** `tryAttach('zen')` tries, in order: the add-on socket, then the BiDi
   "Zen for Stephen" Zen (unchanged), then `open -a` (unchanged). Tools keep the same names and the same results.

### Message contract

- One JSON schema, checked with zod on **both** sides (host and serve), with size limits (for example 4 MB per
  snapshot, 64 KB per command).
- Commands are a closed list: `tabs.list`, `tab.open(url)`, `tab.focus`, `tab.close`, `tab.navigate(url)`,
  `page.snapshot`, `page.find`, `page.describe(ref)`, `page.readText`, `el.click(ref)`, `el.type(ref, text)`,
  `el.select(ref, value)`, `key.press(key)`, `page.scroll`, `media.state`, `media.toggle`.
- No `eval`, no "run this script", no free-form JavaScript. Anything not on the list is refused by the add-on.

## Threat model

Assets: Cris's signed-in Zen (mail, school, accounts), his page content, and his trust in the approval prompts.

| # | Threat | Control |
| --- | --- | --- |
| T1 | Another add-on, or a page, talks to Stephen's host | The host manifest lists **only** Stephen's add-on id in `allowed_extensions`. Zen refuses `connectNative` from any other add-on. Pages cannot call native messaging at all. |
| T2 | Someone installs a fake add-on with Stephen's id | The add-on is signed by Mozilla (AMO, unlisted). A signed id belongs to one AMO account, so nobody else can sign an add-on with it. Keep `xpinstall.signatures.required = true` in Zen (see "Signing"); with it off, any unsigned add-on could claim the id. |
| T3 | A page tells the add-on what to do | The add-on takes commands **only** from its native port. It has no `onMessageExternal` handler and no `window.postMessage` listener. Content scripts run in the isolated world and only answer the background script. |
| T4 | Page text steers the model (prompt injection) | Unchanged: everything the add-on returns (snapshots, text, titles, links) is wrapped as untrusted web data by `serve` (`wrapUntrusted`), exactly like BiDi results today. The add-on never reads page text as an instruction. |
| T5 | An action skips the gate | The add-on and host have no policy. Every action is built as an `ActionRequest` in `serve` and goes through `gate.check` and `hub.action` (Allow / Deny prompts, rate limit, audit) **before** a command is sent. The host only forwards. Tests must prove there is no path from a tool to the socket that skips the gate. |
| T6 | A local program drives Zen through the open door | **No TCP port.** The only door is the Unix socket, owner only (0600 in a 0700 folder). Other macOS users and sandboxed apps cannot reach it. A program already running as Cris can connect; such a program could also edit the profile directly, so this is out of scope, as for `helper.sock`. To narrow it: the host accepts one client at a time, and every connection is audited. |
| T7 | Privileged pages | The add-on refuses `about:`, `chrome:`, `moz-extension:`, `file:`, `view-source:` and `data:` targets, and Zen does not let add-ons script `about:` pages or addons.mozilla.org anyway. `serve` keeps its own URL rules. |
| T8 | Secrets typed or read | Unchanged rules: passwords, one-time codes and payment details are typed by Cris. The gate's sensitive-field rules apply to `el.type` as they do today. The add-on has no password or cookie permission. |
| T9 | Bot detection | The add-on does not set `navigator.webdriver`. Its clicks and keys are synthetic events (`isTrusted = false`); a few sites check that. Accepted; noted as a known limit. |
| T10 | Host binary swapped | The host manifest holds an absolute path to Stephen's own launcher. The manifest folder and file are owned by Cris. Doctor checks that the path exists, is executable, and points into Stephen's install. |

What does **not** change: the gate, the approval prompts, the audit log, "page text is data", and "browser
profiles are the owner's choice". The add-on lives in the profile Cris installs it in. Stephen never installs it
by itself.

## Install, remove, missing

### Install (owner, once)

1. `stephen install-zen-addon` writes the host manifest to
   `~/Library/Application Support/Mozilla/NativeMessagingHosts/stephen_zen.json` (`name`, `description`, absolute
   `path`, `type: "stdio"`, `allowed_extensions: ["<add-on id>"]`). Measured: Zen 1.24.1b reads this folder
   (`XREUserNativeManifests`), the same one Firefox uses.
2. It opens the signed `.xpi` in Zen. Zen shows its own "Add Stephen?" dialog with the permission list. Cris
   clicks Add, then allows "Access your data for all websites" (the optional host permission).
3. Doctor shows: manifest found, host path valid, add-on connected.

### Remove

- In Zen: Add-ons and themes, Stephen, Remove. The native port closes and the host exits.
- `stephen uninstall-zen-addon` deletes the host manifest and the socket. Without the manifest the add-on cannot
  reach Stephen even if it is still installed.

### Add-on missing or off

- `tryAttach('zen')` finds no socket, then tries BiDi, then uses `open -a` as today. "open X" still works.
- The tool text says once: "Stephen is not connected to Zen. Install the Stephen add-on (`stephen
  install-zen-addon`) or open Zen with Zen for Stephen." No retry loop.
- Doctor shows which one is missing: the manifest, the add-on, or the host.

## Signing and installing in Zen

Measured on Zen 1.24.1b (release channel), test profile:

- `xpinstall.signatures.required` is `true` by default, so Zen refuses unsigned add-ons.
- The build does **not** force signing (`AddonSettings.REQUIRE_SIGNING = false`), so a user can turn the pref off
  in `about:config`. That would let **any** unsigned add-on install. We do not ask Cris to do that.
- Decision: sign through addons.mozilla.org as an **unlisted** (self-distributed) add-on with `web-ext sign`.
  It is free and automatic, not public, and the `.xpi` is installed from a file. The AMO API key belongs to Cris
  and stays in the macOS Keychain, never in the repo. Each new add-on version is signed again.
- For development only: `about:debugging`, "Load Temporary Add-on" (removed when Zen restarts).

## Option B: Firefox runtime "Remote control" (`remote.experimental.dynamicstart`)

Tried for about 15 minutes on a throwaway profile in the scratchpad (never Cris's real profile). Zen was started
with that profile, `--new-instance`, and the devtools debugger server to drive the test. Facts:

| Question | Result |
| --- | --- |
| Off by default? | Yes: `remote.experimental.dynamicstart.enabled = false`. |
| How it turns on | Zen's "Remote control" toolbar button calls `RemoteControlServers.start()`. It starts the BiDi Remote Agent **and** Marionette (port 2828), and writes a port file to `~/.firefox-devtools-mcp/instances/<pid>.port`. |
| `navigator.webdriver` | `false` before start, `false` after start, `false` during a live BiDi session. Control: the same profile started with `--remote-debugging-port` gives `true`. So B fixes the bot flag. |
| Allow prompt | Every new connection waits on an "Allow remote control?" window ("An application wants to control this browser session. It can read the content of your tabs, access your saved data, and navigate to any website."). Measured: the session did not start for 15 s until the window was answered. A "Remember my decision until the browser exits" box exists. The prompt can be turned off with a pref (a security downgrade). |
| Banners | An info bar says remote control is on; the address bar shows a remote-control mark. |
| Survives a restart? | No. After Zen restarts, the agent is off and must be turned on again by hand. |
| Port | Fixed at **9222** (the code's default; only the command line can change it). |
| Port 9222 busy | **Zen force-quits.** Reproduced twice: with another program on 127.0.0.1:9222, turning on Remote control closed the whole test browser with no crash report. The code does this on purpose (`Services.startup.quit(eForceQuit)` when the agent cannot listen). On Cris's Mac, Chrome's remote debugging uses 9222 (doctor), so B could close his Zen whenever Chrome is open. |
| Open port | A loopback TCP port with no password for the whole session, like today's launcher. |

**Verdict: B is ruled out for now.** It fixes the bot flag, but it needs a click after every Zen start, a click
on every connection (or a weaker pref), it opens a TCP port, and it can close Zen when Chrome holds 9222. It is
also an experimental pref that can change in any release. Look again if Mozilla makes the port configurable and
the feature stable.

## Consequences

Good:
- Stephen works in the normal Zen: same windows, same logins, no `navigator.webdriver`, no relaunch.
- No TCP port. The add-on is visible and removable in Zen's own add-on list.
- Pause and next work in the normal Zen (`media.toggle`), which helps #205.

Costs:
- A new permission for Cris to OK: an add-on that can read and act on all sites.
- A second transport to build and test: the page engine must run without puppeteer (content script plus
  commands). Larger than one PR.
- Synthetic events: a few sites may ignore them. Autoplay: `video.play()` from an add-on may still be blocked
  until the page had a user gesture; `media.toggle` must fall back to the player button or the media key.
- Signing on every release, with Cris's AMO key.
- The manifest folder is shared with Firefox; installing the add-on there too would also connect. Doctor shows
  which browser is connected.

## Tests (when built)

- Unit: the zod schema refuses unknown commands, bad refs, privileged URLs and oversize messages (host and serve).
- Unit: every tool that acts through the add-on calls `gate.check` first; a denied request never reaches the
  socket (fake socket records nothing).
- Unit: results from the add-on come back wrapped as untrusted.
- Unit: socket created 0600 in a 0700 folder; a second client is refused.
- Unit: `tryAttach` order (socket, BiDi, `open -a`) and the "missing" message.
- Integration: a fake host over stdio with the real length-prefixed framing.
- Mac test by Cris: install, "play X" in normal Zen plays, "pause" pauses, a sign-in page shows no bot check,
  remove the add-on and Stephen falls back to `open -a`.

## Open questions for the dev lane

1. Add-on id and AMO account: Cris's own account?
2. Host lifetime: Zen starts the host only while the add-on keeps the native port open; the add-on must reconnect
   after Zen restarts and after a host crash.
3. One transport or two: keep BiDi for "Zen for Stephen", or retire it once the add-on works?
4. Does the voice path (a fresh `serve` per command) reach the socket fast enough? Measure connect time.
