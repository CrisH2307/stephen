# 7. Codebase analysis and evolution

The last part of a good design answer: show that the design is real, and say honestly where it is weak.
Describes `qa` at commit `5fae967` (2026-11-25). Every count below can be rerun with the commands at the end.

## 7.1 Size at a glance

| Part | Files | Lines | Language |
|---|---|---|---|
| Core (`src/`) | 189 | 45,373 | TypeScript |
| Helper app (`helper/`) | 22 | 8,036 | Swift |
| Tests (`test/`) | 201 test files (223 `.ts` files with helpers) | 44,867 | TypeScript (Vitest) |
| Test cases | about 2,400 | | static count of `it(` and `test(` calls |
| Docs (`docs/*.md`) | 92 | | Markdown |

The tests are about as large as the code they test. That is on purpose: every safety finding is fixed together
with a named test.

**Runtime dependencies: five.** `@modelcontextprotocol/sdk` (the MCP server), `@picovoice/pvrecorder-node` (the
microphone), `puppeteer-core` (the browser drivers), `sherpa-onnx-node` (wake word, voice detection, speech to
text) and `zod` (schema checks). Dev dependencies: `typescript`, `vitest`, `@types/node`, `@sparticuz/chromium` (a
headless Chrome for tests). Node `^20.19.0 || >=22.12.0` (`package.json`). Adding a dependency needs Cris's yes
(`AGENTS.md`).

## 7.2 Module map

Lines are TypeScript lines in each folder. "Uses" lists the other `src/` folders it imports.

| Module | Files | Lines | What it does | Uses |
|---|---|---|---|---|
| `voice/` | 38 | 8,808 | Listener, wake word, speech to text, routers, Claude runners, speech out, cost limit | accounts, app, desktop, helper, history, jobs, memory, phone, replay, safety, server, telemetry, timers |
| `page/` | 6 | 4,544 | In-page code for snapshots, refs, clicks and typing | lib, safety |
| `server/` | 11 | 3,357 | The MCP tool server and its 23 browser tools | accounts, desktop, drivers, safety, voice |
| `safety/` | 11 | 3,321 | Safety gate, policy rules, egress, confirmers, audit log, untrusted wrapper | lib |
| `desktop/` | 12 | 2,918 | Apps, media, volume, play on YouTube | drivers, helper, safety, server |
| `jobs/` | 9 | 2,402 | Background jobs: spec, manager, runner, state, reconcile | accounts, safety |
| `app/` | 15 | 2,271 | `app.sock` server and the window's requests | accounts, helper, history, memory, phone, safety, server, voice |
| `accounts/` | 10 | 2,203 | Gmail, Calendar, Canvas, Notion, weather, read only | safety, server |
| `drivers/` | 7 | 1,845 | Zen (WebDriver BiDi) and Chrome (CDP) | lib |
| `eval/` | 6 | 1,665 | `stephen eval`: real-model injection cases | accounts, drivers, page, safety, server, voice |
| `selftest/` | 4 | 1,455 | Browser self-test against a local page | drivers, page, safety, server |
| `helper/` | 6 | 1,095 | Build, install and talk to the Swift helper | server |
| `lib/` | 15 | 1,022 | Shared helpers: private files and sockets, process, Levenshtein | none |
| `telemetry/` | 4 | 1,013 | Latency records, incidents, `stephen latency`, `stephen report` | history, voice |
| `memory/` | 5 | 1,009 | Memory store, proposals, the "remember" grammar | safety |
| `history/` | 5 | 936 | Conversation history and its purge | safety, server, voice |
| `connect/` | 4 | 820 | Account sign-in commands | accounts, voice |
| `phone/` | 4 | 709 | Phone link through Claude Code remote control | helper, safety, voice |
| `timers/` | 4 | 636 | Timers and reminders | memory |
| `replay/` | 1 | 583 | Opt-in F5 recordings | safety, voice |
| `checks/` | 1 | 301 | `stephen mac-checks` | helper, telemetry |
| top-level `src/*.ts` | 11 | 2,460 | CLI, config, setup, update, install | |

Three things to notice:

1. **`safety/` depends only on `lib/`.** The most important module has the fewest reasons to change.
2. **`voice/` is the hub.** It wires almost everything. That is its job, and also its biggest weakness (7.5).
3. **The tool server's graph never reaches `memory/`, `history/`, `app/` or `jobs/`.** A test checks this on every
   run (`test/memory/boundary.test.ts`). See [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md).

## 7.3 Tests

Vitest, one suite per machine at a time (a lock in `test/global-setup.ts`), files run one after another because
integration tests start real browsers (`vitest.config.ts`). Tests never play sound (`test/no-sound-check.ts`).

| Area | Test files | Cases (static) | | Area | Test files | Cases (static) |
|---|---|---|---|---|---|---|
| voice | 46 | 524 | | phone | 4 | 43 |
| safety | 16 | 255 | | cli | 5 | 36 |
| desktop | 12 | 179 | | selftest | 4 | 30 |
| server | 9 | 170 | | lib | 7 | 29 |
| app | 16 | 157 | | checks | 2 | 25 |
| accounts | 9 | 137 | | e2e | 3 | 23 |
| jobs | 13 | 137 | | timers | 1 | 10 |
| drivers | 9 | 132 | | injection | 4 | 7 |
| helper | 6 | 115 | | security | 2 | 5 |
| page | 8 | 102 | | helpers | 2 | 5 |
| memory | 6 | 69 | | | | |
| replay | 3 | 65 | | | | |
| eval | 6 | 64 | | | | |
| telemetry | 4 | 57 | | | | |
| history | 4 | 51 | | | | |

The static count misses cases made by `it.each`, so the real number is a little higher. A full run takes about 6
to 10 minutes (`AGENTS.md`). Real-model injection checks (`stephen eval`) cost tokens, so they never run in CI. They
are not yet run for every release either; adding them to the release checklist is the next step
([NFR-STEPHEN.md](../NFR-STEPHEN.md) section 1).

## 7.4 How the code grew

The repository starts on 2026-10-30. The first commit already held about 14,800 lines of `src/`, brought in from
earlier work. From there:

| Date | `src/` lines | `test/` lines | `helper/` Swift lines |
|---|---|---|---|
| 2026-10-31 | 25,387 | 20,758 | 1,260 |
| 2026-11-03 | 34,174 | 29,728 | 3,023 |
| 2026-11-08 | 39,654 | 34,338 | 6,261 |
| 2026-11-12 | 41,045 | 35,920 | 6,456 |
| 2026-11-17 | 41,994 | 37,625 | 6,671 |
| 2026-11-22 | 43,693 | 41,379 | 7,934 |
| 2026-11-25 | 45,373 | 44,867 | 8,036 |

1,102 commits and 209 pull request merge commits in the history of `qa`, in four weeks. Commits per ISO week: W44 57, W45 179, W46 94, W47 498,
W48 274. The jump in W47 coincides with the move to many agents working in parallel lanes, each with small
commits ([BRANCHING.md](../BRANCHING.md)).

Read the table as two phases. **Build out (to about 2026-11-08):** `src/` grew by about 14,000 lines, and most
modules appeared: `memory`, `history`, `accounts`, `app` (2026-11-01), `timers` (2026-11-02), `jobs` and `phone`
(2026-11-05). **Harden (after):** `src/` grew only about 5,700 lines in 17 days while `test/` grew about 10,500.
New work was mostly measurement (`telemetry`, 2026-11-10), replay (2026-11-17), safety fixes and tests. That is
the shape you want before letting other people use a system: the tests catch up with the code.

The decisions behind the growth are in the ADRs, in order: browser control (ADR-001, 10-30), a long-lived Claude
(ADR-003), jobs while away (ADR-004), the phone (ADR-005), reply by voice (ADR-006), the conversation store
(ADR-007), the Tier 1 fast path and its measurements (ADR-008), the Zen WebExtension proposal (ADR-009), edit and
resend (ADR-010), then on 11-25 the release set: signed app, updates, release pipeline, incident agent, platform
seam, free or local models (ADR-011 to ADR-016). There is no ADR-002.

## 7.5 Code health

From a read-only audit of `qa` on 2026-11-25 (scope: `src/replay`, `src/voice`, `src/setup.ts`, `src/update.ts`,
`src/cli.ts`, `src/telemetry`, `test/security`, `.github`). In short: one function is far too long, the rest is
small duplication. The audit found no interfaces with only one implementation, and judged the security tests
sound. Several findings were fixed the same day; the "Status" column is the state at `5fae967`.

| Id | Where | Problem | Smallest fix | Status at `5fae967` |
|---|---|---|---|---|
| H1 | `src/voice/index.ts` | `runListen` is about 680 lines and wires voice, helper, memory and jobs in one body. | Move self-contained blocks (speech setup, the wait loop) into named helpers. Needs a safety review: it wires memory and job writes. | Open |
| H2 | `src/telemetry/incidents.ts`, `src/telemetry/latency.ts` | The day-file purge is copied. | One shared purge helper. | Fixed (`purgeDayFiles`) |
| H3 | `src/selftest/index.ts`, `src/desktop/play.ts`, `src/eval/clicks.ts`, `src/helper/install.ts` | Near copies of `firstLine`. | Use the one exported from `src/lib/process.ts`. | Partly fixed: setup and update use the shared one |
| H4 | `src/update.ts`, `src/setup.ts`, `src/cli.ts` | Two copies of the process result type, and a rebuilt exit code mapping. | Reuse `execNoThrow` with an optional buffer size. | Open |
| H5 | `src/voice/grammar/classify.ts` | The same edit distance threshold is written twice in one line. | Compute it once. | Open |
| H6 | `src/voice/audio.ts`, `src/voice/warm-claude.ts` and others | Several copies of `sleep`. | One `sleep` in `src/lib/process.ts`. | Open |
| H7 | `src/setup.ts` | A non-JSON `doctor` output hides the real error. | Show the doctor output as the detail. | Fixed |
| H8 | `src/voice/index.ts` | A failed speech warm-up is dropped with no log line. | Log one line. | Open |
| H9 | `src/replay/recorder.ts` | An exported constant that nothing else imports. | Remove `export`. | Open, smaller than first reported |
| H10 | `src/update.ts`, `src/setup.ts` | Both decide "helper rebuilt" by matching the words "Nothing changed". | Share one exported constant. | Fixed (`HELPER_UNCHANGED`) |


**Deliberate shortcuts.** The code marks known simplifications with a `ponytail:` comment that names the limit, for
example "edit distance 1 (2 for names of 8+ letters); a near match only ever yields a hint." in
`src/voice/grammar/classify.ts`, or "O(n²) over at most 30 items + 20 proposals." in `src/app/memory-graph.ts`. The
audit counted 11 such markers; most do not yet say what would trigger the upgrade.

**Code and docs that disagree,** found while writing these pages:

- In `src/voice/config.ts`, a comment says the default voice model is "haiku", but the code default is `sonnet`.
  The code wins.
- `src/voice/grammar/classify.ts` and the listener header describe Tier 1 as a fast path. Today the classifier only
  labels latency records and decides which media commands may run while sound plays. It does not route.
- [NFR-STEPHEN.md](../NFR-STEPHEN.md) section 6 plans that "jobs count too". Today a job's cost counts toward the day's
  spend, but the limit never blocks a job from starting.

## 7.6 How to recount

Run from the repository root.

```bash
git ls-files 'src/**.ts' 'src/*.ts' | xargs cat | wc -l
```

```bash
git ls-files 'test/**.ts' | xargs grep -hE '^\s*(it|test)(\.each\([^)]*\))?\(' | wc -l
```

```bash
git log 5fae967 --format=%ad --date=format:%G-W%V | sort | uniq -c
```

Next: back to the [index](README.md).
