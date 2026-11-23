# What Stephen keeps on the Mac

Every place Stephen keeps data, how long, and how to delete it. `<home>` is `~/.stephen` unless config says
otherwise. Folders are 0700 and files 0600 (written through `src/lib/fs.ts`). Nothing here is sent to us.

| What | Where | Kept for (source) | How to delete | Can hold your words |
|---|---|---|---|---|
| Memory | `<home>/memory.json` | Until you forget it; at most `MAX_MEMORY_ITEMS` = 30 (`src/memory/store.ts`) | "Forget ..." by voice, the Memory page, or `stephen memory` | Yes, what you asked it to remember (secret-looking text is refused) |
| Memory suggestions | `<home>/memory-proposals.json` | Until Keep or Skip; at most `MAX_PROPOSALS` = 20, oldest dropped (`src/memory/proposals.ts`) | Skip on the Memory page | Yes |
| Timers and reminders | `<home>/timers.json` | Until done or cancelled; at most `MAX_TIMERS` = 20, late ones dropped after `LATE_DROP_MS` = 12 h (`src/timers/store.ts`) | "Cancel the timer", "cancel all timers" | Yes, the reminder text |
| Conversations (history) | `<home>/history/YYYY-MM-DD.jsonl` | `DEFAULT_HISTORY_RETENTION_DAYS` = 7, from 0 (off) to 30 (`src/history/config.ts`) | `stephen history clear`, or `retentionDays: 0` | Yes, what you said and the replies |
| Claude Code transcripts | `<claude config dir>/projects/<voice workdir slug>/` | Deleted when the conversation ends, and on history purge (`src/voice/transcripts.ts`) | `stephen history clear` | Yes, prompts, tool results and replies |
| Conversation trust state | `<home>/voice/conversation-state.json` | Until the conversation ends (`src/safety/session-state.ts`) | Ends with the conversation | No words: private-read markers and approved hosts |
| F5 recordings (opt-in) | `<home>/replay/` | `REPLAY_MAX_AGE_MS` = 30 days, at most `REPLAY_MAX_CLIPS` = 100 (`src/replay/recorder.ts`) | Turn off the switch in Settings > Privacy and choose delete, or `stephen replay delete --all` | Yes, audio and words of F5 commands |
| Latency records | `<home>/telemetry/latency-YYYY-MM-DD.jsonl` | `LATENCY_RETENTION_DAYS` = 30 (`src/telemetry/latency.ts`) | Deleted after 30 days, or delete the folder | No: ids, times and code words only |
| Safety audit log | `<home>/audit.log`, `.1` to `.3` | Rotates at `DEFAULT_MAX_BYTES` = 5 MB, keeps `DEFAULT_KEEP` = 3 (`src/safety/audit.ts`) | Delete the files | Redacted: typed text shows as a length only |
| Job state and logs | `<home>/jobs/<id>.json` and `<home>/jobs/<id>/` | `keepDays` = 30 after the job ends (`src/jobs/config.ts`, `purgeJobs` in `src/jobs/state.ts`) | Deleted after `keepDays` | Yes, the task text |
| Job output folders | `~/Stephen Jobs/<id>/` (`jobs.root`) | Kept until you delete them (`src/jobs/state.ts`: "The job folders stay") | Delete the folder in Finder | Yes, what the job wrote |
| Settings | `<home>/config.json` | Kept | Edit or delete the file | Account ids and settings, no passwords |
| Account secrets | macOS Keychain | Kept until you disconnect | `stephen disconnect <account>` | Tokens and keys, never shown to the model |
