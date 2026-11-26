# Release plan: basics, friends beta, public

**Goal (Cris, 2026-11-23):** Stephen goes public. First the basics are solid, then a friends beta, then public.
Safety and privacy come first, then speed, then cost. Targets are in `docs/NFR-STEPHEN.md`.

## Stages

| Stage | What it means | Gate to move on |
|---|---|---|
| 0. Now | Cris and the lanes use `qa` and `main` | The "basics are solid" checklist is green |
| 1. Friends beta | 3 to 5 friends install it themselves | Checklist green again, plus 2 weeks of beta with no High issue |
| 2. Public | Anyone can download it | Public extras done (below) |

## 1. Weekly release (from now on)

- One small release from `qa` to `main` every week, by `docs/RELEASE-CHECKLIST.md`. The review lane prepares it, the
  dev lane says what must not ship, **Cris does about 20 minutes of Mac checks and the merge**.
- A PR that is not green and reviewed on release day waits for next week. No rush merges.
- Version: `0.1.x`, one step per weekly release, in `package.json` and a short `CHANGELOG.md` entry (written by a free
  agent from the PR titles, checked by the review lane).
- Now: `qa` is 12 PRs ahead of `main`. Cut the next release as soon as the open safety PRs are merged or set aside.

## 2. Friends beta: what it needs

| Need | Today | Work |
|---|---|---|
| Signed and notarized app | Unsigned helper built on each Mac; permissions reset when it is rebuilt | Apple Developer ID (Cris's account and money). Sign and notarize the helper in a release job. Permissions then stay across updates |
| One-command install | About 8 commands, Node and Xcode tools needed | `stephen setup`: checks, installs, stops at the first red `doctor` line. Later a downloadable app with Node inside |
| Updates | `git pull` plus 3 steps | `stephen update`, then a "new version" note in the app |
| "First 5 minutes" guide | README is for developers | One page: install, the 3 permissions, the first command, how to stop it, how to delete data (`docs/DATA-STORES.md`) |
| Crash reports without content | Being built (incident phase 1) | Incident file and `stephen report`; later the event workflow with Cris's Auto-fix switch |
| Daily cost limit | Being built | Warn at 80%, stop new model runs at 100% |

## 3. Public: what it needs on top

Developer ID (same as the beta), a small website with the download and the guide, a support address or GitHub
Discussions, a privacy policy (what stays on the Mac, what goes to Claude and the connected accounts, nothing to us),
a security contact (`SECURITY.md`), and a license check of dependencies. Windows comes later, after the platform seam
note (`docs/NFR-STEPHEN.md` section 10).

## 4. Weekly number sheet

Every release PR gets one table, compared with the targets in `docs/NFR-STEPHEN.md`:

| Number | Source | Status today |
|---|---|---|
| Speed: F5 and wake word, p50 and p95 | `stephen latency --days 7` | Measured |
| Accuracy: share of F5 commands done right | Label the week's clips (`stephen replay list`, then `stephen replay label <id> <code>`), then `stephen replay accuracy --days 7` | Labels built (recorder PR 3). Report the ok share, the count of each wrong code and how many are not labelled yet |
| Crashes and errors | Incident file, `stephen report` | Being built |
| Idle CPU and memory | `scripts/measure-idle.sh` (10 minutes) | Script merged, first run due |
| Daily cost | `stephen latency` cost lines | Measured from #302 on |
| Inject eval: pass rate and cost of the run | `node dist/cli.js eval --only inject` on the release commit (release checklist step 4b); cost from the report file | New from R8. Anything below all passed blocks the release |

A free agent fills the sheet from the command output; the review lane checks it.

## 5. "Basics are solid" checklist

Green before the friends beta, and again before public.

**Safety and privacy**
- [ ] No open High finding; every open Medium has an issue and Cris's OK (`docs/research/FINDINGS-LEDGER.md`).
- [ ] Every acting tool goes through the gate, private reads are audited (open: announce, private-read audit).
- [ ] `stephen eval` inject cases pass 100% on the release commit.
- [ ] A new independent review of the whole safety surface after the last big change.
- [ ] Nothing leaves the Mac except the command to Claude and the accounts the person connected. The data list
      (`docs/DATA-STORES.md`) is complete and each store can be deleted.

**Works every day**
- [ ] Inside the speed targets for F5 and the wake word (the wake word is 2x over today).
- [ ] 98% of commands end ok or with a clear spoken reason, over one week.
- [ ] A crash of the listener is noticed and recovered without Cris.
- [ ] Idle use measured and inside the targets.

**A friend can do it alone**
- [ ] Setup in 15 minutes, timed with a real friend.
- [ ] Update in one command, permissions kept.
- [ ] Crash report in one command, safe to post publicly.
- [ ] Daily cost limit on by default.

## Who does what

Plan and safety code: Claude dev lane. Reviews, releases and the number sheet: review lane. Docs drafts, scripts,
tests and mechanical code from a written plan: OpenCode and freellm (`docs/AGENT-LOOP.md`). Cris: the weekly Mac
checks and merge, and the decisions below.

## Decisions for Cris

1. Weekly release day (proposal: Sunday).
2. Friends beta date (proposal: after the checklist is green, not before 3 weekly releases).
3. Apple Developer Program (99 USD a year) for signing and notarizing. Needed for the beta.
4. Money: a domain and simple hosting for the public website (later).
