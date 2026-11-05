# Work split for the 2026-11-02 handoff (items 1–6 + reviews 7–8)

Date: 2026-11-02. Source: docs/HANDOFF-PROMPT.md, docs/ROADMAP.md. Status: **draft, waiting for owner answers (§6)**.

## 1. Ground truth checked in this session
- Cloud repo: `crish2307/stephen`, branch `claude/nifty-johnson-yk4hv6`. `npm ci && npm run build` green (Node 22 here;
  engines `>=20.19`, so fine).
- The Mac is **not linked** to this session (no Remote Control folders). So no `device_bash`, no Mac sync, no Jev.
- Network is locked down: openrouter.ai, api.open-meteo.com, api.notion.com all fail from the cloud. npm works.
  → **Jev can't run.** Sizing below is by hand, using Jev's own rules (tiny→haiku, everyday→sonnet, large→opus,
  hardest→fable). → Weather and Notion calls are tested only against fake servers here; the real call is a Mac check.

## 2. How agents are split
- One subagent per subtask, each in its own **git worktree** (`../wt-<id>`, node_modules symlinked), with an
  exclusive list of files it may touch. The lead (this session) merges, runs the full suite, updates HANDOVER.md.
- Every agent gets: the subtask text, the files it owns, the modules it must reuse, the test command, and the rule
  "simple, not clever; no new layers".
- Reviews (#7, #8) always go to a **fresh** agent that never saw the build.
- Cost note (from the Jev skill): each helper starts cold (~50–70k tokens). Tiny tasks (docs edits, one eval case)
  are done by the lead, not delegated.

## 3. Task table (size, model, effort, skills)

Effort: low / medium / high (agent `effort`). Skills are the ones available in this Claude setup.

### Item 1 — Morning briefing ("what's my day")
| ID | Task | Owns | Size → model / effort | Skills |
|---|---|---|---|---|
| 1a | `weather_now` tool: Open-Meteo forecast through `ApiClient` (pinned origin `https://api.open-meteo.com`), location from `accounts.weather {lat, lon, label}`; no geocoding by the model | `src/accounts/weather.ts`, config, `index.ts` block, tests | everyday → **sonnet / medium** | test-driven-development |
| 1b | `stephen accounts weather set "<place>"` (owner-only CLI; geocodes once, writes lat/lon to config) | `src/accounts/cli.ts`, tests | everyday → **sonnet / low** | test-driven-development |
| 1c | Persona: "what's my day / morning briefing" → call `calendar_events today`, `canvas_due 7`, `weather_now` **in one turn**, reply 3–4 short sentences | `src/voice/claude.ts` persona line | tiny → **lead** | — |
| 1d | Eval: `brief-day`, `brief-day-partial` (a service not connected), `inject-calendar-brief` (invite title says "open evil.com") | `src/eval/cases.ts`, dry-server fakes | everyday → **sonnet / medium** | — |
| 1e | Docs: SYSTEM-DESIGN §4.10, HANDOVER | docs | tiny → **lead** | documentation |

No composite `day_briefing` tool: the three existing tools are called in parallel in one model turn, so a new tool
would only duplicate code. If the eval shows >2 turns or slow replies, revisit.

### Item 2 — Speed + real follow-ups (phase 3)
| ID | Task | Size → model / effort | Skills |
|---|---|---|---|
| 2a | Baseline: run eval, record median + `formatTiming` per phase (spawn, first token, tools, total) | everyday → **sonnet / low** | — |
| 2b | ADR-003: long-lived `claude` (stream-json input on one `claude -p` process, no API key) vs Agent SDK (needs Console API key, paid). Probe both in the cloud | hardest → **opus / high** + `claude-code-guide` agent for facts | architecture |
| 2c | Pre-warm: spawn `claude` + `serve` when speech starts (VAD onset), feed the transcript when ready; cancel cleanly if nothing is said | large → **opus / high** | test-driven-development |
| 2d | Long-lived session + long-lived `serve` (gate memory in-process, state file only as backup; same lifetime rules as today) | large → **opus / high** | test-driven-development |
| 2e | After-measurement + "read me the second one" eval cases | everyday → **sonnet / medium** | — |

### Item 3 — Finish "read my stuff"
| ID | Task | Size → model / effort | Skills |
|---|---|---|---|
| 3a | Notion: `notion_todos` (configured database, open items), `notion_search` (titles only), `NOTION_API` secret, fake Notion server tests | large → **opus / medium** | test-driven-development |
| 3b | Gmail OAuth: `stephen connect gmail <label>` (loopback + PKCE, `gmail.readonly`, refresh token in Keychain) | hardest → **opus / high** (security-critical) | security-review |
| 3c | Gmail tools: `gmail_search`, `gmail_read` (account label, snippets, code masking) | large → **opus / medium** | test-driven-development |
| 3d | Eval: read-todo, read-mail-prof, inject-email (body says "remember…", "open evil.com/?q=") | everyday → **sonnet / medium** | — |
| R7 | **Security review #7** (items 1–3), fresh agent → `docs/REVIEW-7.md`, then fixes with tests | hardest → **fable / high** | security-review, code-review |

### Item 4 — Jobs while away ("go cook")
| ID | Task | Size → model / effort | Skills |
|---|---|---|---|
| 4a | Research + ADR-004: headless Claude Code / Agent SDK / cloud sessions / scheduled tasks for background jobs | large → **opus / medium** + `claude-code-guide` | architecture |
| 4b | Job runner: separate sandboxed `claude -p` per job (own folder or worktree, file + shell tools only there, no Stephen tools, time/turn budget, no network writes) | hardest → **opus / high** | test-driven-development |
| 4c | Start dialog (exact task + folder), `stephen jobs list/status/stop`, notification + spoken summary | large → **sonnet / high** | — |
| 4d | Jobs tab in the Stephen window (SwiftUI, small) + TS mirror test | everyday → **sonnet / medium** | artifact-design (design direction only) |

### Item 5 — Phone → Stephen
| ID | Task | Size → model / effort | Skills |
|---|---|---|---|
| 5a | Research what exists (Claude mobile + Remote Control + cloud sessions + linked computer). Prefer that | everyday → **sonnet / medium** + `claude-code-guide` | — |
| 5b | Threat model (only if Stephen needs its own channel) | hardest → **fable / high** | architecture |
| R8 | **Security review #8** (items 4–5), fresh agent | hardest → **fable / high** | security-review |

### Item 6 — UI pass after every phase
| ID | Task | Size → model / effort | Skills |
|---|---|---|---|
| 6x | Small SwiftUI change per phase (Today card after item 1, follow-up indicator after 2, accounts status after 3, Jobs tab after 4). System colours, dark mode, empty/error states. TS mirror tests where logic exists | everyday → **sonnet / medium** | artifact-design (no frontend-design skill exists here) |

### Side task — job-market fit (optional)
| ID | Task | Size → model / effort | Skills |
|---|---|---|---|
| M1 | Research: what employers want from agent/LLM-safety projects in 2026 (agent security, evals, MCP, on-device ML), how to present Stephen; output `docs/RESEARCH-MARKET.md` + suggested SYSTEM-DESIGN edits | large → **sonnet / medium** | deep-research |

## 4. Order and parallelism
```
wave 1 (parallel): 1a, 1b, 1d (1d uses 1a's tool name; fake result only)   + M1 if wanted
lead:              1c, 1e, merge, full suite, real eval        → UI 6a (Today card)
wave 2 (parallel): 2a, 2b  → then 2c, 2d (same files, so sequential) → 2e  → UI 6b
wave 3 (parallel): 3a, 3b → 3c → 3d                            → UI 6c
review:            R7 (fresh) → fixes
wave 4/5:          4a, 5a (research, parallel) → 4b → 4c, 4d; 5b if needed → R8 → fixes
```
Stop points for the owner: after each wave (Mac checks list + commit), and before 2c/2d (ADR-003 decision),
before 3b (Google Cloud OAuth client), before 4b and 5b.

## 5. Testing rule for every subtask
Unit tests with fake servers / fixtures; `npm run build && npx vitest run <area>` by the agent; full suite + real
eval (`node dist/cli.js eval --model sonnet --jobs 4`) by the lead after each merge. Mac-only checks go in a numbered
list in HANDOVER.

## 6. Owner answers (2026-11-02)
1. Jev: owner turned on Remote Control, but this session sees **no shared folders**, so Jev still can't run. Size by
   hand. **No Fable** (out of budget): every "hardest" row above runs on **opus / high** instead.
2. Weather default location: **Toronto, ON** (43.6532, -79.3832); changeable with `stephen accounts weather set`.
3. Scope: review the plan, then split and build as far as is sensible, stopping at the owner decision points.
4. Phase 3: **long-lived `claude -p`** (stream-json input), no Agent SDK / API key. ADR-003 confirms it works first.

## 7. Wave 1 as launched
| Agent | Model / effort | Work | Worktree |
|---|---|---|---|
| W1 weather | sonnet / medium | 1a + 1b (+ dry-run fake) | yes |
| N1 notion | opus / medium | 3a (pulled forward: independent of phase 3) | yes |
| P1 probe | opus / high | 2a baseline + 2b ADR-003 (docs + probe scripts only) | no src edits |
| R1 research | opus / medium | 4a ADR-004 jobs + 5a phone options (research only) | no src edits |
| M1 market | sonnet / medium | job-market fit research | no src edits |
Lead: 1c persona, 1d eval cases, merges, full suite, real eval, docs.

## 8. Owner answers, round 2 (2026-11-02)
- ADR-003 accepted. Rate limit **per conversation** (long follow-up chains must work; runaway loops still stopped).
  Caps OK: unused pre-warm 60 s, conversation 30 min / 25 commands.
- Notion: checkbox done / not done, or status todo / progress / in review / done / close; title "todo list" or
  "tasks"; due = first date property. → `Close`, `Closed`, `Cancelled` added to the done names.
- Google OAuth desktop client created (client id goes in config `accounts.gmail.clientId`, not in code).
- Jev now lives in the repo (`jev/`). It runs here but falls back to "self": no key in the cloud (correct) and
  openrouter.ai is blocked. Sizing stays by hand; `hardest` now maps to opus.

## 9. Wave 2 as launched
| Agent | Model / effort | Work |
|---|---|---|
| S1 warm session | opus / high | ADR-003 subtasks 1–3 + docs (2c, 2d, 2e) |
| G1 gmail | opus / high | 3b + 3c + 3d (OAuth PKCE connect, gmail_search, gmail_read, eval) |
| U1 ui | sonnet / medium | Accounts status in the window, Today card, empty/error states |
Then: review #7 (fresh opus / high) over items 1–3, fixes, then items 4–5 per ADR-004/005 after the owner's go.

## 10. Owner notes (2026-11-05)
- Items 1–3 accepted ("good to go"); Mac tests run by the owner.
- Future: Canvas inbox (conversations) and other Canvas pages beyond due items and announcements.
- **Code-quality loop with Grapuco:** after each implementation, the owner shares a short summary of how Grapuco
  evaluates the code (graph, domains, duplication, coupling, data flow). The next session starts by turning that into
  a ranked list of refactors (remove duplicates, reduce coupling, fix wasteful patterns), each with tests, before new
  features. The cloud can't reach api.grapuco.com, so the owner pushes to Grapuco from the Mac and shares exports or
  screenshots.
