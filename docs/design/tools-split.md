# ADR: split `src/server/tools.ts` along its seams

**Status:** Proposed. No code moves until this note is reviewed and Cris agrees.
**Date:** 2026-11-26
**Deciders:** Cris (goal), top lead (review), an independent Opus reviewer.
**Task:** research item 7 (Lauren Tan practices, 2026-11-26): split the biggest files, starting with `tools.ts` only.

Describes `qa` at commit `8414219`.

## Context

`src/server/tools.ts` is 1215 lines (58 KB). One function, `registerTools(mcp, hub)`, registers 23 browser tools
(24 with `evaluate`), then calls `registerDesktopTools`, `registerAccountTools` and `registerAnnounceTool`.

Agents read the whole file to change one tool. That costs context, and agents copy the shape of what they read.
The file already has clear seams: banner comments split it into session, tabs, navigation, reading, acting, audit
and evaluate. The tools share very little: a `tool()` wrapper, a few arg schemas and annotations, and two helpers.

`src/desktop/index.ts` already shows the paved road: `registerDesktopTools(mcp, hub, names)` in its own folder.

Who imports it:

| Importer | Uses |
|---|---|
| `src/server/index.ts` | `registerTools` |
| `src/eval/dry-server.ts` | `registerTools` |
| `test/server/review2.test.ts` | `closePrompt`, `quantizeScroll` |
| `test/memory/boundary.test.ts` | scans its imports: expects `src/voice/announce.ts` |
| `test/telemetry/latency.test.ts` | reads its source for tool names (a fixed file list) |
| `test/injection/web-text.test.ts` | names the file in two `describe` titles only |

Not a safety path: `src/server/tools.ts` is not in `SAFETY_PATHS` (`scripts/safety-paths.mjs`), so the moves need no
`[DEV REVIEW]` tag. But `upload_file` holds safety checks (see Risks), so that move gets an Opus review anyway.

## Decision

Split the tool bodies into a new folder `src/server/tools/`, one file per seam. `tools.ts` stays the only entry
point and keeps the name `registerTools`. Each move is its own PR and a pure move: same tool names, text, schemas,
annotations, errors and audit entries.

### Target files

| File | Holds | About |
|---|---|---|
| `src/server/tools.ts` | `registerTools`: builds the context, calls each group in order, then desktop, accounts, announce | 70 lines |
| `src/server/tools/shared.ts` | `makeTool` (today's `tool()` wrapper), the `ToolCtx` type, annotations (`READ`, `ACT`, `DESTRUCTIVE`, `LOCAL_READ`), arg schemas (`browserArg`, `tabArg`, `refArg`, `intentArg`, `includeSnapshotArg`, `saveToFileArg`), the text limits and notes (`MAX_TYPE_CHARS`, `MAX_FORM_FIELDS`, `SAVE_MAX_CHARS`, `PREVIEW_CHARS`, `SECRET_NOTE`, `TEXT_RULES`), `assertTypeable`, `formatTabs` | 110 |
| `src/server/tools/session.ts` | `browser_status`, `browser_connect`, `recent_actions`, and `SESSION_STARTED_AT` | 150 |
| `src/server/tools/tabs.ts` | `tabs_list`, `tab_open`, `tab_focus`, `tab_close`, `navigate`, `history`, plus `closePrompt` and `goto` | 240 |
| `src/server/tools/read.ts` | `snapshot`, `find`, `read_text`, `screenshot`, `wait_for`, plus `savedOrInline` | 170 |
| `src/server/tools/act.ts` | `click`, `hover`, `type`, `fill_form`, `select_option`, `press_key`, `scroll`, `handle_dialog`, plus `quantizeScroll` and `SCROLL_STEPS` | 400 |
| `src/server/tools/upload.ts` | `upload_file` and `UPLOAD_FOLDERS_LINE`, nothing else | 60 |
| `src/server/tools/evaluate.ts` | `evaluate`, registered only when `cfg.safety.allowEvaluate` | 45 |

Each group file exports one function, `registerXTools(t: ToolCtx): void`. `ToolCtx` is a plain object built once in
`registerTools`: `{ tool, hub, cfg, manager, engine, gate, reuseTabs }`. `gate` stays the lazy `() => hub.safety().gate`.
No barrel file, no class, no registry.

## Options considered

### A: one file per seam in `src/server/tools/` (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low. Same code, new homes, one small context object. |
| Risk | Low per PR. Each PR is a pure move, pinned by a listing snapshot. |
| Agent cost | An agent changing `click` reads `act.ts` (400 lines) and `shared.ts`, not 1215 lines. |
| Familiarity | Same shape as `src/desktop/index.ts`. |

### B: one file per tool (24 files)

More files than seams. Shared helpers (`savedOrInline`, `goto`) would need a home anyway. Rejected: fewest files.

### C: leave it as is

Zero risk now, but every agent keeps paying for the full file, and research item 7 stays open. Rejected.

## Behavior to pin before any move (PR 0, tests only)

1. **The tool listing, exactly.** A new test in `test/server/` calls `tools/list` on the test server and compares
   the full result (names in order, titles, descriptions, annotations, input JSON schemas) with a committed snapshot.
   Two runs: default config, and `allowEvaluate: true`. Every move PR must keep the snapshot byte for byte.
2. **The latency name scan.** `test/telemetry/latency.test.ts` reads a fixed file list and skips missing files
   (`continue`). After a move it would silently lose tool names and still pass (`size > 25`). Change it to read every
   file under `src/server/tools/` too, and assert the count it finds from `tools.ts` and that folder is at least 24 (23 tools plus `evaluate`, read from source).
3. **Existing tests that must stay green unchanged** (they already pin the risky behavior):
   `test/server/server.test.ts` (names, annotations, gate checks, upload folders, recheck after Allow),
   `test/replay/boundary.test.ts` (private clips never uploaded, links), `test/server/review2.test.ts`,
   `test/server/hardening.test.ts`, `test/server/locks.test.ts`, `test/injection/web-text.test.ts`,
   `test/e2e/mcp.int.test.ts`, `test/eval/dry-server.test.ts`.

## Order of moves (one PR each)

| PR | Change | Review |
|---|---|---|
| 0 | Pins above. Tests only. | Sonnet code review |
| 1 | Reorder registration so each group is together (see Open question). Updates the pinned order only. | Sonnet, Cris agrees |
| 2 | Add `tools/shared.ts`; `tools.ts` imports from it. | Sonnet |
| 3 | Move `read.ts`. | Sonnet |
| 4 | Move `tabs.ts`; `review2.test.ts` imports `closePrompt` from it. | Sonnet |
| 5 | Move `session.ts`. | Sonnet |
| 6 | Move `act.ts`; `review2.test.ts` imports `quantizeScroll` from it. | Sonnet |
| 7 | Move `upload.ts`. | Opus, independent |
| 8 | Move `evaluate.ts`. Update `docs/design/CODEBASE.md` sizes and the two `describe` titles. | Sonnet |

Each move PR:

- Touches only `tools.ts`, the one new file, and the test import it names.
- Shows as moved lines: `git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change origin/qa`.
  The only new lines are imports, the `registerXTools(t)` call, and the function header.
- Passes `npm run build && npm run typecheck && npx vitest run`, with the listing snapshot unchanged.
- Small commits as Cris, PR to `qa`. Coding by Opus (Cris, 2026-11-25), code review by `code-review` and
  `ponytail:ponytail-review`.

PRs 3 to 8 touch the same `tools.ts`, so they go one at a time, never in parallel.

## Open question: tool order

Today `wait_for` sits after `scroll`, and `recent_actions` after `handle_dialog`. Grouping them with their seam
changes the order of `tools/list`, which the model sees. The risk is small, but it is a visible change, so it gets
its own PR 1 with nothing else in it. If Cris says no, skip PR 1: `wait_for` then lives at the end of `act.ts` and
`recent_actions` in its own call after `upload.ts`, and the order stays as today.

## Risks

- **Upload checks must stay in one place.** `upload_file` runs three checks twice: before `stat`, and again inside
  `run` after the owner's Allow (owner-only clips, the never-read list, the upload folder allow-list). The move keeps
  both rounds, in that order, in `upload.ts` only. The lists themselves stay in `src/lib/owner-only.ts` (a safety
  path). No file may copy or re-implement them; it imports them.
- **Lazy safety.** `hub.safety()` is created on the first call, once client capabilities are known. The wrapper and
  `gate` must stay lazy. Never call `hub.safety()` at register time.
- **`SESSION_STARTED_AT` stays module level** (in `session.ts`), not inside a function, so `recent_actions` still
  shows only this process's entries.
- **Config read at register time.** Descriptions use `cfg.output.maxSnapshotChars` and friends, and `evaluate` is
  registered only when allowed. Same timing after the move.
- **Import boundaries.** `test/memory/boundary.test.ts` expects `tools.ts` to import `src/voice/announce.ts`. Keep
  the `registerAnnounceTool` call in `tools.ts`. New files import only what their tools used before.
- **Silent test loss.** Covered by pin 2.
- **Merge conflicts.** Any open PR that edits `tools.ts` conflicts with a move. Check open PRs before each move and
  land them first.

## What not to split

- `fill_form` stays one function. Its three phases (describe every field, gate every field, fill with a recheck)
  carry the rule "nothing is typed unless every field is allowed".
- `tab_close` keeps its own confirm for the user's tabs next to the close.
- The upload checks are not folded into one helper during the move. That would be a real change, for a separate
  safety reviewed PR, if ever.
- `hub.ts` (776 lines) and `util.ts`: not now. One file at a time (research item 7).
- The `tool()` wrapper copies in `src/desktop/index.ts` and `src/accounts/index.ts` stay. The accounts one differs
  (rate limit, HTTP errors). Merging them is a separate task.
- No renamed tools, args, messages or files outside `src/server/`. `src/server/index.ts` and `src/eval/dry-server.ts`
  do not change.

## Consequences

- Easier: an agent changing one tool reads one seam file plus `shared.ts`. Reviews of upload code see only upload code.
- Harder: a change that spans seams (for example a new shared arg) touches two files.
- Revisit: after the split, run `ponytail:ponytail-audit` on `src/server/` and decide whether `hub.ts` is next.

## Rules for every brief that does this work

Cheapest model that fits, with a precise spec: Fable plans, Opus codes and reviews safety, Sonnet reviews normal
code, Haiku for read-only checks. Exact files allowed and forbidden, numbered steps, an acceptance test and a done
check. Commit as Cris with all four `GIT_*` vars. PR to `qa`, never merge, never force-push. No em or en dashes.
Questions go to the top lead. Hand over at about 50% context.
