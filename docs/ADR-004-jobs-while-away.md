# ADR-004: Jobs while away ("go cook" mode) run as local, sandboxed `claude -p` runs

**Status:** Proposed (research done, not built)
**Date:** 2026-11-02
**Deciders:** Cris (owner), Claude (researcher)

Sources: `claude --help` on Claude Code **2.1.316**, local probes (below), and code.claude.com docs fetched 2026-11-02:
`sandboxing`, `sandbox-environments`, `cli-reference`, `headless`, `settings-reference`, `claude-code-on-the-web`,
`cloud-environments`, `routines`, `desktop-scheduled-tasks`, `agent-view`, `worktrees`. docs.anthropic.com was
blocked by the cloud proxy; anthropic.com was not needed. Tags: **[probed]** = run here on Linux with 2.1.316,
**[docs]** = documented, not run, **[unverified]** = my inference, check on the Mac.

## Context

"Stephen, while I'm cooking, write my SOFE 3980 lab report draft." The owner wants long work (drafts, research,
homework, code) done while he's away from the Mac. HANDOFF item 4 sets the rules: a job is a **separate sandboxed
Claude Code run**, not the locked voice session. It gets file and shell tools only inside its own folder
(`~/Stephen Jobs/<date>-<slug>/`, or a git worktree for code). It gets no browser and no gate tools, a time and turn
budget, and no network writes (no send, post or push).

That is the opposite of the voice session. The voice session has **no** built-in tools and only Stephen's gated MCP
tools. A job has **only** built-in file and shell tools, inside one folder, and no MCP at all. The threat model
(SYSTEM-DESIGN §5) still applies. The task text comes from the wake word or the phone, so it is low trust. Web
pages a research job reads can carry injected instructions. So the job's power must be bounded by the OS and by
Claude Code flags, not by its prompt.

## What Claude Code offers (2.1.316)

| Feature | What it gives | Fit |
|---|---|---|
| `claude -p` headless | One run, `--output-format stream-json`, `--max-turns`, `--max-budget-usd`, `--session-id`, exit code | Core of a job **[probed]** |
| `--restricted` | Drops command-running tools and WebFetch unless `--tools` names them. Confines built-in **file tools to the working dirs**. Loads only managed settings + `--settings`. Refuses `bypassPermissions` and cloud sessions | Exactly the job boundary for file tools **[probed]** |
| Sandboxed Bash (`sandbox.*` settings) | OS-enforced (Seatbelt on macOS, bubblewrap on Linux) write limits to the working dir, a network proxy with an empty allowlist. `failIfUnavailable`, `allowUnsandboxedCommands:false`, `strictAllowlist` | Bounds shell commands and their children **[docs; fail-closed probed]** |
| `@anthropic-ai/sandbox-runtime` (`srt claude`) | Wraps the **whole** `claude` process (tools, hooks, MCP) in Seatbelt | Beta. Later hardening **[docs]** |
| macOS `sandbox-exec` by hand | Custom Seatbelt profile | Deprecated by Apple. The built-in sandbox already uses Seatbelt, so we don't need it |
| `--bg` / `claude agents` / `stop` / `logs` | Background sessions under a supervisor daemon | Can't be combined with `-p`. Runs as an interactive session. Stephen only needs a pid, so not needed **[docs]** |
| `-w/--worktree` | Claude creates a worktree under the repo | Stephen creates the worktree itself, so the folder is explicit |
| Agent SDK | Programmatic loop | Needs a Console API key (ADR-002 / PLAN-WORK-SPLIT). Same flags via the CLI anyway |
| Cloud sessions (`claude --cloud`, claude.ai/code) | Runs in an Anthropic VM while the Mac sleeps. Watched from the phone | See the comparison below |
| Cloud scheduled tasks (formerly routines) | Cloud runs on a schedule, an API POST or a GitHub event | Cloud, same trade-offs. Not "now, while I cook" |
| Desktop scheduled tasks / Dispatch | Local runs from the Desktop app | Run with Desktop's tools and permission mode, **outside** Stephen's lock-down |

## Options

| | (1) Local `claude -p` + `--restricted` + built-in sandbox | (2) Hand off to a Claude Code cloud session |
|---|---|---|
| Where files live | `~/Stephen Jobs/<id>/` on the Mac. The owner drops inputs in, results land there | A cloned GitHub repo (or an uploaded git bundle) in a VM. Results come back as a branch or PR |
| Folder-only file + shell | Yes. `--restricted` confines file tools **[probed]**. Seatbelt confines Bash **[docs]** | Yes, the whole VM is the sandbox |
| No browser / gate tools | `--tools` lists 6 built-ins, `--strict-mcp-config`, `--no-chrome` **[probed: init lists exactly 6 tools, 0 MCP]** | No Stephen tools there. But claude.ai **MCP connectors** (e.g. Gmail with send) can be attached to the session or environment |
| No network writes | Bash has no route out (empty allowlist + `strictAllowlist`). WebFetch/WebSearch are off by default | **Push is built in.** The GitHub proxy blocks only branch deletes and tags. The default network is "Trusted" (registries). Even "None" still allows GitHub, connectors and the Anthropic API |
| Budgets | `--max-turns`, `--max-budget-usd`, and Stephen's wall-clock kill | Usage limits only. No per-job turn or time cap from Stephen |
| Works with Mac asleep / off | No. Mac must stay awake (`caffeinate`) | Yes |
| Non-repo work (lab report, homework PDFs) | Natural | Awkward: needs a git repo, untracked files aren't uploaded, `.env`-like files are left out |
| Stephen owns status/stop | Child pid, stream-json progress, `kill` | Via the claude.ai session API. Harder to audit locally |
| Privacy | Transcript stays local (it still goes to the model API, like every run) | Transcript and files sit on Anthropic servers |

## Decision

**Option 1: a local `claude -p` run per job, with `--restricted`, a 6-tool allow-list, the built-in sandbox in
strict, fail-closed mode, and no MCP.** Stephen's listener (not the model) creates the folder, shows the
confirmation dialog, starts the run, enforces wall-clock time, and reports back. Cloud sessions stay a later,
opt-in path for repo-only code jobs while the Mac is off, with network "None" and no connectors (open question 4).

## Exact launch (cwd = the job folder)

```
claude -p "<framed task, see rule 3>" \
  --output-format stream-json --verbose \
  --restricted \
  --tools Bash,Read,Edit,Write,Glob,Grep \
  --allowedTools Read,Edit,Write,Glob,Grep \
  --disallowedTools WebFetch,WebSearch,Agent,NotebookEdit \
  --strict-mcp-config --no-chrome \
  --setting-sources "" \
  --settings <~/.stephen/jobs/<id>/settings.json> \
  --permission-mode dontAsk \
  --append-system-prompt-file <~/.stephen/jobs/<id>/persona.md> \
  --max-turns 150 --max-budget-usd 5 \
  --session-id <uuid> --name stephen-job-<slug> \
  --model sonnet
```

- Bash isn't in `--allowedTools` on purpose. `sandbox.autoAllowBashIfSandboxed` approves it **only while it runs
  sandboxed**. With `dontAsk` + `allowUnsandboxedCommands:false`, an unsandboxed retry is denied **[docs]**.
- A web-research job (owner opts in, shown in the dialog) adds `WebSearch,WebFetch` to `--tools` and
  `--allowedTools` and drops them from `--disallowedTools`. Bash stays offline either way.
- Prompt right after `-p`, empty values as real empty argv elements, no shell (same as `buildClaudeArgs`).
- Session persistence stays on, so the owner can `claude --resume <uuid>` the job later.

`settings.json` (written by Stephen, 0600, **outside** the job folder so the job can't edit it):

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": [],
    "allowAppleEvents": false,
    "network": { "allowedDomains": [], "strictAllowlist": true },
    "filesystem": {
      "denyRead": ["~/.stephen", "~/.ssh", "~/.aws", "~/.config", "~/Library/Keychains", "<stephen repo>/.env"]
    }
  },
  "permissions": {
    "blockReadsOutsideWorkingDirectories": true,
    "blockWritesOutsideWorkingDirectories": true,
    "deny": ["Bash(git push *)", "Bash(open *)", "Bash(osascript *)"]
  }
}
```

Environment: Stephen builds it from scratch (`PATH`, `HOME`, `LANG`, `TMPDIR`), plus
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and `BASH_MAX_TIMEOUT_MS=600000`. It never passes on Stephen's own
environment, which may hold `CANVAS_API` and other tokens from `.env`. The child is started detached in its own
process group as `caffeinate -i -w <pid>`, so the Mac stays awake until the job ends.

Code jobs: Stephen runs `git -C <repo> worktree add "<jobdir>/repo" -b stephen/job-<slug>` and makes that the cwd.
The sandbox lets a linked worktree write the shared `.git` but not `hooks/` or `config` **[docs]**. Commits work.
Push fails twice: there's no network, and there's a deny rule. The owner reviews and pushes himself.

Probes run here (Linux, 2.1.316, OAuth login):
1. With `sandbox.enabled + failIfUnavailable` and no bubblewrap, the run **refused to start**
   (`startup_failure_reason: sandbox_required_unavailable`). Fail-closed works.
2. With `--restricted --tools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config`, the init message listed exactly
   those 6 tools, `mcp_servers: []`, `permissionMode: dontAsk`.
3. With `--restricted`, `Write` inside the cwd succeeded. `Write` to a path outside was refused ("confines the file
   tools to the working directory") and showed up in `permission_denials`.

## Safety rules

1. **The model never starts a job.** "While I'm …, …" / "in the background, …" / "start a job …" is matched by a
   deterministic router before Claude (like timers). The voice session has no job tool.
2. **Always a native dialog first.** It shows the exact task, the folder, time/turn/$ budgets, and "web: off/on".
   From the phone, confirmation happens on the phone (ADR-005). A spoken "yes" never counts.
3. **The task is untrusted text.** It goes into the prompt framed as the owner's request. The job gets no memory,
   no `aboutMe`, no account data. Inputs are only what the owner put in `<jobdir>/input/`.
4. **Folder hygiene.** It must be under `~/Stephen Jobs/` (realpath check, no symlinks, `O_NOFOLLOW`). The folder
   is 0700, the slug is `[a-z0-9-]{1,40}`, and one job means one folder.
5. **Budgets.** Default 45 min wall clock (hard cap 3 h), `--max-turns 150`, `--max-budget-usd 5`. At the deadline:
   SIGTERM to the process group, then SIGKILL after 10 s. At most 2 jobs at once, and a daily start limit.
6. **Job output is untrusted.** The result text and `SUMMARY.md` are read as `<untrusted_job_output>` (cleaned,
   secret scrubber, length cap) and are only spoken or shown. They never become a voice-session prompt by
   themselves.
7. **Audit + logs outside the job's reach.** Start, stop, result, denials and cost go to Stephen's audit log. The
   stream-json transcript goes to `~/.stephen/jobs/<id>/log.jsonl` (0600, rolling retention like history).
8. **Stop anytime.** `stephen jobs stop <id>`, the Jobs tab, or "Stephen, stop the job".

## Mac-only parts

Seatbelt sandbox (Linux would need bubblewrap + socat), the Keychain OAuth login that `claude -p` uses,
`caffeinate`, native dialogs and notifications, the spoken summary, the Swift Jobs tab, and real toolchains inside
the sandbox (e.g. LaTeX or Python for a lab report). None of the sandbox behaviour can be checked from the cloud.

## Open questions

1. Do the owner's toolchains (Homebrew, nvm, TeX) work under `blockReadsOutsideWorkingDirectories`? If not, switch
   to explicit `denyRead` entries only. **[unverified]**
2. Is `--max-budget-usd` enforced on a subscription login? `total_cost_usd` is reported there, so it probably is.
   **[unverified]**
3. Web-research jobs: is opt-in WebSearch/WebFetch acceptable? A fetched URL can leak folder contents. Nothing
   private is in the folder unless the owner put it there.
4. Later: a cloud path for repo-only code jobs while the Mac is off (environment network "None", no connectors,
   branch protection on `main`).
5. Wrap the whole process in `srt` (beta) so hooks and file tools are OS-bounded too?

## Build subtasks

1. **`src/jobs/spec.ts` (pure):** job spec → argv, settings.json and env builders, plus slug and folder rules. Unit
   tests in the style of `buildClaudeArgs`, and an init-message probe test asserting the 6 tools and 0 MCP.
2. **`src/jobs/runner.ts` + registry:** create the folder or worktree, spawn detached under `caffeinate`, wall-clock
   kill, parse stream-json progress, write state to `~/.stephen/jobs/<id>.json`. Add
   `stephen jobs list|status|stop|show`.
3. **Start flow:** router intent → native dialog → launch. Wake-word and phone sources always confirm. Eval cases
   prove the voice model can't start a job.
4. **Finish flow + UI:** notification, a spoken summary when the owner is back (untrusted framing), a small Swift
   Jobs tab mirrored by a TypeScript model test.
5. **Mac checklist + docs:** sandbox probes on macOS (`touch ~/probe` and `curl` inside a job must fail), an
   update to SYSTEM-DESIGN §3/§5, and input for review #8.
