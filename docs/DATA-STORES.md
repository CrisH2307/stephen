# What Stephen keeps on the Mac

Every place Stephen keeps data, how long, and how to delete it. `<home>` is `~/.stephen` unless config says
otherwise. Folders are 0700 and files 0600. Most files are written through `src/lib/fs.ts`; `audit.log`
(`src/safety/audit.ts`) and `memory.json.lock` (`src/memory/store.ts`) open their own files, also 0600. Nothing here is
sent to us.

| What | Where | Kept for (source) | How to delete | Can hold your words |
|---|---|---|---|---|
| Memory | `<home>/memory.json` | Until you forget it; at most `MAX_MEMORY_ITEMS` = 30 (`src/memory/store.ts`) | "Forget ..." by voice, the Memory page, or `stephen memory` | Yes, what you asked it to remember (secret-looking text is refused) |
| Memory suggestions | `<home>/memory-proposals.json` | Until Keep or Skip; at most `MAX_PROPOSALS` = 20, oldest dropped (`src/memory/proposals.ts`) | Skip on the Memory page | Yes |
| Timers and reminders | `<home>/timers.json` | Until done or cancelled; at most `MAX_TIMERS` = 20, late ones dropped after `LATE_DROP_MS` = 12 h (`src/timers/store.ts`) | "Cancel the timer", "cancel all timers" | Yes, the reminder text |
| Conversations (history) | `<home>/history/YYYY-MM-DD.jsonl` | `DEFAULT_HISTORY_RETENTION_DAYS` = 7, from 0 (off) to 30 (`src/history/config.ts`) | `stephen history clear`, or `retentionDays: 0` | Yes, what you said and the replies |
| Claude Code transcripts | `<claude config dir>/projects/<voice workdir slug>/` | Deleted when the conversation ends, and on history purge (`src/voice/transcripts.ts`) | `stephen history clear` | Yes, prompts, tool results and replies |
| Follow-up record | `<home>/voice/conversation.json` | Until the conversation ends, like the trust state below (`src/voice/conversation.ts`) | Ends with the conversation | No words, but it holds the Claude session id, which points to the transcript above |
| Conversation trust state | `<home>/voice/conversation-state.json` | Until the conversation ends: when the follow-up window has passed and the next command starts, or on Esc or "Stephen stop". The window check runs in memory, so after a single command the file can stay on disk until the next command or until the listener stops (`src/safety/session-state.ts`, `src/voice/conversation.ts`) | Ends with the conversation | No words: private-read markers and approved hosts |
| F5 recordings and their labels (opt-in) | `<home>/replay/` (labels: `<id>.label.json`, a code and a time only) | `REPLAY_MAX_AGE_MS` = 30 days, at most `REPLAY_MAX_CLIPS` = 100 (`src/replay/recorder.ts`) | Turn off the switch in Settings > Privacy and choose delete, or `stephen replay delete --all` | Yes, audio and words of F5 commands |
| Latency records | `<home>/telemetry/latency-YYYY-MM-DD.jsonl` | `LATENCY_RETENTION_DAYS` = 30 (`src/telemetry/latency.ts`) | Deleted after 30 days, or delete the folder | No: ids, times, code words and numbers (such as `costUsd`) only |
| Incidents | `<home>/incidents/YYYY-MM-DD.jsonl` | `INCIDENT_RETENTION_DAYS` = 30 (`src/telemetry/incidents.ts`) | Deleted after 30 days, or delete the folder. Sent only by `stephen report` after you type y | No: ids, times, versions, code words and numbers only |
| Safety audit log | `<home>/audit.log`, `.1` to `.3` | Rotates at `DEFAULT_MAX_BYTES` = 5 MB, keeps `DEFAULT_KEEP` = 3 (`src/safety/audit.ts`) | Delete the files | Yes, partly: the intent of each action (one short sentence, up to `AUDIT_INTENT_MAX` = 200 characters, web addresses cut to the site and path, with the part after `?` or `#` removed). Typed text and code show as a length only |
| Tool log | `<home>/voice/tool-log.jsonl` | Emptied before each model run (`resetToolLog`, `src/server/tool-log.ts`) | Delete the file | No: tool names, an error flag, times and the command id only, never arguments or results |
| Job state and logs | `<home>/jobs/<id>.json` and `<home>/jobs/<id>/` | `keepDays` = 30 after the job ends (`src/jobs/config.ts`, `purgeJobs` in `src/jobs/state.ts`) | Deleted after `keepDays` | Yes, the task text |
| Announced jobs | `<home>/jobs/.announced.json` | Kept; the list of job ids already spoken (`src/jobs/finish.ts`) | Delete the file | No: job ids only |
| Job output folders | `~/Stephen Jobs/<id>/` (`jobs.root`) | Kept until you delete them (`src/jobs/state.ts`: "The job folders stay") | Delete the folder in Finder | Yes, what the job wrote |
| Helper log | `<home>/logs/helper.log`, `.1` | Moved to `.1` when over 1 MB at helper start (`helper/main.swift`) | Delete the files | No words expected: helper status and error lines |
| Listener log and pid | `<home>/logs/listen.log`, `.1` and `<home>/run/listen.pid` | The log moves to `.1` when over 2 MB at start; the pid file is removed when the listener exits (`helper/StephenControl.swift`) | Delete the files | Possibly: the listener's own output lines |
| Settings | `<home>/config.json` | Kept | Edit or delete the file | Account ids and settings, no passwords |
| Account secrets | macOS Keychain (services `stephen-<name>`, for example `stephen-canvas`, `stephen-canvas-url`, `stephen-notion`, `stephen-calendar-ics`, `stephen-google-oauth`, `stephen-elevenlabs`, and one per Gmail account) | Kept until removed | Gmail: `stephen disconnect gmail <label>`. ElevenLabs: `stephen voice-key delete`. Canvas, Notion, the calendar address and the Google sign-in client: no command yet (task R10); remove them in Keychain Access | Tokens and keys, never shown to the model |
| Account secrets in a `.env` file (older setups) | `.env` in the Stephen folder, next to `package.json` (`src/accounts/secrets.ts`) | Kept until you delete it | Delete the lines or the file | Tokens and keys, never shown to the model |

# Everything that leaves the Mac

Only these leave the Mac. Nothing is sent to us (Cris) unless the person sends a report. Source: docs/ARCHITECTURE-PLAN.md
section 7.2, checked against the code on 2026-11-25.

| Goes to | What | When | Code |
|---|---|---|---|
| Anthropic, under the person's own Claude account | The command text, the persona with the memory block, and every tool result the model reads (page text, email text, Canvas, calendar, Notion) | Every model run: typed, F5 or wake word | `src/voice/claude.ts`, `src/voice/warm-claude.ts` |
| Anthropic, background jobs | The job's task text and what the job reads and writes in its folder | Each job run, after the person clicks Start | `src/jobs/runner.ts` |
| Anthropic, phone link | The phone conversation, through Claude Code's remote control | Only while `stephen phone on` is on | `src/phone/cli.ts` |
| Google (Gmail, Calendar), Canvas, Notion | Read requests with the person's own token or secret calendar address | When a tool reads that account | `src/accounts/` |
| ElevenLabs (only if the person set a key and chose that voice) | The reply text to be spoken | Every spoken reply | `src/voice/tts/elevenlabs.ts` |
| Open-Meteo | The configured place's latitude and longitude (Toronto by default) | "What's the weather", the morning briefing | `src/accounts/weather.ts` |
| YouTube | The search words when the person asks Stephen to play something (Stephen reads the search page itself) | "Play ..." | `src/desktop/media.ts`, `src/desktop/play.ts` |
| GitHub | The person's IP address: speech model download, `stephen update` (git pull). An incident report only after the person types "y" | First run; each update; on "y" | `src/voice/models.ts`, `src/update.ts`, `src/telemetry/report.ts` |
| The npm registry | The person's IP address and the package names Stephen needs | `stephen setup` and each `stephen update` (npm install) | `src/update.ts` |
| Websites | Whatever the person asks Stephen to open; a job with "with web" also searches and reads the web | On request | Browser tools, `src/jobs/spec.ts` |
| Us (Cris) | Nothing, unless the person sends a report | | |
