---
name: verify-stephen
description: Prove that a Stephen change works, the same way every time. Launch with fakes, check the setup, drive the feature, keep the evidence, clean up. Use it before you report a PR as ready, or when asked "does it still work?". Each feature has its own file in features/.
---

# verify-stephen

One standard way to prove a change works. Tests say the code does what the test says. This skill says the
feature works for a person, as far as a machine can tell without Cris's hands.

Every command below exists in the repo today. If one stops working, fix this file in the same PR.

## Ground rules

- Use a throwaway `STEPHEN_HOME`. Never point a command at Cris's real home, config or browser profiles.
- `selftest` always runs agent mode in a temporary profile and only opens pages it serves on 127.0.0.1. Do not
  change that to make a check pass.
- One test suite per machine. `test/global-setup.ts` holds a lock while vitest runs. Before you start, check that
  no suite is running: `pgrep -fl vitest` prints nothing.
- A SKIP is not a PASS. A flaky failure is a failure: find the cause, do not rerun until green.
- Evidence goes into a public repo. No tokens, no real mail, tabs, names or home paths (see Evidence).

## Launch

Build once in your worktree (never `npm install`; link `node_modules` from the main checkout):

```bash
npm run build
```

Make a throwaway home with a fake Zen, the same fakes Linux CI uses (`test/helpers/fake-zen.ts`,
`test/selftest/selftest.int.test.ts`). The fake Zen starts Chromium and prints Gecko's
"WebDriver BiDi listening on ws://..." line, so the real Zen launch and connect path runs.

On macOS the browser is the installed Google Chrome, headless. On Linux use the Chromium from `@sparticuz/chromium`
(`test/helpers/chromium.ts`) and its flags instead.

```bash
H=$(mktemp -d "${TMPDIR:-/tmp}/verify-stephen-XXXXXX")
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ZEN=$(node --input-type=module -e "import { writeFakeZen } from './test/helpers/fake-zen.ts'; console.log(await writeFakeZen(process.argv[1], process.argv[2]))" "$H" "$CHROME")
node -e "require('fs').writeFileSync(process.argv[1]+'/config.json', JSON.stringify({chrome:{executablePath:process.argv[2],extraArgs:['--headless']},zen:{executablePath:process.argv[3],extraArgs:['--headless']}}))" "$H" "$CHROME" "$ZEN"
```

The `node -e` import of a `.ts` file needs Node 22.18 or newer (type stripping is on by default there).

## Doctor

`node dist/cli.js doctor` checks the real Mac setup: Node, config, Chrome and Zen, the helper, Claude Code, the
voice key. It is read only. Run it on Cris's Mac before a `[hands]` step, and when `selftest` check 1 fails (its
hint says to).

With the fakes above, skip doctor: it looks at the real browsers and the Keychain whatever `STEPHEN_HOME` says.
Its output names real paths and a key suffix, so never paste it into a PR or issue. Report only "doctor: no red
lines" or the names of the red lines.

## Drive

Open the feature file for what you changed and run its commands in order. Each file says what proves the feature,
the exact commands, and what output to expect.

| Feature | File |
| --- | --- |
| Typed Ask box to a tab action | [features/ask-box-tab-action.md](features/ask-box-tab-action.md) |

No file for your feature yet? Add one in the same shape (What proves it, Commands, Expected output, What this does
not prove) in its own small PR.

## Evidence

Paste into the PR body, under a heading "Verified with verify-stephen":

- the feature file name and the commit sha you ran it on,
- each command, its exit code, and its summary lines (for `selftest`: the `Result:` line and any FAIL row with its
  `fix:` line; for vitest: the `Test Files` and `Tests` lines),
- the machine: `darwin` or `linux`, and the Node version from the first `selftest` line.

Before you paste, replace your temp folder with `$TMPDIR` and any path under your home with `~`. Never paste
`doctor`, `history`, the audit log, the tool log or a screenshot of a real page.

## Cleanup

`selftest` deletes its own temporary profile and quits the browser it started (check 16 says "temp profile
deleted"). Then check nothing from your run is left running, and remove the throwaway home:

```bash
pgrep -fl "$H/" || echo "nothing left running"
rm -rf "$H"
```

If `pgrep` lists a process, it is a browser from your run: quit it with `kill <pid>`. Never kill a process you did
not start.
