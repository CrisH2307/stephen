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
- An unknown setting in the config file is now a doctor warning instead of stopping Stephen. In the safety, desktop and accounts sections a typo still stops Stephen and names the setting, so a block list is never lost.
- A Canvas school is no longer set for you by default.
- If Claude Code or Zen cannot start, Stephen says one plain sentence and keeps the raw reason in the log.
- `stephen zen-launch` shows one plain line when Zen cannot open, and a shorter message when it works.
- Proxy settings from your shell are no longer passed to Claude. If you need a proxy to reach Claude, tell Cris before you update.
- Spoken and typed messages look the same, with no "From: F5" line.
- When the helper does not build, `stephen setup` says why in one plain sentence.
- When Claude Code stops in the middle of an answer, Stephen says one plain line and keeps the raw error text in the log only. A plan limit says the plan limit line.
- Stephen is tested with Claude Code up to 2.1.332 and knows its new wording for an expired sign-in and for running out of usage credits.
- 0.1.0 has no `stephen update`, so update to 0.1.1 by hand once: `git pull`, `npm install`, `npm run build`, then `node dist/cli.js install-helper`, turn Stephen Helper on again under Input Monitoring, and restart Stephen. After that, `stephen update` does it.

### Fixed
- A question is never saved as a memory, even without a question mark.
- An overdue job still stops its own Claude run.
- Chips in the window have clean edges.
- The audit log never writes the same line twice after a write that stopped halfway.
- Running `stephen update` again after a failed step now finishes the update.
- The Chrome and Zen self tests no longer fail now and then.

### Security
- After Stephen reads something private, a wake word reply is shown instead of spoken, and announce says nothing.
- Every private read gets one audit line.
- Text from web pages, emails and jobs is kept inside its untrusted wrapper, including lookalike closing tags.
- Activity and chat steps hide private site labels and details.
- No new job starts once today's cost limit is used.
- The helper's socket uses a new secret for each launch.
- Zen no longer opens a port on a shared Mac.
- Stephen only uploads files from your Downloads, Desktop or Documents folder, and says so in a plain sentence otherwise.
- Stephen never uploads its own files, your SSH or cloud keys, your Keychains, or files that look like keys or passwords, such as `.env` or `id_rsa`.
- Other programs on your Mac can no longer add a memory through Stephen's app connection.
- A shell setting that sends Claude's traffic to another server is ignored, and doctor names it.

### Removed
- Unused code that could add a memory from the menu bar.

