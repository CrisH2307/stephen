# Stephen: positioning (draft)

Draft for Cris. Nothing here is published. Every claim points to a repo file. If the code changes, change the claim.

## Who it is for

1. **Now: Cris and a few friends.** Mac students who already use Claude Code and want to talk to their Mac and
   browser. (`docs/RELEASE-PLAN.md`: friends beta is 3 to 5 friends.)
2. **Later: anyone on a Mac.** Public comes after the friends beta and the "basics are solid" checklist
   (`docs/RELEASE-PLAN.md`).

Today a user needs: macOS 14 or newer, Node, Claude Code signed in, and Zen or Chrome (`README.md`, Requirements).
Each person uses their own Claude account (`docs/NFR-STEPHEN.md`, section 6). So Stephen is for people who are fine
with a Terminal for setup. It is not yet for everyone.

## The one-line pitch

**Stephen is a voice assistant for your Mac and browser. It asks before anything risky.**

Shorter: "Hey Stephen, open YouTube."

Backup lines:
- "Talk to your Mac. Stay in charge."
- "A voice assistant that treats web pages as text, not orders."

## Three promises

### 1. Voice control of the Mac and browser

- Say "Hey Stephen", or hold F5, then speak (`docs/SYSTEM-DESIGN-STEPHEN.md`, F1).
- Stephen works in your own Zen or Chrome, signed in as you (`README.md`).
- It does several steps from one sentence: "what's due on Canvas this week, and put on some lofi"
  (`docs/SYSTEM-DESIGN-STEPHEN.md`, section 1).
- It answers in one or two spoken sentences (`README.md`, Voice).
- Reads: Canvas, calendar, Notion, Gmail, read-only (`docs/SYSTEM-DESIGN-STEPHEN.md`, F6).
- Honest limit: the wake word is slow today. p50 9.6 s against a target of 4.8 s (`docs/NFR-STEPHEN.md`,
  section 3). F5 is faster (p50 1.96 s). Do not promise "instant".

### 2. Safety: it asks first, and page text is never an order

- Risky actions stop at a **macOS dialog**. A spoken "yes" never counts. Allow and Deny are clicks only
  (`README.md`, Voice; `AGENTS.md`).
- Web pages, emails and Canvas posts are treated as data. The model cannot write memory, timers or jobs: no such
  tool exists (`docs/NFR-STEPHEN.md`, section 1).
- After Stephen reads something private, it asks before it sends anything out (`docs/SYSTEM-DESIGN-STEPHEN.md`,
  section 4.1).
- The wake word gets less trust than F5, because a video could say "Hey Stephen" (same doc, section 4.2).
- Checked by tests (about 2,500), a real-model attack eval, and independent reviews REVIEW-1 to REVIEW-10B
  (`docs/NFR-STEPHEN.md`, section 1).
- Say it plainly: "designed and tested to resist prompt injection". Never say "unhackable" or "100% safe".
  The NFR doc lists open safety items.

### 3. Privacy: speech stays on your Mac

- The wake word, end-of-sentence detection and transcription run on the Mac. Only the transcribed text goes to
  Claude (`README.md`, Voice).
- Nothing is sent to us. Stephen has no server (`docs/DATA-STORES.md`, `docs/NFR-STEPHEN.md`, section 2).
- Secrets stay in the macOS Keychain and are never shown to the model (`docs/DATA-STORES.md`).
- Every store has a retention time and a way to delete it. History is 7 days by default. Recordings are off
  unless you opt in (`docs/DATA-STORES.md`).
- What does leave the Mac: your command text to Claude, and calls to the accounts you connected.

## What Stephen is not

- Not a chatbot. One spoken request, one short spoken answer (`docs/SYSTEM-DESIGN-STEPHEN.md`, section 1).
- Not a Claude replacement. The AI behind it is Claude (`README.md`).
- Not for Windows or Linux. macOS 14+ only (`docs/NFR-STEPHEN.md`, section 10).
- Not one-click yet. Setup takes about 8 commands and 3 permission screens. A 15 minute setup is the target, not
  a fact (`docs/NFR-STEPHEN.md`, section 7).
- Not free of cost. It runs on your own Claude account. A daily cost limit is on the way
  (`docs/NFR-STEPHEN.md`, section 6).
- Not signed or notarized yet. macOS may ask for permissions again after an update
  (`docs/RELEASE-PLAN.md`, section 2).
- Not a promise that a Zen window is private to Stephen. While Zen runs for Stephen, other programs on your Mac can
  reach its control port (`README.md`, Zen security trade-off). Say this when we talk about Zen.
- Not an official Anthropic product. Do not use the Claude or Anthropic logos or imply a partnership.

## Words to use and avoid

| Use | Avoid |
|---|---|
| "asks before risky actions" | "can never be tricked" |
| "speech stays on your Mac" | "everything stays on your Mac" (the command text goes to Claude) |
| "designed to resist prompt injection" | "secure", "unhackable" |
| "friends beta" | "launch" (before the public stage) |
| "open source, MIT" | "free" (it uses your own Claude account) |

## Sources

`README.md`, `docs/SYSTEM-DESIGN-STEPHEN.md`, `docs/NFR-STEPHEN.md`, `docs/RELEASE-PLAN.md`, `docs/DATA-STORES.md`,
`LICENSE`.
