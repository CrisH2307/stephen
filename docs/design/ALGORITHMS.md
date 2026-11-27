# 6. Algorithms

The key algorithms, in plain words first, then as pseudo-code. Each one lists its problem, complexity, edge cases,
tests and code path. Terms: see [README.md](README.md#words-used-on-these-pages).
Describes `qa` at commit `5fae967` (2026-11-25).

Pseudo-code is a sketch. The code is the source of truth. Where a line number is not given, search for the name.

## 6.1 Command routing

**Problem.** Many commands ("remember milk", "set a timer for 10 minutes", "what timers do I have") need no model.
A model run costs seconds and money. Which commands can skip it?

**Idea.** Try three local routers in a fixed order. The first match answers. If none matches, the model runs, unless
today's limit is used up.

```text
ROUTE(text, source):
  for router in [memory, timer, job]:              # src/voice/assistant.ts:297-311
    r = router.route(text, source)
    if r is null: continue
    if r.rest is null: return r.reply              # no model run
    prefix, prompt = r.reply, r.rest               # "remember X and play Y"
    break
  if not limit.allowed(): return prefix + LIMIT_REACHED   # src/voice/assistant.ts:330-341 (prefix is empty if no router matched)
  reply = claude.run(prompt or text, trust)        # the only model run
  if limit.warnNow(): reply += LIMIT_WARNING
  return prefix + reply
```

**Complexity.** Each router is a grammar match, linear in the text length. The model run is the only costly step.

**Edge cases.**

- Order is the rule. A text that two routers could match goes to the first one.
- "Remember X and play Y" saves X, then sends "play Y" to the model, and the limit applies to that part.

**Tests.** `test/voice/memory-flow.test.ts`, `test/memory/remember-table.test.ts`, `test/timers/timers.test.ts`,
`test/jobs/router.test.ts`, `test/voice/daily-limit-assistant.test.ts`.

**Code.** `src/voice/assistant.ts`, `src/voice/memory-router.ts`, `src/timers/router.ts`, `src/jobs/router.ts`.

## 6.2 Fuzzy matching

**Problem.** Speech to text and typed text are rarely exact. "Youtube musics" should still find YouTube Music, but a
wrong match is worse than none.

**Idea.** Use edit distance (single-letter inserts, deletes and changes) with a small limit. Exact matches win. A near
match is a hint, never an action.

### Edit distance with early stop

```text
LEV(a, b, max):                                    # src/lib/levenshtein.ts:2-17
  if |len(a) - len(b)| > max: return max + 1
  prev = [0, 1, ..., len(b)]
  for i in 1..len(a):
    cur = [i]; best = i
    for j in 1..len(b):
      v = min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i] != b[j]))
      cur.push(v); best = min(best, v)
    if best > max: return max + 1                  # no path can get back under max
    prev = cur
  return prev[len(b)]
```

**Complexity.** Worst case O(|a| x |b|) time and O(|b|) space. Unrelated words usually stop early.

### Entity resolve (apps and sites)

```text
RESOLVE(text, names):                              # src/voice/grammar/classify.ts:91-103
  t = apply_variants(text)                         # "you tube" -> "youtube"
  exact = [n for n in names if plain(n) == t]
  if |exact| == 1: return entity
  if |exact| > 1: return unknown("ambiguous")
  near = first n with len(n) >= 4 and LEV(t, n, max) <= max,
         max = 2 if len(n) >= 8 else 1
  return fuzzy_hint(near) if near else unknown     # a hint, never an action
```

This classifier only labels. In shadow mode, its tier and reason go to the latency record (`src/voice/index.ts:507-515`).
It also decides which media commands may run while sound plays (`src/voice/media-command.ts:24-37`, called from
`src/voice/listener.ts:878`). It does not pick between the routers and the model (routing is 6.1).
[ADR-008](../ADR-008-tier1-fast-path.md) is the proposed fast path.

### Name correction after speech to text

```text
CORRECT_NAMES(words, names):                       # src/voice/names.ts:37-65
  entries = [n for n in names if len(n without spaces) >= 5]
  i = 0
  while i < len(words):
    for k in 3, 2, 1:                              # longest window first
      key = join(words[i:i+k]).lower()
      skip if len(key) < 5, or (k == 1 and key in COMMON)
      hits = [e for e in entries if e[0] == key[0] and LEV(key, e, 1) <= 1]
      if |hits| == 1: replace the window by that name; i += k; break
    else: i += 1
```

A word close to two names is left as heard.

### Wake phrase matching

```text
WORD_MATCH(heard, want, strict):                   # src/voice/transcript.ts:39-44
  if heard == want: return true
  if strict and len(want) >= 4:                    # a bare "Stephen": only a homophone counts
      return HOMOPHONE(heard, want)
  if SOUNDS_LIKE(heard, want) or HOMOPHONE(heard, want): return true   # any length, strict or not
  return len(want) >= 5 and LEV(heard, want, 1) <= 1
```

`findWakeSpan` looks at up to 6 words, skips short filler words (3 letters or fewer), and needs one content word to
match. An anchored match counts only when the words before it are lead words such as "um" (`LEAD_WORDS`).
The acoustic keyword spotter is the first filter. The transcript check (`verifyWake`) is the second.

**Complexity.** About 6 x |phrase| comparisons per transcript. Both matchers are tiny.

**Edge cases.** Whisper repeats a phrase on short clips, and `collapseRepeats` keeps one copy. A bare "Steve" is never
the wake word.

**Tests.** `test/voice/names.test.ts` ("leaves a weak match alone"), `test/voice/grammar/classify.test.ts` ("a real word
one edit from an app name is Tier 2 with a hint"), `test/voice/text.test.ts`, `test/voice/wake-variants.int.test.ts`.
`levenshtein` has no unit test of its own. It is covered through these callers.

**Code.** `src/lib/levenshtein.ts`, `src/voice/grammar/classify.ts`, `src/voice/names.ts`, `src/voice/transcript.ts`.

## 6.3 Untrusted text wrapper

**Problem.** A page, email or tab title is written by a stranger. The model must read it as data, and the text must
not be able to close the data block early and then write as if it were instructions.

**Idea.** Wrap the text in a tag. First change every opening or closing tag of that name inside the text, so its `<`
becomes `&lt;`. The only closing tag left is the one we add.

```text
WRAP(source, url, text):                           # src/safety/index.ts:50-60
  origin = origin(url), or about: href, or protocol, or "unknown"
  safe = replace every match of DELIMITER_RE in text by "&lt;" + the match without its "<"
  return '<untrusted_web_content source="' + esc(source) + '" origin="' + esc(origin) + '">\n'
         + safe + '\n</untrusted_web_content>'

DELIMITER_RE (case-insensitive):                   # src/safety/index.ts:43
  "<", then spaces or zero-width characters, optional "/", more of the same,
  then "untrusted_web_content"
esc(s): replace & " < > in the attribute values    # src/safety/index.ts:38-40
```

**Why it stops an early close.** After the replacement, no `<` in the body can start the tag name, even with spaces,
a slash or zero-width characters in between. So the only closing tag in the output is ours.

**Complexity.** One regex pass, linear in normal input. Known cost: spaces are allowed on both sides of an optional
slash, so one long run of spaces after a `<` can be split between the two parts in many ways. An independent run
(node v24.20.0) on one `<` followed by N spaces gave: 2,000 spaces, 2.7 ms; 4,000, 7.9 ms; 8,000, 24 ms; 16,000,
97 ms; 32,000, 413 ms. That is about 4x per doubling at the top end. Timings vary by machine. This has been reported
to the dev lane for the W1 fix.

**Known gap.** The match is ASCII only. Lookalike brackets, such as a full-width `＜`, are not matched. This is gap W1
in [INJECTION-COVERAGE.md](../INJECTION-COVERAGE.md), which also lists the proposed fix. The wrapper is framing, not
the defence. The defences are the safety gate and taint (6.4, and [SYSTEM-DESIGN-STEPHEN.md](../SYSTEM-DESIGN-STEPHEN.md)
section 4.1).

**Tests.** `test/safety/index.test.ts` ("wraps with source and origin", "escapes attribute values"),
`test/injection/web-text.test.ts` ("a title that closes the block stays inside the untrusted block, and its tag is
escaped"; the W1 gaps are `it.fails` cases).

**Code.** `src/safety/index.ts`, called from `src/server/tools.ts`, `src/server/hub.ts` and `src/desktop/`.

## 6.4 Safety policy: reduce, then confirm

**Problem.** One action can break several rules at once. The gate must give one verdict, and no allow or confirm may
overrule a deny.

**Idea.** Run every rule once and collect the ones that fire. Then reduce: any deny gives deny, otherwise any confirm
gives confirm, otherwise allow. Only a confirm asks the owner. The owner's answer comes from a chain of confirmers, and
the first real answer wins.

```text
EVALUATE(req):                                     # src/safety/policy.ts:325-604
  fired = {}
  for each rule (inline, 20 rule ids):             # each fire(id, verdict, risk, message) call in the code
    if the rule matches req: fired[id] = verdict, risk, messages
  verdict = allow
  for f in fired.values():
    if f.verdict == deny: verdict = deny
    elif f.verdict == confirm and verdict == allow: verdict = confirm
  return verdict

GATE(req):                                         # src/safety/gate.ts:307-386
  d = EVALUATE(req)
  if d.verdict == deny: return refused             # no prompt at all
  if d.verdict == confirm: outcome = CHAIN(prompt(req, d))
  allowed = (outcome == approved)
  if allowed and kind == read: arm taint for the page host
  audit the action (non-read kinds)

CHAIN(prompt, confirmers):                         # src/safety/confirm.ts:426-441
  for c in confirmers:                             # auto: MCP elicit, Ask box, macOS dialog
    try: o = c.confirm(prompt)
    except: o = unavailable
    if o != unavailable: return o                  # a decline stops the chain
  return unavailable                               # nothing could ask: refused
```

**Complexity.** O(R) per action, with R = 20 rule ids. The rate window is 60 s (`src/safety/policy.ts:88`), and the
default limit is 40 actions (`src/config.ts:323`). Every action except a read counts: page-changing actions, hover and
scroll, not reads (`src/safety/policy.ts:17, 440`; `src/safety/classify.ts:314`).

**Edge cases.**

- Fail closed: a missing element, unknown focus or unreadable page URL is a deny.
- A decline from the Ask box is final. It does not fall through to the macOS dialog.
- Approval comes only from the Allow click. Esc is Deny.
- The macOS dialog passes its text as argv, never inside the script (`src/safety/confirm.ts:360-366`).

**Tests.** `test/safety/policy.test.ts` (rules and messages), `test/safety/confirm.test.ts` ("first non-unavailable
answer wins", "passes title/body via argv, never interpolated into the AppleScript"), `test/safety/gate.test.ts`.

**Code.** `src/safety/policy.ts`, `src/safety/gate.ts`, `src/safety/confirm.ts`, `src/safety/app-confirm.ts`.

## 6.5 Daily cost limit

**Problem.** Stop model runs at today's limit, with no server, no clock timer, and no block on the free paths. The
numbers come from several places, and any of them can fail.

**Idea.** Add up today's cost from the latency records on disk, the runs not yet on disk, and today's job cost.
Count in whole millionths of a dollar, so 0.1 + 0.7 is exactly 0.8.

```text
MICRO(usd) = round(usd x 1e6) if usd is finite and > 0, else 0

SPENT(today):                                      # src/voice/daily-limit.ts:88-111
  records = latency records of the last 24 h       # latency.read(1), src/voice/index.ts:645
  total = sum of MICRO(cost) over records dated today
  for each pending run (id, day, micro) of today:
     if its id is not in records (of any day): total += micro
  total += MICRO(job cost of today)                # any read that fails counts as 0, logged

STATE(limit):                                      # src/voice/daily-limit.ts:73-86
  if not enabled or limit == 0: ok
  s = SPENT(today)
  if s >= limit: over                              # no new model run
  if s x 5 >= limit x 4: warn                      # 80%, integer test
  else ok

warnNow(): true once per local day, the first time the state is not ok after a run
```

**Complexity.** Each check reads the latency lines of the last 24 hours, from up to two day files, each capped at 4 MB
(`src/telemetry/latency.ts:144`, read at `:322-336`). Pending runs are capped at 2,000 (`MAX_PENDING`).

**Edge cases.**

- A run that started before midnight is matched on yesterday's line, so it is not counted twice.
- No timer at midnight. Each check computes "today" from the current time.
- A run whose latency line is never written stays counted until midnight.
- `--dry-run` has no limit, because it has no latency monitor.

**Tests.** `test/voice/daily-limit.test.ts` ("exactly 80% warns, just under does not; sums are exact (0.1 + 0.7)",
"exactly 100% refuses, just under allows", "the day changes at local midnight on the same object", "a missing or broken
latency file fails open and is logged", "warnNow: once per day at 80% or more, again the next day"),
`test/voice/daily-limit-assistant.test.ts` ("at 100% no model run starts and Stephen says the limit message").

**Code.** `src/voice/daily-limit.ts`, `src/voice/assistant.ts:330-341`, `src/voice/config.ts:195-199`.

## 6.6 Retention and purge

**Problem.** Keep history, logs and recordings only as long as promised, with no clock timer, and never delete the
live session.

**Idea.** Name each day file by its local date. A purge deletes the files older than the cutoff. Purges run at
startup, on reads and on writes, so nothing waits for a timer.

```text
PURGE_DAY_FILES(dir, days, now):                   # src/telemetry/incidents.ts:193
  cutoff = local date of (now - days)
  for file in dir: if file.date < cutoff: delete file

HISTORY_PURGE(now, keep_days):                     # src/history/store.ts:349-399
  cutoff_ms = same wall-clock time, keep_days ago  # rolling, so DST-safe
  delete day files dated before the cutoff date
  trim the boundary day file to lines with ts >= cutoff_ms (atomic rewrite)
  purge Claude's transcripts with the same cutoff, never the live session
```

**Complexity.** One directory listing per purge, one delete per expired file, and one rewrite of the boundary file.

| Store | Keeps | Source |
|---|---|---|
| History | 7 days by default, 0 to 30 | `src/history/store.ts`, `src/history/config.ts` |
| Claude transcripts | deleted when the session ends, expires or is replaced; the history purge sweeps leftovers | `src/voice/index.ts:363, 376, 381`, `src/voice/transcripts.ts` |
| Latency records | 30 days | `src/telemetry/latency.ts:142` |
| Incident records | 30 days | `src/telemetry/incidents.ts:209-211` |
| F5 recordings | 30 days, at most 100 clips, 50 MB a day | `src/replay/recorder.ts:36`, `:352-357` |
| Finished jobs | `keepDays` after they end (30 by default) | `src/jobs/state.ts:273-282` |
| Timers | an overdue timer older than 12 h is dropped | `src/timers/store.ts:18`, `:161` |
| Audit log | 5 MB a file, 3 old files | `src/safety/audit.ts:11-12` |

**Edge cases.** Clearing history deletes every day file and every transcript at once. Memory has no time purge; it has
a maximum item count instead.

**Tests.** `test/history/store.test.ts` ("retention is a rolling cutoff at the default 7 days: 7 d - 1 s is listed, 7 d + 1 s
is purged"), `test/voice/wake-memory-and-history.test.ts` ("R5-6: history retention is a rolling window, purged at start and on list"),
`test/voice/transcripts.test.ts` ("purges old sessions, keeps new ones and the live one, ignores other files"),
`test/telemetry/incidents.test.ts` ("deletes a day file older than 30 days and keeps a recent one"),
`test/timers/timers.test.ts`.

## 6.7 Incident parser and `stephen report`

**Problem.** A failure report must help a developer, and it must hold no words, names, URLs or page text. Anything not
on the allow list must be dropped, even from a file written by another version.

**Idea.** Build a new record field by field from an allow list. Unknown fields are never copied. The record has no
free-text field at all. The report shows exactly the parsed record, and sends it only after a "y".

```text
PARSE(v):                                          # src/telemetry/incidents.ts:100-131
  if v is not an object, or v.v != 1: return null
  if v.id is not a string matching [A-Za-z0-9_-]{1,64}: return null
  if v.ts is not a string of at most 40 characters, or not a date: return null
  rec.stephen = v.stephen if it looks like a version, else "0.0.0"
  rec.part    = v.part  if in the closed list, else "other"     # same for code and stage
  rec.stages  = only the 8 known stage names, whole ms in [0, 86400000)
  return rec

REPORT(argv):                                      # src/telemetry/report.ts
  n = --last (1 to 50, default 5)
  purge incident files older than 30 days
  records = newest n parsed records, newest file first
  if none: print "No incidents recorded." and stop
  print the body (rebuilt from parsed fields only)
  ask "Send this to GitHub as an issue? (y/N)": only "y" or "yes" continues
  check gh sign-in, then gh issue create with the same body and label incident
```

**Complexity.** Linear in the lines read. It reads day files newest first until it has n records, each file capped at 1 MB.

**Edge cases.** A bad line is skipped, not fatal. Recording never throws. End of input counts as "no". The repo is
fixed in code (`REPORT_REPO`, `src/telemetry/report.ts:14`).

**Tests.** `test/telemetry/incidents.test.ts` (paraphrase: free text dropped, version and stage rules, purge),
`test/telemetry/report.test.ts` ("free text planted in the file is never shown or sent", "no incidents: says so, asks
nothing, sends nothing", "gh missing or not signed in: nothing is created, the manual steps are shown").

**Code.** `src/telemetry/incidents.ts`, `src/telemetry/report.ts`, `src/telemetry/latency.ts`.

## 6.8 Job reconcile after a crash

**Problem.** A job runs in its own process. If the listener or the Mac dies mid-job, the job may still show as running,
its process may be gone, or its pid may now belong to another program. The state must become true without killing the
wrong process.

**Idea.** On each list, look at each open job and ask whether its runner and Claude are still ours. If not, mark it
failed. Kill only a Claude process that proves it is ours, by its session id. Reconcile never starts a job, so no job
runs twice.

```text
RECONCILE(job, now):                               # src/jobs/state.ts:179-191
  if job.status is final: return job               # done, failed, stopped or timeout
  if job.status == queued and no pid:
      if now - createdAt > 60 s: return FAIL("The job runner didn't start.")   # state.ts:158, 184-185
      return job
  if no pid, or pid is not "jobs _run <this id>" (command line check), or now > deadline + 15 min:   # state.ts:186
      if claude pid is still ours (its --session-id matches): SIGKILL it       # state.ts:188
      return FAIL("Stephen's job runner ended without a result (the Mac restarted, or it crashed).")   # state.ts:159
  return job
```

**Complexity.** One process-table lookup per open job. At most 2 jobs run at once (`maxRunning`, `src/jobs/config.ts`).

**Edge cases.** A reused pid is caught by its command line, so a stranger's process is never killed. When `ps` times
out, the job stays open and nothing is killed (`reconcileAsync`).

**Tests.** `test/jobs/state-pid.test.ts` ("reconcile: a reused supervisor pid → failed; a Claude pid that is not this
session is never killed"), `test/jobs/reconcile-claude-ps.test.ts` ("a ps timeout for the Claude pid keeps the job
non-final; the next real answer handles it", "#296: past the deadline, a Claude proven ours by its --session-id is still
killed before the job fails"), `test/jobs/manager.test.ts`.

**Code.** `src/jobs/state.ts`, `src/jobs/manager.ts`, `src/jobs/runner.ts`.

Next: [CODEBASE.md](CODEBASE.md).
