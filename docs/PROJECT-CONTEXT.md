# Stephen — project context (start here in a new chat)

Add these files to the Claude Project knowledge: `docs/PROJECT-CONTEXT.md` (this), `docs/ROADMAP.md`,
`docs/HANDOVER.md`, `docs/STEPHEN.md`, `docs/VOICE.md`, `docs/DESKTOP.md`, `docs/HELPER.md`, `README.md`.

## What Stephen is
A voice assistant for the owner's Mac (Apple Silicon, macOS, Zen + Chrome, Node via nvm v24). Say "Hey Stephen …"
or hold **Fn+Option**; local wake word + speech-to-text; the command runs through Claude Code headless
(`claude -p`, model sonnet) locked to Stephen's own MCP tools; replies are spoken (ElevenLabs voice). Stephen started
as "browser-hub" (an MCP server driving Zen/Chrome) and kept its safety gate: private-read taint, egress rules,
confirmations as macOS dialogs, secret fields never typed, audit log.

## The owner
Cris — student at Ontario Tech (Canvas), uses Zen daily, Notion for to-dos, Gmail. Prefers short, simple answers;
wants a plan first for big changes, then builds after agreeing; likes parallel worktrees + independent reviews;
wants a handover doc kept current. Casual tone is fine.

## Where the code is and how to work on it
- **Source of truth:** the owner's Mac, `~/Documents/SoftwareProject/brower-hub/browser-hub` (branch `main`),
  pushed by the owner to **github.com/CrisH2307/browser_hub**. The owner commits/pushes; ask before committing.
- **New chat workflow:**
  1. Get the code: clone the GitHub repo into the cloud workspace (attach the repo), or read it from the Mac via
     the desktop app's device tools (ask the owner to link this chat in the Claude desktop app and grant the folder).
  2. Build and test in the **cloud workspace** (Linux): `npm ci && npm run build && npx vitest run` (~4 min; real
     Chromium via @sparticuz/chromium, real sherpa-onnx models download on first run). ~1990 tests, all green.
  3. Sync back to the Mac: `git archive` zip → SendUserFile → device_commit_files to
     `~/Documents/SoftwareProject/brower-hub/stephen.zip` → in device_bash unzip to `$HOME/stageN` and
     `rsync -rc --exclude node_modules --exclude dist --exclude .git` over the repo. **First** check for owner edits
     (`rsync -rcn` against the previous stage, or `git status` on the Mac) and merge them in.
  4. **Never** run `npm install` in the device shell (it's a Linux VM; it would put Linux binaries in the Mac's
     node_modules). The owner runs `npm install && npm run build` in VS Code's terminal.
- **Logs on the Mac:** `~/.browser-hub/` (legacy home still in use): `audit.log` (every action), `state/zen.json`,
  `state/zen-real.log`, `logs/helper.log`. Ask for folder access to read them when debugging.
- The helper app is in the owner's Dock at `~/Applications/Stephen Helper.app`; rebuild with
  `node dist/cli.js install-helper` only when `helper/` Swift files change (rebuild may re-ask Input Monitoring).

## Secrets
ElevenLabs key lives only in macOS Keychain (`stephen voice-key set`, service `stephen-elevenlabs`). Never write
keys into the repo, docs, tests or logs. Future Canvas/Notion/Gmail tokens: same pattern.

## Key commands (owner, in VS Code terminal)
```
npm install && npm run build
node dist/cli.js doctor --network     # health check incl. helper, voice key, models
node dist/cli.js listen               # voice; hold Fn+Option or say "Hey Stephen"
node dist/cli.js listen --text "play one call away"   # no mic
node dist/cli.js install-helper       # rebuild Stephen Helper.app
node dist/cli.js voice-setup          # speech models
```
Open Zen with **"Zen for Stephen"** (Dock) so Stephen can control it.

## Next step
See `docs/ROADMAP.md` → phase 2a "read my stuff" (Gmail, Canvas, Notion, Calendar, Maps), read-only first.
