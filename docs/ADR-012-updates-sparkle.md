# ADR-012: In-app updates with Sparkle 2, two channels, two signatures, one-step rollback

**Status:** Proposed 2026-11-25. Sparkle is a new dependency, so it needs Cris's decision D4 in
**Cris, 2026-11-25:** approved, but it waits for D1 (the Apple Developer Program), later, when there is budget. Until
then the beta is unsigned and installed with `stephen setup`.
`docs/ARCHITECTURE-PLAN.md`. Depends on ADR-011.
**Deciders:** Cris (owner), dev lane.
**Sources:** `docs/NFR-STEPHEN.md` section 8 (update target), `docs/RELEASE-CHECKLIST.md` ("Going back"),
`helper/StephenControl.swift` (Stop), parsers that drop unknown fields (`parseLatencyRecord`, `parseIncidentRecord`).

## Context

- Target: a friend sees "update ready", updates with one click, keeps permissions, and can go back with one click.
- Today: `git pull`, `npm install`, build, `install-helper`, and maybe the Input Monitoring steps again.
- An updater is a trust boundary: whoever can push an update can run code on every friend's Mac.

## Options

| Option | Good | Bad |
|---|---|---|
| A. Sparkle 2 (MIT, the usual updater for Mac apps outside the App Store) | EdDSA signatures, signed feeds, code signature checks, channels, replaces a running app, years of use and audits | A new framework in the helper; built with `swiftc` today, so it must be linked by hand |
| B. Our own updater (Node's built-in Ed25519, GitHub Releases, `ditto` swap) | No new dependency | New security code to write, review and keep correct; app replacement edge cases |
| C. No in-app update; friends download each DMG | Nothing to build | Friends stay on old, maybe unsafe, versions |
| D. Homebrew `brew upgrade` | Free | Friends do not use Homebrew |

## Decision

Option A, with these rules:
1. **Appcast** on GitHub Pages, deployed only by the release and promote jobs (ADR-013), one item per release, each
   marked stable or beta (Sparkle channels). The app checks once a day and from the menu. "Get beta updates" is a
   Settings switch, off by default, kept in the helper's `UserDefaults` (not `config.json`).
2. **Checks before install:** the feed itself is EdDSA-signed (`SURequireSignedFeed`), the zip's EdDSA signature
   matches the public key inside the running app, and the new app's code signature is valid
   (`SUVerifyUpdateBeforeExtraction`).
   **Honest limit:** Sparkle allows a release to rotate either the EdDSA key or the code signing identity when the
   other still matches. So the EdDSA key alone may be enough to ship an update. It is guarded exactly like the
   Developer ID key, and experiment E9 tests the "valid EdDSA, other team" case before we claim anything about it.
3. **Before install** the helper stops the listener the normal way (SIGINT, then the existing escalation). Running
   jobs are detached and keep running; the new listener finds them through their state files, as after a restart.
4. **Rollback:** one app serves every account on the Mac, so an update or a rollback changes it for all of them and
   needs an admin password for a non-admin user. The previous version is kept once per Mac. "Go back to the previous
   version" (and `stephen rollback`, which asks the helper) goes through the same installer path as an update, never
   a file swap done by Node. Same Team ID, so permissions stay.
5. **Data rule (N minus 1):** a release may add fields, never change their meaning, and the release before it must
   read every file it writes. Today `config.json` and its sections are strict (`z.strictObject`): an unknown key stops
   Stephen. So a tolerant-reader release (task B11: warn in `doctor`, keep strict types for known keys) ships before
   any release adds a config key. A fixtures test guards the rule (task B10).
6. **A bad release:** first remove it from the appcast, then tell friends to go back (otherwise Sparkle offers it
   again), then fix forward. Sparkle never installs an older version by itself.
7. The EdDSA private key lives only in the `release` environment and in Cris's offline backup (ADR-013). If it leaks,
   rotate it at once with a release signed by our Developer ID.

## Consequences

- Good: one click to update, one to go back, permissions kept, and the verification is code many apps rely on.
- Cost: one framework (about 3 MB) in the app, and linking it in `scripts/build-app.mjs`.
- Risk: losing the EdDSA key stops updates; every friend would download the app again by hand. Hence the backup.
- Risk: Sparkle's relaunch while a command runs. Experiment E4 checks it before the beta.
- Developer installs (git) keep `stephen update` from the setup work in flight.

## How we would know it fails

- A zip with a wrong EdDSA key and a tampered feed must both be refused; the E9 result is written down (task F7).
- After a real update: `mac-checks` and the helper doctor line show the permissions still granted.
- The version in incident and latency records shows who runs what; a friend stuck on an old version shows up there.
