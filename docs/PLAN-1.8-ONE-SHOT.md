# Phase 1.8 — "one shot": Stephen gets the whole request the first time (plan, 2026-10-31)

Owner goal: say the whole thing once ("Hey Stephen, open my Notion to-dos and put on some lofi") and Stephen does
all of it, without cutting you off and without asking back unless it really has to. Follow-ups stay as they are
(they work). Memory + a chat dashboard come later (bottom of this file).

## Status
- 2026-10-31: owner answers — mostly Fn+Option (both used); best guess preferred over asking; fix small things
  first, then build new. Example asks: "routes from my home to two stations" (Stephen didn't know the home address
  and asked back); "check my Canvas assignments and materials, recommend what to do, write a summary in a Google
  Doc and message my friend on Discord" (needs phase 2a read + 2b careful writes — not one-shot-fixable yet).
- **Done (step 1):** tracks A and B, plus `voice.aboutMe` and `open_url new_tab` (routes). See HANDOVER.md.
- **Done (step 2):** track D (`stephen eval`, dry-run server, 39 cases) and track C (`volume`, `media_control`).
- **Eval round 1:** 37/39 on the Mac; both misses were can't-yet cases (slow browsing). Fixed → 40/40 (HANDOVER 21:45, 23:30).
- **Next:** 1.9 built (HANDOVER 13:30) → owner compiles the helper + tries memory and the app → security review #5 → phase 2a.

## Why one-shot fails today (found in the code)

| # | Where | What happens |
|---|---|---|
| 1 | `voice.silenceSec` = 0.8 s (listener, wake-word path) | A normal pause mid-sentence ("open Notion… and then play lofi") ends the command. Claude only gets the first half. |
| 2 | `voice.maxCommandSec` = 12 s | Longer requests are cut at 12 s. (Push-to-talk is fine: up to 30 s, ends on release.) |
| 3 | Persona: "Do exactly what was asked and nothing more", "If you really can't tell, say you didn't catch it" | Nothing tells Claude a request can have several steps, so it may do step 1 and stop, or ask back instead of making a safe best guess. |
| 4 | Persona: "Reply in ONE short spoken sentence" | A 3-part request gets a reply about one part; you can't tell if the rest happened. |
| 5 | `voice.maxTurns` = 15 | Enough for 1–2 steps; a 3–4 step request with an announce per step can run out. |
| 6 | Tool gaps | Some one-shot requests fail because there's no tool for them (e.g. pause/next track, volume). Claude then asks back or gives up. |
| 7 | No measurement | We can't tell whether a change made one-shot better or worse. |

## Plan — 4 tracks (parallel worktrees, then one review)

### A. Hear the whole command — `feat/endpoint` (`src/voice/listener.ts`, `config.ts`, tests)
- **Adaptive end-of-speech:** short commands still end fast (0.8 s), but once you've talked > ~2.5 s the pause
  needed grows to ~1.4 s (multi-part sentences have thinking pauses). New `voice.longSilenceSec`.
- **"Not finished yet" check:** if the transcript ends in a joining word ("and", "then", "also", "after that",
  "plus", "um", "uh", "with", "to"), Stephen doesn't send it: a short "still listening" chime, up to 5 s more,
  and the two parts are joined. One continuation max.
- `maxCommandSec` 12 → 25 (whisper's window is 30 s).
- Print what was heard (already) and, for long commands, a one-line "Heard: … (2 parts)".

### B. Understand it all at once — `feat/oneshot-persona` (`src/voice/claude.ts`, tests)
Persona changes:
- "The request may contain several steps. Split it, then do **every** step in order in this one run."
- **Best guess over asking:** when something is unclear but a wrong guess is cheap and reversible (which song,
  which tab, which site), pick the most likely meaning, do it, and say what you picked ("put on Lofi Girl — say
  'something else' if not"). Ask back only when a wrong guess is costly (sending, deleting, buying, anything with
  a confirmation) or there's no reasonable guess. Safety refusals: unchanged.
- **Reply covers every part:** one or two short sentences; anything that failed is named ("Notion's open, but
  YouTube didn't load").
- Only one sound-playing step per request gets an announce (the first).
- `voice.maxTurns` default 15 → 25.

### C. Fill tool gaps — `feat/media-keys` (`src/desktop/**`) — after you send real examples
Candidate small, safe desktop tools (no clicking, no screen reading):
- `media_control {play | pause | next | previous}` — system media keys (via the helper).
- `volume {set N | up | down | mute}`.
- Maps search/directions via `open_url` (already planned in 2a; cheap to do now).
Final list depends on the commands you actually say (see questions).

### D. Measure it — `feat/eval` (`src/eval/**`, `stephen eval`)
- A set of ~40 realistic one-shot commands: single, multi-step ("open X and play Y"), misheard names, vague
  ("play something chill"), and ones that *should* ask back (e.g. "email him").
- `stephen eval` runs each through the real `claude -p` + a **dry-run** Stephen server (`serve --dry-run`: tools
  are recorded and return plausible fake results — nothing opens or plays on your Mac).
- Scores each: right tools in the right order? asked back when it shouldn't (or didn't when it should)? turns,
  time. Prints a table and saves `~/.stephen/eval/<date>.json`, so every later change can be compared.
- Runs on your Mac (needs your Claude login); the scorer and dry-run server are unit-tested in the cloud.

Order: D first (baseline numbers) → A + B in parallel → re-run D → C → independent review → sync to the Mac.

## After 1.8: memory + chat dashboard (design only for now)

**Memory (designed: docs/PLAN-1.9-MEMORY-DASHBOARD.md):**
1. *History:* every command (what you said, reply, tools used, time) saved locally in `~/.stephen/history/`
   (0600, auto-deleted after N days, `stephen history clear`).
2. *Facts about you:* "Stephen, remember my prof is Dr. X" → saved to `~/.stephen/memory.json`, shown to Claude in
   every run. **Only from your own spoken words via an explicit "remember"**, never from web pages or emails
   (otherwise a malicious email could plant a permanent instruction). You can list/forget items.

**Dashboard (`stephen dashboard`):** a local web page (127.0.0.1 only, random login token) with chat history,
a text box to type to Stephen, the memory list (edit/forget), settings, and the audit log. Chat there = the same
assistant and the same safety gate as voice.

Then phase 2a "read my stuff" (Gmail, Canvas, Notion, Calendar) as in ROADMAP.md.
