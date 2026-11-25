# Stephen: production readiness

**Status:** Proposed 2026-11-25 by the dev lane. Plan only, no code. Nothing here is decided until Cris accepts it
on #10.
**Goes with:** `docs/ARCHITECTURE-PLAN.md` (PR #318; task ids B, F, P, W and experiments E come from there),
`docs/RELEASE-PLAN.md`, `docs/NFR-STEPHEN.md`, `docs/AGENT-LOOP.md`, `docs/DATA-STORES.md`.
**Rule for this doc:** every claim about today was checked against `qa` at `881b5cf`. New tasks here have ids R1 to
R23. Tasks already planned in #318 keep their ids and are not repeated in full.

## How to read this

Stephen is a local Mac app. It has no server, no accounts of its own, and no money of its own: each person runs it on
their own Claude account. Many items on a normal production checklist assume a web service. For each item below:
does it apply, what exists today, the gap, and a phase.

| Phase | Meaning |
|---|---|
| NOW | Needed for the friends beta. Cris: "fully working first" |
| PUBLIC | Needed before anyone can download it |
| LATER | Only when a trigger happens (named in the row) |
| N/A | Does not apply to Stephen, with one line why |

## 1. Triage

| # | Item | Applies? | Today (files) | Gap | Phase |
|---|---|---|---|---|---|
| 1 | CI/CD | Yes | CI: `.github/workflows/ci.yml` runs `linux` and `macos` on every PR to `qa` and `main`, pinned actions, no secrets, no `pull_request_target`. `qa` ruleset requires both checks. No CD: releases are a manual merge plus a build on each Mac | `main` is not protected (B1). No release job, no signing (F4, F6) | NOW (B1, F6) |
| 2 | Unit tests | Yes | Vitest over `test/` (one folder per `src/` area), helper tests in `test/helper`, boundary tests (`test/memory/boundary.test.ts`), the lock in `test/global-setup.ts` | No test that last release's files still load (B10). Config is strict, so a new key breaks going back (B11) | NOW (B10, B11) |
| 3 | Performance monitoring | Yes, local only | `stephen latency` (`src/telemetry/latency.ts`, `src/telemetry/cli.ts` with `TARGETS`), `scripts/measure-idle.sh`, the weekly number sheet (`docs/RELEASE-PLAN.md` section 4) | Idle CPU and memory never measured (R14). Wake word 2x over target (NFR section 3). No weekly summary a friend can send (F13) | NOW (R14, F13) |
| 4 | Auth on every endpoint | Yes | `app.sock` and `phone.sock`: 0600 sockets in a 0700 folder, same user only (`src/lib/private-socket.ts`); `phone.sock` is off by default and rate limited (`src/phone/server.ts`). `helper.sock`: 0600 plus a `getpeereid` uid check (`helper/Core.swift`). MCP `serve`: stdio only, spawned by `claude` from a strict per-run config, no network port. Gmail sign-in: one-shot loopback server on 127.0.0.1 with `state` and PKCE (`src/connect/gmail-oauth.ts`). Zen's debug port: **no auth**, any local user can reach it (`src/drivers/zen.ts`). Chrome asks for an Allow on each connection (`src/drivers/chrome.ts`) | Nonce on `helper.sock` (F15). Debug port on shared Macs (B5). No test stops a new network listener from appearing (R4) | NOW (R4, B5, F15) |
| 5 | Dependency audit | Yes | `npm ci` from the lockfile, 5 runtime dependencies, every new one needs Cris's OK (`AGENTS.md`), pinned action SHAs | No Dependabot config (`.github/dependabot.yml` is missing), alerts not confirmed on, no audit step anywhere. License check not done (P4) | NOW (R1, R2; audit in F6), PUBLIC (P4) |
| 6 | Spend caps and billing alerts | Yes, for the person's own account | Daily limit on by default, 1 USD (`src/voice/config.ts` `dailyLimit`), 80% warning and stop at 100% (#305, #309); job budget 5 USD (`src/jobs/config.ts`). We hold no paid key today | The 1 USD default is a guess; what cost means on a subscription is unknown (E7, R13). Our only future key (incident agent) needs a spend limit (D3, F11) | NOW (R13) |
| 7 | Backups and a tested restore | Partly | Atomic 0600 writes (`src/lib/fs.ts`, temp file, fsync, rename), so a crash does not leave half a file. Time Machine covers `~/.stephen` if the person uses it. Keychain items are the person's own | No export or import, no restore test. Loss today is small (memory is at most 30 items) | NOW: N-1 reads (B10, B11). PUBLIC: R20 |
| 8 | Rollback for bad updates | Yes | Going back by git in `docs/RELEASE-CHECKLIST.md`. `stephen update` is planned (#317), not on `qa` yet | No one-click go back (F8); the N-1 data rule needs B10 and B11 first | NOW (B10, B11, F8) |
| 9 | Secrets out of the repo | Yes | `.env` in `.gitignore`; secrets live in the Keychain (`src/lib/keychain.ts`); `test/security/no-secret-leak.test.ts` proves no account secret reaches tool results, logs or history; CI holds no secret | GitHub secret scanning and push protection not confirmed on (R1) | NOW (R1) |
| 10 | Rotate leaked keys | Yes, from F1 on | None. Today we hold no long-lived key in CI | A runbook for each key we will hold (Developer ID, notary key, Sparkle EdDSA key, incident key) and for the person's own tokens (R12). Must exist before F1 creates the first key | NOW (R12) |
| 11 | Rate limiting | Yes, for local actions | SafetyGate `maxActionsPerMinute`, account reads included (`src/safety/gate.ts`); phone asks 6 a minute (`PHONE_ASKS_PER_MIN`); planned incident runs at most one per issue per edit window (ADR-014, in PR #318). Model API limits are Anthropic's, on the person's account | None new. A model "rate limited" answer needs a plain spoken reason (R5) | NOW (done; R5 for the reply) |
| 12 | Error tracking | Yes, content-free | Incident file and `stephen report` (#303, `src/telemetry/incidents.ts`, `src/telemetry/report.ts`) | Friends have no `gh` (F12). Workflow that hands an incident to a lane (F11). Automatic reports off by default (P6) | NOW (F11, F12), PUBLIC (P6) |
| 13 | Uptime monitoring | No server | | N/A: nothing of ours runs all the time. The local version is "the listener is alive": B3 restarts it. The appcast on GitHub Pages rides on GitHub's uptime | N/A (B3 covers the local part) |
| 14 | Staging | Yes, as channels | `qa` is the staging branch; weekly release to `main` | A beta channel friends opt into, and promote to stable after 7 days (F7, D7) | NOW (F7) |
| 15 | Custom domain SSL | Only if D5 b | GitHub Pages serves `github.io` over HTTPS already | If Cris picks a domain: Pages custom domain with "Enforce HTTPS" (R22). **The feed URL is baked into every installed app, so it must be fixed before F7 ships** | PUBLIC (only with D5 b); the URL choice is NOW |
| 16 | SPF, DKIM, DMARC | No | Stephen sends no email | N/A: no sending domain. If D5 b adds a support mailbox, set them at the mail host then | N/A (LATER with own-domain mail) |
| 17 | Real error, empty and loading states | Yes | Helper pages: Home, Memory, Conversations, Jobs, Settings, the Ask box (`helper/*.swift`). Spoken fallbacks "Something went wrong." (`src/voice/assistant.ts:386`) and "Something went wrong while I was working on that." (`src/voice/claude.ts:493`) | Not audited page by page (R6, R7a to R7e). A generic spoken error breaks the "clear spoken reason" target of 98% (R5) | NOW (R5, R6, R7) |
| 18 | Evals | Yes | `stephen eval` with 15 categories (`src/eval/cases.ts`, `src/eval/run.ts`, `src/eval/score.ts`); `test/eval/` tests the runner | Not run per release because it costs tokens (NFR section 1). Not in the release checklist (R8) | NOW (R8) |
| 19 | Prompt-injection tests | Yes | 7 `inject` eval cases with fake pages (`serve --dry-run --fake-page`); injection fixtures in `test/fixtures/`; taint and egress in `src/safety/`; boundary tests | Inject cases not run per release (R8). Coverage per untrusted source (mail, calendar, Notion, Canvas, page) not listed (R9). The incident workflow is a new injection surface (F11 strict parse) | NOW (R8, R9, F11) |
| 20 | Fallback when the model API is down | Yes | Speech to text, the routers (memory, timers, jobs) and the clicks are local and keep working. A failed run says "Something went wrong" (`src/voice/assistant.ts:386`, `src/voice/claude.ts:493`) | No plain reason (no network, signed out, usage limit, Claude busy) and no incident code word for it (R5). Running on a local model is ADR-016, LATER | NOW (R5), LATER (ADR-016) |
| 21 | Privacy policy and terms | Yes | Content planned in ARCHITECTURE-PLAN section 7.3; MIT license (no warranty) | No published policy (P2). "What leaves the Mac" is wrong in the NFR (B7). No short terms page (R21) | NOW (B7), PUBLIC (P2, R21) |
| 22 | Delete all my data | Yes | Each store has its own delete in `docs/DATA-STORES.md`; `stephen history clear`; `stephen disconnect <account>` | No list in one place (B6) and no "delete everything" (R10). Uninstall steps not written (F10) | NOW (B6, R10, F10) |
| 23 | Password reset | No | | N/A: Stephen has no accounts or passwords. Claude sign-in is Anthropic's, connected accounts are the providers' | N/A |
| 24 | Penetration test | Yes, as reviews | Independent reviews `docs/REVIEW-1.md` to `REVIEW-10B.md`, findings in `docs/research/FINDINGS-LEDGER.md` | Review of the new packaging and updater (F16), full review before public (P10). A paid outside test costs money and fits a company, not a free app | NOW (F16), PUBLIC (P10), LATER (paid test) |
| 25 | Google CASA | Not today | Each person makes their own "Desktop app" OAuth client, scope exactly `gmail.readonly` (`src/connect/gmail-oauth.ts`). A personal client in Testing mode needs no Google verification, but it is limited to its test-user list, Google expires its refresh tokens after 7 days (`docs/PLAN-2A-READ-MY-STUFF.md`), and each friend must make their own Google Cloud client | Setup cost for friends (F10 must explain it). CASA comes only if we ship one shared Google client for everyone (`gmail.readonly` is a restricted scope: verification plus a yearly security assessment) | LATER (trigger: a shared Google client) |
| 26 | Microsoft audit | No | No Microsoft account connector | N/A until an Outlook or Microsoft 365 connector exists (then publisher verification) | N/A (LATER with an Outlook connector) |
| 27 | DPA | No | Nothing reaches us; each person's data goes to Anthropic under their own account and its terms | N/A: we are not a processor of anyone's data. Only a business customer would ask | LATER (trigger: a business user) |
| 28 | Security questionnaire | No | `docs/SYSTEM-DESIGN-STEPHEN.md`, `docs/DATA-STORES.md`, `SECURITY.md` (P3) answer most questions | N/A for friends and public individuals | LATER (trigger: a business user) |
| 29 | SSO and audit logs | Partly | No accounts, so no SSO. A local safety audit log exists, redacted and size capped (`src/safety/audit.ts`) | SSO N/A. The audit log is for the person, not an admin | N/A (SSO); audit log done |
| 30 | Sending domains off blocklists | No | Stephen sends no email; reports go through GitHub | N/A: no sending domain | N/A |
| 31 | Claude Code version drift (added) | Yes, our main outside dependency | Tested range and flag check (`TESTED_CLAUDE_MIN`, `TESTED_CLAUDE_MAX`, `checkClaudeFlags` in `src/voice/claude.ts`); Stephen refuses a `claude` without the lock-down flags | No weekly check against the newest Claude Code (B2, E8) | NOW (B2) |
| 32 | Mac permissions after an update (added) | Yes, hits every friend | Ad hoc signed helper: a rebuild resets Input Monitoring | Developer ID keeps them (E1, F2, F4); `doctor` and the incident record flag a lost permission | NOW (D1, E1, F4) |
| 33 | Model endpoint from the shell (added) | Yes | `withoutSecrets` (`src/voice/claude.ts`) passes `ANTHROPIC_*` variables from the shell to `claude`, so `ANTHROPIC_BASE_URL` can send prompts elsewhere | Strip them unless Stephen's own setting names an endpoint (R23) | NOW (R23) |

## 2. Decisions this triage adds

Most choices here are the dev lane's. These need Cris (goals, money, settings clicks):

| # | Decision | Why now | Recommendation |
|---|---|---|---|
| D5 (from #318), now urgent | Website address: `crish2307.github.io/stephen` or an own domain | The update feed address goes into every installed app (`SUFeedURL`). Changing it later strands every friend on the old feed. It must be fixed before F7 | GitHub Pages now. An own domain later can still serve the site; the feed stays on the Pages address |
| D9 | Turn on GitHub secret scanning, push protection, Dependabot alerts and private vulnerability reporting (R1) | Free for public repos; settings clicks only Cris can make | Yes, all four |
| D10 | Dependabot version PRs to `qa` (R2) | A new source of PRs; AGENTS.md says ask first | Yes, weekly, grouped, `qa` only |

Still open from #318: D1 (Developer ID) blocks F1 to F8 and the whole beta packaging path.

## 3. Task queue

### Rules for every task (copy into every brief)

- **Model rule:** use the cheapest model that can do the job. Free agents (OpenCode, or freellm with a healthy model
  picked by name, never `auto`) do drafts, docs, tests and planned non-safety code from a precise spec. Haiku does
  read-only checks. Sonnet does normal coding. Opus does safety code, design and reviews. The cheaper the model, the
  more precise the spec. The strong model checks every number a helper writes.
- **Usage rule:** at about 75% of the 5-hour usage limit, pause: finish the small step, update the handover note,
  tell Cris in one line, start nothing new.
- **Branch rule:** one task, one branch from `origin/qa`, one PR to `qa`, small commits as Cris (`AGENTS.md`).
- **Files forbidden, always:** the "Always Claude-only" list in `docs/AGENT-LOOP.md` for free agents and Haiku, and
  every file not under "Files allowed".
- **Done check, always:** `git diff --stat origin/qa...HEAD` shows only allowed files;
  `git log --format='%an <%ae> | %cn <%ce>' origin/qa..HEAD` shows only Cris; no em or en dashes;
  `npm run build && npm run typecheck && npx vitest run` passes (one suite at a time).
- **No free agent on a Claude-only path.** A #318 row that edits a workflow or a memory path (F14's `release.yml`
  step, B8's `src/memory/intent.ts` comment) is done by Sonnet or Haiku, not a free agent. The free agent keeps only
  the other files of that row.
- **`[DEV REVIEW]`** in the title for safety paths; it needs a dev-lane review and an independent Opus review.

### Queue, NOW (friends beta), in order

Rows on the same step can run in parallel (their files do not overlap). A later step waits for the ones it names.

| Step | Task | Waits for | Model | Safety |
|---|---|---|---|---|
| 1 | B1 protect `main` (Cris click) | | Haiku writes steps | No |
| 1 | R1 repo security settings (Cris clicks, D9) | | Haiku writes steps | No |
| 1 | R12 key rotation runbook | | Free agent, Opus checks | No |
| 1 | R14 idle measurement | | Cris on the Mac, free agent fills | No |
| 2 | B11 tolerant config readers | | Per #318 | Per #318 |
| 2 | R4 network listener test | | OpenCode, Sonnet reviews | No |
| 2 | R23 no model endpoint from the shell | | Opus | **[DEV REVIEW]** |
| 2 | R6 UI states audit | | Haiku | No |
| 2 | B7 "what leaves the Mac" docs | | Per #318 | No |
| 3 | B10 N-1 data fixtures | B11 | Per #318 | No |
| 3 | R5 plain reasons when Claude fails | R23 (same file) | Sonnet, Opus reviews | **[DEV REVIEW]** |
| 3 | R7a to R7e UI states, one page each | R6 | Sonnet (UI lane) | No |
| 3 | B6 `stephen data` list | B7 | Per #318 | No |
| 4 | R10 delete all my data | B6 | Opus | **[DEV REVIEW]** |
| 4 | R8 inject eval per release | | Sonnet | Claude-only file (`docs/RELEASE-CHECKLIST.md`) |
| 4 | R9 inject coverage per source | | Opus | **[DEV REVIEW]** |
| 4 | R2 Dependabot config (after D10) | R1 | Sonnet | Cris OKs |
| 5 | B2, B3, B4 (after E3), B5, B8, B9 | Per #318 | Per #318 | Per #318 |
| 5 | R13 daily limit default | one week of cost lines, E7 | Sonnet | No |
| 6 | F1 to F16, in #318 section 11 order | D1, D5 | Per #318 | Per #318 |
| 6 | F6 adds `npm audit signatures` and `npm audit --omit=dev --audit-level=high` to the release build | Same PR as F6 | Per #318 | Per #318 |
| 6 | F10 adds "how to leave" (quit, remove the app and the login item, then R10) and the Google Testing-mode limits | Same PR as F10; R10 | Per #318 | No |

**Beta gate:** the #318 gate (F16 with no open High, E6 under 15 minutes) plus R5, R7, R8, R10 and R23 merged.

### Queue, PUBLIC, in order

| Step | Task | Waits for | Model | Safety |
|---|---|---|---|---|
| 1 | P2 privacy policy, R21 terms | B7 | Free agent, Opus checks | No |
| 1 | P3 `SECURITY.md`, P4 notices, P9 `CONTRIBUTING.md` | | Per #318 | No |
| 2 | R20 export and import with a restore test | B6, B10 | Opus | **[DEV REVIEW]** |
| 2 | P1 website, R22 custom domain (only with D5 b) | P2, P3 | Per #318 | Per #318 |
| 3 | P5, P6, P7, P8 | Per #318 | Per #318 | Per #318 |
| 4 | P10 full review | all of the above | Opus, fresh reviewer | Review |

### Task specs (new tasks only; #318 rows already hold files, model and acceptance test)

```text
R1  Repo security settings                         Model: Haiku writes the steps, Cris clicks
Goal:            Secret scanning, push protection, Dependabot alerts and private vulnerability reporting are on.
Files allowed:   none (settings). The step list goes in the PR body of R2 or a comment on #10.
Steps:           1. Haiku lists the exact Settings > Code security clicks.
                 2. Cris clicks them.
                 3. Haiku reads back the state.
Acceptance test: gh api repos/CrisH2307/stephen --jq .security_and_analysis shows secret_scanning and
                 secret_scanning_push_protection "enabled"; the Security tab shows "Report a vulnerability".
Done check:      Read-back pasted on #10.
```

```text
R2  Dependabot version updates                     Model: Sonnet    Safety: Cris OKs first (D10)
Goal:            Dependabot opens grouped weekly PRs to qa for npm and github-actions.
Files allowed:   .github/dependabot.yml (new)
Steps:           1. Two ecosystems: npm at "/", github-actions at "/".
                 2. target-branch: qa. schedule weekly. One group per ecosystem. open-pull-requests-limit 3.
                 3. No auto-merge. Action updates keep SHA pins (Dependabot updates the SHA and the comment).
Acceptance test: GitHub validates the file (Insights > Dependency graph > Dependabot shows no error); the first
                 PRs target qa.
Done check:      Standard.
```

```text
R4  Network listener test                          Model: OpenCode from this spec, Sonnet reviews
Goal:            A test fails when code anywhere in src/ starts a new server outside a known list.
Files allowed:   test/security/listeners.test.ts (new)
Files forbidden: all of src/
Steps:           1. Walk src/ for *.ts files. Find lines with "createServer(", ".listen(" or "listenPrivateSocket(".
                 2. Allowed files (exact list, from qa today): src/lib/private-socket.ts, src/app/server.ts and
                    src/phone/server.ts (through listenPrivateSocket), src/connect/gmail-oauth.ts,
                    src/selftest/fixtures.ts, src/eval/clicks.ts. Check each with grep before writing it down,
                    and add any other file that matches today only after the reviewer agrees.
                 3. Key the list by file and the number of listener calls in it, so a second listener in an
                    allowed file also fails.
                 4. For an allowed file that uses node:http, the file must contain "127.0.0.1" and must not contain
                    "0.0.0.0".
                 5. A second case with a planted fake file content proves the test fails on a new listener.
Acceptance test: npx vitest run test/security/listeners.test.ts
Done check:      Standard.
```

```text
R5  Plain reasons when Claude fails                Model: Sonnet, Opus reviews   Safety: [DEV REVIEW]
Goal:            When a model run fails, Stephen says why in one plain sentence and writes an incident code word.
Files allowed:   src/voice/claude.ts (error classification only), src/voice/assistant.ts (the spoken line),
                 src/telemetry/incidents.ts (new code words), test/voice/claude-errors.test.ts (new)
Files forbidden: claudeSpawnOptions, withoutSecrets and REQUIRED_CLAUDE_FLAGS in src/voice/claude.ts; formatReport
                 in src/telemetry/
Steps:           1. Classify a failed run into: claude_missing (no binary), claude_signed_out, claude_usage_limit,
                    claude_busy (overloaded or rate limited), claude_offline (no network), claude_other.
                    Use only the result subtype, the exit code and fixed error markers, never the text itself.
                 2. One spoken line each, for example "I can't reach Claude right now. Check the internet."
                 3. Add the code words to INCIDENT_CODES. Older versions map unknown codes to "other" already.
                 4. Say once that local commands (timers, memory) still work.
                 5. No retry loop. No config key (B11 rule).
Acceptance test: npx vitest run test/voice test/telemetry, with a fake claude for each case.
Done check:      Standard. No transcript or error text reaches the incident file.
```

```text
R6  UI states audit                                Model: Haiku, read-only
Goal:            A table of every helper page and the Ask box: loading, empty, error, and offline states.
Files allowed:   docs/research/UI-STATES-AUDIT.md (new)
Steps:           1. For Home, Memory, Conversations, Jobs, Settings and the Ask box (helper/*.swift), find what the
                    page shows while waiting for app.sock, with no data, when the listener is stopped, and on an
                    error reply.
                 2. One row per page and state: today (file:line), missing or fine.
Acceptance test: Sonnet spot-checks 5 rows against the code.
Done check:      Standard.
```

```text
R7a to R7e  UI states, one page each               Model: Sonnet (UI lane)
Goal:            Each page shows a real loading, empty and error state, and a "Stephen is stopped, press Start"
                 state, per R6.
Files allowed:   R7a helper/HomeView.swift; R7b helper/MemoryPage.swift; R7c helper/ConversationsPage.swift;
                 R7d helper/JobsPage.swift; R7e helper/SettingsPage.swift. Shared views only in a new file under
                 helper/Components/ made by R7a, which the others then use.
Files forbidden: helper/AppConfirm.swift, helper/AppConnection.swift, src/app/protocol.ts, src/app/server.ts
Steps:           From the R6 rows for that page. Words follow docs/UI-PLAN.md. No new app.sock request.
Acceptance test: npx vitest run test/helper; a screenshot of each state in the PR (Cris checks on the Mac).
Done check:      Standard.
```

```text
R8  Inject eval per release                        Model: Sonnet
Goal:            Every release runs the inject eval and records the score; less than 100% blocks the release.
Files allowed:   docs/RELEASE-CHECKLIST.md, docs/RELEASE-PLAN.md (number sheet row)
Steps:           1. Add step 4b: stephen eval --only inject on the release commit, on Cris's Mac.
                 2. Add a number sheet row: inject pass rate and the cost of the run.
Acceptance test: The review lane follows the new step once on the next release.
Done check:      Standard.
```

```text
R9  Inject coverage per untrusted source           Model: Opus     Safety: [DEV REVIEW]
Goal:            Every source of third-party text has at least one inject case.
Files allowed:   src/eval/cases.ts, test/fixtures/ (new fake pages only), test/eval/ (case count test)
Steps:           1. List the sources: web page, Gmail message, calendar event, Notion page, Canvas
                    announcement, a job's output read back, a phone ask.
                 2. Add a case for each source without one. The pass rule: no acting tool is called, or the gate
                    refuses it.
Acceptance test: npx vitest run test/eval; then one paid run of the new cases, score in the PR.
Done check:      Standard.
```

```text
R10 Delete all my data                             Model: Opus     Safety: [DEV REVIEW]
Goal:            stephen data delete --all removes everything Stephen keeps, after one clear question.
Files allowed:   the B6 file (src/app/data-cli.ts or its src/cli.ts case), test/app/data-delete.test.ts (new)
Steps:           1. Refuse while stephen listen runs (app.sock answers): "Quit Stephen first."
                 2. Show the list from B6 and ask "Delete all of this? [y/N]". Default no. No terminal: refuse.
                 3. Delete <home> (every row of docs/DATA-STORES.md), the voice Claude transcripts
                    (src/voice/transcripts.ts), and each Keychain item through the existing disconnect path.
                 4. Ask separately about ~/Stephen Jobs (it holds the person's own files).
                 5. Never follow symlinks out of <home>; print what was deleted.
Acceptance test: Test with a temp <home> full of fixture files and a fake Keychain: all gone, a symlink target
                 outside <home> kept, refusal while a fake app.sock answers.
Done check:      Standard.
```

```text
R12 Key rotation runbook                           Model: Sonnet drafts, Opus checks every step (secrets: no free agent)
Goal:            For each key: where it lives, signs of a leak, how to rotate, and who tells friends.
Files allowed:   docs/KEY-ROTATION.md (new)
Steps:           1. Our keys (from F1 on): Developer ID certificate, App Store Connect API key, Sparkle EdDSA key,
                    the incident key (D3). Use ARCHITECTURE-PLAN section 5.3 as the source.
                 2. The person's own: Gmail refresh token, Google OAuth client secret, Canvas token, Notion token,
                    ElevenLabs key: stephen disconnect, then revoke at the provider.
                 3. A Sparkle key leak is handled like a Developer ID leak (ARCHITECTURE-PLAN section 4.2).
Acceptance test: Opus checks each step against the provider's current docs.
Done check:      Standard.
```

```text
R13 Daily limit default                            Model: Sonnet
Goal:            The daily limit default comes from one week of real cost lines, not a guess.
Files allowed:   src/voice/config.ts (the default only), docs/NFR-STEPHEN.md section 6, the test of the default
Steps:           1. Cris pastes 7 days of stephen latency cost lines (numbers only), or Haiku reads them.
                 2. Use E7 to say what the number means on a subscription.
                 3. Set the default near the 90th percentile day, rounded up. Write the numbers in the NFR.
Acceptance test: npx vitest run test/voice
Done check:      Standard. Sonnet checks every number.
```

```text
R14 Idle measurement                               Model: Cris runs it, free agent fills the doc
Goal:            The NFR section 5 numbers are measured.
Files allowed:   docs/NFR-STEPHEN.md section 5
Steps:           scripts/measure-idle.sh for 10 minutes, Stephen running, other Claude sessions closed.
Acceptance test: Haiku checks the numbers in the doc match the script output.
Done check:      Standard.
```

```text
R23 No model endpoint from the shell              Model: Opus     Safety: [DEV REVIEW]
Goal:            claude gets no ANTHROPIC_* variable from the shell; the endpoint is always Anthropic's default.
Files allowed:   withoutSecrets in src/voice/claude.ts, the job spawn environment in src/jobs/ (step 2),
                 their tests in test/voice/ and test/jobs/
Steps:           1. In withoutSecrets, delete every key that starts with ANTHROPIC_. Keep the person's Claude
                    sign-in working: check first which variables Claude Code needs (none today in KEPT_CLAUDE_CODE_ENV).
                 2. Same for the job runner's environment (src/jobs/), if it does not already go through
                    withoutSecrets.
                 3. ADR-016 may later add one explicit endpoint setting; until then there is none.
Acceptance test: npx vitest run test/voice test/jobs: ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in the parent env are
                 absent in the child env.
Done check:      Standard. A doctor line if the shell had ANTHROPIC_BASE_URL set (so the person knows why).
```

```text
R20 Export and import, with a restore test         Model: Opus     Safety: [DEV REVIEW] (memory and timer writes)
Goal:            stephen data export <folder> and stephen data import <folder> move config, memory, timers and
                 (if asked) history between Macs or versions.
Files allowed:   the B6 file, test/app/data-export.test.ts (new), docs/DATA-STORES.md
Steps:           1. Export: copy the files into a new 0700 folder, files 0600, with the version.
                 2. Import: Stephen stopped; parse with the same parsers as the stores (B11 tolerant readers);
                    write through the existing store write functions, never a raw copy; refuse a bad file whole.
                 3. Never export Keychain items.
Acceptance test: Round trip on the B10 fixtures; a corrupt file is refused and nothing changes; an import from
                 the last release's fixtures works.
Done check:      Standard.
```

```text
R21 Terms of use                                   Model: free agent draft, Opus checks
Goal:            A short page: free software under MIT with no warranty, a beta, your Claude account's terms apply,
                 you are responsible for what you ask it to do, Allow and Deny are yours.
Files allowed:   docs/TERMS.md (new)
Acceptance test: Opus checks it does not promise more than docs/SYSTEM-DESIGN-STEPHEN.md and P2 say.
Done check:      Standard.
```

```text
R22 Custom domain HTTPS (only with D5 b)           Model: Haiku writes steps, Cris clicks
Goal:            The site answers on the own domain over HTTPS. The update feed URL does not change.
Steps:           Pages custom domain, DNS records at the registrar, "Enforce HTTPS" on, a CAA record.
Acceptance test: curl -sI https://<domain> shows 200; the appcast URL in the app is unchanged.
```

## 4. What this does not cover

Windows (phase W), ADR-016 (free or local models, LATER), and anything that needs a server: none is planned.
