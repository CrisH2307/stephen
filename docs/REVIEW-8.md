# Review 8: background jobs (ADR-004), phone channel (ADR-005), B1 fix, shared helpers

Date: 2026-11-06. Repo `/Users/crishuynh/Documents/SoftwareProject/brower-hub/browser-hub`, branch `phone_remote_control`
@ `de66527`. Independent reviewer (did not build this code). The repo was not changed except for this file. Probes ran
on the owner's Mac (macOS 26, Node 24, Claude Code **2.1.319**, one patch newer than the 2.1.318 named in the brief)
against `dist/` (built 09:34, no `src/` file newer). Probe scripts and outputs are in `/private/tmp/claude-501/r8.9HH1/`
(named below). `~/.browser-hub` was only read, never written; every Stephen run used a temp `STEPHEN_HOME`.
`claude remote-control` was not run.

## Scope

Everything since review 7 (`git diff f5fdcbf..HEAD`, 45 files, plus the jobs commits 555b058 to 40e3e46):

1. Item 4, jobs: `src/jobs/` (spec, runner, manager, state, router, intent, finish, cli, config), `src/app/jobs-status.ts`,
   `src/voice/job-rows.ts`, the Jobs tab in `helper/AppWindow.swift` and `helper/AppClient.swift`, `src/timers/notify.ts`.
2. Item 5, phone: `src/phone/` (setup, server, bridge, cli), `src/lib/private-socket.ts`, the `phone` trust in
   `src/voice/assistant.ts`, `claude.ts`, `conversation.ts`, `memory-router.ts`, `src/timers/router.ts`,
   `src/jobs/router.ts` (`startFromPhone`), `startPhone` in `src/voice/index.ts`.
3. Bug B1: `src/drivers/common.ts` (`isLive`, `DriverBase.current`). The companion commit (clear "Connection closed"
   message in `src/errors.ts`, audit of failed tab opens) is not on this branch and was not reviewed.
4. Moved helpers: `src/lib/claude-stream.ts`, `src/lib/repo.ts`.

## Method

Threat model as in reviews 6 and 7: same-user processes are out of scope. A finding counts if it helps a lower-trust
actor (web page, email sender, other people's text, the model, the person holding the phone, a bystander saying "Hey
Stephen", another macOS user) or breaks a promise the design makes to the owner.

- **Phone session surface (T4).** Copied `~/.browser-hub/phone/` to a temp folder and ran `claude -p` there, the way
  Remote Control runs the session (`claude --print --sdk-url …`, ADR-005 Probe results), with `STEPHEN_HOME` pointing
  at an empty temp home so the bridge could never reach the real `phone.sock`:
  - `config.jsonl`: init line (tools, agents, slash commands, skills, MCP servers) and `/config` with no argument.
  - `cfg.jsonl`: `/config remoteControl=true permissionMode=auto` with `CLAUDE_CONFIG_DIR` set to a temp folder, then
    read what it wrote.
  - A loop over 20 slash commands (`/permissions`, `/agents`, `/add-dir`, `/hooks`, `/memory`, `/login`, `/resume`,
    `/mcp`, `/mcp enable`, `/config …`, `/output-style`, `/advisor`, `/heapdump`, `/reload-skills`, `/import`,
    `/list-agents`, `/team-onboarding`, `/design-consent`, `/fast`, `/doctor`), each a local command (cost 0).
  - `fork.jsonl`: a project skill with `context: fork`, `agent: general-purpose`, `allowed-tools: Bash(touch *)`,
    typed as `/r8probe` (haiku, $0.001). `shell.jsonl`: a skill with inline `` !`touch …` `` typed as `/r8shell`.
  - Docs fetched today: `remote-control` (which commands work from the phone), `skills`, `cross-session-messaging`,
    `sandboxing`, `settings-reference`.
- **Job sandbox.** Two real jobs through `JobManager.start` and the real detached supervisor (`job/probe.mjs`, haiku,
  temp Stephen home and jobs root, the real repo as `stephenRepo`, the real `HOME`). The first (commands in the task)
  was refused by the model. The second ran an owner-style `input/check.sh` from the inbox: Keychain lookup of the
  existing `stephen-elevenlabs` item (attributes, and `-w` to `/dev/null`), `ls ~/.browser-hub`, `head -c 0` of the
  repo `.env`, `ls ~/Library/Application Support`, `ls ~/.claude/projects`, `curl https://example.com`, a connect to a
  Unix socket I was listening on, and a `fork()` + `setsid()` child that sleeps 150 s.
- **Audit, caps and phone jobs** with `dist/` classes and fakes (no Claude): `audit/probe-audit.mjs` (refused starts,
  phone refusals, task truncation), `inb/p.mjs` (inbox files moved into a phone job), `race/p.mjs` (four concurrent
  phone starts).
- **Cached state as live (B1 pattern).** Read `puppeteer-core` 25.16.0 `bidi/Browser.js` and `bidi/Connection.js`, then
  every place that trusts a pid, a marker file or a socket set: `src/phone/cli.ts`, `setup.ts`, `server.ts`,
  `src/jobs/state.ts`, `manager.ts`, `runner.ts`, `src/app/server.ts`, `src/drivers/manager.ts`.
- `npx vitest run test/phone test/drivers/common.test.ts test/jobs`: 164 passed, 2 skipped (the opt-in real tests).

Probe side effect: `/heapdump` wrote two files to the owner's real `~/Desktop` (it ignores `CLAUDE_CONFIG_DIR`). I
deleted exactly those two files right after. The `setsid` child of probe 2 was killed after it was observed.

## Findings

| ID | Severity | Title | File:line |
|----|----------|-------|-----------|
| R8-1 | Medium | `/config key=value` typed on the phone writes the owner's user-wide Claude Code settings (default permission mode `auto`/`acceptEdits`/`dontAsk`, model, language, output style) | `src/phone/setup.ts:36-48`, `src/phone/cli.ts:101-104` |
| R8-2 | Medium | What the phone tap approves is not what runs: a phone job silently takes every inbox file, or a worktree of a named repo, and with `web: true` can send them out; the task is also cut from 2000 to 500 characters | `src/jobs/router.ts:104-116`, `src/jobs/manager.ts:189,219,281-288`, `src/phone/bridge.ts:85` |
| R8-3 | Low | Job and phone caps are check-then-act across awaits: four parallel phone starts all start with `maxRunning: 1` and a phone cap of 3 | `src/jobs/router.ts:107-111`, `src/jobs/manager.ts:259-268`, `src/voice/index.ts:630` |
| R8-4 | Low | Approved actions that fail leave no audit outcome, and phone requests are audited `ok` before they run | `src/jobs/manager.ts:259-348,368-371,403`, `src/jobs/state.ts:133-152`, `src/phone/server.ts:124,129,135` |
| R8-5 | Low | Liveness from cached state: the phone kill switch is "a file exists", and job stop/reconcile trust a bare pid | `src/phone/setup.ts:24-25`, `src/jobs/manager.ts:404-419`, `src/jobs/state.ts:139-143` |
| R8-6 | Low | A job can leave processes running after it ends (`setsid` child survived), and with the supervisor gone nothing enforces the wall clock | `src/jobs/runner.ts:244`, `src/jobs/state.ts:138-143` |
| R8-7 | Info | Phone session hardening left on the table: cross-session messages into it, 228 user/plugin skills and bundled workflows, `/heapdump`, `/design-consent`; the start check compares tools only | `src/phone/setup.ts:36-48,72-78` |
| R8-8 | Info | Phone conversations get the full `<user_memory>` block, so "listing gives the count only" can be bypassed by asking Claude; the phone model can create timers and reminders through `ask` | `src/voice/memory-router.ts:120-128`, `src/voice/claude.ts:149-161`, `src/timers/router.ts:84-95`, `docs/ADR-005-phone-channel.md` Bridge rules |

No Critical or High findings. The phone session really is limited to the three bridge tools (also for a typed forked
skill), the bridge reaches only `phone.sock`, phone conversations run at `--trust wake --confirm deny` with their own
conversation, every router refuses memory changes, timer cancels and job start/stop from the phone, and nothing
reachable from the phone starts a job without the tap. The job sandbox held for every read and network probe,
including the Keychain.

### R8-1 (Medium) `/config` from the phone writes the owner's global Claude Code settings

**What.** Remote Control runs the phone session as `claude --print …`, and the docs list `/config` among the commands
that work from the phone ("from the mobile app, pass `key=value` to set a setting"). Probed in a copy of the phone
folder:

- `config.jsonl`: `/config` lists 37 settable keys, among them `permissionMode=default|plan|acceptEdits|auto|dontAsk`,
  `model=…|opus|fable|best…`, `language`, `outputStyle`, `checkpoints`, `gitignore`, `worktreeBaseRef`.
- `cfg.jsonl` (with `CLAUDE_CONFIG_DIR` at a temp folder): `/config permissionMode=auto` answered "Set Default
  permission mode to auto" and wrote `"permissions": {"defaultMode": "auto"}` into **user** `settings.json`. A second
  run set `dontAsk` the same way. `remoteControl=true` was refused ("isn't a /config setting"), so auto-connect can't
  be turned on this way.

The phone session itself is not widened (it starts with `--permission-mode default`, and its tools come from the
`stephen-phone` agent). Stephen's voice session and jobs are not affected (`--setting-sources ""` and explicit
`--permission-mode dontAsk`, `src/voice/claude.ts:238`, `src/jobs/spec.ts:148-150`). But every other Claude Code
session the owner starts on this Mac (this repo's dev sessions included) would open in `auto` or `acceptEdits`, and
`model=opus` / `language=…` follow the owner everywhere.

**Why it matters.** Actor: the person holding the phone (T1) or an account takeover (T2). ADR-005 T4 promises that
slash commands typed on the phone are checked and that the phone can only reach the bridge. `/config` is a write to
the owner's own configuration from the low-trust channel, and nothing on the Mac notices it.

T4 answers, command by command (probed in print mode unless noted):

| Command | Result | Plan survives? |
|---|---|---|
| `/model x`, `/effort`, `/advisor` | Session model/effort only (print mode does not save a default); `/advisor` "isn't available" | Yes (cost only) |
| `/fast` | "not available in the Agent SDK" | Yes |
| `/mcp`, `/mcp enable\|disable\|reconnect` | Text summary; the subcommands need an interactive terminal (docs). Enabling a server would not add tools to the agent | Yes |
| `/permissions`, `/add-dir`, `/hooks`, `/memory`, `/login`, `/resume`, `/import` | "isn't available in this environment" | Yes |
| `/agents` | "The /agents wizard has been removed" (text only) | Yes |
| **`/config key=value`** | **Writes user settings** (above) | **No: fix** |
| `/clear`, `/compact`, `/context`, `/usage`, `/recap`, `/rename`, `/color`, `/focus`, `/output-style` (built-ins only from the phone), `/autocompact` | Session-local | Yes |
| `/heapdump` | Writes a heap snapshot of the session (conversation, tokens in memory) to `~/Desktop` | Low risk, see R8-7 |
| `/design-consent` | Tries to record "Design agent access" on the claude.ai account (401 here with the temp config) | Account-level, see R8-7 |
| `/list-agents` | Works; `SendMessage` is not in the tool list, so the phone can't message other sessions | Yes (inbound see R8-7) |
| A typed skill with `context: fork` (`fork.jsonl`) | Ran with only the three bridge tools; Bash never called, file not created | Yes |
| A typed skill with inline `` !`cmd` `` (`shell.jsonl`) | "Shell command permission check failed", nothing ran | Yes in print mode; not verified whether Remote Control forwards that check to the phone as a prompt |
| A line starting with `!` | Goes to Claude as text (docs: "doesn't run in shell mode") | Yes |
| `/schedule`, `/loop`, `/goal`, `/batch`, workflows, `/ultrareview` | Not probed (model calls); they need tools the agent doesn't have, or run in the cloud under the same account | Not verified |

**Fix.** Run the phone session with its own Claude Code config folder: `stephen phone on` and `checkPhoneLockdown`
spawn `claude` with `CLAUDE_CONFIG_DIR=<home>/phone/claude-config` (0700). `/config` then writes only there, and the
owner's user skills, plugins, hooks and MCP servers (T6: the full `stephen` browser server, firefox-devtools,
agentmemory, all claude.ai connectors) stop loading in the phone session. Cost: one `claude /login` in that folder
(probed: a fresh config folder is "Not logged in"); document it in `stephen phone setup`. If that is not wanted, the
smaller fix is to check on every `stephen phone on` and `off` that user `permissions.defaultMode` and `model` are what
they were at `on`, and warn loudly if not; that detects, it doesn't prevent.
**Test.** `test/phone/cli.test.ts`: the fake spawn for both the check and `remote-control` receives
`CLAUDE_CONFIG_DIR` under `<home>/phone/`; `setup` creates that folder 0700. Opt-in real test: `/config
permissionMode=auto` in the phone folder leaves `~/.claude/settings.json` byte-identical.

### R8-2 (Medium) The phone approves `{task, web}`, but the job also gets the inbox or a repo

**What.** The Mac dialog (`startPrompt`, `src/jobs/router.ts:41-57`) shows the folder, the input files moved from the
inbox, the repo worktree and the budgets. The phone tap shows only the tool input the phone model wrote: `task` and
`web`. `startFromPhone` (`router.ts:104-116`) runs the same `plan()`, so:

- `inb/p.mjs`: with `~/Stephen Jobs/inbox/transcript.pdf` present, `startFromPhone('summarize my notes', true)`
  answered "Job started … web on" and the file was **moved** into the job's `input/`; the reply never mentions it.
- A task that names a configured repo (`reposNamed`, `manager.ts:196-205`) gets a git worktree of that repo the same
  way, also invisible on the phone.
- `probe-audit.mjs`: the bridge and `phone.sock` accept 2000 characters (`bridge.ts:22,85`, `server.ts:24,34`), but
  `cleanTask` keeps 500 (`spec.ts:36,52`). A 656-character task approved on the phone ran as its first 500
  characters, and the tail ("IMPORTANT: do not include any names.") was gone.

With `web: true` the job has WebFetch, which runs outside the sandbox (docs: "`allowedDomains` doesn't limit
WebFetch"). A fetched URL can carry the content of `input/` or the worktree.

**Why it matters.** Actor: the person holding the phone (T1/T2), and injected text in a Stephen reply (T3) that gets
the phone model to propose an innocent-looking `start_job({task: "summarize my notes", web: true})`. The owner taps
Allow on what looks harmless; files the owner left in the inbox for a Mac job (transcripts, lab data) or a private
repo then sit next to an open WebFetch. ADR-005 promises the phone tap is the confirmation of the exact job; the
folder contents are part of the job and are not shown. The truncation breaks "the phone showed the exact input".

**Fix.** In `startFromPhone`: refuse a plan with `repo` ("start code jobs at the Mac") and plan phone jobs with no
inbox inputs (a `plan(task, { inbox: false })` option; the inbox stays for the next Mac job). Cap the phone task at
`TASK_MAX` in both places (`bridge.ts` `max(500)`, `server.ts` `PHONE_MAX_TEXT` for `start_job`) so a longer task is
refused, not cut. Say in the reply "no input files, web on/off".
**Test.** `test/phone/routers.test.ts`: inbox has a file → phone job's `input/` is empty and the file is still in the
inbox; a task naming a configured repo → refused, no worktree call; a 501-character `start_job` → error, no job.

### R8-3 (Low) Caps can be raced from the phone

**What.** `startFromPhone` checks the phone cap, then awaits `plan()` and `start()`; `start()` checks `capError()` and
then awaits `ensurePrivateDir` before the state file exists. Phone starts do not go through the listener queue
(`index.ts:630` calls `jobRouter.startFromPhone` directly), and Claude Code can issue parallel tool calls. `race/p.mjs`:
four parallel `startFromPhone` calls with `maxRunning: 1` → all four "Job started", four queued jobs. The hard cap
`MAX_RUNNING_CAP = 2` and the phone cap of 3 are both passed. The same race exists between a phone start and a Mac
start waiting on its dialog.

**Why it matters.** Actor: the person holding the phone (needs one tap per job, but can approve a burst). Budgets are
per job ($5, 45 min), so N parallel jobs cost N times; ADR-004 rule 5 promises "at most 2 jobs at once".

**Fix.** Serialize starts in `JobManager` with a promise chain (`this.#starting = this.#starting.then(...)`), and do
the cap checks (running, daily, and a caller-supplied extra check for the phone cap) inside it, after the previous
start has written its state.
**Test.** `test/jobs/manager.test.ts`: `Promise.all` of four `start()` with `maxRunning: 1` → one state, three
refusals; the same through `startFromPhone` with the phone cap.

### R8-4 (Low) Approved actions that fail are not audited, and phone requests are audited too early

**What.** ADR-004 rule 7 says start, stop, result and denials go to the audit log; ADR-005 says every phone request is
audited. Gaps found:

1. `JobManager.start` after an approved dialog or phone tap: every `refused` return (cap reached meanwhile, folder
   exists, worktree failed, files not written; `manager.ts:260-272,274-275,346-347`) writes no audit line.
   `probe-audit.mjs`: approved, then "I couldn't make the job folder (EEXIST …)" → 0 audit lines.
2. `phone.sock` writes `phone.start_job outcome: ok` before calling `startJob` (`server.ts:135`), and `startFromPhone`
   never throws (it returns refusals as text), so a refused phone start is always logged `ok`. `probe-audit.mjs`: two
   "2 jobs are already running" refusals → two `phone.start_job ok` lines and no `job_start` line. `ask` and
   `job_status` are logged `ok` before they run too (`server.ts:124,129`).
3. A supervisor that never starts: `failQueued` (`manager.ts:368-371,384-392`) and `reconcile` marking a job failed or
   SIGKILLing its Claude group (`state.ts:133-152`) write state but no audit.
4. `job_stop` is logged `ok` before the stop happens (`manager.ts:403`), whatever the outcome.
5. A failed worktree or file write after `makeFolder` leaves the folder, meta folder and possibly the branch behind
   with no state and no audit.

Checked OK: the supervisor's own `job_end` line is flushed (`src/cli.ts:522` sets `process.exitCode`, it does not call
`process.exit`).

**Why it matters.** The owner reads the audit log to see what happened while away. Today it can claim a phone job
started when it was refused, and it has no line for an approval that led nowhere.

**Fix.** Audit `job_start` with `outcome: 'error'` and the reason (plus `confirmation: 'approved'`, `source`) on
every refusal after approval, in one helper used by both paths. In `PhoneServer.handle`, audit after the call with
the outcome: have `startJob` return `{ ok: boolean, text }` (or a `refused` flag) so `start_job` is `ok` only when a
job was created. Audit `job_end` from `reconcile`/`failQueued` (status `failed`, `by: 'reconcile'`).
**Test.** `test/jobs/manager.test.ts`: folder exists → one `job_start` `error` line. `test/phone/server.test.ts`: a
`startJob` that refuses → `phone.start_job` `denied`. `test/jobs/state.test.ts`: reconcile of a dead supervisor →
one `job_end` line.

### R8-5 (Low) Liveness from cached state (the B1 pattern)

**What.**
- The phone kill switch is `existsSync(<home>/phone/.on)` (`setup.ts:24-25`), read on every request. The marker is
  removed only when `stephen phone on` sees Remote Control exit (`cli.ts:114-115`) or by `off`. If `stephen phone on`
  is killed (SIGKILL, a crash, a power loss), the marker survives a reboot and `phone.sock` keeps answering although
  the owner's mental model is "off unless I'm running `phone on`". `status` already does the right check
  (`isRemoteControl(commandOf(m.rc))`, `cli.ts:74`); `isOn` does not.
- Job pids: `JobManager.stop` sends SIGTERM to `s.pid` after only `kill(pid, 0)` (`manager.ts:404-419`), and
  `reconcile` keeps a job "running" while its supervisor pid is alive (`state.ts:139`). After a restart or a crashed
  supervisor, a reused pid makes the Jobs tab show a dead job as running for up to deadline + 15 min, and **Stop** (or
  "stop the job") signals an unrelated process of the owner. `reconcile`'s SIGKILL of `claudePid` is a process-group
  kill gated the same way (`state.ts:143`).
- Not affected: `DriverBase.current()` now (see Checked); `app.sock` and `phone.sock` client sets (removed on
  `close`, writes check `destroyed`); the warm Claude (R7-1 lock with pid check).

**Why it matters.** No lower-trust actor gains much: the stale marker only matters if something else can reach
`phone.sock`, and pid reuse is chance. It breaks the "on only while I run it" promise (owner decision 2) and can
signal the wrong process.

**Fix.** `isPhoneOn` = marker exists **and** its `rc` pid is alive and is `claude … remote-control` (reuse
`isRemoteControl` + `commandOf`, cache the answer for a few seconds); otherwise remove the stale marker. For jobs,
record the supervisor's start time (`ps -o lstart=`) or check `ps -o command=` contains `jobs _run <metaDir>` before
treating the pid as ours, in `reconcile` and `stop`.
**Test.** `test/phone/setup.test.ts`: marker with a dead `rc` → `isPhoneOn` false and the marker is gone.
`test/jobs/state.test.ts`: state with a live pid whose command is not the supervisor → reconciled to failed, no kill.

### R8-6 (Low) Job processes can outlive the job

**What.** `check.sh` item 9 forked a child that called `setsid()` and slept. The job ended (`done`, 3 turns), the
supervisor sent SIGTERM to Claude Code's group (`runner.ts:244`), and the child was still running with ppid 1 and its
own process group (seen with `ps` after the job, then killed by me). `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` does not
stop this. The child keeps the Seatbelt sandbox (no network, writes only in the folder), but it can run, use CPU and
keep writing into the job folder after "done", "stopped" or "timeout".
Second path: if the supervisor dies (crash, `kill -9`) while no listener is running, nothing enforces the wall clock;
`reconcile` only acts when something lists jobs, and only kills before deadline + 15 min (`state.ts:138-143`). Turns
and dollars still bound it.

**Why it matters.** Actor: injected text in a web page (web jobs) or the task text. ADR-004 rule 5 promises the job
ends at the deadline. Impact is limited by the sandbox.

**Fix.** At the end of a job, kill every process still inside the job's sandbox: on macOS the simplest reliable
handle is the folder: `lsof +D <folder>` / `pgrep -U $UID` filtered by `cwd` under the job folder, SIGKILL them, and
audit the count. Longer term, run the whole job under `srt` (ADR-004 open question 5). Have the listener's
`FinishWatcher` also kill an overdue Claude group whose supervisor is gone when the pid still runs `claude` with the
job's `--session-id` (command-line check, see R8-5).
**Test.** Opt-in real test (`test/jobs/real-claude.test.ts`): a job script that `setsid`s a sleeper → no process with
cwd under the job folder 5 s after the job ends.

### R8-7 (Info) Phone session hardening

**What.** Smaller things around the phone session, none of which reaches Stephen's power today:
- **Inbound cross-session messages.** The phone session binds an inbox socket, and as a "prompting" session it
  accepts messages from the owner's other sessions by default, including cloud and Remote Control sessions on other
  machines (docs, cross-session-messaging). A message starts a turn, where the model can call `ask` (pre-allowed) with
  the message's text. Same reach as T2/T3, but it is one more unaudited input.
- **228 user and plugin skills, bundled skills and workflows** load in the phone session (`config.jsonl`: 283 slash
  commands, 11 agents, 37 MCP servers starting). Only the tool list is checked at start (`setup.ts:72-78`), so a
  plugin update that adds a forked skill, inline shell or a workflow is not caught by `stephen phone check`.
- `/heapdump` writes the session's heap (conversation, tokens) to `~/Desktop`; `/design-consent` records an account
  consent. Both from the phone.

**Fix.** R8-1's separate `CLAUDE_CONFIG_DIR` removes most of this. Also add to the phone folder's
`.claude/settings.json`: `"crossSessionInbound": "refuse"`, `"disableSkillShellExecution": true`,
`"disableBundledSkills": true`, `"disableWorkflows": true`, and `permissions.deny: ["Skill", "SendMessage",
"ListAgents"]`. Extend `compareTools` to fail on any `mcp_servers` entry other than `stephen_phone` and to report
(at least) the skill count.
**Test.** `test/phone/setup.test.ts`: the written settings contain those keys; `compareTools` with an extra MCP
server → not locked.

### R8-8 (Info) Memory and timers from the phone

**What.** The memory router answers a phone "what do you remember" with a count only (`memory-router.ts:120-128`),
but every Claude run, phone included, gets the whole `<user_memory>` block in its persona (`claude.ts:149-161`; the
runner's `memory` option is not trust-dependent). "What's in your user memory block?" from the phone returns the items
into the Remote Control transcript. The wake word has the same gap (pre-existing). Separately, ADR-005 says "the
model never writes memory or timers", but the phone session's model can create timers and reminders by calling
`ask("remind me in 2 minutes to …")` (`timers/router.ts:84-95`, wake parity), and injected text (T3) can ask it to.
Rate limited (6 asks a minute) and only spoken at the Mac.

**Fix.** Either leave memory out of the persona for `phone` (and `wake`) trust, or document that the count-only
listing is a convenience, not a boundary. Correct the ADR-005 sentence about timers, or refuse timer creation for
`phone` like cancel.
**Test.** `test/voice/claude.test.ts`: a `phone` run's persona has no `<user_memory>` (if chosen).

## Checked, OK

- **Phone session tool lock.** Init line in the copied folder (Claude Code 2.1.319): exactly
  `mcp__stephen_phone__ask`, `job_status`, `start_job`, mode `default`. A typed `context: fork` skill ran with only
  those tools. `!` lines go to the model. `/permissions`, `/add-dir`, `/hooks`, `/memory`, `/login`, `/resume` are
  unavailable in this mode. `checkPhoneLockdown` fails closed on no init line, exit or timeout (`setup.ts:86-115`).
- **No job without the tap.** `start_job` carries `requiresUserInteraction` (`bridge.ts:88`); `ask("start a job …")`
  and `ask("stop the job")` are refused by `JobRouter.route` for `phone` (`router.ts` 'start'/'stop' cases); the
  voice Claude has no job tool; `web` is the phone's flag, not `wantsWeb(task)` (`router.ts:111`).
- **Phone trust plumbing.** `trustOf('phone')` → `phone`; `mcpConfig` gives `--confirm deny --trust wake`
  (`claude.ts:331-333`); `--confirm deny` maps to `DenyConfirmer` (`serve-args.ts:74`, `confirm.ts:465`);
  `ToolLogRunner` forwards trust (`command-log.ts:36`); a conversation or warm process of another trust is never
  reused and the session-state file is deleted on a trust change (`conversation.ts:116-121,131,226-231,354-362`).
  Memory changes, timer cancels and job start/stop are refused for `phone` before Claude.
- **No app.sock, `.on` holds.** The bridge only knows `phoneSocketPath(home)`; `phone.sock` checks `isOn()` on every
  request, accepts three strict zod shapes, 8 KiB lines, two clients, never logs request text, and notifications pass
  text only as `osascript` argv (`notify.ts:12-23`).
- **`private-socket.ts`** is the old app.sock code moved as is: 0700 own-user real folder, 0600 socket, stale socket
  replaced only when nobody answers, removed on close only if the inode is still ours.
- **Job sandbox (probe 2, real Seatbelt).** Keychain lookup of an existing Stephen item → rc 44 (both attribute and
  `-w`), `~/.browser-hub`, the repo `.env`, `~/Library/Application Support` and `~/.claude/projects` → denied, `curl`
  → `deny network-outbound example.com:443`, Unix socket connect → blocked. Init check: exactly the 6 tools, 0 MCP
  (`runner.ts:264-272`). The job env is built from scratch; settings, persona and logs sit outside the job folder.
- **B1.** puppeteer-core 25.16.0 `BidiBrowser` has a public `connection` getter (`bidi/Browser.js:213`) and
  `BidiConnection.closed` (`bidi/Connection.js:37`); `isLive` reads it and stays true for CDP browsers without it;
  `DriverBase.current()` forgets a dead browser, and `BrowserManager.#sync` goes through `current()`
  (`drivers/manager.ts:229`). The "Connection closed" message and failed-open audit commit is not on this branch.
- **Moved helpers.** `claude-stream.ts` is `parseJobLine` unchanged; `REPO_ROOT` in `src/lib/repo.ts` resolves two
  levels up like the old copies in `src/accounts` and `src/jobs`, so the `.env` in `denyRead` is unchanged.
- **Jobs UI.** Rows carry no pid, session id or log path (`job-rows.ts:12-26`); Swift shows task, summary and folder
  with `Text(verbatim:)` and only reveals the folder in Finder; the spoken finish line is the cleaned summary, never a
  prompt.
- **Supervisor end audit** is flushed before exit (`src/cli.ts:522`).

Not verified: whether Remote Control forwards a skill's inline-shell permission check to the phone as a prompt
(print mode refused it); the model-driven commands (`/schedule`, `/loop`, `/goal`, `/batch`, workflows); whether the
phone app offers a permission-mode switch of its own; `--max-budget-usd` on a subscription (ADR-004 open question 2).

## Fix status

Not started
