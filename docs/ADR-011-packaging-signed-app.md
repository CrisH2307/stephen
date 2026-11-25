# ADR-011: Ship Stephen as one signed and notarized app with Node inside

**Status:** Proposed 2026-11-25. Needs Cris's decision D1 (Apple Developer Program) in `docs/ARCHITECTURE-PLAN.md`.
**Deciders:** Cris (owner), dev lane.
**Sources:** `src/helper/install.ts` (ad hoc signing today), `src/voice/models.ts` (pinned model downloads),
`helper/StephenControl.swift` (`launch.json`), `package.json`, `docs/NFR-STEPHEN.md` sections 7 and 8,
`docs/RELEASE-PLAN.md` section 2.

## Context

- Today a Mac gets Stephen by cloning the repo, `npm install`, building, and `stephen install-helper`, which compiles
  the Swift helper with the Mac's own `swiftc` and signs it ad hoc (`codesign --sign -`).
- A friend would need git, Node and Apple's command line tools (about 2 GB). #248 showed the build can break when
  macOS changes its SDK.
- macOS ties Input Monitoring, Microphone and Automation to the app's signature. An ad hoc signature is the code hash,
  so every helper rebuild asks again.
- The setup target is 15 minutes from zero to the first spoken command (Cris, 2026-11-23).

## Options

| Option | Good | Bad |
|---|---|---|
| A. Git plus `stephen setup` | No cost; already being built | Apple tools needed; 30 to 60 min; permissions reset; breaks with SDK changes |
| B. Homebrew formula from source | Familiar to developers | Same problems as A, plus Homebrew |
| C. Signed, notarized `Stephen.app` with Node, the built code and small models inside, in a DMG | About 10 min setup; permissions kept; no Apple tools; one thing to update | 99 USD a year; a build and signing pipeline to own |
| D. Homebrew cask of C | Easy for developers | Needs Homebrew; friends do not have it |
| E. `.pkg` installer | Can install extra files | Admin password; nothing we need beyond C |
| F. Mac App Store | Trusted store | Impossible: needs the App Sandbox |

## Decision

Option C. One app, `Stephen.app`, bundle id kept stable forever (today `dev.stephen.helper`):
- `Contents/MacOS/Stephen`: the Swift helper, the app's main program.
- `Contents/Resources/node/bin/node`: the official Node 24 binary, pinned by version and sha256, re-signed with our ID.
- `Contents/Resources/app/`: `dist/` and production `node_modules` (`npm ci --omit=dev`).
- `Contents/Resources/models/`: the wake word and VAD models (about 19 MB). The speech to text model downloads on
  first run through the existing sha256-pinned downloader into `~/.stephen/models`.
- Signed with a Developer ID Application certificate, hardened runtime, every Mach-O signed inside out, notarized and
  stapled. Entitlements start from Node's own entitlements file plus `com.apple.security.device.audio-input` and
  `com.apple.security.automation.apple-events`, then shrink to what experiment E2 shows is needed.
- The helper starts the listener from its own bundle. `launch.json` stays only for developer installs.
- Apple Silicon only for the beta (decision D6). Option D (a cask) can follow for developers at almost no cost.

## Consequences

- Good: a friend downloads one DMG, drags one app, and clicks the permission prompts once. Updates keep permissions.
- Good: the Mac no longer compiles anything. The SDK problem (#248) moves to our CI, where we see it first.
- Cost: 99 USD a year, Cris's time for the sign-up, and a release pipeline (ADR-013).
- Risk: the hardened runtime may block parts of V8 or the native add-ons. Experiment E2 settles this before code.
- Risk: the mic permission must be attributed to the app when Node opens the mic. E2 checks it on a fresh account.
- Developers keep the git path (`npm run build`, `install-helper`) for daily work.

## How we would know it fails

- Notarization rejects the upload: the notary log names the file.
- `spctl -a -t exec -vv Stephen.app` does not say "Notarized Developer ID": the release job stops.
- A friend sees a Gatekeeper warning or setup over 15 minutes: E6 with a stopwatch, and beta feedback.
- Permissions asked again after an update: the helper doctor line, and a `permission_lost` incident code.
