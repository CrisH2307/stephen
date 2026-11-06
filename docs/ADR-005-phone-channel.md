# ADR-005: Phone → Stephen through Claude Code Remote Control, not a Stephen listener

**Status:** Accepted, owner decisions in; build not started. Probed on the Mac 2026-11-05 (Claude Code 2.1.318): the Remote Control
lock-down works, so no custom channel is needed. Threat model and build plan below; independent review (#8) before
shipping.
**Date:** 2026-11-02, updated 2026-11-05
**Deciders:** Cris (owner), Claude (researcher)

Sources: `claude remote-control --help` (2.1.316) and code.claude.com docs fetched 2026-11-02: `remote-control`,
`mobile`, `desktop` (Dispatch), `channels`, `cross-session-messaging`, `claude-code-on-the-web`, `mcp`
(requires-user-interaction tools). Tags: **[docs]** = documented, **[unverified]** = check on the Mac.

## Context

HANDOFF item 5: talk to Stephen from the phone. Use existing Claude features if they work. A custom channel must
be authenticated end to end, must have nothing listening on the open internet, and must be rate-limited and
audited. Phone requests are **low trust, like the wake word**: jobs and anything that changes things need
confirmation. Stephen's power lives on the Mac (gate, account tools, ADR-004 jobs), so "reach Stephen" means
reaching a process **on the Mac**.

## What already exists

| Feature | Runs on | Reaches Stephen? | Notes |
|---|---|---|---|
| **Remote Control** (`claude remote-control`, `/rc`, Desktop "Connect new sessions to Remote Control") | The Mac | **Yes**, if the session has a Stephen tool | **Outbound HTTPS only, no inbound port** **[docs]**. Phone uses the Claude app or claude.ai/code. Permission prompts are forwarded to the phone, plus push notifications. Pro/Max/Ultra/Team/Enterprise |
| **Trusted Devices** (beta) | n/a | n/a | Adds an enrolled device + a sign-in under 18 h old, refreshed by Face ID / passkey, for every Remote Control session. Owner turns on "Require trusted devices" (Pro/Max/Ultra) **[docs]** |
| **Dispatch** (Claude app → Cowork on Desktop) | The Mac | Not safely | Spawns Desktop Code sessions with their own tools and computer use. That **bypasses Stephen's gate and the job sandbox**. Pro/Max/Ultra only |
| **Cloud sessions** from the phone (Code tab) | Anthropic VM | No | Fine for repo code tasks. Can't touch the Mac |
| **Channels** (Telegram/Discord/iMessage plugins, research preview) | The Mac (CLI) | Yes, if built like Remote Control | Pushes chat messages into a local session. Sender allowlist (iMessage: texting yourself passes). Needs Bun, a bot token and a third-party chat platform |
| **Cross-session messaging** | n/a | Via Remote Control | A cloud or phone session can message the Mac's Remote Control session. That's the same path |
| **Linked-computer folders** (a cloud session attaches to a Mac folder served by Remote Control) | The Mac | Shell on the Mac | Seen only in this cloud session's own tool list, not in the fetched docs **[unverified]**. Never share Stephen's folders this way |

**Yes: the owner can reach Stephen from the phone with Stephen opening no listener.** Remote Control already gives
authenticated (claude.ai account + optional Trusted Devices), outbound-only, TLS transport, a phone UI, push
notifications and a confirmation prompt the model can't answer.

## Decision

Run one dedicated, locked-down **Remote Control session** on the Mac whose only tools come from a small Stephen
bridge MCP server. Stephen opens no port, and every request enters Stephen's normal pipeline marked
`source: phone` (low trust).

```
phone (Claude app) ─TLS─▶ Anthropic ◀─outbound poll─ claude remote-control --spawn session --no-chrome
                                                       cwd ~/.stephen/phone/  (0700)
                                                       tools: mcp__stephen_phone__* only
                                                            │ stdio
                                                       stephen phone-bridge ── app.sock (0600) ──▶ stephen listen
```

- **Launch:** `claude remote-control --spawn session --no-chrome --permission-mode default --name Stephen`, started
  by `stephen phone on` (on demand, owner decision 2) in `~/.stephen/phone/`. Run it once in a TTY to accept workspace trust and the
  Remote Control prompt **[docs]**.
- **Lock-down (the main thing to verify).** Server mode refuses most global flags, including `--settings`, so the
  folder's own `.claude/settings.json` + `.mcp.json` must do it:
  - deny every built-in tool;
  - allow `mcp__stephen_phone__ask` and `mcp__stephen_phone__job_status`;
  - if the `agent` setting with a tools-limited agent works for the main thread, use it as the real allow-list.

  Then verify with the same init-message probe used for the voice lock-down. A deny-list alone missed 13
  built-ins before (VOICE.md), so this had to be proven: **done 2026-11-05, see Probe results**.
- **Tools:**
  - `ask(text)`: Stephen answers as for a wake-word command. Anything the gate would confirm is **refused** from
    the phone ("confirm at the Mac"), because the native dialog isn't in front of anyone.
  - `start_job(task, web)`: marked `_meta["anthropic/requiresUserInteraction"] = true`. Claude Code then shows a
    permission prompt with the exact input on **every** call, in every mode. It has no "don't ask again", and it
    can't be auto-approved **[docs]**. That prompt on the phone is the phone-side confirmation ADR-004 needs.
    Stephen then applies its own job rules (budgets, limits, audit).
  - `job_status()`: list and summary, read-only.
- **Owner setup:** turn on **Require trusted devices**, and turn on push for "actions required".

## Probe results (2026-11-05, on the owner's Mac)

Throwaway folder with a stand-in bridge MCP server (`ask`, `job_status`, `start_job`, no side effects), started as
`claude remote-control --spawn session --no-chrome --permission-mode default`, driven from the owner's phone.

| Question | Result |
|---|---|
| Can the session be limited to exact tools? | **Yes.** `.claude/settings.json` `{"agent": "phone", "enableAllProjectMcpServers": true}` + `.claude/agents/phone.md` with `tools:` listing the bridge tools. The session's init line listed exactly those tools (2, then 3). Baseline in the same folder without the agent setting: **437 tools** (every built-in, the full `stephen` browser server, firefox-devtools, agentmemory, all claude.ai connectors incl. Gmail/Drive/Notion, 228 skills) |
| How does Remote Control run the session? | `claude --print --sdk-url … --input-format stream-json` in the folder, so project settings apply exactly as in a local `claude -p` (that is how the lock-down was first probed locally) |
| Project `.mcp.json` approval | Shown once in the folder trust prompt ("launch, without asking, 1 MCP server: stephen_phone"). Persists: a restart in the same folder asked nothing |
| Does `requiresUserInteraction` reach the phone? | **Yes.** `can_use_tool` for `start_job` carried `requires_user_interaction: true`, `suppress_always_allow_rule: true`, `permission_suggestions: []`; the phone showed the exact input ("Write a poem about rivers."), the owner tapped Allow. No "always allow" offered |
| Ordinary bridge tools | `ask` prompted too, offering "allow for this session" (taken) or a local-settings rule |
| Round trip | Phone "Yo yo" → `ask` → stub reply shown on the phone |

Also seen, and design inputs below:
- The owner's **other MCP servers still start** in that session (full `stephen`, firefox-devtools, agentmemory,
  claude.ai connectors). The model can't call them, but they run, and the `stephen` one is a full browser server.
- The owner's **global hooks run** (SessionStart: Discord, Ponytail, ARS).
- **Slash commands work from the phone** (`/model` switched the model). The person holding the phone can type them.
- Remote Control writes the session transcript on the Mac (`~/.claude/projects/<folder>/…jsonl`) and on Anthropic's
  servers **[docs]**.

## Threat model

Assets: the owner's accounts and browser sessions (through Stephen's gate), private data in replies (calendar,
Canvas, email, Notion), the Mac (shell, files), job budgets (time, money), Stephen's memory/timers/history.

Trust: the phone is **low trust, like the wake word**: the person holding it may not be the owner, and the model in
the phone session reads text the owner didn't write (Stephen's replies quote web pages and email).

| # | Actor / event | Could | Stopped by |
|---|---|---|---|
| T1 | Thief with the unlocked phone (or a shoulder-surfed open session) | Send asks, type slash commands, tap Allow on a job | Trusted Devices step-up (Face ID / passkey, 18 h) **[docs]**; the session can only reach the bridge; phone conversations run at `wake` trust (no gated actions, email summary only); job caps from the phone (§ Bridge rules); every phone request audited and noticed on the Mac; `stephen phone off` kill switch |
| T2 | claude.ai account takeover (any device) | Same as T1 | Trusted Devices enrollment needs a fresh full sign-in **[docs]**; same limits; Mac notification per request |
| T3 | Injected text (web, email, Canvas) in a Stephen reply, read by the phone session's model | Make that model call `ask` / `start_job` with attacker text | The model has only the bridge tools; `start_job` always needs a human tap showing the exact task; `ask` re-enters Stephen at `wake` trust, where the gate refuses confirm-level actions; per-minute rate limit |
| T4 | Slash commands typed on the phone (`/model`, `/mcp`, `/permissions`, `/agents`, `/config` …) | Change the session (model, permission mode, maybe settings) | Startup lock-down check (below) on every launch; the bridge enforces its own limits whatever the session allows (it never trusts the session's permission mode); the phone folder's settings are 0600 and outside the repo; review #8 lists which slash commands can change tools or settings, and the bridge plan blocks or survives each |
| T5 | Settings widened later (user settings, a plugin, a Claude Code update, a "local settings" allow rule saved from a prompt) | More tools in the phone session | `stephen phone on` runs the same init probe as the voice session (`claude -p` in the folder) and refuses to start unless the tool list is exactly the bridge's; re-checked at each launch; `start_job` keeps `requiresUserInteraction`, which no allow rule can skip |
| T6 | Other MCP servers still starting in the phone session | Nothing directly (not callable), but a full `stephen` browser server runs there | Deny them in the phone folder's settings where Claude Code allows it (to probe in subtask 1); otherwise accepted, since the init check proves they aren't callable |
| T7 | Private data in replies | Lands in the Remote Control transcript (Mac + Anthropic) | `wake` trust already limits email to who/when; owner chose contents at `wake` trust (decision 1) |
| T8 | Another local process talks to the bridge's socket | Run phone commands | A dedicated `phone.sock` (0600, in the 0700 home), not `app.sock`: only `ask`, `job_status`, `start_job`; same-user processes stay out of scope (as in reviews 6 to 7) |
| T9 | Replay / flooding | Repeat requests, burn job budget | Rate limits (asks/min, job starts/day from the phone), request ids, existing per-conversation limits and job caps |
| T10 | Mac asleep / process died | Phone silently unanswered | `claude remote-control` exits after ~10 min without network **[docs]**: owner chose on-demand only (decision 2): `stephen phone status` and doctor show it |

### Bridge rules (what the code enforces, whatever the session does)
- Not a client of `app.sock`: `app.sock` also offers `memory.add`, `history.clear`, `settings.get` and more. The bridge
  gets its own `phone.sock` with exactly three requests.
- Source `voice-phone` → trust `wake`. So: email is summary only, the gate refuses confirm-level actions ("confirm at
  the Mac"), and the model never writes memory or timers (as today).
- `start_job(task, web)`: the phone tap (requiresUserInteraction) is the confirmation, because nobody is at the Mac
  to answer the native dialog (owner decision 3). Phone jobs also: web off unless asked, a lower daily cap, the same
  budgets and sandbox as ADR-004, a Mac notification "job started from your phone".
- `job_status()`: read-only, the same capped summary as the Jobs tab.
- Every request: audited (`source: phone`), rate limited, and a short macOS notification on the Mac.

## Build plan (each step tested)
1. **Phone folder + check** (`src/phone/setup.ts`, `stephen phone setup|check`): create `~/.browser-hub/phone/`
   (0700; `~/.stephen/phone/` after the home move) with settings.json, agents/phone.md, .mcp.json (0600); probe
   whether other servers can be denied there; `check` = the init-line probe, exact tool list or fail.
2. **phone.sock + listener side** (`src/phone/server.ts`, wiring in `src/voice/index.ts`): the three requests,
   source `voice-phone` → `wake`, rate limits, audit, Mac notification.
3. **Bridge MCP** (`stephen phone-bridge`, stdio): the three tools, `start_job` with
   `_meta["anthropic/requiresUserInteraction"] = true`; talks only to phone.sock.
4. **Jobs from the phone** (`src/jobs/router.ts` / `manager.ts`): a phone-approved start path with the phone caps.
5. **Run it** (`stephen phone on|off|status`): check, then `claude remote-control --spawn session --no-chrome
   --permission-mode default --name Stephen` in the folder; on demand only (no launchd).
6. **Tests + Mac checks** (fake socket, fake claude init lines, router cases; MAC-TEST-PLAN §9 with the phone), docs
   (SYSTEM-DESIGN §4.14, HANDOVER), then **review #8** over items 4 and 5.

## If a custom channel is still needed

Use it only if Remote Control can't be locked down (see the lock-down bullet). Each option needs:
- a paired device secret (stored in Keychain, rotatable);
- per-request HMAC over the body, a timestamp and a nonce (reject replays older than 60 s);
- the same rate limits, low trust and audit as above.

| Option | Listener? | Auth | Notes |
|---|---|---|---|
| **Outbound-only relay** (Stephen long-polls a queue, e.g. its own Cloudflare Worker) | None on the Mac | HMAC + **end-to-end encryption** with the paired key (the relay is untrusted) | Preferred custom option. A small Shortcut or PWA on the phone posts to the relay |
| **Tailscale** (`tailscale serve`, bound to the tailnet IP only) | Yes, tailnet-only | WireGuard device keys + tailnet ACL + HMAC | Simple, but it is a listener. A tailnet compromise reaches it |
| **iMessage / Shortcuts** (text yourself, Stephen reads Messages) | None | Apple ID. Self-messages are easy to spoof locally | Needs Full Disk Access for Stephen to read `chat.db`. That's too much privilege. Rejected |

## Owner decisions (2026-11-05)
1. Phone replies: **contents**, like today's wake-word trust (Canvas, calendar and Notion in full; email who/when
   only). This is exactly `wake` trust, so the phone reuses it unchanged.
2. **Only when turned on**: `stephen phone on` before leaving, `stephen phone off` after. No launchd.
3. **The phone's Allow tap starts a job**, with the phone limits in Bridge rules (web off by default, lower daily
   cap, ADR-004 sandbox and budgets, Mac notification).

Answered by the probe: tool lock-down (yes, `agent` setting), `.mcp.json` approval (once, at folder trust, persists),
`requiresUserInteraction` on the phone (yes, exact input, no "always allow").
