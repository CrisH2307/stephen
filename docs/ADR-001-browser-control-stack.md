# ADR-001: One local MCP server driving Zen and Chrome through puppeteer-core

**Status:** Accepted
**Date:** 2026-10-29
**Deciders:** Cris (owner), Claude (implementer)

## Context

Claude Code's built-in browser integration (Claude in Chrome) only works with Google Chrome and Microsoft Edge. The owner's daily browsers are **Zen** (a Firefox/Gecko fork) and **Chrome**, on **macOS**, and the goal is everyday productivity work (mail, docs, calendars, forms, research, dashboards), not one specific site. The project is browser-only for now; OS-level desktop control (Coco-style) is a later phase.

Forces at play:

- **Gecko has one remote protocol.** CDP was disabled by default in Firefox 129 and removed in 141, so Zen can only be driven over **WebDriver BiDi**. Its listener only starts when the browser is launched with `--remote-debugging-port`; you cannot attach to a Zen that was opened normally.
- **Chrome locked down its everyday profile.** Since Chrome 136, `--remote-debugging-port` is ignored on the default profile (infostealers used it to dump cookies). Since **Chrome 144**, the user can opt in at `chrome://inspect/#remote-debugging`; Chrome then writes `DevToolsActivePort` and shows an *Allow* dialog per connection.
- **Prompt injection is unsolved.** Best published defenses still leave ~1.4% adaptive-attack success. A server that touches logged-in sessions must enforce rules in code, not just in prompts.
- **Token budget.** Claude Code warns above ~10k tokens per tool result and caps at ~25k by default.
- **Must work with the Claude Code the owner already has**, over stdio.

## Decision

Build **one Node.js/TypeScript MCP server ("browser-hub")** that:

1. Uses **puppeteer-core 25.x for both browsers**: CDP for Chrome, `protocol: 'webDriverBiDi'` for Zen. One library, one `Page` API.
2. Represents pages with **one injected DOM walker** (identical in both browsers) that emits a compact role/name tree with refs like `z1:e12`. Puppeteer's built-in accessibility snapshot is unavailable over BiDi, so an injected walker is the only representation that behaves the same everywhere — and it gives one place to strip hidden text and redact secrets.
3. Puts a **deterministic safety gate** between every tool and the browser: blocked/sensitive domains, refusal to touch password/OTP/payment fields, risk classification against the *live* element, human confirmation the model cannot forge, rate limits, and an audit log.
4. Uses the **MCP TypeScript SDK v1 maintenance line (`@modelcontextprotocol/sdk` 1.32.x) over stdio**, isolated in one module.

## Options Considered

### Option A: Run existing single-browser servers side by side (chrome-devtools-mcp + firefox-devtools-mcp)
| Dimension | Assessment |
|---|---|
| Complexity | Low to start |
| Cost | Free |
| Fit | Two tool vocabularies, two ref formats, no shared safety layer |
| Zen support | Unverified; Mozilla's connect-existing mode requires Marionette, which sets `navigator.webdriver` and trips bot detection |

**Pros:** Nothing to build. **Cons:** No unified safety gate; chrome-devtools-mcp sends usage stats by default; Zen path untested and fingerprintable.

### Option B: Playwright for both
| Dimension | Assessment |
|---|---|
| Chrome | Good (`connectOverCDP`, `ariaSnapshot({mode:'ai'})`), though "lower fidelity" over CDP and an open issue with Chrome 144 auto-connect timeouts |
| Zen | **Not viable** — Playwright drives its own patched Firefox (Juggler); stock-Firefox BiDi support is experimental |

### Option C: puppeteer-core for both (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium (we write the snapshot walker) |
| Chrome | First-class CDP; reads `DevToolsActivePort` the same way chrome-devtools-mcp does |
| Zen | Official Firefox support over BiDi since Fx 129; `connect({browserWSEndpoint, protocol:'webDriverBiDi'})` |
| Gaps | No a11y snapshot or ARIA selectors over BiDi → solved by our injected walker |

### Option D: Our own browser extension (like Claude in Chrome)
Rejected for v1: needs a Chrome extension *and* a Firefox add-on (Firefox release builds require signed add-ons), plus native messaging hosts for each. Far more surface than a protocol client, and it would still need a server.

### MCP SDK: v1 (1.32.x) vs v2 (`@modelcontextprotocol/server` 2.4.0)
v2 is the new stable line (2026-07-27) and implements the 2026-07-28 spec, including a new `inputRequired` confirmation flow. Whether the owner's Claude Code build speaks that flow is unverified. v1 implements classic `elicitation/create`, which Claude Code reportedly supports since v2.1.76. **Choose v1 now**, keep all SDK calls in `src/server/`, and migrate in one file later.

## Trade-off Analysis

- **Fidelity vs uniformity.** Chrome's native accessibility tree would be richer, but two snapshot engines means two sets of bugs and refs that behave differently per browser. Uniformity wins; a CDP-native path can be added behind the same interface later.
- **Real profile vs agent profile.** Real profiles bring logins but raise the stakes. Chrome's real-profile attach is user-consented by Chrome itself (144+ toggle + Allow dialog), so it is the Chrome default. Zen's real-profile mode requires quitting Zen and relaunching it with a debug port, so Zen defaults to a **dedicated agent profile** (sign in once, it persists) and real-profile mode is opt-in.
- **Port vs pipe for the Chrome agent profile.** A pipe is safer but dies with the server, so every restart would relaunch Chrome. We use `--remote-debugging-port=0` bound to loopback with a *dedicated* profile that holds no everyday cookies, and reattach via its `DevToolsActivePort`. Accepted risk, documented.
- **Confirmation channel.** MCP elicitation is native to the client but depends on client support; a macOS `osascript` dialog always works and is out of the model's reach. We chain them: elicitation if the client advertises it, else the native dialog, else deny. A token returned in a tool result is never used — an injected model could replay it.

## Consequences

- **Easier:** one tool vocabulary for both browsers; one place to enforce safety; adding Brave/Edge (CDP) or Firefox/LibreWolf (BiDi) is a new driver file.
- **Harder:** we own the snapshot walker (visibility rules, iframes, ref stability). Zen real-profile mode is inherently disruptive (quit + relaunch).
- **Revisit:** migrate to SDK v2 once Claude Code supports the 2026-07-28 spec; add CDP-native snapshots for Chrome if fidelity matters; per-task origin scoping; Safari via `safaridriver`; desktop-control phase.

## Action Items
1. [x] Research protocols, libraries, prior art and safety (see `reports/`)
2. [x] System design (`docs/DESIGN.md`)
3. [ ] Shared contracts + scaffold
4. [ ] Parallel build: drivers · page engine · safety · MCP server/CLI/docs
5. [ ] Integrate, test against real Chromium over **both** CDP and BiDi
6. [ ] Owner verifies on macOS with real Zen + Chrome (`browser-hub doctor`)
