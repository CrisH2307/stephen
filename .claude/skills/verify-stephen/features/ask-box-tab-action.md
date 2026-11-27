# Feature: typed Ask box to a tab action

Cris types "open YouTube" in the Ask box and presses Return. A tab opens on YouTube, and the reply shows in the box.

## The path

1. The Ask box (`helper/AskBox.swift`) calls `sendChat` in `helper/AppClient.swift`, which sends `chat.send` with the
   text on app.sock.
2. `src/app/server.ts` answers `chat.accepted`, then calls `assistant.command(text, { source: 'app' })`.
3. `src/voice/assistant.ts` runs the memory, timer and job routers, then Claude: `claude -p "<text>"` with only
   the Stephen tools allowed (`--allowedTools mcp__stephen`, `--tools ""`).
4. Claude calls a tab tool (`open_url`, `tab_open`, `navigate`), which drives Chrome over CDP or Zen over WebDriver
   BiDi.
5. The server pushes `chat.done` with the reply and the tool names. The Ask box shows it.

## What proves it works

No machine check covers all five steps at once: step 4 needs the real model. So the proof has three parts, and
each part covers a different step. All three must pass.

| Part | Proves | Where |
| --- | --- | --- |
| A. `selftest` with fakes | step 4: tab actions work in both browsers, and the safety refusals hold | any machine |
| B. Ask path tests and a dry run | steps 1, 2, 3 and 5: typed text reaches the command and builds the right Claude call | any machine |
| C. Cris types it, then `mac-checks` | all five, with the real model and browsers | Cris's Mac only |

Parts A and B are what an agent runs. Part C is a `[hands]` step for Cris (`docs/MAC-TEST-PLAN.md` section 13.3).

## Part A: tab actions, through `selftest`

Do the Launch step in `SKILL.md` first, so `$H` holds the throwaway home with a fake Zen.

```bash
STEPHEN_HOME="$H" node dist/cli.js selftest --browser all; echo "exit=$?"
```

Expect:

- a block for Chrome (CDP) and a block for Zen (WebDriver BiDi), each with rows 1 to 16, every row `PASS`;
- row 1 `connect & open tab` with "agent profile, tab c2" (Chrome) and "tab z2" (Zen): a tab was opened;
- row 2 `navigate to fixture page` with a `http://127.0.0.1:<port>/form` URL;
- row 10 `"Send" refused, nothing submitted` with "server got 0 submissions";
- row 16 ending in "temp profile deleted";
- the last line starts with `Result: PASS` and ends with `chrome 16/16 passed · zen 16/16 passed`;
- `exit=0`.

A FAIL row prints a `fix:` line under it. Follow that line. For row 1 it says to run `stephen doctor`.

The same run is pinned in CI by `test/selftest/selftest.int.test.ts` (both browsers, and a Zen that never starts).

## Part B: typed text reaches the command

Run the Ask path tests and the selftest test together (one suite):

```bash
npx vitest run test/app/server.test.ts test/app/listen.int.test.ts test/selftest/selftest.int.test.ts
```

Expect `Test Files  3 passed (3)` and no failed or skipped tests. The cases that matter here:

- `test/app/server.test.ts`, the chat cases: `chat.accepted` comes first, then `chat.done` with the reply and the tool names;
  text over 2000 characters is refused and nothing runs; a second command while one runs gets "busy".
- `test/app/listen.int.test.ts`, "hello, typed chat, memory and settings work while listening": a real
  `stephen listen --dry-run` serves app.sock, `chat.send "open youtube"` gets `chat.accepted` and then `chat.done`
  with "Dry run: Claude was not started.".

`listen.int.test.ts` skips when the voice test model cannot be downloaded (CI caches it in
`~/.cache/stephen-voice-test`). A skip there means Part B is not proven.

Then look at the Claude call a typed command builds:

```bash
STEPHEN_HOME="$H" node dist/cli.js listen --text "open youtube" --dry-run --no-speak --no-chimes --no-helper
```

Expect, in this order:

- `Heard: "open youtube"`;
- `claude argv (dry run): [...]` that contains `"-p","open youtube"`, `"--tools",""`, `"--allowedTools","mcp__stephen"`
  and `"--permission-mode","dontAsk"`;
- `Stephen: Dry run: Claude was not started.`

`listen --text` is the `cli` source, not the Ask box's `app` source. Both are trusted and build the same Claude call;
the `app` source itself is what the `listen.int.test.ts` case covers.

Do the Cleanup step in `SKILL.md` when Parts A and B are done.

## Part C: on Cris's Mac (hands)

Build from `qa` and start Stephen (`docs/MAC-TEST-PLAN.md` section 0). Then:

1. Cris opens the Ask box, types "open YouTube" and presses Return.
2. See: a tab opens on YouTube, and the reply shows in the Ask box.
3. Right after the reply (the next command resets the tool log), run:

```bash
node dist/cli.js mac-checks
```

Expect `13.3a` to `13.3f` all `PASS`: one command id joins the tool log, the latency log, the history and the audit
log, and the command id file is private. The last line says `0 failed`. Exit code 0.

A `SKIP` means no command was logged yet: give the command again, then rerun `mac-checks`. Report only the check ids
and PASS or FAIL. Never paste the history or the audit log.

## What this does not prove

- That the model picks a tab tool for a given sentence. `stephen eval` scores that with a dry run of the tools.
- The Ask box look, focus and keys (Esc, ⌘K). Those are `[hands]` steps in `docs/MAC-TEST-PLAN.md` sections 11.5,
  12.1 and 14.7.
- Allow and Deny on a gated action. Those are clicks only, by Cris.
