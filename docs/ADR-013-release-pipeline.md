# ADR-013: Release pipeline: build on `main`, sign only after Cris approves, promote beta to stable by hand

**Status:** Proposed 2026-11-25. Adds a workflow, a CI trigger and secrets, so Cris must OK it (AGENTS.md).
Depends on ADR-011 and ADR-012.
**Deciders:** Cris (owner), dev lane, review lane.
**Sources:** `.github/workflows/ci.yml`, `docs/CI-CD-PROPOSAL.md` (sections 4, 5, 9), `docs/RELEASE-CHECKLIST.md`,
`docs/BRANCHING.md`, the repository's rulesets (read 2026-11-25: `qa` active, `production` disabled).

## Context

- Today a release is the PR `qa` to `main`, merged by Cris, then a rebuild on his Mac. Nothing is built for anyone
  else.
- With ADR-011 a release becomes a signed file that runs on friends' Macs. Signing keys must never be reachable from
  a PR, a fork, an issue, or an agent's disk.
- Agents use Cris's GitHub login, so GitHub cannot tell an agent from Cris.
- `main` has no active ruleset today.

## Options

| Option | Good | Bad |
|---|---|---|
| A. Release job on `push` to `main`, signing in a GitHub environment that needs Cris's approval | Keys never on a laptop; every use is in the audit log; one approval click | Keys live at GitHub; an agent with Cris's login could approve |
| B. Sign on Cris's Mac with a local script and the certificate in his login Keychain | Keys never leave his Mac | Agent sessions on the same Mac can use that Keychain too; no audit log; depends on his Mac being on |
| C. Release on a tag push that an agent creates | Flexible | A tag is easier to create by mistake than a merge to a protected `main` |

## Decision

Option A:
1. **Trigger:** `push` to `main` and `workflow_dispatch` on `main`. Never `pull_request`, never `pull_request_target`,
   never `qa`.
2. **Job 1, build and test** (no secrets, `contents: read`): `npm ci`, build, typecheck, the full suite, then
   `scripts/build-app.mjs`. Upload the unsigned app as an artifact. Stop if the version tag already exists.
3. **Job 2, sign and publish** in environment `release` (required reviewer: Cris; deployment branch: `main` only):
   it runs no `npm`, installs no Node, uses no cache (a cache in a release job can be poisoned), and checks out only
   `scripts/sign-app.sh` (sparse checkout) plus the artifact from job 1. Import the certificate into a temporary
   keychain, sign, `notarytool submit --wait`, staple, `spctl` check, build the DMG and the zip, EdDSA-sign the zip,
   create the tag `v<version>`, publish a GitHub Release with SHA256 sums. Delete the temporary keychain in an
   `always()` step. Permissions: `contents: write` (tag and Release) in this job only.
4. **Job 3, appcast:** EdDSA-sign the feed and deploy the Pages site with `actions/deploy-pages` (`pages: write`,
   `id-token: write`, this job only), adding a **beta** item. Nothing else can deploy Pages.
5. **Promote to stable:** a `workflow_dispatch` with the version, in the same environment, after 7 days with no High
   issue. It flips the item's channel and redeploys the signed feed.
6. **One release at a time:** `concurrency: { group: release, cancel-in-progress: false }`, and job 1 refuses a version
   whose tag exists, so two pending runs cannot sign two commits as one version.
7. **Versioning:** `package.json` is the source. `0.1.x` weekly now, `0.2.0` the first friends build, `1.0.0`
   public. `CHANGELOG.md` entry in the release PR.
8. **Protect `main`** first (task B1): a `pull_request` rule (the `qa` ruleset has none today), `linux` and
   `macos` checks required, no force-push, no deletion, no bypass.
9. **Secrets:** Developer ID certificate and password, App Store Connect API key (role Developer), Sparkle EdDSA key.
   All in the `release` environment only. Offline backup with Cris. Actions pinned to full SHAs, as in `ci.yml`.

## Consequences

- Cris's clicks per release: merge the release PR, approve the `release` environment, and a week later promote.
  About 2 minutes a week on top of the Mac checks (decision D7).
- A week without a release for friends: reject the pending run with one click (it would wait up to 30 days).
- Honest limit: an agent using Cris's login could approve the environment. The rule is "agents never approve
  deployments"; the audit log shows who approved. This guards against mistakes, not against an agent acting on purpose.
- macOS runners are free for a public repository; notarization is free with the Developer Program.

## How we would know it fails

- A dry run on a fork or a PR must show job 2 never starting (task F6 acceptance test).
- `spctl` failing stops the release before anything is published.
- The GitHub audit log lists every environment approval; the review lane checks it at each release.
