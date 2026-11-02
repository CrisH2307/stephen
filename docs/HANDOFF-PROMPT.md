# Master handoff prompt (paste into a new Claude session)

Copy everything below the line into the first message of a new session on the owner's personal Claude account.
It assumes the session can read the repo, either from GitHub (`CrisH2307/browser_hub`, branch `main`) or from the
owner's Mac through the desktop app (folder `~/Documents/SoftwareProject/brower-hub/browser-hub`).

---

You're picking up **Stephen**, my voice assistant for my Mac. "Hey Stephen" or hold **F5** (Fn+Option still works)
→ local speech-to-text → `claude -p` headless, locked to Stephen's own MCP tools → spoken reply. Repo:
github.com/CrisH2307/browser_hub (branch `main`), TypeScript (Node 24) + a small Swift helper app.

## Read first (in this order)
1. `docs/PROJECT-CONTEXT.md`: how to work (build/test commands, sync rules, never `npm install` in the Mac shell,
   Swift only compiles on my Mac).
2. `docs/HANDOVER.md`: progress log. The last 6 entries (2026-11-01/02) are the latest state.
3. `docs/SYSTEM-DESIGN-STEPHEN.md`: architecture, algorithms, threat model. Keep this doc current. I use it to
   show my work to employers.
4. `docs/ROADMAP.md` (phases) and `docs/PLAN-2A-READ-MY-STUFF.md` (account tools).
5. `docs/REVIEW-5.md` and `docs/REVIEW-6.md`: the latest independent security reviews and their fixes.

## Where we are (2026-11-02)
- Done and green: browser and desktop control behind a safety gate, memory by voice, history, the Stephen window
  (SwiftUI in Stephen Helper.app over `app.sock`), YouTube Music control, Canvas (`canvas_due`,
  `canvas_announcements`), Google Calendar (`calendar_events` via the secret iCal URL), timers and reminders
  (handled before Claude), hold-F5 push-to-talk, security reviews 5 and 6 with fixes.
- Tests: `npm ci && npm run build && npx vitest run` gives ~2568 passed, 11 skipped (about 6 min). One page test
  (`review2.int #15`) is timing-sensitive under full-suite load and passes alone. Real eval:
  `node dist/cli.js eval --model sonnet --jobs 4` gave 52/53 (`mis-lofi` is borderline).
- Secrets: `CANVAS_API` (and later `GOOGLE_CALENDAR_ICS`, `NOTION_API`) live in the repo's `.env` (gitignored,
  0600) or in Keychain items `stephen-<name>`. Never put keys in code, docs, tests, logs or commits.

## What to build, in order
Plan briefly first (a short plan in `docs/`), then build in small subtasks, each with tests. After each subtask:
update `docs/HANDOVER.md`. Ask me before committing; I commit and push myself.

1. **Morning briefing.** "Hey Stephen, what's my day?" gives today's calendar, what's due on Canvas this week and
   the weather (Open-Meteo, no key, fixed origin through `src/accounts/http.ts`; home location from
   `voice.aboutMe` or config). One spoken answer, 3 to 4 short sentences. Reuse the account tools; don't duplicate
   them. Add eval cases.
2. **Speed and real follow-ups (phase 3, see ROADMAP).** Start Claude while I'm still speaking (pre-warm), and keep
   a long-lived session plus a long-lived Stephen server, so "read me the second one" works and the gate's memory
   lasts exactly as long as Claude's. Measure before and after (the `formatTiming` output and the eval's median
   time).
3. **Finish "read my stuff".** Notion to-dos (`NOTION_API` token, read-only), then Gmail for my two personal
   accounts first (OAuth desktop flow with PKCE, `gmail.readonly`, refresh token in Keychain). Same pattern as
   Canvas: pinned origin, `gate.notePrivateData`, cleaned `<untrusted_account_data>`, eval cases incl. injection.
4. **Jobs while I'm away ("go cook" mode).** I say "Stephen, while I'm cooking, write my SOFE 3980 lab report
   draft", or research, homework, a paper, code, vibe-coding. Stephen hands it off and works without me touching
   the computer.
   - Design rule: a job is a **separate, sandboxed Claude Code run**, NOT the locked voice session. It gets file and
     shell tools only inside its own job folder (e.g. `~/Stephen Jobs/<date>-<slug>/`, or a git worktree for code),
     no access to my browser tabs or Stephen's gate tools, a time and turn budget, and no network writes (no sending,
     posting or pushing).
   - Starting a job shows a dialog with the exact task and folder. Starting from my phone (item 5) also needs a
     confirmation on the phone. When the job finishes: a notification plus a spoken summary when I'm back, and
     `stephen jobs` (list/status/stop). The Stephen window gets a Jobs tab.
   - Before building, research what Claude Code already offers for long-running and background work (headless mode,
     the Agent SDK, cloud sessions, scheduled tasks). Prefer it over custom code. Record the decision as an ADR in
     `docs/`.
5. **Talk to Stephen from my phone.** First check what already exists (Claude mobile app + Claude Code
   remote/cloud sessions, the Claude desktop app's linked-computer features) and prefer that. If Stephen needs its
   own channel, it must be authenticated end to end (paired device + secret, nothing listening on the open
   internet, e.g. a private network like Tailscale or an outbound-only relay), rate-limited and audited. Phone
   requests count as low trust, like the wake word: jobs and anything that changes things need confirmation. Write
   the threat model first and get an independent review before shipping.
6. **UI at the end of every job.** Finish each phase by improving the Stephen app UI: use the frontend-design skill
   (or the design skills available) for direction, keep it clean and native (SwiftUI, system colours, dark mode,
   clear empty and error states). Swift can't be compiled in the cloud, so keep each Swift change small and
   self-contained, mirror logic in TypeScript tests where possible (like `test/helper/ptt-model.ts`), and give me
   the exact `node dist/cli.js install-helper` step to check it on my Mac.

After items 1–3: an independent security review (#7) by a fresh subagent that didn't build it, written to
`docs/REVIEW-7.md`, then fixes with tests. Do the same after items 4–5 (#8).

## How I like to work
- Short, simple answers. Plan first for big changes. Small separate subtasks, each tested.
- Care about function first, then legacy code and scaling: one implementation per concern, reuse modules (e.g.
  `src/accounts/http.ts`, `result.ts`, the import-boundary tests), keep code **simple, not clever**. Prefer
  deleting code to adding layers.
- Keep the safety model: the model never writes memory, timers or jobs by itself; anything third parties write is
  untrusted data; secrets never reach the model; every new Claude-reachable module goes in `CLAUDE_REACHABLE` in
  `test/helpers/import-scan.ts`.
- My Jev router (`~/.config/jev`, see PROJECT-CONTEXT) sizes subtasks and picks subagent models when it's reachable
  (openrouter.ai was blocked from the cloud last time; if so, size by hand: large tasks → opus).
- Parallel git worktrees are fine. Before syncing to my Mac, compare my Mac's files with your copy and pull in my
  edits first (deleting files on my Mac is off, so use `tar --overwrite` / `rsync --inplace`).
- Mac-only checks (Swift compile, real Canvas/Google, microphone): give me a short numbered test list.
- Keep `docs/SYSTEM-DESIGN-STEPHEN.md` updated with each new algorithm or design decision, written for a technical
  interviewer.

Start by reading the docs above, then reply with a short plan for item 1 (morning briefing) and any questions.
