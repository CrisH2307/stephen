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
- **New chat workflow** (updated 2026-11-01):
  1. Get the code from the Mac (the desktop app links the chat; grant `~/Documents/SoftwareProject/brower-hub`):
     in device_bash `tar --exclude=node_modules --exclude=dist --exclude=.git -czf ../stephen-base.tgz browser-hub`
     from the `brower-hub` folder → device_stage_files → untar in the cloud workspace, `git init` + commit as a base.
  2. Build and test in the **cloud workspace** (Linux): `npm ci && npm run build && npx vitest run` (~8 min; real
     Chromium, sherpa-onnx models download on first run). **~2473 passed, 11 skipped**, all green.
  3. The real `claude` CLI works in the cloud workspace, so `node dist/cli.js eval [--only x] --model sonnet --jobs 4`
     runs the real one-shot eval there (cloud plan; dry-run tools). Last full run: 46/46.
  4. Sync back: **first** check the Mac has no owner edits (compare its files with your base snapshot, e.g.
     `rsync -rcn` against the untarred base, or `git status`/`git log` on the Mac; merge any edits). Then tar the
     changed files → device_commit_files to `brower-hub/stephen-<name>.tgz` → in device_bash
     `tar --overwrite -xzf ../stephen-<name>.tgz` (or `rsync -rc --inplace`) inside the repo. Plain `tar -x` fails:
     deleting files on the Mac is disabled, and tar unlinks before writing. Verify with `cmp` / `git diff --stat`.
  5. **Never** run `npm install` in the device shell (it's a Linux VM; it would put Linux binaries in the Mac's
     node_modules). The owner runs `npm install && npm run build` in VS Code's terminal. Swift can't be compiled in
     the cloud: the owner runs `node dist/cli.js install-helper` (a rebuild drops Input Monitoring; re-enable it).
  6. Parallel work: git worktrees in the cloud copy (symlink node_modules; add it to `.git/info/exclude`), one
     subagent per worktree, the lead merges and runs the full suite. The owner's Jev router lives on the Mac at
     `~/.config/jev` (`cd "$HOME/mnt/jev" && JEV_DIR="$PWD" python3 jev_router.py route --test "<task>"`) and sizes a
     task to haiku / sonnet / opus / fable; the owner wants it used to pick subagent models.
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
Independent security review #5 of phase 1.9 (docs/PLAN-1.9-MEMORY-DASHBOARD.md), then `docs/ROADMAP.md` → phase 2a "read my stuff" (Gmail, Canvas, Notion, Calendar, Maps), read-only first.
