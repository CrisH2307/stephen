# Stephen — System Design

> Stephen was called browser-hub until phase 1 of `docs/STEPHEN.md` (MCP server `stephen`, home `~/.stephen`, launcher "Zen for Stephen").

Let Claude Code drive **Zen** and **Chrome** on macOS for everyday productivity work, through one MCP server with one tool vocabulary and a safety gate it cannot talk its way past.

## 1. Requirements

### Functional
- F1. Connect to Chrome (real logged-in profile via Chrome 144+ consent, or a dedicated agent profile) and Zen (dedicated agent profile, or real profile via relaunch).
- F2. List, open, focus and close tabs in either browser; existing user tabs are visible.
- F3. Read pages: compact interactive snapshot with refs, `find` by text, readable text extraction, screenshots.
- F4. Act on pages: navigate/back/forward/reload, click, type, fill several fields, select options, press keys, hover, scroll, wait for text, upload files, answer JS dialogs.
- F5. Safety: blocked + sensitive domains, never touch password/OTP/payment fields, confirm high-risk actions with a human, rate limit, audit log, `recent_actions`.
- F6. CLI: `serve` (MCP stdio), `doctor` (diagnose the Mac setup), `selftest` (prove each installed browser works end to end on this machine — temporary agent profile, local fixture pages, safety refusals checked; see §3.6), `install` (print/run the `claude mcp add` line).

### Non-functional
- Every tool result ≤ ~10k tokens by default (hard char caps, opt-in file spill).
- Never quit or close the user's browser on disconnect; never change user's real-profile data beyond what's documented.
- Debug endpoints on loopback only; MCP over stdio only.
- Survive server restarts: reattach to an agent browser that is still running.
- Works with Claude Code over stdio, MCP SDK v1.

### Constraints
- Node ^20.19.0 || >=22.12.0 (tests: 22.12+ or 24, for vitest 5), ESM, TypeScript strict. Deps: `puppeteer-core`, `@modelcontextprotocol/sdk`, `zod`. Dev: `typescript`, `vitest`, `@types/node`, `@sparticuz/chromium` (real browser for tests on Linux CI).
- macOS-specific paths are overridable by config (so Linux tests run).

## 2. High-level design

```
 Claude Code ──stdio(MCP)──▶ ┌────────────────────────── Stephen ──────────────────────────┐
                             │ server/   McpServer + tool handlers (zod schemas)             │
                             │    │            │                                            │
                             │    ▼            ▼                                            │
                             │ safety/   SafetyGate ── policy · classify · confirm · audit    │
                             │    │   (every mutating call: resolve live element → check)    │
                             │    ▼                                                          │
                             │ page/     snapshot walker · ref resolver · actions · text     │
                             │    │                                                          │
                             │ drivers/  BrowserManager + TabRegistry                        │
                             │           ChromeDriver (CDP)        ZenDriver (BiDi)          │
                             └──────────────┬──────────────────────────┬────────────────────┘
                                            ▼                          ▼
                              Google Chrome (real/agent)       Zen (agent/real)
                         DevToolsActivePort → ws://…           stderr "WebDriver BiDi listening
                                                                on ws://127.0.0.1:N" → /session
```

### Request flow (mutating tool, e.g. `click {target:"z1:e12"}`)
1. server: parse with zod → `parseRef("z1:e12")` → tab `z1` → `TabRegistry.get` → `Page`.
2. page: `describeRef(page, ref)` re-resolves the **live** element (throws `StaleRefError` if gone) → `ElementInfo`.
3. safety: `gate.check({kind:'click', element, pageUrl, intent, …})` → allow | confirm (ask human with real button text + origin) | deny.
4. page: `click(page, ref)` via a real puppeteer `ElementHandle.click()`.
5. audit: append JSONL (tool, redacted args, element summary, url before/after, risk, outcome).
6. result: one-line outcome + `title · url` (+ optional fresh snapshot when `include_snapshot: true`).

## 3. Deep dive

### 3.1 Drivers (`src/drivers/`)

**ChromeDriver** (`protocol: 'cdp'`)
- `mode: 'real'` — read `<chromeUserDataDir>/DevToolsActivePort` (default `~/Library/Application Support/Google/Chrome/DevToolsActivePort`): line 1 = port, line 2 = `/devtools/browser/<id>`. `puppeteer.connect({browserWSEndpoint: 'ws://127.0.0.1:<port><path>', defaultViewport: null})`. Missing/stale file → actionable error: "Open chrome://inspect/#remote-debugging and enable *Allow remote debugging for this browser instance*, then click Allow when Chrome asks." Keep **one long-lived connection** (each new one triggers Chrome's Allow dialog). Wait up to 60 s for the user to click Allow (status shows "waiting for Allow"; the timeout error says the port is open but nobody clicked Allow, and where the dialog may hide).
- `mode: 'agent'` — profile dir `~/.stephen/profiles/chrome`. If its `DevToolsActivePort` points to a live endpoint, reattach. Else spawn Chrome detached: `--user-data-dir=<dir> --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check`, poll `DevToolsActivePort` (≤15 s), connect. Never `--remote-allow-origins=*`.
- `disconnect()` → `browser.disconnect()` (never `close()`).

**ZenDriver** (`protocol: 'webDriverBiDi'`)
- Binary default `/Applications/Zen.app/Contents/MacOS/zen` (also probe `Zen Browser.app`, `Zen Twilight.app`; config override).
- **Default: attach-only real mode** (`mode: 'real'`, `launch: 'never'`). Gecko's Remote Agent can only be enabled by *starting* Zen with `--remote-debugging-port` ([Firefox remote security](https://firefox-source-docs.mozilla.org/remote/Security.html)) — a normally opened Zen can never be attached to, and Zen refuses unsigned extensions. So the user opens their everyday Zen through `stephen zen-launch` (wrapped by the "Zen for Stephen" applet, below) and the driver only attaches. With `launch: 'never'` the driver **never spawns Zen** (any mode):
  - **Stephen-ready Zen running** — the state file names a live pid in this mode on the same profile → reattach over BiDi (the normal reattach path; records `ownerPid`). A state still `starting` is waited for, never relaunched.
  - **Zen running, not Stephen-ready** (`pgrep -x zen`, no usable state / endpoint refuses) → `NEEDS_USER`: "Zen is open, but it wasn't started with Stephen access, so Stephen can't connect to it. Stephen needs "Zen for Stephen". Stephen can only connect to a Zen that was started with its remote-control port open. A normal Zen window does not open that port. The 'Zen for Stephen' app opens Zen with it. Quit Zen (⌘Q) and reopen it with the 'Zen for Stephen' app (or run `stephen zen-launch`). Your tabs come back if Zen is set to restore your previous session."
  - **Zen not running** → `NEEDS_USER`: open Zen with the Zen for Stephen app (setup: `install-zen-launcher`).
  - Agent mode with `launch: 'never'` likewise only reattaches (error says to set `launch: 'auto'`).
  - Never quits or kills Zen. `browser_connect zen mode:'agent'` is refused in attach-only (it would open a separate Zen); `browser_status`/`browser_connect` print "Zen: attach-only (uses your open Zen; never launches one)"; server `instructions` tell the model to relay the error once and not retry in a loop, and to prefer the user's tabs / `tab_open` in their Zen.
- **`stephen zen-launch [--quit-running] [--json]`** (`src/zen-launcher.ts` + `ZenDriver.inspect()/launchForClaude()`): `inspect('real')` = state names a live pid, mode real, same profile, ws endpoint answers a TCP probe (no BiDi session — Gecko allows one). Ready → `open -a <Zen.app>` (bring to front), exit 0. Zen running normally → exit 2 with a message, or with `--quit-running` → `osascript -e 'tell application id "<CFBundleIdentifier from Zen.app/Contents/Info.plist, default app.zen-browser.zen>" to quit'` (same as ⌘Q), poll `pgrep` ≤ 20 s, never kill; still running → exit 2. Otherwise launch with the driver's launch code (binary, real profile from `profiles.ini`, `user.js` block, `--remote-debugging-port 0`, log file, "WebDriver BiDi listening" parse), write `{pid, wsUrl, profileDir, mode:'real'}` (no `ownerPid`), open **no** session, exit 0 leaving Zen detached. Exit codes 0 ready / 2 user action / 1 error; the message goes to stderr on non-zero (the applet shows it).
- **`stephen install-zen-launcher [--dry-run]`** builds `~/Applications/Zen for Stephen.app` with `osacompile`: the AppleScript runs `do shell script (quoted form of <process.execPath>) & " " & (quoted form of <dist/cli.js>) & " zen-launch"` (paths are escaped AppleScript literals; locals, not `property`, so the applet never rewrites itself). Exit 2 + "Zen is open without Stephen access." → dialog *Cancel / Reopen* → `zen-launch --quit-running`; other failures → dialog with the message. Copies Zen's `.icns` (CFBundleIconFile) over `applet.icns`, writes a marker (re-install only replaces its own app), re-signs ad hoc. macOS only (`--dry-run` prints the plan anywhere).
- **Security trade-off** (README): while Zen runs Stephen-ready, any local program can drive it through the password-less loopback port (Chrome blocks remote debugging on default profiles for this reason). Users should quit and reopen Zen normally when they don't need Claude.
- `mode: 'agent'` (opt-in: `{"mode": "agent", "launch": "auto"}`) — profile dir `~/.stephen/profiles/zen` (created if missing). Runs **alongside** the user's normal Zen.
- `mode: 'real'` with `launch: 'auto'` (the old real mode) — profile path from config or `profiles.ini` under `~/Library/Application Support/zen/` (prefer `[Install*] Default=`, else the `Default=1` profile). If Zen is running (`pgrep -x zen` — the `.parentlock` file is NOT inspected: macOS holds it with an fcntl lock Node can't probe, and a stale file proves nothing), fail with "Quit Zen (⌘Q) and retry — Zen must be relaunched with remote control enabled." A second Zen on an in-use profile exits immediately; that exit is reported with the same advice. Write `user_pref("remote.prefs.recommended", false);` into `user.js` inside a clearly marked block so automation prefs don't alter the real profile.
- **user.js block in BOTH modes (review #2 #9, #16).** Gecko's RemoteAgent applies "recommended automation prefs" at startup unless `remote.prefs.recommended` is false; they turn off Safe Browsing, Remote Settings (security blocklists), app/extension updates and password saving. Real profile: that one line, nothing else. Agent profile (written before every launch): that line + first-run/welcome/default-browser suppression + config `zen.extraPrefs` (validated: dotted names, bool/int/one-line string; `remote.prefs.recommended` reserved; never written to the real profile). `fission.webContentIsolationStrategy` is NOT set by default (Puppeteer's Firefox launcher sets it to 0 because automated clicks can't reach out-of-process iframes, bug 1773393; that weakens site isolation in a browser that visits hostile pages). README documents the opt-in via `zen.extraPrefs` if selftest check 12 fails on Zen; the selftest carries `extraPrefs` over so the opt-in can be verified and shows that hint on a Zen check-12 failure.
- Launch: `spawn(zen, ['--profile', dir, '--new-instance', '--remote-debugging-port', '0'], {detached})`; output goes to `<stateDir>/zen-<mode>.log`, polled until `WebDriver BiDi listening on (ws://127.0.0.1:\d+)` (≤60 s — the first launch after a Zen update is slow). Endpoint = `<url>/session`. `puppeteer.connect({browserWSEndpoint, protocol: 'webDriverBiDi', defaultViewport: null})`.
- **Zen is never killed** — not even one we launched that is slow to start (it may be the real profile). On timeout it is left running, the state file marks it `starting`, and the next connect resumes polling its log instead of launching a second Zen.
- State file `~/.stephen/state/zen.json` `{pid, wsUrl, profileDir, mode, ownerPid?, starting?, logPath?}` → reattach on restart if pid alive. `ownerPid` = the Stephen process whose BiDi session is open (cleared on disconnect).
- One BiDi session at a time: always end it on `disconnect()` and on process exit/SIGINT/SIGTERM. "Maximum number of active sessions" → if `ownerPid` is another live process: "another Claude Code session is using Zen's agent profile; close that session or use Chrome" (never "quit Zen", which would break that session); otherwise (stale session from a crash) tell the user to quit and reopen the agent Zen.
- Debug ports outlive the server by design (agent Zen/Chrome keep running for reattach; a real-profile Zen keeps its BiDi port until it is restarted). README tells the user to restart Zen after a real-mode session.

**Private dirs**: `~/.stephen` and its `profiles/`, `state/`, `output/` dirs are created (or chmod-ed) 0700 at startup and whenever a driver creates them; files written there are 0600.

**BrowserManager**: `get(name)` lazily connects using configured mode; `connect(name, mode)`; `status()`; `shutdown()` disconnects all. Emits `disconnected` → TabRegistry purges that browser's tabs.

**TabRegistry** also records which tabs Stephen opened (`openTab`) — `BrowserManager.openedByHub(tab)` (not in the frozen `IBrowserManager`; the server treats a manager without it as "every tab is the user's"). `closeTab` uses `page.close({runBeforeUnload: true})` and waits ≤ 5 s for the `close` event; a tab kept open by its "leave page?" dialog stays registered (CDP: `Page.close` returns at once and the dialog follows; BiDi: `browsingContext.close` blocks until the prompt is answered — both surface as a page `dialog` event).

**TabRegistry**: stable short ids `c1, c2…` (Chrome) / `z1, z2…` (Zen) mapped to `Page` objects (WeakRef-free; purge on `close`/`targetdestroyed`). `list(browser?)` refreshes from `browser.pages()` (30 s timeout; on timeout it falls back to the already-known tabs, and titles are read ≤16 at a time) so user-opened tabs appear. Tracks the "current" tab per browser (last used/opened).

### 3.2 Page engine (`src/page/`)

**Ref grammar:** `<tabId>:e<n>` for the main frame, `<tabId>:f<k>e<n>` for child frame *k*. Refs are opaque to the model. Element numbers *n* and frame indexes *k* are **monotonic per tab across documents** (Node tracks the next number and seeds the runtime), so a ref from a previous page can never name an element on the new page — it resolves as `STALE_REF` (review #8).

**Snapshot walker** (one function serialized into each frame's **isolated world** — `frame.isolatedRealm()`, which works under both CDP and BiDi — so page scripts can neither see nor poison it; review #9). The walker returns **structured data only**; Node builds every output line, escapes names/values (quotes, newlines, `[ref=` sequences) and accepts only refs the walker actually issued for that frame:
- Keeps state on `window.__bhRefs = {seq, byRef: Map<string,Element>, byEl: WeakMap<Element,string>}` per frame. An element keeps its ref while connected and its role+name are unchanged (Playwright-style stability). Lookup only against the latest snapshot generation; `isConnected` check → else stale.
- Role: explicit `role` attr, else implicit from tag/type (a[href]→link, button, input types → textbox/checkbox/radio/combobox/searchbox/spinbutton/slider, select→combobox, textarea→textbox, `[contenteditable]`→textbox, h1–h6→heading, img[alt]→img, nav/main/header/footer/aside/form/dialog → landmarks, table/row/cell, li→listitem, summary→button, label…).
- Name: `aria-labelledby` → `aria-label` → `<label for>`/wrapping label → `alt`/`title`/`placeholder` → text content (collapsed, ≤80 chars).
- Visibility: skip `display:none`, `visibility:hidden`, `opacity:0`, zero-size, `aria-hidden="true"`, `hidden`, `inert`, clipped/off-document; count them as `hiddenOmitted`. Text with near-zero alpha or fontSize < 2px is dropped as likely injection carrier.
- `filter: 'interactive'` (default): only interactive nodes + their landmark/heading ancestors as context. `'all'`: headings, text paragraphs (truncated), lists, tables too.
- States: `checked`, `selected`, `expanded`, `disabled`, `required`, `value="…"` (≤60 chars; **always `value=[redacted]` for password/OTP/payment-like fields**).
- Output (text, indented two spaces per level):
  ```
  Page: Inbox (12) – Gmail
  URL: https://mail.google.com/mail/u/0/#inbox
  - navigation "Main"
    - link "Inbox 12" [ref=z1:e3]
    - button "Compose" [ref=z1:e4]
  - textbox "Search mail" [ref=z1:e5]
  - checkbox "Select" [ref=z1:e9] checked
  [42 refs · 3 hidden elements omitted · truncated at 20000 chars — use find or scope]
  ```
- Child frames: walk `page.frames()` (skip detached, `about:blank` without content); same-process or not, `frame.evaluate` works in both protocols. Each frame's subtree is emitted under `- iframe "<url host>"`.

**API** (all take a puppeteer `Page`): `snapshot`, `find`, `readText`, `describe` (→ `ElementInfo` for safety, incl. `formSummary` for submit/dialog buttons: what the click would send, secrets redacted), `describeFocused`, `click`, `hover`, `type`, `selectOption`, `pressKey`, `scroll`, `waitFor`, `screenshot`, `uploadFile`. Actions get an `ElementHandle` for the ref and scroll it into view first.
- **click** is hit-tested: `elementFromPoint` at the click point (through open shadow roots, in the element's frame and every ancestor frame) must be the target or inside it, else `OBSCURED` and nothing is clicked (review #7); the covering element's role/name travels in `PageTextError.pageText`, which the server shows only inside `<untrusted_web_content>` (review #2 finding 8).
- **type** *inserts* text — it is never replayed as key presses, so `\n`/`\t` can't submit a form or move focus (review #2). In textarea/contenteditable `\n`/`\t` become content; in a single-line input they are refused (`INVALID_ARG`, "use submit: true"). Text goes in chunks; between chunks the engine checks focus is still on the target and stops with `FOCUS_MOVED` or `TIMEOUT` — nothing lands after either (review #11). `clear` selects-all + deletes. `submit` presses Enter only if focus is still on the field.
- **describeFocused** returns null only when focus is on body/html/nothing, and **throws** when it can't tell (closed shadow root, unreadable frame) — the server maps that to `focus:'unknown'`.
- **screenshot** caps each side at 8000 px and total pixels at ~25 MP (clips and says so).
- Secret-field and payment-frame rules come from `src/lib/secret-fields.ts`, shared with the gate (review #13).

**readText:** article-ish extraction — prefer `main`/`article`/`[role=main]`, drop nav/aside/footer/script/style/hidden, collapse whitespace, keep headings as `#` lines and list items as `- `; cap at `max_chars` (default 20 000).

### 3.3 Safety (`src/safety/`)

| Check | Rule | Verdict |
|---|---|---|
| Blocked domain | default: password-manager vaults (1password.com, *.lastpass.com, bitwarden vault, vault.bitwarden.com, my.1password.*), `chrome://`, `about:` (except about:blank), `file://` + user list | **deny** navigate/act |
| Sensitive domain | banking/payments/brokerage/gov/health/IdP-security pages (seed list: paypal, stripe dashboard, *.bank, chase, rbc, td, bmo, scotiabank, cibc, wealthsimple, questrade, accounts.google.com, myaccount.google.com, account.microsoft.com, appleid.apple.com, canada.ca, cra-arc.gc.ca, irs.gov…) + user list | navigate → **confirm**; any mutation → **confirm** |
| Secret field | one shared definition in `src/lib/secret-fields.ts`: `type=password`, autocomplete `current-password`/`new-password`/`one-time-code`/`cc-*`, name/id/label/placeholder words (passwords, OTP/2FA, card/CVV/expiry, IBAN/routing/account, SSN/SIN, PIN, API keys, seed phrases; en/fr/es/de), or a payment-processor frame | **deny** type/fill/select, text-producing keys and paste combos (tell model: ask the user to enter it themselves) |
| High-risk click | element name/value matches multilingual send/submit/pay/buy/delete/publish/share/transfer… words (en/fr/es/de/pt/it, word boundaries) or Gmail-specific ones (Create filter, Report spam, Delete forever, Empty trash…), or element is a submit control; Enter/Space on such a focused control is treated as the click | **confirm** (prompt shows `formSummary`) |
| Submitting keys | Enter in a single-line form field (search boxes excepted) or Meta/Ctrl+Enter in an editor; `type {submit:true}` is evaluated as one request with `key:'Enter'` | **confirm** (one prompt showing the text) |
| Key focus unknown | text-producing key, Enter, Tab, Backspace or Delete with `focus:'unknown'` | **deny** ("click the field first") |
| App shortcuts | nothing editable focused: Delete, Backspace, `#`, `!` and similar destructive single-key shortcuts | **confirm**; navigation keys allowed |
| Upload | any `upload_file` | **confirm** (show file names) |
| Dialog accept | `handle_dialog accept=true` on beforeunload/confirm | **confirm** |
| Cross-site egress (`src/safety/egress.ts`, review #1) | Reading a *private origin* (mail, ~90 private apps, sensitive domains, user list) taints the session for good, recording the **exact host** (per document/repo for Google Docs and GitHub-style hosts). Then: text entry into any other scope → confirm. Outbound navigate/tab_open/link click/form submit → confirm if it hits an *open endpoint* (redirectors, Apps Script, Forms, shorteners, request collectors, tunnels, pastebins — even on a tainted host), or goes to an untainted host with a URL that can carry data (query, fragment, port, IP, credentials, more than 30 chars of sub-domain + path combined, form submission). Per-document scopes on collaborative hosts (Notion, Figma, Slack channels, Atlassian, Office, Google Drive files…). | **confirm** |
| First interaction / first destination (review #2) | After a private read, the first click/type/press/hover/scroll/upload/dialog on a host neither read nor approved, and any outbound URL carrying more than a bare origin (a path, or a sub-domain other than www) to such a host, asks once: "Allow it to interact with / visit <host> for the rest of this session?". Approval trusts the host until the server stops; data-carrying URLs to trusted hosts still ask. Trade-off: after reading mail, each new site asks once, and a web search asks every time. | **confirm** once per host |
| Paste | Meta/Ctrl+V, Shift+Insert, Meta+Shift+V — always, tainted or not (the page reads the clipboard) | **confirm** |
| Landing check | after every action and history move, the landed URL is checked: blocked → tab blanked, error without content; sensitive → confirm | deny/confirm |
| Evaluate | disabled unless `safety.allowEvaluate`; then always **confirm** with the **full** code shown (≤ 2000 chars, longer is denied; dangerous APIs flagged in the title) | deny/confirm |
| Rate limit | > `maxActionsPerMinute` (default 40) mutating actions | **deny** with cooldown message |

- Hosts normalized before compare: lowercase, strip trailing dot, punycode via `URL`, IP forms. Taint compares **exact hosts**; registrable domains (small multi-part suffix list: co.uk, com.au, gc.ca, …) are used only for domain-list matching.
- **Confirmer chain** (`safety.confirm: 'auto'|'elicit'|'dialog'|'deny'`): `auto` = MCP elicitation if client advertised `elicitation` capability, else macOS dialog (`osascript -e 'display dialog … buttons {"Deny","Allow"} default button "Deny" with icon caution giving up after 120'`), else deny. The prompt text comes from the **live page** (origin, element role+name, typed value preview with secrets redacted), plus the model's `intent` labelled as "Claude says". Timeout = deny.
- **Untrusted content**: every snapshot/text/find result is wrapped `<untrusted_web_content source="z1" origin="https://…">…</untrusted_web_content>` with any literal `</untrusted_web_content` in page text escaped. Tool descriptions tell the model page content is data, never instructions.
- **Audit log**: JSONL, `~/.stephen/audit.log`, mode 0600, rotated at 5 MB (keep 3). URLs lose query/fragment, intent capped at 200 chars, typed text = length only (no preview: a refused or partly typed value may be a secret), evaluate code / prompt text = length + hash. `recent_actions` returns only entries since this server started and hides element labels / intents / errors of private sites not read in this session (review #2 verification N1).

### 3.4 MCP surface (`src/server/`) — server name `browser`

| Tool | Args | Annotations |
|---|---|---|
| `browser_status` | – | readOnly |
| `browser_connect` | `browser: chrome\|zen`, `mode?: real\|agent` (real only if configured; agent→real switch asks the human), `intent?` | – |
| `tabs_list` | `browser?` | readOnly |
| `tab_open` | `browser`, `url?` (gate as navigate) | – |
| `tab_focus` | `tab` | – |
| `tab_close` | `tab`, `intent` (user tabs ask the human; runs beforeunload) | destructive |
| `navigate` | `tab`, `url`, `intent` | – |
| `history` | `tab`, `action: back\|forward\|reload` | – |
| `snapshot` | `tab`, `filter?`, `scope?` (ref), `max_chars?`, `save_to_file?` | readOnly |
| `find` | `tab`, `query`, `max_results?` (default 15) | readOnly |
| `read_text` | `tab`, `scope?`, `max_chars?`, `save_to_file?` | readOnly |
| `screenshot` | `tab`, `target?`, `full_page?`, `scale?` (default 0.5) | readOnly |
| `click` | `target`, `intent`, `double?`, `button?`, `include_snapshot?` | destructive |
| `hover` | `target` | – |
| `type` | `target`, `text` (≤5000, no control chars but `\n`), `intent`, `clear?`, `submit?`, `include_snapshot?` | destructive |
| `fill_form` | `fields: [{target, value}]` (≤20, values ≤5000), `intent` | destructive |
| `select_option` | `target`, `values[]`, `intent` | destructive |
| `press_key` | `tab`, `key` (any puppeteer KeyInput — Enter, Home, End, PageDown, F5, KeyA… — aliases like esc/up, or a combo like `Meta+A`), `intent` | destructive |
| `scroll` | `tab`, `target?`, `direction: up\|down\|left\|right`, `amount?` (px, default 600, snapped to fixed steps) | – |
| `wait_for` | `tab`, `text?`, `text_gone?`, `timeout_ms?` (≤30000) | readOnly |
| `upload_file` | `target`, `paths[]`, `intent` | destructive |
| `handle_dialog` | `tab`, `accept`, `prompt_text?`, `intent` | destructive |
| `recent_actions` | `limit?` (default 20), newest first | readOnly |
| `evaluate` | `tab`, `expression` (≤2000 chars), `intent` — **registered only if allowEvaluate** | destructive |

Errors are returned as tool results with `isError: true` and an actionable message (stale ref → "re-run snapshot"; needs user → exact instruction; OBSCURED → "something covers that element — snapshot again, close the banner/overlay first"; FOCUS_MOVED → "typing stopped, field may hold partial text").

**Server-side hardening (review #1):**
- **Profile mode is the user's choice.** `browser_connect` may use the configured mode or downgrade to `agent`; `real` when the config says `agent` is refused (the user edits the config themselves). Switching a connected browser from agent to real — even when allowed — asks the human through the same confirmer as the gate.
- **Per-tab readers–writer lock** (`server/locks.ts`): mutating tools hold their tab exclusively for the whole describe → gate (incl. human approval) → re-check → act → report sequence; reads share it. FIFO, so actions are not starved. A page op that outlives its call (timeout, or a dialog opened) is the tab's *orphan*; the next holder waits for it (≤15 s, else a TIMEOUT error without acting). `handle_dialog` skips that wait (it is what unblocks the op) and awaits the orphan before releasing.
- **TOCTOU re-check:** right before acting, the ref is described again and its identity (role, name, tag, inputType, href, frameUrl, formAction) compared with what the gate approved; any change or a vanished element → `STALE_REF`, nothing done. Key presses re-check the focused element the same way.
- **Key presses** always carry `focus`: `'element'` (+ the focused element), `'none'`, or `'unknown'` when `describeFocused` throws (closed shadow root, unreachable frame) — the gate fails closed on the latter.
- **Typed text** (`type`, `fill_form`, `prompt_text`): ≤5000 chars per field, ≤20 fields; control characters other than `\n` are refused (no Tab/Escape-as-text). `type {submit:true}` is ONE gate request carrying both the text and `key:'Enter'`, checked before anything is typed, so the human sees a single prompt with both. `evaluate` ≤2000 chars. `handle_dialog` passes `prompt_text` to the gate as `text`.
- **Review #2 server hardening:**
  - *Private titles (#1).* Every tab title/URL the server returns (tabs_list, browser_status, browser_connect, tab_focus, tab_close, the "page now" line) goes through `Hub.tabLine`: shown only if `!gate.isPrivate(url) || gate.wasRead(url)`; otherwise `[title hidden — private site; snapshot or read_text this tab to read it]` + origin and first path segment (segments > 24 chars → "…"). Blocked web URLs never show a title (origin only). If the gate throws, hidden (fail closed). With `include_snapshot` the snapshot is taken first, so the title is shown.
  - *Frames (#2).* `gateRead` lists `engine.frameUrls(page)` (fallback: puppeteer's `page.frames()`, then the page URL) and refuses the read if any http(s) frame is denied by `gate.evaluate({kind:'read', pageUrl: frame})` (blocked list). After every read (snapshot, find, read_text, screenshot, wait_for — even on timeout — and `include_snapshot`), `noteRead` is called for the page URL and every frame URL listed before AND after the read.
  - *Hover / scroll (#6)* run through `gate.check` (kinds `hover` with the element / `scroll` with the target element), so the gate's rate limit and post-taint rules apply. Scroll amounts are snapped to 100/300/600/1200/2500/5000/10000/20000 px.
  - *Page text in errors (#8).* The engine passed to tools is wrapped (`tagPageErrors`) so every rejection is marked page-originated. Error text: if the error (HubError) or a refused GateResult has a `pageText` field (string or string[]), the message is shown as is and the page text inside `<untrusted_web_content>`; a page-layer error without that field is wrapped whole; server-authored errors are plain.
  - *tab_close (#11).* Refused while a dialog is pending. `gate.check({kind:'tab_close', pageUrl})` with an extra runtime field `userTab: true` for tabs Stephen did not open; if the gate did not already ask (`confirmation: 'not-needed'`), the server asks the human itself (same confirmer as browser_connect) — prompt: host first, "Claude says (unverified)", page title last under "From the page (unverified)". A beforeunload dialog is returned like any other (accept → "The tab is now closed.").
  - *Landing check (#12).* After every action (`perform`: click, press, type/submit, navigate, tab_open, history, handle_dialog, select, hover, scroll…) and in every outcome line (fill_form, wait_for), the landed URL is checked with `gate.evaluate({kind:'navigate', targetUrl: landed})`; a deny other than a pure rate-limit deny = blocked → dismiss/accept any dialog, load `about:blank`, audit (`tool: 'landing-check'`, origin only), and return an error naming only the host. `history` back/forward has no known target before acting, so this check is its gate.
- **Shown = read (review #2 verification N4):** whenever a result shows page-supplied text without a snapshot — the acted-on / focused element's label, fill_form field labels, alert and dialog messages — the server calls `gate.noteRead` for that page (and the element's frame), so private text can never reach the model without arming the cross-site taint.
- **Untrusted marking:** every page-derived string the server returns — tab titles/URLs (tabs_list, browser_status, browser_connect), element labels and page titles in action results, audit entries in recent_actions — is inside an `<untrusted_web_content>` block; the server-authored lines refer to refs (`Clicked z1:e4 in z1.`). Server `instructions` give the model the workflow: `browser_status` → `tabs_list`/`tab_open` → `snapshot`/`find` → act by ref → re-snapshot after navigation.

### 3.5 Config (`~/.stephen/config.json`, all optional)
```json
{
  "defaultBrowser": "zen",
  "chrome": { "mode": "real", "executablePath": null, "userDataDir": null, "agentProfileDir": null },
  "zen":    { "mode": "real", "launch": "never", "executablePath": null, "profilePath": null, "agentProfileDir": null, "extraPrefs": {} },
  "safety": { "confirm": "auto", "blockedDomains": [], "sensitiveDomains": [], "allowEvaluate": false,
              "maxActionsPerMinute": 40, "confirmCrossSiteTyping": true },
  "output": { "maxSnapshotChars": 20000, "maxTextChars": 20000, "saveDir": null },
  "auditLogPath": null
}
```
`zen.launch` (`HubConfig`, like `extraPrefs`; not in the frozen `ResolvedConfig`): `"never"` = attach-only, `"auto"` = the driver may start Zen. Default `"never"`, except `"auto"` when `zen.mode` is `"agent"` (so `{"mode": "agent"}` keeps working). A `ResolvedConfig` without the key behaves as `"auto"`; the selftest always forces agent + `"auto"` on its temp profile (`assertSelftestConfig` refuses `"never"`).

Env overrides: `STEPHEN_HOME` (default `~/.stephen`), `STEPHEN_CONFIG`; the pre-rename `BROWSER_HUB_HOME` / `BROWSER_HUB_CONFIG` are fallbacks, and an existing `~/.browser-hub` is used while `~/.stephen` does not exist (`resolveStephenHome` in `src/config.ts`; never moved automatically, `doctor` explains how).

### 3.6 Selftest (`src/selftest/`, `stephen selftest [--browser chrome|zen|all] [--keep-open] [--json]`)
- **Never the real profile.** Per browser: a fresh dir `<home>/selftest/<browser>-<random>` (0700) becomes the whole Stephen home for the run — agent profile, state, output and audit log live inside it; `mode` is forced to `agent` for both browsers and the real-profile locations point at a nonexistent dir inside it (`assertSelftestConfig` refuses anything else). Only binary paths and `extraArgs` come from the user's config. Safety uses the built-in lists with `confirm: 'deny'`, so nothing can ever prompt a human and every "needs approval" is a refusal the test can assert.
- **Same layers as real use.** The real `buildServer` (every tool handler, page engine, gate, real `ChromeDriver`/`ZenDriver`) is connected to an SDK `Client` over an in-memory transport; the browser is launched by the drivers' own code (binary check, args, `DevToolsActivePort` / `WebDriver BiDi listening on` parsing, connect). The drivers' `spawn` is wrapped only to record the processes they start.
- **No internet.** Fixture pages come from an in-process HTTP server on 127.0.0.1 (two listeners → origins `127.0.0.1` and `localhost`, so the iframe is cross-site); it answers only its own Host names and records submissions and page beacons, which is how "Send was refused AND nothing was submitted", "the covered button was not clicked" and "the iframe click landed" are verified server-side. The temp Chrome gets `--disable-background-networking --disable-component-update --use-mock-keychain …`; the temp Zen profile gets a `user.js` disabling welcome pages, updates and telemetry.
- Zen: the agent profile's `user.js` block (above) is appended after the selftest's own prefs; `zen.extraPrefs` comes from the user's config.
- **Checks** (each PASS/FAIL/SKIP with ms): connect & open tab · navigate · snapshot refs · find · type text + textarea with `\n` · select · checkbox · read_text (the page echoes its inputs) · password typing refused · Send refused + 0 submissions · overlay → `OBSCURED` · cross-origin iframe ref + click · screenshot is a PNG · `Escape` allowed · stale ref after navigation · disconnect & clean up. A check whose prerequisite failed is SKIP.
- **Check 16 / cleanup** (always runs, each phase independently): close MCP + `manager.shutdown()` (as `serve` does) → the hub holds no connection; for Zen a NEW BiDi session must be accepted (Gecko allows one, so this proves the old one ended) → that connection sends `browser.close` (CDP `Browser.close` for Chrome) → wait for the recorded child to exit, else SIGTERM/SIGKILL **its own process group only** → delete the temp dir. `--keep-open` ends the session but leaves browser and dir. Ctrl-C does the same synchronously for the processes/dirs of the current run.
- **Output**: a table per browser with the browser version from the protocol, Stephen and Node versions, a `fix:` line under every FAIL (binary missing → paths searched + `<browser>.executablePath`; BiDi line not seen → slow first launch / wrong binary / blocked port, with the tail of Zen's log); `--json` prints the report. Exit 0 only if at least one browser ran and nothing that ran failed; with `--browser all` a missing browser is SKIP, a requested one is FAIL.

## 4. Reliability & failure modes
| Failure | Handling |
|---|---|
| Chrome toggle off / no DevToolsActivePort | Actionable error naming chrome://inspect/#remote-debugging |
| User clicked "Deny" on Chrome's Allow dialog | connect rejects → error asks to retry and click Allow |
| Zen real mode while Zen open | refuse with "Quit Zen (⌘Q)"; never kill it |
| Zen zombie BiDi session | error explains; agent-mode offers `browser_connect` after reopening |
| Zen BiDi session owned by another live Stephen | "another Claude Code session is using Zen…; close it or use Chrome" |
| Zen slow to start (first launch after update) | wait 60 s, then leave it running and resume waiting on the next connect; never kill |
| Two tool calls on one tab at once | per-tab lock serializes them; element re-checked after approval |
| Browser closed by user mid-session | `disconnected` → purge tabs; next call reconnects lazily |
| Stale ref | `StaleRefError` → "re-run snapshot" |
| Navigation during action | catch context-destroyed errors, report new URL |
| Huge pages | char caps + `save_to_file` spill to `~/.stephen/output/` |
| Hung page | every page op wrapped with a timeout (45 s, navigation 35 s, wait_for ≤35 s); a timed-out op keeps the tab locked until it settles (bounded) so it can't interleave with the next action |

## 5. Test plan
- **Unit (vitest, no browser):** ref grammar, DevToolsActivePort parsing, profiles.ini parsing, BiDi stderr parsing, Zen arg building, config merge, domain normalization, exact-host taint and outbound-URL rules, every safety rule incl. homoglyph/trailing-dot hosts, confirmer chain (fake elicit/dialog), audit redaction + rotation, untrusted wrapping/escaping.
- **Integration (real Chromium via `@sparticuz/chromium`), run twice: `protocol: 'cdp'` and `protocol: 'webDriverBiDi'`** — the BiDi run exercises the exact Puppeteer code path Zen uses: snapshot on fixture pages (forms, hidden injection text, iframes, contenteditable, password/card fields), refs stable across snapshots, stale after removal, click/type/select/press/scroll/wait/upload/dialog, readText.
- **MCP end-to-end:** spawn the built server with an SDK client over stdio, a config that launches Chromium in "agent" mode via `executablePath` override; call tools through the protocol; confirm denial of password typing and confirmation flow with `confirm: "deny"` and a fake approve.
- **Selftest:** unit tests of the orchestration with fakes (table, exit code, skip logic, cleanup on failure, agent-only config) and of the check script against a scripted fake tool surface; integration runs the built `selftest --browser chrome --json` on Chromium, `--browser zen` on a fake `zen` executable that launches Chromium and prints Gecko's `WebDriver BiDi listening on` line (so the real ZenDriver launch/BiDi-connect path runs; Chromium answers via BiDi-over-CDP), and a `zen` that never prints it (hint + only its own process stopped).
- **Owner on macOS:** `stephen doctor`, then `stephen selftest`, then the manual checklist in README.

## 6. Build plan — parallel worktrees
Contracts live in `src/types.ts` (frozen before the split). Each worktree owns disjoint files:

| Worktree | Branch | Owns | Depends on |
|---|---|---|---|
| wt-drivers | `feat/drivers` | `src/drivers/**`, `test/drivers/**` | types |
| wt-page | `feat/page` | `src/page/**`, `test/page/**`, `test/fixtures/**` | types |
| wt-safety | `feat/safety` | `src/safety/**`, `test/safety/**` | types |
| wt-server | `feat/server` | `src/server/**`, `src/cli.ts`, `src/config.ts`, `test/server/**`, `README.md` | types (codes against interfaces; fakes in tests) |

Integration: merge all four into `main`, wire real implementations, run unit + integration (CDP & BiDi) + MCP e2e, independent review.
