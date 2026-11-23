# Data Stores

Every place Stephen keeps data on the Mac.

| What | Path | File mode | Retention (constant) | How to delete | Private words |
|------|------|-----------|---------------------|---------------|---------------|
| Memory | `<home>/memory.json` | 0600 atomic | MAX_MEMORY_ITEMS = 30 (src/memory/store.ts) | `forget <text>` voice command or Memory page Keep/Skip | Yes (strict sanitizing, 200 chars, secret text refused via checkMemoryText) |
| Memory proposals | `<home>/memory-proposals.json` | 0600 atomic | MAX_PROPOSALS = 20 (src/memory/proposals.ts) | Press Skip on Memory page (auto-drops oldest) | Yes (same checkMemoryText rules as memory) |
| Timers and reminders | `<home>/timers.json` | 0600 atomic O_NOFOLLOW reads | MAX_TIMERS = 20 LATE_DROP_MS = 12h (src/timers/store.ts) | `cancel the timer`, `cancel all timers`, `cancel the reminder about X` voice commands | Yes (cleanMemoryText, 200 chars max) |
| Command history | `<home>/history/YYYY-MM-DD.jsonl` | Folder 0700 files 0600 O_NOFOLLOW O_APPEND | DEFAULT_HISTORY_RETENTION_DAYS = 7 MAX_HISTORY_RETENTION_DAYS = 30 (src/history/config.ts) | `stephen history` purge or set history.retentionDays = 0 in config | Yes (local log for owner only, never sent to Claude) |
| Replay recordings | `<home>/replay/` | Dir 0700 files 0600 | REPLAY_MAX_AGE_MS = 7d REPLAY_MAX_CLIPS = 50 (src/replay/recorder.ts) | Auto-purge on age or count or manual file deletion | Yes (audio recordings of voice interactions) |
| Telemetry latency | `<home>/telemetry/latency-YYYY-MM-DD.jsonl` | 0600 | LATENCY_RETENTION_DAYS = 7 (src/telemetry/latency.ts) | Auto-purge on age | No (id and timing only, no content) |
| Job states | `<home>/jobs/<id>.json` | 0600 via writePrivateJsonFileSync | Until FINAL_STATUSES = {done, failed, stopped, timeout} (src/jobs/state.ts) | Auto-cleanup on final status or manual file deletion | Yes (job state may contain private data) |
| Safety audit log | `<home>/audit.log` (rotated .1 .2 .3) | 0600 | DEFAULT_MAX_BYTES = 5MB DEFAULT_KEEP = 3 (src/safety/audit.ts) | Auto-rotation or manual file deletion | No (secret keys stripped via SECRET_KEY_RE) |
| Conversation state | Session directory/state.json | 0600 | Session lifetime | Auto-cleanup on session end | Yes (session state) |

Notes
- `<home>` is the Stephen home directory (default `~/.stephen`, configurable).
- All files written through `src/lib/fs.ts` helpers use atomic writes and 0600 mode.
- Directories use 0700 mode.
- The `cleanMemoryText` function (src/memory/store.ts) limits text to 200 characters and refuses secret-looking text.
- History retention 0 = history off (nothing written, existing day files deleted on next purge).
- Memory enabled by default with 30 item cap (src/memory/config.ts).
- Timers use fixed grammar before Claude (src/timers/intent.ts).
- Memory proposals never sent to Claude (src/memory/proposals.ts).