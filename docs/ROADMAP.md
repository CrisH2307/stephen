# Stephen — roadmap (as of 2026-11-02)

## Order agreed 2026-11-02 (details: docs/HANDOFF-PROMPT.md)
1. Morning briefing ("what's my day": calendar + Canvas due + weather).
2. Phase 3 speed + real follow-ups (start Claude while speaking; long-lived session and server).
3. Finish 2a: Notion to-dos, then Gmail (two personal accounts first).
4. Jobs while away ("go cook" mode): a separate sandboxed Claude Code run per job (own folder or git worktree, no
   browser/gate tools, budgets, no network writes), dialog to start, notification + spoken summary, Jobs tab.
5. Phone → Stephen: prefer existing Claude mobile/remote features; otherwise an authenticated, private, low-trust
   channel with a threat model and an independent review first.
6. Every phase ends with a Stephen app UI pass (frontend-design skill; small, self-contained SwiftUI changes).
Reviews #7 after 1–3 and #8 after 4–5. Keep code simple; reuse modules; keep SYSTEM-DESIGN-STEPHEN.md current.
Done since 10-31: phase 1.9, review 5, F5 push-to-talk, Canvas + Google Calendar (2a part 1), timers/reminders, review 6.

Owner: Cris (cris.huynh@ontariotechu.net). Product: Stephen, a voice assistant for the owner's Mac ("Hey Stephen…",
or hold Fn+Option). Repo: `~/Documents/SoftwareProject/brower-hub/browser-hub` → github.com/CrisH2307/browser_hub.

## Done (phases 0–1.7)
- Browser control of Zen (attach-only via "Zen for Stephen") and Chrome, behind a safety gate (4 independent reviews).
- Safe desktop actions: `open_app`, `open_url`, `desktop_status`, `play_media` (YouTube, resolves the video
  server-side, attaches on demand, reuses the open YouTube tab, presses play).
- Voice: local wake word (hey/yo/ok/bare "Stephen"), push-to-talk Fn+Option via "Stephen Helper.app" (Swift,
  in the Dock), Esc cancel, whisper-small.en ASR, `claude -p` (sonnet) locked to Stephen's tools, ElevenLabs voice
  (Keychain key) → Kokoro → `say` fallback, speak-first `announce`, quiet while sound plays, casual Gen-Z tone.

## Next: phase 2a — "read my stuff" (read-only) ← recommended next
Goal: by voice, get answers from the owner's own data quickly and safely.

| Ask | Source | How (preferred → fallback) |
|---|---|---|
| "What's new in my email?" / "any email from my prof?" | Gmail | claude.ai Gmail connector (already connected to the owner's account) if Claude Code can use it headless → Gmail API (OAuth, read-only scope) → browser read of mail.google.com |
| "What's due on Canvas this week?" | Canvas LMS (Ontario Tech) | Canvas REST API with a personal access token (Account → Settings → New access token, if the school allows), stored in Keychain → browser read |
| "What's on my to-do list?" | Notion | claude.ai Notion connector (connected) → Notion API integration token → browser read |
| "What's on my calendar today?" | Google Calendar / Notion Calendar | connector → API |
| "Find coffee near me" / "directions to …" | Google Maps | just `open_url https://www.google.com/maps/search/?api=1&query=…` (no API) |

Design rules (keep the safety model):
1. **Read-only first.** Allow only read/search/get tools; no send/trash/update/delete/share tools in voice runs.
2. **Reading private data arms the taint.** Any voice command that may use a private-data tool starts Stephen's
   server with a new `serve --assume-private-read` flag, so the existing egress rules (cross-site, first-destination,
   open endpoints) treat the session as tainted from the start. Data can't silently leave via open_url/play_media.
3. **Connector allow-list, not wildcards.** `--allowedTools` lists exact read tools (e.g. Gmail search/get thread,
   Notion search/fetch). `--strict-mcp-config` stays; connectors are added explicitly to the voice MCP config.
4. **Spoken answers are short summaries;** details are printed in the terminal. Never read secrets/codes aloud
   unless asked (e.g. 2FA codes in email: say "there's a verification code from X", not the code).
5. **Tokens in Keychain** (`stephen connect canvas` / `notion`), like `voice-key`; never in the repo.

First tasks for the new chat:
- [ ] Verify whether `claude -p` can use the owner's claude.ai connectors (Gmail, Notion, Google Drive) and how
      they're named/allowed headless (`/mcp`, `--mcp-config`, `--allowedTools mcp__claude_ai_*`?). Decide connector vs API.
- [ ] `serve --assume-private-read` + tests (taint from start; egress prompts as after a private read).
- [ ] Canvas: read-only client (courses, assignments with due dates, announcements) + `stephen connect canvas`.
- [ ] Google Maps search/directions via open_url (+ persona hint).
- [ ] Persona: how to summarize email/to-dos by voice; privacy rules above.
- [ ] Independent security review (prompt injection via email content is the main new risk).

## Phase 1.9 — memory + Stephen app (built 2026-11-01; review #5 pending)
See docs/PLAN-1.9-MEMORY-DASHBOARD.md. Memory only from the owner's own "remember …"; local history; `stephen dashboard` on 127.0.0.1.

## Phase 3 — follow-ups and speed
Agent SDK + Console API key (Anthropic requires API-key auth for SDK products), one long-lived session and one
long-lived Stephen server (so the gate's memory and Claude's memory last together) → "read me the second one",
"reply to that later". Start Claude while the user is still speaking (biggest latency win).

## Phase 2b — careful actions
Reply/draft email, tick off a Notion to-do, add a calendar event — each confirmed in a macOS dialog showing exactly
what will be sent/changed.

## Phase 4 — cursor control (approved apps)
AX-first clicking in approved apps, swallowed Esc stop key, secure-input/frontmost checks, "Stephen is controlling"
indicator, helper socket authentication (review #4 #6). Then the logo.

## Later
- Canvas inbox (conversations API) and more Canvas pages, read-only like the rest of 2a.

## Known open items
- Helper socket not authenticated (review #4 #6); Keychain item readable by same-user processes (#5).
- Real-Mac-only checks still pending: helper on every macOS update, Kokoro latency, YouTube page-format drift.
- Owner should rotate the ElevenLabs key that was pasted in chat (if not done).
