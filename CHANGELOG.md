# Changelog

What changed in each release, in plain words for the people who use Stephen. The release PR adds the section
(`docs/RELEASE-PLAN.md`), and `node scripts/release-notes.mjs <version>` turns it into the release notes.

Format: one `## <version> (YYYY-MM-DD)` section per release, newest first, with `### Added`, `### Changed`,
`### Fixed`, `### Removed` or `### Security` lists. One short sentence per bullet, about what a person notices.

## Unreleased

## 0.1.1 (2026-11-26)

### Added
- `stephen setup` sets up Stephen on a new Mac with one command.
- `stephen update` updates Stephen with one command and says when to click Input Monitoring again.
- First-run setup in the window walks you through Claude Code, the voice models and the Mac permissions.
- Stephen can start on its own when you log in.
- A Stop button in the Ask box, on Home and in the menu bar stops what Stephen is doing, running jobs included.
- The Activity page shows what Stephen did in the last 24 hours.
- A daily cost limit warns you at 80% and stops new model runs at 100%.
- `stephen report` files a crash report with no private content, also from the menu when gh is missing.
- `stephen report --week` gives a weekly summary with no content.
- `stephen data` lists everything Stephen keeps, and `stephen data delete --all` removes all of it.
- You can export your Stephen data and import it again.
- Stephen asks for your weather city the first time it needs one.
- The Paper theme gives the Ask box the website's look.
- You can label voice clips and see an accuracy number.

### Changed
- When something fails, Stephen now says one plain sentence instead of raw error text, on every page, in the menu bar and in jobs.
- When Claude fails, Stephen says the plain reason, such as signed out or plan limit.
- The Conversations, Memory and Jobs pages show loading, an error with Try again, and empty only after a good read.
- Settings use the Mac's own controls, and each page has one sentence under its title.
- An unknown setting in the config file is now a doctor warning instead of stopping Stephen.
- A Canvas school is no longer set for you by default.

### Fixed
- A question is never saved as a memory, even without a question mark.
- An overdue job still stops its own Claude run.
- Chips in the window have clean edges.

### Security
- After Stephen reads something private, a wake word reply is shown instead of spoken, and announce says nothing.
- Every private read gets one audit line.
- Text from web pages, emails and jobs is kept inside its untrusted wrapper, including lookalike closing tags.
- Activity and chat steps hide private site labels and details.
- No new job starts once today's cost limit is used.
- The helper's socket uses a new secret for each launch.
- Zen no longer opens a port on a shared Mac.

### Removed
- Unused code that could add a memory from the menu bar.

