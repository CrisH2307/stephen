# Review 6: phase 2a (Canvas, Google Calendar, private-data taint) and timers/reminders

Date: 2026-11-02. Repo `/home/claude/work/browser-hub` @ `1b39762`. Independent reviewer (did not build this code).
The repo was not changed except for this file. Nothing was built or installed. Mac-only parts (Keychain, osascript
notification, TTS) were checked by reading only. Small probe scripts were run outside the repo against `dist/`.

## Scope

Commits `371db65..1b39762` plus the `notePrivateData` work from `0868bee`. Code: `src/accounts/` (secrets, http,
result, canvas, calendar, index, cli, config), `src/util/zone.ts`, `src/safety/gate.ts` + `egress.ts`
(`notePrivateData`, synthetic host), `serve --assume-private-read` (`src/serve-args.ts`, `src/cli.ts`), `src/timers/`
(intent, store, router, notify) and their wiring in `src/voice/index.ts` and `src/voice/assistant.ts`,
`src/eval/dry-server.ts` + `cases.ts`, persona lines in `src/voice/claude.ts`, `test/helpers/import-scan.ts`.

## Method

Followed every value a tool sends to the network back to its source (config, `.env`, Keychain, the model, the remote
server). Followed every account byte from the response to the tool result, and checked that the taint is on disk
before it. Read every path that ends in `TimerStore.add/remove` and every place timer text is spoken or shown.
Probes (Node 22, from `dist/`): `field()` on hostile strings and long inputs; calendar feeds with old RRULEs,
repeated BYDAY, long EXDATE lists, `INTERVAL=0`, `COUNT` huge, `FREQ=SECONDLY`; undici error messages for odd tokens;
the boundary scanner's regexes against TypeScript's own import list (`ts.preProcessFile`) for every file in `src/`.

Threat model: same-user processes are out of scope. A finding counts if it helps a lower-trust actor (web page, other
people's Canvas posts, strangers' calendar invites, the model, a bystander or video saying "Hey Stephen") or breaks a
promise the plan makes to the owner.

## Findings

| ID | Severity | Title | File:line |
|----|----------|-------|-----------|
| R6-1 | Medium | `.env` (Canvas token, secret calendar address) is not gitignored, although the plan says it is | `.gitignore:1-5`, `src/accounts/secrets.ts:27`, `docs/PLAN-2A-READ-MY-STUFF.md:71` |
| R6-2 | Medium | Third-party text can freeze the MCP server for minutes: quadratic tag regex in `htmlToText`, and calendar expansion that does thousands of `Intl.DateTimeFormat` builds per event | `src/accounts/result.ts:18,20`, `src/util/zone.ts:8`, `src/accounts/calendar.ts:147-151,196-211` |
| R6-3 | Low | Recurring events older than a few years disappear (the 2000-instance cap counts from DTSTART); repeated BYDAY days give duplicate events | `src/accounts/calendar.ts:196-201,205` |
| R6-4 | Low | Wake-word timer commands have no trust level: a bystander or video can cancel all timers, hear reminder text, fill all 20 slots, or plant a reminder | `src/timers/router.ts:67,86-98` |
| R6-5 | Low | Timer alerts ignore the listener state: they speak during push-to-talk recording, speak anyway after 60 s, and the wake word stays live while they speak | `src/voice/index.ts:551-559` |
| R6-6 | Low | A token with a NUL character is copied into the tool error (undici puts the header value in its message, `http.ts` echoes it) | `src/accounts/http.ts:106`, `src/accounts/secrets.ts:59-61,94` |
| R6-7 | Info | The synthetic taint host counts as a "read" host, so a URL on `canvas.private.stephen.invalid` passes every taint rule | `src/safety/policy.ts:304,574`, `src/safety/egress.ts:361` |
| R6-8 | Info | Result-cleaning gaps (defense in depth): schemeless / `hxxps` / `https:/\` links, dotted or non-ASCII codes, full-width `＜/untrusted_…＞` | `src/accounts/result.ts:33-52` |
| R6-9 | Info | `withoutSecrets` removes only `ELEVENLABS_API_KEY`; account keys in the shell env reach `claude` and every `serve` | `src/voice/claude.ts:612-616` |
| R6-10 | Info | `.env` parser: `KEY="v" # note` keeps the quotes; the first duplicate wins (dotenv: the last) | `src/accounts/secrets.ts:57-62` |
| R6-11 | Info | The boundary scanner is regex-based and can be fooled (apostrophe in a comment inside a multi-line import, template-literal `import()`, `createRequire`) | `test/helpers/import-scan.ts:45-47` |

No Critical or High findings. The model cannot steer an account request: no tool takes a URL, path or id from the
model, the origin is pinned, and secrets never reach a result, log or argv in normal operation. The taint is armed and
saved before every data return, and only then. Claude has no way to create, change or cancel a timer.

### R6-1 (Medium) `.env` is not gitignored

**What.** Secrets are read from `<repo>/.env` (`secrets.ts:27`). PLAN-2A §6 says that file is "gitignored, 0600". The
`.gitignore` lists only `node_modules/`, `dist/`, `*.log`, `.DS_Store`, `coverage/`. `git check-ignore .env` prints
nothing. On the Mac, `git status` shows `.env` as untracked, so the next `git add -A` or `git commit -a` with new files
includes it. Coding agents in this project commit often, and the history shows the repo moves between the Mac and the
cloud (`bbbf426 merge mac handover`).

**Why it matters.** One commit puts the Canvas token (full API access to the owner's school account as the owner) and
the secret calendar address into git history, then into every copy of the repo, and into any remote added later.
Removing it then means rotating both secrets and rewriting history. The 0600 check in `readEnvFile` does not help:
git stores content, not modes.

**Fix.** Add `.env` and `.env.*` to `.gitignore` today. Add a test that runs `git check-ignore .env` (skip if git is
missing). Optionally, have `stephen accounts` warn when `git ls-files --error-unmatch .env` succeeds.

**Test.** `test/accounts/gitignore.test.ts`: `git check-ignore -q .env` exits 0 in the repo root.

### R6-2 (Medium) Third-party text can freeze the server

**What.** Two CPU sinks run synchronously in `stephen serve`, before the result goes back.

1. `htmlToText` runs `/<[^>]*>/g` and `/<(script|style)[\s\S]*?<\/\1>/gi` on the raw field before any length cap
   (`result.ts:18,20`; `field()` caps only at the end, `:52`). Each `<` with no `>` after it scans to the end of
   the string, so the cost is quadratic. Measured: 10,000 `<` = 66 ms, 40,000 = 956 ms. A 2 MB field (the HTTP cap)
   extrapolates to about 40 minutes.
2. `tzOffset` builds a new `Intl.DateTimeFormat` on every call (`zone.ts:8`), and `zonedToUtc` calls it twice. The
   calendar calls this per EXDATE value and per expanded instance. Expansion starts at DTSTART, not at the window, and
   instances before the event start do not count against the cap (`calendar.ts:196-201`). Measured:
   - one event with `BYDAY=SU,SU,…` (50,000 repeats, 150 KB) starting on a Saturday: 6.3 s;
   - 50 events with `FREQ=DAILY` from 1900: 13.3 s (each walks 2,000 instances);
   - one `EXDATE` line with 20,000 values: 4.5 s.

**Why it matters.** A stranger can put an event on the owner's calendar by sending an invite (Google adds invites from
anyone by default). A few dozen spam invites with old daily rules make every "what's on my calendar" take minutes. One
long title of `<<<<…` (if Google keeps it) does the same through `field()`. Canvas announcement HTML from course staff
is also untrusted input to the same regex. While this runs, the server's event loop is blocked, so every tool in that
command stalls. No data leaks (the taint is armed after the work), but the calendar tool stops being usable until
someone finds and deletes the event.

**Fix.**
- In `field()`, cut the raw input to about `8 * max` characters before `htmlToText`. Replace the tag regex with a
  single linear scan, or use `/<[^<>]*>/g`, which cannot rescan. Drop the `script|style` regex, or bound it the same
  way.
- In `zone.ts`, cache one formatter per zone (a `Map<string, Intl.DateTimeFormat>`).
- In `expandStarts`, jump straight to the first period at or before the window start when there is no COUNT
  (DAILY/WEEKLY: arithmetic on days; MONTHLY/YEARLY: on months). Dedupe BYDAY. Count loop iterations, not just pushed
  instances, and stop at a fixed limit (for example 5,000 per event).
- In `parseIcs`, cap the number of events (for example 5,000), properties per event, and EXDATE values per event
  (for example 1,000).

**Test.** `field('<'.repeat(2_000_000))` finishes in under 200 ms. A feed with 200 daily events from 1900, one BYDAY of
100,000 repeats and one EXDATE with 100,000 values gives `calendar_events` an answer in under 1 s (vitest timeout).

### R6-3 (Low) Old recurring events disappear

**What.** `push()` stops at `MAX_INSTANCES` (2000) counted from DTSTART (`calendar.ts:198`). Probes:
- `FREQ=DAILY` from 2015-01-01: 0 instances this week (it should be 7);
- `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` from 2010: 0 instances (it should be 5).

So a daily event older than about 5.5 years, or a weekday event older than about 7.7 years, is silently missing. Also,
`BYDAY=MO,MO,MO` gives three copies of each Monday instance (no dedupe, `:205`).

**Why it matters.** "Am I free this afternoon?" gets "yes" while a standing meeting is on the calendar. No attacker
gain, but the tool promises the real schedule.

**Fix.** Same as the R6-2 skip-ahead. COUNT still needs a count from DTSTART, which can be computed arithmetically
for DAILY and simple WEEKLY rules. Dedupe BYDAY.

**Test.** The two probes above return 7 and 5 instances. `BYDAY=MO,MO` gives one instance per Monday.

### R6-4 (Low) Wake-word timer commands have no trust level

**What.** `TimerRouter.route` ignores `opts.source` (`router.ts:67`, `_opts`). After the wake word, anyone in the room
(or a video, when the sound gate is open) can:
- say "cancel all timers" or "cancel the reminder": they are deleted at once (`:96-98,110`);
- say "what reminders do I have": up to 5 reminder texts are spoken (`:86-91`). Memory only says the count in this
  case (R5-5);
- say "remind me in 1 minute to …" 20 times: the store is full and the owner's next reminder fails (`store.ts:93`);
- plant a reminder that Stephen later speaks aloud and shows as a notification.

SYSTEM-DESIGN §5 promises "dialogs for memory changes, counts instead of contents" for wake-word trust. Timers do not
follow that rule.

**Why it matters.** A roommate or a TV can cancel the owner's "take the pizza out" timer, or hear "reminder at 3 pm:
call the clinic about my results". Nuisance and a small privacy leak. Claude itself has no path in (see "Checked, OK").

**Fix.** Pass the source through. After the wake word: a list gives only the count ("You have 3; hold F5 to hear
them"); cancel-all and cancel-one ask with the same Deny-default dialog as memory forget; creating stays free, but at
most 5 wake-word items at a time. Also run `memoryTextLooksSecret` on timer labels, not only on reminder text (`:75`).

**Test.** `timers.test.ts`: with `source: 'voice-wake'`, a list reply has no item text; cancel-all with a declining
confirmer removes nothing; the 6th wake-word reminder is refused; `voice-ptt` keeps today's behaviour.

### R6-5 (Low) Timer alerts ignore the listener state

**What.** `alertTimers` (`index.ts:551-559`) waits only while `assistant.busy` is true, and for at most 60 s. Then it
speaks through `speaker.speak` directly. Problems:
- `assistant.busy` is false while the listener records (wake-word capture or a held F5). The alert is spoken into the
  mic and ends up in the owner's command transcript. A push-to-talk command is trusted (memory saves without a
  dialog), so a planted reminder (R6-4) can put words into a trusted command.
- After 60 s it speaks over a running command or its reply.
- The listener does not know Stephen is talking. Without the helper, a reminder that says "hey stephen …" can trigger
  the wake word on Stephen's own voice. With the helper, the "sound is playing" gate blocks this.
- Two items firing in separate ticks start two loops that can talk over each other.

**Fix.** Queue alerts in the listener: fire only when `listener.idle` is true (not recording, not busy, nobody
talking), mark the listener busy while the alert is spoken, and keep one alert queue. If Stephen stays busy, show the
notification at once and speak later.

**Test.** A fake listener in `recording` state: the alert is not spoken until it returns to idle. While the alert
speaks, `submit()` returns null and a wake hit is ignored.

### R6-6 (Low) The token can end up in an error message

**What.** `fetchOnce` puts the fetch error message into the result (`http.ts:106`, `could not reach … (${message})`,
120 characters). For an invalid header value, undici's message holds the whole header. Probe (Node 22):
`Headers.append: "Bearer abc\u0000SECRET" is an invalid header value.` The token is not checked anywhere: `.env` values
are only trimmed (`secrets.ts:59-61`), and Keychain values too (`:94`). A Canvas token is about 70 characters, so it
fits inside the 120-character slice.

**Why it matters.** It needs a NUL in the stored value (a bad paste, an editor or a Keychain item made by a script),
so it is unlikely. But then the token goes into a tool result. That means Claude's context, the session transcript,
maybe the spoken reply, and `stephen accounts test` output.

**Fix.** In `lookupSecret`, accept only printable ASCII (`/^[\x21-\x7e]{8,4096}$/`) for tokens and a valid https URL
for the calendar. Otherwise return a note "the value has characters that can't be right". In `fetchOnce`, never echo
the raw message: map `AbortError`, `TypeError: fetch failed` + `cause.code` (ENOTFOUND, ECONNREFUSED, certificate
errors) to fixed words.

**Test.** A token `abc\u0000SECRET` gives a "not connected" notice. With a fake `fetch` that throws
`new TypeError('… Bearer SECRET …')`, the tool result does not contain `SECRET`.

### R6-7 (Info) The synthetic host is a "read" host

**What.** `untrustedDestinationHosts` treats every read host as OK (`policy.ts:304`), and `taintFromOtherHosts` skips
reads on the same host (`:574`). After only a Canvas read, `open_url https://canvas.private.stephen.invalid/<data>?d=…`
fires no taint rule. Normally the request dies at DNS (`.invalid` is reserved). A browser behind an HTTP proxy, or a
resolver that answers every name, would receive the full URL.

**Fix.** Deny any navigation or request to a host ending in `.invalid` (at least `.stephen.invalid`) in `evaluate`.

**Test.** After `notePrivateData('canvas')`, `open_url` to that host is denied.

### R6-8 (Info) Result-cleaning gaps

**What.** Probes through `field()`:
- `reduceLinks` keeps `hxxps://evil.com/?q=`, `evil.com/?q=1`, `//evil.com/a`, `https:/\evil.com/x` (browsers read
  it as `https://evil.com/x`) and full-width `ｈｔｔｐｓ://…`;
- `maskCodes` keeps `12.34.56`, `١٢٣٤٥٦`, `１２３４５６` and `482913abc`;
- `＜/untrusted_account_data＞` (full-width) is not escaped. `&amp;lt;/untrusted_account_data&amp;gt;` comes out as
  the literal text `&lt;/untrusted_account_data&gt;`.

**Why it matters.** Small. The model can rebuild any URL it is told to, so the egress gate (taint plus dialogs) is the
real control, and it holds. These are cheap hardening steps.

**Fix.** NFKC-normalize first. Reduce `\b[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*` and `h..ps?:/+\\?` shapes to `[link: host]`.
Mask digit runs with `.` separators and `\p{Nd}`. Escape `untrusted_` after NFKC, and map `<` and `>` in third-party
text to `‹` and `›` as memory does.

**Test.** A table in `accounts.test.ts` with the strings above.

### R6-9 (Info) Account keys in the shell environment reach claude

**What.** `withoutSecrets` deletes only `ELEVENLABS_API_KEY` (`claude.ts:612-616`). Stephen itself never sets account
keys in the environment. But if the owner's shell exports them (`source .env`, direnv in the repo folder), `CANVAS_API`
and `GOOGLE_CALENDAR_ICS` go to `claude` and to every `stephen serve`. Neither needs them: serve reads the file.

**Fix.** Delete every name in `SECRET_SPECS[*].env` in `withoutSecrets`.

**Test.** `withoutSecrets({CANVAS_API:'x', GOOGLE_CALENDAR_ICS:'y', PATH:'p'})` keeps only `PATH`.

### R6-10 (Info) `.env` parser edge cases

**What.** `CANVAS_API="tok" # mine` keeps the quotes, because the quote check runs before the comment is stripped
(`secrets.ts:60-61`). Canvas then answers 401. If a key appears twice, the first one wins; dotenv uses the last.

**Fix.** Strip a trailing ` #…` first when the value does not start with a quote. Then remove the matching quotes.
Let the last duplicate win, or report duplicates in `stephen accounts`.

**Test.** `parseEnvFile('CANVAS_API="tok" # mine')` gives `tok`.

### R6-11 (Info) The boundary scanner can be fooled

**What.** `STATIC_RE` (`import-scan.ts:45`) stops at any quote inside the import clause, so
`import {\n TimerStore, // don't\n} from '../timers/store.js'` is not seen. Template-literal ``import(`…`)`` and
`createRequire(...)('…')` are not seen either. Today nothing is missed: I compared the scanner with
`ts.preProcessFile` for every file in `src/`, and the only differences are two package `require`s in `src/voice/`.

**Fix.** Use `ts.preProcessFile` (TypeScript is already a dev dependency) for the import list. Fail the test on any
non-literal `import(` or `createRequire` in Claude-reachable files.

**Test.** A fixture file with the three shapes is reported by the scanner.

## Fix status (2026-11-02, lead; each fix has a test in test/accounts/hostile-input-and-tokens.test.ts)

| ID | Status | What changed |
|----|--------|--------------|
| R6-1 | Not an issue on the owner's Mac | The Mac's `.gitignore` has `.env` (owner commit "ignore"); the reviewer's cloud copy was an older snapshot. |
| R6-2 | Fixed | `field()` cuts input to 8× the cap before any regex; tag regex is `<[^<>]*>` (linear), script/style regex dropped; one `Intl.DateTimeFormat` per zone (cache); expansion skips ahead to the window, BYDAY deduped, `MAX_ITER` 5000 per event; feed caps (5000 events, 200 props, 1000 EXDATEs). |
| R6-3 | Fixed | Skip-ahead (DAILY/WEEKLY/MONTHLY/YEARLY arithmetic) when there is no COUNT, so a daily event since 2015 shows this week. |
| R6-4 | Fixed | Wake-word timer list = count only; cancel asks (Deny default, no dialog = kept); at most 5 wake-word items; timer names secret-checked. |
| R6-5 | Fixed | Notification shows at once; the spoken alert waits in one queue for `listener.idle` and runs through `listener.submit` → `Assistant.announce` (busy while speaking). |
| R6-6 | Fixed | Secrets must be printable ASCII (URLs: https/webcal); network errors map to fixed words (`networkReason`), never the raw message. |
| R6-7 | Fixed | `*.stephen.invalid` targets are blocked (`blockedTargetReason`). |
| R6-8 | Fixed | `reduceLinks` handles hxxp(s), `:/\`, schemeless host+path/query; NFKC before escaping (full-width `＜`); dotted codes masked. |
| R6-9 | Fixed | `withoutSecrets` also strips every account env name (`ACCOUNT_ENV_NAMES`). |
| R6-10 | Fixed | `KEY="v" # note` parsed; last duplicate wins. |
| R6-11 | Open (Info) | Regex import scanner kept; it matches TypeScript's import list today. |

## Checked, OK

- **No off-origin request.** Tools take only `days` (int 1–30, clamped again), `include_done` (bool) and `range`
  (enum). Paths are fixed strings plus `URLSearchParams` (`canvas.ts:117-130`). `context_codes[]` come from
  `course.id` values from Canvas, filtered with `Number.isSafeInteger`, at most 40. `ApiClient.url` and `fetchOnce`
  both compare the origin (`http.ts:80,86`). `Link: rel="next"` must have the same origin, so `//evil.com`,
  `http://same-host` and other ports stop paging. At most 5 pages. `redirect: 'manual'`, and any 3xx is an error.
  https only (loopback http only with a test flag). User info in an origin is refused. Timeout covers the body read.
  2 MB cap on Content-Length and on the stream.
- **Calendar feed secret.** `calendarFeed` keeps the path only for the request. Every error message names the host
  only. The CLI prints `api.origin`. A bad address gives a fixed notice. No token is sent to the feed host.
- **Secrets never in results, logs, argv or the gate audit** (except R6-6). Keychain via `security … -w` (argv holds
  the service name only), with the secret on stdout. Notes carry paths and modes, never values. The tool log stores
  names only. Account tools don't call `gate.check`, so nothing about them goes into audit args.
- **`.env` reading.** `REPO_ROOT` is the repo from both `src/accounts` and `dist/accounts`. `lstat` refuses symlinks
  and non-files. Owner uid, `mode & 077 == 0`, 64 KiB cap. Only known key names are taken. No expansion. A BOM is
  removed by `trim()`. (Gaps: R6-1, R6-10.)
- **Taint order.** In all three tools, `notePrivateData` runs after fetch, parse and format, and right before
  `okResult` (`index.ts:102,123,155`). Every failure throws earlier, so no taint and no data. `remember()` writes the
  session state synchronously, and on a write error `bindSessionState` exits the server (code 70), so the data never
  returns. A re-read of a known scope is not rewritten (it is already on disk). `hub.safety()` is created before the
  handler runs.
- **No untainted path.** Error texts hold no response content. The dry-run server returns only fake data, and its
  account results use the same `accountBlock`. `stephen accounts test` prints to the owner's terminal, not to Claude.
  `--assume-private-read` only adds taint, takes no value, and is not used by the listener yet (by plan).
- **Synthetic host and saved state.** `privateDataHost` accepts only the 5 known sources. `validateGateState` accepts
  the synthetic host as a normal host. A hand-edited state can only add taint (imports never remove). No real page
  can share the host (R6-7 covers the one corner).
- **Delimiters.** Entity-decoded `</untrusted_…` is escaped, case-insensitive. Control, bidi and zero-width characters
  are stripped after entity decoding. Each field is one line. `source="…"` is a fixed enum. The block is capped at
  6000 characters. Header and footer are Stephen's own text. (Look-alikes: R6-8.)
- **Regexes.** Every regex in `calendar.ts`, `intent.ts` and `result.ts` was read. Only the two `htmlToText` tag
  regexes are super-linear (R6-2). `parseProp`'s `(?:[^;"]|"[^"]*")+` has disjoint branches. `maskCodes` is linear
  (one digit per step). `nextLink`, `unfold`, `parseRrule` and the ISO duration regex are anchored or linear.
- **RRULE edge cases.** `INTERVAL=0` becomes 1. `COUNT=999999999` is bounded by the window and the cap. `FREQ=SECONDLY`
  or anything unknown gives the first instance only. NaN dates are pushed but never shown. `zonedToUtc` is two fixed
  steps (no loop), so no timezone input can hang it. TZID is validated before use.
- **No timer path from Claude.** `TimerRouter` runs only from `Assistant.command`, which is called with the owner's
  transcript or typed app text (`listener`, `app/server.ts:428,437`). The split `rest` goes straight to Claude and is
  not routed again. Claude's reply is never parsed. No MCP tool touches timers, and `src/timers/` is a boundary for
  every Claude-reachable folder, including `src/accounts/`. The `stephen serve` start-up graph has no timers code.
  The persona tells Claude it can't set timers.
- **Notification.** `osascript` with an `on run argv` script. The text is one argv item, capped at 240. It always
  starts with fixed words ("Your …", "Reminder…", "While I was off…"), so it can't be read as an option. Text comes
  from `timerWords` (`[a-z0-9:'.]` only) and `cleanMemoryText`.
- **Timer store.** `<home>/timers.json` is read with `O_NOFOLLOW`, regular file, owner uid, mode exactly 0600, 512 KiB
  cap, and invalid JSON is ignored. Writes go to an `O_EXCL|O_NOFOLLOW` temp file and are renamed. Ids, kinds, `dueAt`
  and text are re-validated on load. 20 items, 200 characters each. A secret-looking reminder is refused, and history
  keeps `remind me [refused: …]`.
- **Scheduler.** One timer, re-armed after each change. The wait is capped below 2^31 ms (it re-checks and re-arms
  after a chunk). Due items are removed before `onFire`, so nothing fires twice in one process. Items more than 12 h
  late are dropped and the rest are marked late. A throwing alert is logged. The timer is `unref`'d and stopped on
  exit.
- **Grammar.** Parts the grammar doesn't understand either go to Claude (`rest`, or the whole line) or are said back in
  the reply ("10 minute timer for 30 started" for "10 minutes and 30"), so nothing is dropped silently. 48 h maximum,
  1 s minimum. "today at 5" in the past is refused.
- **Boundary tests.** `src/accounts/` is in `CLAUDE_REACHABLE`. `src/timers/`, `src/memory/`, `src/app/` and
  `src/history/` are protected, transitively, with dynamic imports included. `export * from` is matched. (Scanner
  robustness: R6-11.)
