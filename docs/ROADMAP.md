# Stephen: roadmap (as of 2026-11-08)

## Next order (owner's list of 2026-11-08, sorted; draft until the owner agrees)
Done from the 11-02 order below: items 1 to 5 (briefing, warm session, Notion + Gmail, jobs, phone), reviews 7 and 8,
plus play from the phone, the Canvas inbox and secrets out of the repo. Each item below: plan first, small subtasks
with tests, a Mac check list, and a fresh review after anything that writes or sends.

**Why this order.** Everything later stands on two things: actions that work every time, and an app the owner can
use without a terminal. Features that *send* or *apply* come after those, because a wrong click there costs real
money or reputation. Speed comes after reliability (fast and wrong is worse than slow and right).

| # | Item | Why here | Depends on | Size |
|---|------|----------|------------|------|
| P1 | **Reliable clicks and actions** (today about 7 in 10 for YouTube; goal 19 in 20) | Every later item (apply, send, faster) is built on clicks working | none | M-L |
| P2 | **App-first: run and test Stephen from the app, not the terminal** | Daily use and testing without commands; the redesign must include these controls | none | M |
| P3 | **UI redesign** (clean, e-commerce-quality look) | Best done once P2 decided what the app must hold | P2 | M |
| P4 | **Reply to email / Canvas by voice, send only after you see it** | High value, but Stephen's first *sending* feature: needs a design and review #9 | P1, P2 | L |
| P5 | **Internship pipeline with `~/ai-job-search`** (find, write, apply) | The biggest goal; needs reliable clicks, uploads and the confirm pattern from P4 | P1, P4 | XL, in phases |
| P6 | **Faster actions** | After reliability; measure, then cut round trips | P1 | M |
| P7 | **Better transcription of names** | Owner: low priority | none | S-M |
| Vision | **Stephen as the bridge between automation and AI** | The result of P1 to P6, not a separate task | all | n/a |

### P1. Reliable clicks and actions
- Measure first: a click-reliability eval (fixture pages plus the real YouTube flow), 20 runs each, and a failure log
  by cause: stale ref, element covered, page still loading, wrong element, autoplay blocked, tab not focused.
- Fix where all callers go through (`src/page/index.ts`): wait for the page to settle, re-find the element once on
  STALE_REF for safe actions, check the result after a click (did the video start, did the page change).
- Done when: 19/20 on each eval case, and the owner's YouTube test passes 10/10.

### P2. App-first
- The Stephen window starts and stops `stephen listen` itself (through the Helper, as a background process that keeps
  running when the window closes), shows its log, and has buttons for: phone on/off and sign-in, Zen for Stephen,
  doctor, and the Mac test checklist (tick boxes, with the command run for you where it's safe).
- Done when: a full day of use and the MAC-TEST-PLAN can be done without opening Terminal.

### P3. UI redesign
- Process: three theme directions (below) as clickable mockups, owner picks one, then tab by tab in SwiftUI with the
  TS mirror tests. No new features in this pass.
- Directions to choose from:
  - **A. Storefront (light first):** white and soft gray, big rounded cards (16 px), a hero "Today" card like a
    product banner, Jobs and Accounts as a grid of cards with status chips, one bold accent color.
  - **B. Night market (dark first):** deep navy background, glassy cards, a vivid accent (teal or orange), large
    numbers for "due this week", "unread", "jobs running".
  - **C. Native premium:** macOS materials and SF Symbols, sidebar plus content, quiet colors, polish in spacing,
    typography and motion (closest to Apple's own apps).
- **Chosen 2026-11-08: A. Storefront**, refined the same day into **docs/UI-PLAN.md** (the spec to build from:
  anti-slop rules, screens, tokens with measured contrast, components, states, build order, open questions).
  **Superseded the same day by v3** (owner's direction: calm navy, small floating chat, context network,
  personality settings), then **v3.1** so Stephen does not copy the friend's product: Personal (grouped lists plus a
  permissions table) replaces the context network, the Ask box (menu bar popover) replaces the floating chat, and Settings
  uses Length/Tone controls. **Build from docs/UI-PLAN.md v3.1.** Mockups:
  https://claude.ai/artifact/LPZoKp4HvKkyjAM2ysAUrd (row "v3.1": Home, Ask box, Personal, Memory, Settings, Appearance).

### P4. Reply by voice (email, Canvas)
- Flow: read → "want to reply?" → you say the reply (Stephen's ASR, or Wispr Flow typing into the draft) → the draft
  shows on screen (window and notification) with recipient and subject → you say or click **Send** → it sends.
  Never sends what you haven't seen; never from the wake word alone; from the phone only with a phone tap showing
  the exact text.
- Needs: a write scope (Gmail `gmail.send`, new consent; Canvas conversation reply), a threat model (injected email
  asking to "reply with your password"), and review #9 before it ships.

### P5. Internship pipeline (in phases, each usable alone)
1. **Find:** Stephen reads job sites you name and saves each match (link and job description text) into
   `~/ai-job-search/inbox/`.
2. **Write:** a job (ADR-004 sandbox) runs your `ai-job-search` project on each saved posting and puts the resume and
   cover letter PDFs next to it.
3. **Apply (assisted):** Stephen opens the posting, fills the form, uploads those PDFs, and **stops before Submit**
   for your OK. Watch for: site bot checks (plan §14), sites' terms of use, one application at a time.

### P6. Faster actions
- Measure each step (think, tool call, page wait). Cut round trips: batch actions, fewer snapshots, include the
  snapshot in the action's answer, keep tabs warm.

### P7. Names in transcription
- A custom word list from your memory, contacts and course names fed to the speech model as hints; when a name is
  unsure, Stephen asks "did you mean …?" instead of guessing.

### Carried over (not lost)
- Phone confirmations as a phone tap (plan §13 option 2), bot detection in "Zen for Stephen" (plan §14), more Canvas
  pages, Gmail consent screen "In production" (MAC-TEST-PLAN §10), the `~/.stephen` move (§10).

## Order agreed 2026-11-02 (done; details: docs/HANDOFF-PROMPT.md)

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
