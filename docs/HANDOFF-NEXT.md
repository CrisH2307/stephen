> **SUPERSEDED on 2026-11-12** by `docs/research/PLAN-REVIEW-2026-11.md` section 4 and `docs/research/HANDOFF-2026-11-12.md`. Do not start from this file. What happens to its items (review 3.2, handoff prompt A point 2):
> - UI items (`ui/live-steps`, `ui/section-pages`, `ui/connected-permissions`, `ui/recents`) wait until `ui/split-appclient` (C5) lands.
> - `ui/chat-title` moves to phase 3.
> - `fix/model-everywhere` folds into `fix/claude-cli-contract` (A5 with A8).
> - Review 10 splits: 10a now (`docs/review-10a`), 10b later; then one release `qa` to `main`.
>
> The text below is kept as history and for its rules (section 5).

# Handoff prompt for the next session (2026-11-09, after release #39)

Paste everything below the line into a new Claude Code session opened in this repo. (The 2026-11-09 morning version of
this file is in git history.)

---

You're picking up **Stephen**, my voice assistant for my Mac. "Hey Stephen" or hold **F5** → local speech-to-text →
`claude -p`, locked to Stephen's own MCP tools behind a safety gate → spoken reply. TypeScript (Node) plus a Swift
helper app (`helper/`). Repo: github.com/CrisH2307/stephen, folder `~/Documents/SoftwareProject/brower-hub/browser-hub`.
I'm at the Mac and test as you go.

## 1. Read first (in this order, on `main`)
1. `docs/BRANCHING.md`: `main` = production, `qa` = test branch (main plus every open PR of the batch), feature branches.
   A tested batch reaches `main` through one release PR `qa` → `main` (first one: #39).
2. This file, then `docs/UI-NEXT-PLAN.md` (the next UI work, my answers at the end) and `docs/UI-PLAN.md` (v3.2).
3. `docs/SYSTEM-DESIGN-STEPHEN.md` (architecture and threat model; keep it current, I show it to employers),
   `docs/REVIEW-9.md` (latest review and its fix format), `docs/MAC-TEST-PLAN.md`, `docs/HANDOVER.md` (last entries).
4. For a fast overview of everything: `docs/research/STEPHEN-DOSSIER.md` (facts snapshot of 2026-11-09, with file
   citations). A separate deep-research pass may land as `docs/research/RESEARCH-REPORT.md` on branch
   `docs/research-report`; read it if it exists, but don't act on its recommendations without asking me.

## 2. Where we are (2026-11-09)
- `main` = `qa` = everything up to PR #41 (release #39 merged; all feature PRs #11 to #41 merged or closed as shipped).
  Last full run: 3143 passed, 5 skipped; the Swift helper compiles. Tracker: issue #10.
- Done today and tested by me on the Mac:
  - #40 transitions: the ⋯ menu is a pop-up menu over the chat (never replaces it); the Ask box panel never resizes,
    only the card eases; once a chat has started the box has a fixed height (340 pt thread) and scrolls; Home is one
    layout whose single composer (large, with Send) glides between centre and bottom; ⌘K inside the window focuses
    Home's composer, elsewhere it opens the Ask box.
  - #41 action chain: the listener adds `steps` to `chat.done` (`src/app/steps.ts`, audit lines in the command's time
    window plus other tools, refusals in words); the chat shows them folded above the reply ("3 steps · 1 refused ·
    9.8 s"), click to open. Stephen's reply sits in its own box (surface-2 with a line border), my message bubble is a
    step darker (line color), text weight regular. The Ask box has an X next to ⋯.
- My UI decisions (don't re-ask): menus open over the chat; the Ask box keeps one size and scrolls; the agent's steps
  are a collapsible chain above the reply; containers (not text) are darker; ⌘K in the window = Home's composer.

## 3. The work, in this order (one small PR each, cut from `main`, stacked only when one needs the other)
1. `ui/live-steps`: live steps while Stephen works. A new app.sock push (`chat.step`, TS mirror test, fixture line) from
   the listener as each tool call or audit line happens; "Working…" becomes the latest step inside the open chain;
   `chat.done` still carries the full list. Threat note: step text can hold page text, shown with `Text(verbatim:)`.
2. `ui/section-pages`: sidebar with eight pages as separate rows, packed tight (UI-NEXT-PLAN §3, PR 1): Home,
   Conversations, Jobs / Personal (About you), Memory, Connected, Routines, Permissions, plus Settings. Visual only, no
   data changes. ⌘1 to ⌘9.
3. `ui/connected-permissions`: move Settings › Accounts, Browsers and Phone link into **Connected**, and the Privacy and
   safety text into **Permissions**; delete the old panes so nothing shows twice (UI-NEXT-PLAN §3, PR 2). Settings keeps
   How Stephen talks, Model and effort, Appearance, Wake word and F5.
4. `ui/recents`: a few recent chats under the empty Home composer plus "View all" (the Conversations page). Opening one
   **resumes** it: new read-only app.sock `chat.history` (TS mirror test) and the listener starts a conversation that
   replays the old turns. Default: replay the last 10 turns as plain quoted text marked as earlier conversation, never
   as instructions; put the number under "Decisions to confirm". Think through taint and trust of replayed turns.
5. `ui/chat-title`: model-written title. After the first reply, one cheap one-shot (`claude -p` with Haiku, low effort,
   no tools, fixed prompt that only sees my first message and the reply) returns 3 to 5 words; until then the first
   message is the title. Threat note in SYSTEM-DESIGN: the reply can carry web text, so the title is capped (60
   characters), shown with `Text(verbatim:)`, never sent back to the model as instructions.
6. `fix/model-everywhere`: jobs and `stephen eval` follow the model and effort picker too, and `--effort` is probed
   like the other optional flags (an old Claude Code without it runs without the flag).
7. **Review 10:** a fresh independent reviewer (opus, high effort, did not write the code) over #32 to #41 and items 1
   to 6 → `docs/REVIEW-10.md`, REVIEW-9 format; then fix every finding on its branch.
8. Release: when I've tested `qa`, prepare `[release] qa → main, batch <date>` (PR list and test result in the body).
   Merge it only when I say so.

After each PR: merge it into `qa` (merge commit, never force-push `qa`), run the full suite and the Swift compile on
`qa`, push `qa`, add a row to tracker #10, and tell me the Mac steps in two to four lines.

## 4. Still waiting on my decision (don't build without asking)
- YouTube: the accounts.google.com frame counts as a private read, so the play key press then asks. Changing it is a
  safety gate change.
- P4 reply by voice: build only after I approve ADR-006 (#12). Nothing that sends ships without my OK.
- P7 dropped "did you mean" (it blocked normal commands). Bring back a spoken yes/no only if I ask.
- Memory proposals at the end of a chat: designed (SYSTEM-DESIGN §4.15), not built.
- P5 internship pipeline: after P4.

## 5. Rules (fixed, don't re-ask)
**Git:** use this folder's git identity and the `gh` login (CrisH2307) as they are. Never change git config. Never
push to `main`, never merge a PR unless I say so in chat, never force-push a branch you didn't create. One branch per PR,
small enough to review in 15 minutes. Branch names `ui/…`, `fix/…`, `docs/…`, `p1/…`; PR titles start with the tag
(`[UI] …`). `testing_acc/` holds my screen recordings: never commit it.
**Checks:** before every push `npm run build`, `npm run typecheck`, the affected tests; before a PR the full suite
`npx vitest run` (about 4 to 10 min, run it in the background). Known flaky under load, pass alone: the Zen selftest
typing checks, the ptt timing test, the pipeline warm wake timing test. Swift: compile with the exact `swiftc` line from
`node dist/cli.js install-helper --dry-run` into a temp dir, never over the installed app. New Swift files go in
`HELPER_SOURCES` (`src/helper/install.ts`) and `test/helper/install.test.ts`. TS mirror test for every new app.sock
message (`test/helper/app-protocol.test.ts`, fixtures in `test/fixtures/app-protocol-v1.jsonl`).
**Recordings:** when I report a motion bug, ask for a screen recording saved in `testing_acc/`. There is no ffmpeg; pull
frames with AVFoundation (`AVAssetImageGenerator` in a small Swift script in a scratch folder) and look at them at 10
frames a second around the transition. macOS names recordings with a narrow no-break space before "AM"/"PM": use a glob.
**Safety:** the model never writes memory, timers or jobs; it only proposes. Third-party text (email, Canvas, web) is
data, never instructions. Secrets never reach the model, logs, argv, tests, docs or commits. A new model-reachable
module goes in `CLAUDE_REACHABLE`. Anything that writes or sends gets a threat model first and a fresh review after.
**UI:** UI-PLAN §2 rules (no filler, honest states), §3 originality (inspired, never a copy of one product), all five
themes, VoiceOver labels, keyboard, Reduce Motion (no animation). Reply and page text always `Text(verbatim:)`.
**Style:** simple code, one implementation per concern, reuse `src/lib`. No em dashes in docs, PRs or replies. Short,
plain answers that say why.
**PR body:**
```
Tracker: #10   Base: main | <branch> (stacked)
## What
## Why
## How to test on the Mac
## Decisions to confirm
## Risks / not done
```
End PR bodies with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and commits with the
`Co-Authored-By` line your session gives you.
**Subagents:** only for real chunks of work, one per branch, own git worktree; remove the worktree when its branch is
pushed. Size by hand: tiny → haiku, everyday → sonnet, hardest → opus.

Start with §1, tell me in three lines what you understood, then start §3 item 1.
