# ADR-012: In-app updates with Sparkle 2, two channels, two signatures, one-step rollback

**Status:** Proposed 2026-11-25. Sparkle is a new dependency, so it needs Cris's decision D4 in
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
| A. Sparkle 2 (MIT, the usual updater for Mac apps outside the App Store) | EdDSA signatures, Team ID check, channels, replaces a running app, years of use and audits | A new framework in the helper; built with `swiftc` today, so it must be linked by hand |
| B. Our own updater (Node's built-in Ed25519, GitHub Releases, `ditto` swap) | No new dependency | New security code to write, review and keep correct; app replacement edge cases |
| C. No in-app update; friends download each DMG | Nothing to build | Friends stay on old, maybe unsafe, versions |
| D. Homebrew `brew upgrade` | Free | Friends do not use Homebrew |

## Decision

Option A, with these rules:
1. **Appcast** on GitHub Pages, one item per release, each marked stable or beta (Sparkle channels). The app checks
   once a day and from the menu. "Get beta updates" is a Settings switch, off by default.
2. **Two checks before install:** the zip's EdDSA signature against the public key inside the running app, and the
   new app's code signature from the same Developer ID Team. Both must pass.
3. **Before install** the helper stops the listener the normal way (SIGINT, then the existing escalation). Running
   jobs are detached and keep running; the new listener finds them through their state files, as after a restart.
4. **Rollback:** before install the helper copies the current app to
   `~/Library/Application Support/Stephen/previous/Stephen.app`. "Go back to the previous version" and
   `stephen rollback` swap the two. Same Team ID, so permissions stay. Only one previous copy is kept.
5. **Data rule (N minus 1):** a release may add fields, never change their meaning, and the release before it must
   read every file it writes. A fixtures test guards it (task B10).
6. **A bad release** is removed from the appcast at once and fixed forward. Sparkle never installs an older version by
   itself; going back is the rollback above.
7. The EdDSA private key lives only in the `release` environment and in Cris's offline backup (ADR-013).

## Consequences

- Good: one click to update, one to go back, permissions kept, and the verification is code many apps rely on.
- Cost: one framework (about 3 MB) in the app, and linking it in `scripts/build-app.mjs`.
- Risk: losing the EdDSA key stops updates; every friend would download the app again by hand. Hence the backup.
- Risk: Sparkle's relaunch while a command runs. Experiment E4 checks it before the beta.
- Developer installs (git) keep `stephen update` from the setup work in flight.

## How we would know it fails

- A test zip signed with a wrong EdDSA key, and a build signed by another team, must both be refused (task F7).
- After a real update: `mac-checks` and the helper doctor line show the permissions still granted.
- The version in incident and latency records shows who runs what; a friend stuck on an old version shows up there.
