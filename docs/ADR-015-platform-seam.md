# ADR-015: Platform seam for Windows later: one module per OS concern now, interfaces only when Windows starts

**Status:** Proposed 2026-11-25. Step 1 can start now; step 2 waits for Cris's go after the public release.
**Deciders:** Cris (owner), dev lane.
**Sources:** `docs/NFR-STEPHEN.md` section 10, the calls found in `src/` on 2026-11-25 (listed below),
`docs/ARCHITECTURE-PLAN.md` section 8.

## Context

- Stephen is macOS only. Windows comes later, "without a rewrite of the core" (NFR section 10).
- macOS calls found today: `osascript` in `src/safety/confirm.ts`, `src/timers/notify.ts`, `src/desktop/sound.ts`,
  `src/desktop/system.ts`, `src/drivers/macos.ts`, `src/zen-launcher.ts`; `security` in `src/lib/keychain.ts` and
  `src/connect/keychain-write.ts`; `say` and `afplay` in `src/voice/speech.ts` and `src/voice/tts/`; `/usr/bin/open`
  in `src/desktop/system.ts`, `src/zen-launcher.ts`, `src/app/cli.ts`; `caffeinate` in `src/jobs/runner.ts`; the
  Swift helper for keys, the Ask box and the menu bar.
- Many places already check `process.platform === 'darwin'` and do nothing elsewhere.

## Options

| Option | Good | Bad |
|---|---|---|
| A. Build `src/platform/` interfaces now, macOS implementation only | Ready for Windows | Interfaces with one implementation; guesses about Windows that may be wrong; work now for nothing now |
| B. Do nothing until Windows | No work | macOS calls spread further; the Windows work grows |
| C. Step 1 now: keep every macOS call in the files listed above, enforced by a test. Step 2 later: interfaces when the Windows work starts | Cheap now; the seam is known and cannot grow | The interfaces are designed later |

## Decision

Option C.
- **Step 1 (now, task W0):** `test/platform-calls.test.ts` scans the program names passed to `execFile` and `spawn` in
  `src/` (not comments or messages) and fails when a file outside the allow-list calls `osascript`, `security`, `say`, `afplay`, `/usr/bin/open` or `caffeinate`. Moving a call is a normal PR.
- **Step 2 (later, task W1):** one interface per concern (key listener, secret store, speaker, app launcher, dialogs
  and notifications, file permissions and sockets, keep awake), each with a macOS and a Windows implementation,
  chosen once at start. The secret store, dialogs and file permissions are safety paths: `[DEV REVIEW]`.
- **Stays macOS only:** the Swift helper, notarization, the Seatbelt job sandbox, AppleScript media control.
- **Jobs on Windows:** off. They already refuse to start without a sandbox.
- **Already portable:** the gate, routers, memory, history, the CDP and BiDi drivers, sherpa-onnx speech to text
  (it ships `win-x64`), the account tools.

## Consequences

- Good: almost no work now, and the seam cannot grow by accident.
- Cost: the Windows design is still to do; a Windows tray app (the helper's job) is the largest piece.
- Risk: a new macOS call hides in a form the test does not see (for example a binary name built from parts). The
  test also checks `process.platform` uses; the review lane watches new `execFile` sites.

## How we would know it fails

- The test fails on any PR that adds a macOS call outside the list.
- When step 2 starts, the list in this ADR is the complete work list; anything missing from it is a bug in step 1.
