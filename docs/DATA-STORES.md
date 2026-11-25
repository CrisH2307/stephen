# What Stephen keeps on the Mac

Every place Stephen keeps data, how long, and how to delete it. `<home>` is `~/.stephen` unless config says
otherwise. Folders are 0700 and files 0600 (written through `src/lib/fs.ts`). Nothing here is sent to us.

---

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
| GitHub | The person's IP address: speech model download, `stephen update` (git pull). An incident report only after the person types "y" | First run; each update; on "y" | `src/voice/models.ts`, `src/update.ts`, `src/telemetry/report.ts` |
| Websites | Whatever the person asks Stephen to open; a job with "with web" also searches and reads the web | On request | Browser tools, `src/jobs/spec.ts` |
| Us (Cris) | Nothing, unless the person sends a report | | |
