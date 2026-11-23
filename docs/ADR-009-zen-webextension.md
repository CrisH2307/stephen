# ADR-009: Control the normal Zen through a Stephen add-on and native messaging

**Status:** Proposed, revision 2. Paper only; no add-on code ships with this ADR. Build starts after the dev lane
reviews revision 2 and Cris (owner) OKs the new browser permission.
**Date:** 2026-11-18 (revision 1, #212); revision 2 the same week.
**Deciders:** Cris (owner), dev lane (picked option A, security review on #212), review lane (this write-up)
**Sources:** `docs/research/ZEN-REAL-BROWSER-2026-11.md` (#177), `docs/ADR-001-browser-control-stack.md`,
`docs/PLAN-WORK-SPLIT.md` section 14 (bot check), issue #205 (stop while music plays), the dev-lane review comment
on #212, the code in `src/drivers/zen.ts`, `src/zen-launcher.ts`, `src/desktop/index.ts` (`tryAttach`,
`openParsed`), `src/page/runtime.ts`, `src/page/index.ts`, `src/safety/policy.ts`, and the Zen 1.24.1b source in
`omni.ja` (read on 2026-11-18). Option B facts were measured on a throwaway test profile on Cris's Mac; his real
profile was never opened.

**Revision 2 changes:** the dev lane's ten review points (marked R1 to R10 below), Cris's "simple setup for every
new user" requirement (section "Setup for a new user"), and publishing on AMO under Cris's account (section
"Publishing on AMO").

## Context

- Today Stephen can drive Zen only when Zen was **started** with `--remote-debugging-port` (the "Zen for Stephen"
  app). A Zen opened the normal way cannot be attached to. Then `play_media` falls back to `open -a`, and Stephen
  cannot press play, pause or read the page (#177).
- Cris wants Stephen to work in his normal Zen: his usual windows, his logins, and no bot checks.
- With `--remote-debugging-port`, pages see `navigator.webdriver = true` and some sign-in pages show a bot check.
  Measured again on 2026-11-18: `true` in that mode.
- The port opened by "Zen for Stephen" has no password. Any local process can drive the signed-in browser,
  outside Stephen's gate.
- The dev lane chose option A: a small Zen add-on (WebExtension) that talks to Stephen through Firefox native
  messaging. This ADR records how to do it safely, how a new user sets it up, and the facts that rule option B out.

## Decision

Build a Stephen add-on for Zen and a native messaging host. The add-on is a **hand** only. Every decision stays
in `stephen serve`, behind the same gate, the same approval prompts and the same audit as today.

### Parts

1. **The add-on.** Manifest V3. Its id is the one claimed on AMO under Cris's account (see "Publishing on AMO");
   it is fixed in code and in the host manifest.
   - Permissions: `nativeMessaging`, `tabs`, `scripting`. Host access `<all_urls>`, asked once at install time in
     Zen's own dialog.
   - No `cookies`, `history`, `bookmarks`, `downloads`, `webRequest`, `management`, `privacy`, `proxy` or
     `debugger`. It never reads saved passwords or form data. Stephen does not need them, so the add-on does not
     ask for them.
   - **Manifest settings (R8):** `incognito: "not_allowed"` (never in private windows); no
     `web_accessible_resources`; no `externally_connectable`; no `update_url` (R4); no remote code: every script is
     inside the `.xpi`, nothing is fetched and run.
   - Background script: one `runtime.connectNative("stephen_zen")` port. It turns a closed list of commands into
     tab calls and content-script calls, and sends results back. On connect it first sends a **hello** with its id
     and version (R10).
   - **Content script (R2):** injected on demand with `scripting.executeScript`, always with
     `world: "ISOLATED"`. Nothing is ever injected into the page's main world. It is the same DOM walker the page
     engine uses (`src/page/runtime.ts`), and like it, it keeps the ref-to-element map **in its own memory** (a
     `WeakMap` from element to `{ n, sig }` plus a map from ref number to element). It never writes refs as DOM
     attributes: a page could move such an attribute from "Cancel" to "Delete" after Cris approved the click.
2. **The native messaging host** (`stephen zen-host`, a Node entry in Stephen's install). Zen starts it when the
   add-on connects and stops it when the add-on disconnects. It talks to the add-on over stdin and stdout
   (Firefox's length-prefixed JSON) and to Stephen over a **Unix socket** at `<stephen home>/run/zen-ext.sock`
   (folder 0700, socket 0600), the same pattern as `helper.sock`. It keeps no log with page content.
3. **A new Zen transport in Stephen.** `tryAttach('zen')` tries, in order: the add-on socket, then the BiDi
   "Zen for Stephen" Zen (unchanged, until the add-on passes the Mac test), then `open -a` (unchanged). Tools keep
   the same names and the same results.

### Message contract

- One JSON schema, checked with zod on **both** sides (host and serve), with size limits (for example 4 MB per
  snapshot, 64 KB per command).
- Commands are a closed list: `tabs.list`, `tab.open(url)`, `tab.focus`, `tab.close`, `tab.navigate(url)`,
  `page.snapshot`, `page.find`, `page.describe(ref)`, `page.readText`, `el.click(ref)`, `el.type(ref, text)`,
  `el.select(ref, value)`, `key.press(key)`, `page.scroll`, `media.state`, `media.toggle`.
- No `eval`, no "run this script", no free-form JavaScript. Anything not on the list is refused by the add-on.
- **Every acting command carries what the gate saw (R1):** the tab's expected top-level URL and document id, and
  for element actions the element's signature (`sig`, as in `runtime.ts`). The add-on compares them with the live
  tab and element just before it acts. If either changed while Cris was approving, it does nothing and answers
  `STALE_REF`, exactly like the BiDi path does today.

## Threat model

Assets: Cris's signed-in Zen (mail, school, accounts), his page content, and his trust in the approval prompts.

| # | Threat | Control |
| --- | --- | --- |
| T1 | Another add-on, or a page, talks to Stephen's host | The host manifest lists **only** Stephen's add-on id in `allowed_extensions`. Zen refuses `connectNative` from any other add-on. Pages cannot call native messaging at all. |
| T2 | Someone signs a fake add-on with Stephen's id (R4) | The id will be public in this repo, and whoever signs an id on AMO first owns it. So Cris claims it **before** the id is pushed (see "Publishing on AMO"). After that, no other AMO account can sign that id. Keep `xpinstall.signatures.required = true` in Zen; with it off, any unsigned add-on could claim the id. |
| T3 | A page tells the add-on what to do | The add-on takes commands **only** from its native port. It has no `onMessageExternal` handler, no `externally_connectable`, and no `window.postMessage` listener. The content script runs in the isolated world and only answers the background script. |
| T4 | Page text steers the model (prompt injection) | Unchanged: everything the add-on returns (snapshots, text, titles, links) is wrapped as untrusted web data by `serve` (`wrapUntrusted`), exactly like BiDi results today. The add-on never reads page text as an instruction. |
| T5 | An action skips a check (R1) | The add-on and host have no policy. Every action is built as an `ActionRequest` in `serve` and goes through `gate.check` and `hub.action` (Allow / Deny prompts, rate limit, audit) **before** a command is sent. The add-on transport also keeps every check that runs **at action time** today: the element identity re-check after approval (`sig` plus document id, refused with `STALE_REF`); the focus re-check between typing chunks (`verify: () => hub.recheckFocus(...)`, as in `src/desktop/media-tab.ts` and `src/page/index.ts`); `blockedPageReason` on the **live** page URL; the payment-frame rules (`classify.ts`) and secret-field rules. Frame URLs come from the browser (`scripting.executeScript` frame results, `tabs`), never from page text. A frame whose URL is unknown counts as a payment or sensitive frame, so it fails closed. |
| T6 | A local program drives Zen through the open door | **No TCP port.** The only door is the Unix socket. Other macOS users and sandboxed apps cannot reach it. A program already running as Cris can connect; such a program could also edit the profile directly, so this cannot be fully prevented for the same user, as for `helper.sock`. The host accepts one client at a time. |
| T7 | Privileged or script URLs (R3) | **Allow list, not a block list.** The add-on accepts only `http:`, `https:` and `about:blank` as targets, the same rule as `blockedTargetReason` in `src/safety/policy.ts`. So `javascript:`, `blob:`, `data:`, `file:`, `resource:`, `about:` pages and `moz-extension:` are all refused. Serve's check is the one that counts; the add-on's is a second check. Zen also never lets add-ons script `about:` pages or addons.mozilla.org. |
| T8 | Secrets typed or read | Unchanged rules: passwords, one-time codes and payment details are typed by Cris. The gate's sensitive-field rules apply to `el.type` as they do today. The add-on has no password or cookie permission. |
| T9 | Bot detection | The add-on does not set `navigator.webdriver`. Its clicks and keys are synthetic events (`isTrusted = false`); a few sites check that. Accepted; a known limit. |
| T10 | Host or manifest swapped (R5) | **What it can do:** whoever controls the manifest `path` or the host file can send any listed command to the add-on, on every site, with no gate, because the add-on trusts its native port. This is the same-user risk already accepted for `helper.sock`; it is written down here on purpose. **Guards:** (1) serve checks the manifest **on every connect**, not only in doctor: a real file, not a symlink, owned by Cris, not group- or world-writable, `path` points into Stephen's install, and `allowed_extensions` is exactly `[<id>]`; if any check fails, serve does not use the socket and falls back. (2) The launcher in `path` runs node by its **full path**, never found through `PATH`. (3) The host exits unless `argv` carries the expected add-on id (Firefox passes it; weak, but free). (4) The host never deletes a socket that still answers: it tries to connect first, so a second `stephen zen-host` started by hand cannot take the socket over. |
| T11 | Something other than Zen starts the host (R6) | Possible: any program running as Cris can run `stephen zen-host` and speak the stdio protocol. It then poses as "Zen": it receives the commands serve sends and returns fake pages. It **cannot** drive the real Zen, and what it returns is untrusted data anyway. Guards: those of T10, plus T12 (the host cannot take a live socket). This cannot be fully prevented for the same user. |
| T12 | Socket swapped or opened wide (R7) | Serve checks the socket like `helper.sock` before every connect: `lstat` says a socket (not a symlink), owner uid is Cris, mode 0600, folder 0700. **Serve** writes one audit line per connection: "connected to Zen add-on `<id>` `<version>`" with the hello's id and version. The host writes no page content anywhere. |
| T13 | A model, a page or the phone installs, removes or re-points the add-on (R9) | **Owner only.** `stephen setup zen` and `stephen setup zen --remove` are CLI commands Cris types. No MCP tool, voice command, phone request or job can run them, write the host manifest, or change `xpinstall.signatures.required`. A test checks that no tool or route can reach them. |
| T14 | A bad add-on update (R4) | See "Updates" below: no `update_url`, every version reviewed by the dev lane before it is signed, the AMO key only in Cris's Keychain, and serve compares the hello version with the versions Stephen knows. |

What does **not** change: the gate, the approval prompts, the audit log, "page text is data", and "browser
profiles are the owner's choice". The add-on lives in the profile Cris installs it in. Stephen never installs it
by itself.

## Setup for a new user

Target (Cris's requirement): **one command, then one click.** No `about:config`, no second profile or window, no
debug port, no restart of Zen.

### What the user does

1. In Terminal: `stephen setup zen`
2. Zen shows the Stephen add-on page. Click **Add to Firefox**, then **Add** in Zen's dialog.

That is all. Within a few seconds `stephen doctor` shows "Zen add-on: connected". Zen shows the button as
"Add to Firefox" because AMO sees Zen as Firefox.

### What `stephen setup zen` does

1. Checks Zen is installed (same lookup as today). If not: "Zen is not installed. Install it from zen-browser.app,
   then run `stephen setup zen` again." Nothing is written.
2. Writes the host manifest to
   `~/Library/Application Support/Mozilla/NativeMessagingHosts/stephen_zen.json` (`name`, `description`, absolute
   `path` to Stephen's launcher, `type: "stdio"`, `allowed_extensions: ["<add-on id>"]`), mode 0644, owned by the
   user. Measured: Zen 1.24.1b reads this folder (`XREUserNativeManifests`), the same one Firefox uses.
3. Opens the add-on's AMO page in Zen (`open -a <Zen.app> https://addons.mozilla.org/firefox/addon/<slug>/`).
   Before the listing is approved, or with `--offline`, it opens the `.xpi` that ships inside Stephen's install
   instead, after checking its pinned sha256 (R4). Zen then shows the same "Add" dialog. Nothing is downloaded by
   Stephen.
4. Waits up to 2 minutes for the hello on the socket, then prints one line: "Done. Stephen is connected to Zen."
   or the doctor line below. Running it again is safe: it rewrites the same manifest and reopens the page.

`stephen setup zen --remove` deletes the host manifest and the socket and prints: "Stephen can no longer use Zen.
To remove the add-on too: Zen, Add-ons and themes, Stephen, Remove."

### What `stephen doctor` says

| State | Doctor line (fix) |
| --- | --- |
| Manifest missing | "Zen add-on: not set up. Run `stephen setup zen`." |
| Manifest fails a T10 check | "Zen add-on: the setup file was changed (`<which check>`). Run `stephen setup zen` again." |
| Manifest ok, no hello | "Zen add-on: not connected. In Zen, open Add-ons and themes and check that Stephen is installed and turned on. If it is not there, run `stephen setup zen`." |
| Hello with a wrong id | "Zen add-on: a different add-on answered (`<id>`). Stephen does not use it. Remove it in Zen, then run `stephen setup zen`." |
| Hello with an unknown version | "Zen add-on: version `<v>` is not one this Stephen knows. Update Stephen, or reinstall the add-on with `stephen setup zen`." |
| Connected | "Zen add-on: connected, `<id>` `<version>`." (R10: Cris can see it is the real one.) |
| After `--remove`, add-on still answers | "Zen add-on: still installed in Zen. Remove it there: Add-ons and themes, Stephen, Remove." (R10) |

### Add-on missing or off at run time

- `tryAttach('zen')` finds no socket, then tries BiDi, then uses `open -a` as today. "open X" still works.
- The tool text says once: "Stephen is not connected to Zen. Run `stephen setup zen`." No retry loop.

## Publishing on AMO

Cris wants the add-on on addons.mozilla.org so a new user installs it with one click. AMO signs it, so
`xpinstall.signatures.required` stays on.

### Steps for Cris (once)

1. **Mozilla account.** Go to `https://accounts.firefox.com`, create an account with an email Cris controls, and
   turn on two-step authentication (Settings, Two-step authentication). Save the recovery codes offline.
2. **Developer Hub.** Sign in at `https://addons.mozilla.org/developers/`, accept the Firefox Add-on Distribution
   Agreement, and fill in the developer profile (name, and the email AMO shows to reviewers).
3. **Claim the id before it is public (R4).** The dev lane prepares a stub: a `manifest.json` with
   `browser_specific_settings.gecko.id` set to the chosen id (an email-style id under a name Cris controls, for
   example `stephen-zen@<domain Cris owns>`), version `0.0.1`, no permissions, no code. The id is **not** pushed to
   GitHub yet. Cris uploads the stub on Developer Hub, "Submit a New Add-on", "On your own" (unlisted). Signing an
   unlisted version is automatic and usually takes minutes. From then on, only Cris's account can sign that id.
   Only after that may the id appear in the repo.
4. **API key for signing.** Developer Hub, Tools, Manage API Keys, generate. Store both values in the macOS
   Keychain, never in a file:
   `security add-generic-password -a "$USER" -s stephen-amo-jwt-issuer -w`
   `security add-generic-password -a "$USER" -s stephen-amo-jwt-secret -w`
   (each asks for the value). Signing reads them from the Keychain for one run of `web-ext sign`.
5. **Listing.** When the first real version is reviewed by the dev lane, Cris submits it "On this site" (listed),
   with the description saying that it needs the Stephen app on the Mac (native messaging) and what it can do.
   Add-ons with native messaging and access to all sites get a human review on AMO; plan for days, not minutes.
   AMO also asks for the add-on's data-collection declaration in the manifest; the dev lane fills it in honestly
   (page content goes only to the Stephen app on the same Mac).

Never in the repo, CI or GitHub secrets: the AMO API key, the Mozilla account password, the recovery codes.
Whoever holds the API key can ship code that runs on every site Cris visits.

### Updates (R4, and a choice for Cris)

- No `update_url` in the manifest: no update server of our own.
- Every version is reviewed by the dev lane before Cris signs it, by hand, on his Mac. Never from CI.
- Stephen's install ships the reviewed `.xpi` with its sha256 pinned. `stephen setup zen --offline` checks the pin.
- Serve keeps the list of reviewed versions and compares the hello version with it. An unknown version is not
  used (doctor line above). This is a weak check: a malicious version could claim a known version number. It still
  catches honest mismatches.
- **Choice for Cris:** a **listed** add-on is updated by Zen from AMO automatically. That is what makes the
  one-click install possible, but it also means a new version signed with Cris's account reaches users without
  `stephen setup zen`. The dev lane's review asked that a new version come **only** through Stephen's install.
  The two cannot both hold for a listed add-on. Options:
  - (a) Listed, AMO updates on (simplest for users). Guard: 2FA on the account, key only in the Keychain, dev-lane
    review before every upload, AMO's own review of each listed version.
  - (b) Unlisted, installed from the pinned `.xpi` by `stephen setup zen` (still one click on "Add"). No automatic
    updates; a new version comes only with a new Stephen. Not discoverable on AMO.
  - Review lane's recommendation: (b) until the add-on is stable, then (a) if Cris wants public users. Cris and
    the dev lane decide.

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

**Verdict: B is ruled out for now** (the dev lane agreed on #212). It fixes the bot flag, but it needs a click
after every Zen start, a click on every connection (or a weaker pref), it opens a TCP port, and it can close Zen
when Chrome holds 9222. It is also an experimental pref that can change in any release. Look again if Mozilla
makes the port configurable and the feature stable.

## Consequences

Good:
- Stephen works in the normal Zen: same windows, same logins, no `navigator.webdriver`, no relaunch.
- Setup for a new user is one command and one click.
- No TCP port. The add-on is visible and removable in Zen's own add-on list.
- Pause and next work in the normal Zen (`media.toggle`), which helps #205.
- Once the add-on passes the Mac test, the BiDi "Zen for Stephen" port can be retired (dev lane, open question 3).

Costs:
- A new permission for Cris to OK: an add-on in his normal Zen with "access your data for all websites". It acts
  only when serve sends a command after the gate. In return, the passwordless debug port goes away. The remaining
  risk, a program already running as Cris, is the same as today and smaller than today's open port.
- A second transport to build and test: the page engine must run without puppeteer (content script plus
  commands). Larger than one PR.
- Synthetic events: a few sites may ignore them. Autoplay: `video.play()` from an add-on may still be blocked
  until the page had a user gesture; `media.toggle` must fall back to the player button or the media key.
- Signing every version by hand with Cris's AMO key, and an AMO review for listed versions.
- The manifest folder is shared with Firefox; installing the add-on there too would also connect. Doctor shows
  which add-on id and version are connected.

## Tests (when built)

- Unit: the zod schema refuses unknown commands, bad refs, non-allowed URL schemes (`javascript:`, `blob:`,
  `resource:`, `data:`, `file:`) and oversize messages (host and serve).
- Unit: every tool that acts through the add-on calls `gate.check` first; a denied request never reaches the
  socket (fake socket records nothing).
- Unit (R1), next to the test above: a changed `sig`, a changed document id or a changed top-level URL between
  approval and action gives `STALE_REF` and no action; the focus re-check runs between typing chunks; a frame with
  an unknown URL is treated as a payment or sensitive frame.
- Unit (R2): the content script is injected with `world: "ISOLATED"` only, and no DOM attribute carries a ref.
- Unit: results from the add-on come back wrapped as untrusted.
- Unit (R5, R7): serve refuses a manifest that is a symlink, writable by others, owned by someone else, points
  outside the install, or lists more than one id; serve refuses a socket that is a symlink, not 0600 or not owned
  by Cris; the host does not delete a socket that still answers; the host exits without the expected id in argv.
- Unit (R9): no MCP tool, voice route, phone route or job can call `setup zen` or write the manifest.
- Unit (R10): hello with a wrong id or an unknown version is not used; the audit line names id and version.
- Unit: `tryAttach` order (socket, BiDi, `open -a`) and the "missing" message.
- Unit: `stephen setup zen` writes the exact manifest, refuses when Zen is missing, checks the `.xpi` sha256 with
  `--offline`, and is safe to run twice; `--remove` deletes manifest and socket.
- Integration: a fake host over stdio with the real length-prefixed framing.
- Mac test by Cris: `stephen setup zen`, one click, "play X" in normal Zen plays, "pause" pauses, a sign-in page
  shows no bot check, `stephen setup zen --remove` and Stephen falls back to `open -a`.

## Open questions

1. AMO account: Cris's own (answered on #212). The id itself is still to be chosen and claimed (step 3 above).
2. Host lifetime: Zen starts the host only while the add-on keeps the native port open; the add-on must reconnect
   after Zen restarts and after a host crash. Reliability, not security.
3. Keep BiDi "Zen for Stephen" until the add-on passes the Mac test, then retire its open port (answered on #212).
4. Does the voice path (a fresh `serve` per command) reach the socket fast enough? Measure connect time.
   Reliability, not security.
5. Listed with AMO updates, or unlisted from the pinned `.xpi` (section "Updates"). Cris and the dev lane decide.
