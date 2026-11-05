# Master handoff prompt (paste into a new Claude session)

Updated 2026-11-05. Copy everything below the line into the first message of a new session. The repo is
github.com/CrisH2307/stephen. Work continues on branch `claude/nifty-johnson-yk4hv6` (16 commits ahead of `main`;
the owner merges to `main` by PR).

---

You're picking up **Stephen**, my voice assistant for my Mac. "Hey Stephen" or hold **F5** → local speech-to-text →
`claude -p` headless, locked to Stephen's own MCP tools behind a safety gate → spoken reply. TypeScript (Node) +
a small Swift helper app. Repo: github.com/CrisH2307/stephen, branch `claude/nifty-johnson-yk4hv6`.

## Read first (in this order)
1. `docs/PROJECT-CONTEXT.md`: how to work (build/test, never `npm install` in the Mac VM shell, Swift only compiles
   on my Mac).
2. `docs/HANDOVER.md`: progress log; the last 6 entries (2026-11-02 to 11-05) are the current state.
3. `docs/PLAN-WORK-SPLIT.md`: how work is split across subagents, my decisions (§6, §8, §10), what's next.
4. `docs/SYSTEM-DESIGN-STEPHEN.md`: architecture, algorithms, threat model (§4.10 briefing to §4.13 jobs). Keep it
   current; I use it with employers.
5. `docs/ADR-005-phone-channel.md` (next item), then `docs/REVIEW-7.md` (latest review and its fix format).

## Where we are (2026-11-05)
- Done, merged, green: items 1–4 of the plan.
  1. Morning briefing (`weather_now` + calendar + Canvas in one step).
  2. Phase 3: one warm `claude -p --input-format stream-json` per conversation, pre-warmed on wake word / F5,
     per-conversation rate limit, caps (60 s unused, 30 min / 25 commands), serve instance lock (R7-1).
  3. Notion (`notion_todos`, `notion_search`) and Gmail (`stephen connect gmail <label>`, OAuth PKCE,
     `gmail.readonly`, `gmail_search`, `gmail_read`). Wake word = "summary only" for email (R7-2).
  4. Jobs while away (src/jobs): deterministic router + native dialog for every start, sandboxed `claude -p` per
     job (6 tools, no MCP, strict sandbox, scratch env, budgets 45 min / 150 turns / $5, max 2), inbox
     `~/Stephen Jobs/inbox/`, notification + spoken summary, Jobs tab, `stephen jobs …`.
  Plus: review #7 (no Critical/High, all 12 findings fixed), a code-quality pass (src/lib: one implementation per
  concern, jscpd 4 clones → 0, no-secret-leak test), Stephen window Accounts / Today card / Jobs tab.
- Tests: `npm ci && npm run build && npx vitest run` → 2932 passed, 15 skipped (~10 min). Known flaky under full
  load, pass alone: `test/page/review2.int.test.ts #15`, `test/drivers/review1` "60 s Allow wait".
  `npm run typecheck` 0 errors. Real eval: `node dist/cli.js eval --model sonnet --jobs 4` → 59/60 (`mis-lofi`
  borderline), plus wake / notion / mail / job cases pass.
- **Not yet tested on my Mac**: everything above. My checklist is `docs/MAC-TEST-PLAN.md` (I'm running it). Swift
  (Accounts, Today card, Jobs tab) has never been compiled. The sandbox for jobs can only be proven on macOS.

## What to do next, in order
1. Fix anything I report from `docs/MAC-TEST-PLAN.md`.
2. **Item 5: talk to Stephen from my phone** (ADR-005): prefer Claude Code Remote Control with one dedicated session
   limited to a small Stephen bridge MCP (`ask`, `job_status`, `start_job` with per-call approval); phone = low
   trust. First probe on my Mac whether a Remote Control session can be limited to exactly those tools. If not, the
   fallback is an outbound-only relay with a paired secret. Write the threat model first.
3. **Review #8** by a fresh subagent that didn't build items 4–5 → `docs/REVIEW-8.md`, then fixes with tests.
4. UI pass after each phase (small SwiftUI changes, system colours, TS mirror tests).
5. Later: Canvas inbox (conversations) and more Canvas pages; Gmail consent screen to "In production" once my tests
   pass (I chose Testing first).

## My decisions so far (don't re-ask)
- Rate limit per conversation; Notion done = checkbox or status Done/Close/Closed/Cancelled; weather default Toronto.
- Gmail labels: the account's name, or `personal_purpose_<what>` if two share a name; consent screen Testing first.
- Wake word: summary only for email; everything else full.
- Jobs: inbox folder for inputs; normal claude.ai login (no API key); defaults above.
- Phase 3: long-lived `claude -p`, no Agent SDK.

## How I like to work
- Short, simple answers that explain why. Plan first for big changes; small subtasks, each tested.
- Split work across subagents (one per subtask, own git worktree, exclusive files), pick model + effort per task:
  tiny → haiku, everyday → sonnet, large/hardest → opus (high). **No Fable** (out of budget). My Jev router is in
  `jev/` but can't run in the cloud (no key there, openrouter.ai blocked): size by hand. Subagents are expensive
  (opus/high used 300–400k tokens each): don't delegate tiny tasks.
- After each merge: build, full suite, real eval for the touched cases, update `docs/HANDOVER.md`, commit and push
  to the branch. Never push to `main`; I merge by PR.
- **Code-quality loop:** after each implementation I push to Grapuco on my Mac and share its findings. Verify them
  against the code before acting (its first two reports were mostly guesses from file names). Real tools that
  worked: `npx -y jscpd@4.0.5 src --min-lines 8 --min-tokens 70` and the repo's own import scanner
  (`test/helpers/import-scan.ts`). Keep code simple, one implementation per concern, reuse `src/lib`.
- Safety model is fixed: the model never writes memory, timers or jobs; third-party text is untrusted data; secrets
  never reach the model, logs or argv; new Claude-reachable modules go in `CLAUDE_REACHABLE`; a fresh independent
  review after each phase.
- Secrets: `.env` in the repo (gitignored, must be chmod 600) or Keychain `stephen-<name>`. Never put keys in chat,
  code, docs, tests, logs or commits. (I pasted a Canvas token in chat once; I'm rotating it.)
- No em dashes in docs or replies.

Start by reading the docs above, then tell me in a few lines what you understood and ask what I found on the Mac.
