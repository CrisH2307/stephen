# ADR-005: Phone → Stephen through Claude Code Remote Control, not a Stephen listener

**Status:** Proposed (research done, threat model outline below; independent review before shipping)
**Date:** 2026-11-02
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
| **Trusted Devices** (beta) | — | — | Adds an enrolled device + a sign-in under 18 h old, refreshed by Face ID / passkey, for every Remote Control session. Owner turns on "Require trusted devices" (Pro/Max/Ultra) **[docs]** |
| **Dispatch** (Claude app → Cowork on Desktop) | The Mac | Not safely | Spawns Desktop Code sessions with their own tools and computer use. That **bypasses Stephen's gate and the job sandbox**. Pro/Max/Ultra only |
| **Cloud sessions** from the phone (Code tab) | Anthropic VM | No | Fine for repo code tasks. Can't touch the Mac |
| **Channels** (Telegram/Discord/iMessage plugins, research preview) | The Mac (CLI) | Yes, if built like Remote Control | Pushes chat messages into a local session. Sender allowlist (iMessage: texting yourself passes). Needs Bun, a bot token and a third-party chat platform |
| **Cross-session messaging** | — | Via Remote Control | A cloud or phone session can message the Mac's Remote Control session. That's the same path |
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
  by `stephen listen` (or launchd) in `~/.stephen/phone/`. Run it once in a TTY to accept workspace trust and the
  Remote Control prompt **[docs]**.
- **Lock-down (the main thing to verify).** Server mode refuses most global flags, including `--settings`, so the
  folder's own `.claude/settings.json` + `.mcp.json` must do it:
  - deny every built-in tool;
  - allow `mcp__stephen_phone__ask` and `mcp__stephen_phone__job_status`;
  - if the `agent` setting with a tools-limited agent works for the main thread, use it as the real allow-list.

  Then verify with the same init-message probe used for the voice lock-down. A deny-list alone missed 13
  built-ins before (VOICE.md), so this **must be proven, not assumed** **[unverified]**.
- **Tools:**
  - `ask(text)`: Stephen answers as for a wake-word command. Anything the gate would confirm is **refused** from
    the phone ("confirm at the Mac"), because the native dialog isn't in front of anyone.
  - `start_job(task, web)`: marked `_meta["anthropic/requiresUserInteraction"] = true`. Claude Code then shows a
    permission prompt with the exact input on **every** call, in every mode. It has no "don't ask again", and it
    can't be auto-approved **[docs]**. That prompt on the phone is the phone-side confirmation ADR-004 needs.
    Stephen then applies its own job rules (budgets, limits, audit).
  - `job_status()`: list and summary, read-only.
- **Owner setup:** turn on **Require trusted devices**, and turn on push for "actions required".

## Threat model outline (for the Remote Control path, and any custom channel)

| Actor / event | Can | Stopped by |
|---|---|---|
| Phone thief (unlocked phone) | Send asks, tap "allow" on a job | Trusted Devices biometric step-up (18 h). Phone = low trust: no gated actions. Job start limit/day. `stephen phone off` kill switch. Audit |
| claude.ai account takeover | Same as above, from any device | Trusted Devices enrollment only right after a full sign-in. Same limits. Audit + a notification on the Mac for every phone request |
| Injected text (Canvas/web) in Stephen's reply, read by the phone session's model | Make that model call tools | It only has `ask` / `job_status`. `start_job` needs a human tap. `ask` re-enters Stephen at low trust |
| Private data in replies | Ends up in the Remote Control transcript on Anthropic servers **[docs]** | Option: phone gets counts, not contents (like the wake word). Owner decides |
| Replay / flooding | Repeat requests | Bridge rate limit (e.g. 10 asks/min, 3 job starts/day), request ids, a per-command limit in the gate |
| Bridge or Remote Control session widened by user settings | More tools | Verified lock-down probe at startup, refusing to start if the tool list isn't exact (same check as the voice session) |

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

## Open questions

1. Can a `claude remote-control` session be limited to an exact tool list (project settings deny-list,
   `agent` setting, or managed settings)? Probe it on 2.1.316 on the Mac. This decides between the Remote Control
   path and a custom channel.
2. Does a project `.mcp.json` server in a Remote Control session need a one-time approval, and does that approval
   persist?
3. Does the `requiresUserInteraction` prompt actually reach the phone and show the full `start_job` input?
4. Should phone replies include private contents (Canvas, calendar) or only counts?
5. Mac must be awake with the `claude remote-control` process running. Should it be launchd-managed and restart
   after the roughly 10-minute network-loss exit in server mode **[docs]**?
6. Get the independent threat-model review (HANDOFF item 5) before any build.
