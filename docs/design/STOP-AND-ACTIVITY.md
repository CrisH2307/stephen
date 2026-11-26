# Design note: T6, a Stop button and an Activity view

Status: proposal, no code yet. Describes `qa` on 2026-11-26. Two small features for the helper app:

1. **Stop**: one button that stops what Stephen is doing now (a reply, the browser action inside it, and on request
   the running jobs).
2. **Activity**: one page that says, in plain words, what Stephen did recently, built only from logs that exist today.

## What exists today

Most of the plumbing is already there. T6 is mainly UI.

| Piece | Where | What it does |
|---|---|---|
| `chat.stop` | `src/app/server.ts`, `helper/AppProtocol.swift` | Calls `listener.cancel('app')`. Esc in the Ask box sends it. |
| `Listener.cancel` | `src/voice/listener.ts` | Ends the conversation. While recording: drops the recording. While busy: `assistant.cancel()`. |
| `Assistant.cancel` | `src/voice/assistant.ts` | Running: kills the Claude run. Speaking: cuts the spoken reply short. |
| Claude run kill | `src/voice/claude.ts` | SIGTERM to Claude's whole process group, SIGKILL after `killGraceMs`. The tool server (`serve`) is in that group, so it ends too. |
| `jobs.stop` | `src/jobs/manager.ts`, `runner.ts` | SIGTERM to the job's supervisor; it SIGTERMs Claude Code's group, SIGKILL after 10 s (`KILL_GRACE_MS`), writes `stopped`, audits `job_stop`. A queued job is marked stopped at once. |
| Pending question | `src/app/server.ts` `settle()` | When the asker's socket closes (the tool server died), the question ends as "no answer" and the Ask box drops it. |
| `audit.recent` | `src/safety/audit.ts` | Newest audit entries: time, tool, kind, element, URLs, redacted args, verdict, confirmation, outcome, intent, `cmd`. |
| `history.list`, `jobs.list` | `src/history/`, `src/jobs/` | What you asked and the reply; the jobs and their status. |
| Conversations page | `helper/ConversationsPage.swift` | Already joins history and audit per command, by time, with `auditActionText`. |

What is missing: a visible Stop control (Esc is hidden and only works with the box focused), a way to stop jobs from
the same place, honest words about what could not be undone, and one flat "what happened" list across chats and jobs.

## What the user sees

### Stop

- **Ask box and Home thread:** while Stephen is working or speaking, a **Stop** button sits next to "Working…".
  Esc keeps working. The button has the label "Stop Stephen" for VoiceOver.
- **Menu bar menu:** a "Stop" item, shown only while something runs.
- **After Stop**, one grey line in the thread, in words, never color alone:
  - `Stopped.` when nothing was in flight.
  - `Stopped. The last browser step may already have happened.` when a tool call was running.
- **Jobs:** if jobs are running, the line adds `2 jobs are still running.` and a **Stop them too** button. Stop alone
  never ends a job: a job is long work the owner started on purpose, and a reflex press should not lose it.
- A pending Allow or Deny question closes as "not allowed". Stop never counts as Allow.

### Activity

A list, newest first, of the last 24 hours, one line per thing done:

```
2:14 PM  Opened a tab on youtube.com                 done
2:14 PM  Clicked button "Play" on youtube.com        done
2:15 PM  Send on mail.google.com                     you said no
2:20 PM  Job "Sort my downloads"                     stopped by you
2:31 PM  Typed into a field on docs.google.com       failed
```

Each line: the time, the action in words (from the audit `kind` and `tool`), the site **host only**, and the result
(`done`, `you allowed`, `you said no`, `refused`, `failed`, `stopped by you`). A line opens the Conversations entry
it belongs to.

## Which process stops what, and how

```
Helper (Swift)  --chat.stop-->  Listener  --SIGTERM group-->  claude + stephen serve   (SIGKILL after grace)
Helper (Swift)  --jobs.stop-->  Listener  --SIGTERM-->        job supervisor --SIGTERM group--> claude (SIGKILL 10 s)
```

- The helper never signals a process itself. It only sends `chat.stop` and `jobs.stop` over app.sock.
- Both requests already exist, so **steps 1 to 3 need no protocol change**.

### What cannot be stopped mid-step

Stop ends the next step. It cannot take back a step that already reached the browser or the disk:

- A click, key press or navigation already sent to the browser. A page that started loading keeps loading.
- Text already typed into a field (a `type` or `fill_form` call that was running may be partly done).
- Anything the owner already allowed, for example a sent email.
- Files a job already wrote. They stay in the job's folder, as today.
- The spoken reply stops at once; a word may be cut.

The thread line says so in plain words (see above). Stephen does not try to undo.

## What the Activity view reads, and what it must never show

**Reads:** `audit.recent`, `history.list` and `jobs.list`. Nothing new is logged for T6.

**Never shows:**

- `args`, even redacted. They can hold a preview of typed text.
- Full URLs. Only the host. Paths and queries can hold tokens or search words.
- Page text, replies of tools, and the job's `log.jsonl` (the model's transcript). The page never reads it.
- `error` strings. They can quote a page. The line says `failed` only.
- Element labels from private sites (mail and the other sites in the private list). A Gmail row label can hold
  "your code is 771204". The line then says `Clicked a row on mail.google.com`. `recent_actions` uses the same rule. Build step 3 does this in the listener.

**Untrusted text is framed:** element labels come from web pages and `intent` is written by the model. When shown,
they are in quotes, one line, cleaned (`clean` in `src/safety/text.ts`, as the audit already does), cut at 60
characters, drawn with `Text(verbatim:)`, never as a link or Markdown. The job task text is the owner's own words.

## Options compared

### Stop

| | A. Stop the reply, offer jobs (recommended) | B. Stop everything at once | C. Restart the listener |
|---|---|---|---|
| What it ends | Reply and its browser step; jobs only on a second press | Reply and every job | Everything, including the wake word |
| Protocol change | None | New `stop.all`, or a loop | None |
| Risk | Low | A reflex press loses long jobs | Loses timers in flight, slow to come back |
| Work | S | S | S, but bad for people |

### Activity

| | A. New sidebar page "Activity" (recommended) | B. A filter in Conversations | C. A section on Home |
|---|---|---|---|
| Shows jobs and chats together | Yes | No, Conversations is per chat | Only the last few |
| Reuse | `auditActionText`, the existing requests | All of Conversations | Home's recent list |
| Cost | One Swift file and a sidebar row | Small, but the page gets more crowded | Small, but Home is the chat |

**Recommendation:** Stop option **A** and Activity option **A**. They reuse the requests that exist and keep a
reflex press safe for long jobs.

## Build steps (one PR each)

1. **Stop button** in the Ask box, Home and the menu bar menu, sending `chat.stop`. The "may already have happened"
   line when a tool was running (from the `chat.done` `cancelled` outcome and its `tools`). Helper only. Size S.
2. **Stop them too** for running jobs: after Stop, the helper reads `jobs.list` and offers one button that sends
   `jobs.stop` for each running job. Helper only. Size S.
3. **Private labels hidden at the source**: the listener drops element labels of private sites from `audit.recent`
   before they reach the helper, so neither Activity nor Conversations shows them. The private list is built into
   the policy (`isPrivateUrl` and `compileLists` in `src/safety/policy.ts`), not in `settings.get`, so the helper
   cannot do this itself. Touches the app.sock answer, so `[DEV REVIEW]` and an independent review. Size S.
4. **Activity page** (after step 3): the sidebar row, the list, the row text builder with the "never show" rules,
   and one Swift test for the row text (host only, no args, no error text, quotes and the 60 character cut). Helper
   only. Size M.
5. **Join by command id**, not by time: audit entries carry `cmd` today. If history ids are the same ids, Activity and
   Conversations join on it and the "two commands at once could swap lines" ceiling goes away. Check at build time.
   Size S.

Each coding brief copies the AGENTS.md coding responsibilities. Opus codes; screenshots of every UI step in the PR.

## Questions for Cris

1. Should Stop leave running jobs alone and only offer "Stop them too"? (yes = recommended)
2. Is a new "Activity" row in the sidebar OK? (no = it becomes a filter in Conversations)
3. Should Activity hide button labels on private sites like Gmail? (yes = recommended)
4. Do you want a global Stop key that works when the Ask box is closed? (no = recommended for now; Esc and the
   button cover it)
