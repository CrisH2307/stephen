# Independent review #1 — findings and fix assignments

Reviewer had not seen the build. Probe scripts that reproduced findings live in
`/tmp/claude-0/-home-claude/dfece691-d57e-52ff-8500-7366f1373087/scratchpad/` (probe.mjs, probe2.mjs, live.mjs, live2.mjs, tab.mjs, speed.mjs) — read them to reproduce, then turn each into a regression test.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | CRITICAL | Cross-site rules compare eTLD+1, so after reading mail.google.com, script.google.com/macros/…?d=<mail>, docs.google.com (type into attacker doc), www.google.com/url?q= redirect are all allowed; same for outlook.live.com→onedrive.live.com. Link clicks to other hosts are never checked. Reads of other private apps (Drive, Notion, Slack DMs, Calendar) don't arm the rule. | safety |
| 2 | HIGH | `type`/`fill_form` send text as keystrokes: `"hi\n"` submits forms / sends chat messages unconfirmed; `"me\thunter2"` tabs into the next password field (BiDi). Audit then logs part of the password. | page (+server validation) |
| 3 | HIGH | `press_key "KeyA"`/`"Digit1"`/`"Numpad1"` type text but aren't treated as text keys → allowed into password/OTP fields. Fail-open when describeFocused throws. Closed shadow root: host described instead of the inner input. | safety (+server passes `focus`) |
| 4 | HIGH | Enter in a single-line form field is never confirmed (README claims it is). E.g. GitHub "type repo name to delete" + Enter. | safety (+README) |
| 5 | HIGH | `browser_connect {mode:"real"}` lets a prompt-injected model switch Zen from the agent profile to the user's real profile (relaunch under automation, user.js write). | server |
| 6 | HIGH* | evaluate confirmation prompt truncates code at 300 chars while schema allows 10k → hidden `fetch(cookie)` approved. (*only if allowEvaluate) | safety + server |
| 7 | MED | Click has no hit-test: a transparent overlay receives the click the gate approved for another element. | page |
| 8 | MED | Refs restart per document: `c1:e1` = "Save draft", after navigation `c1:e1` = "Send". No re-check after the human approves. No per-tab serialization. | page (epochs) + server (re-describe, mutex) |
| 9 | MED | Snapshot lines are rendered inside the page; a hostile frame that overrides JSON.stringify/String.prototype.replace can inject fake lines/refs (`- button "Not spam" [ref=c1:e1]`). | page |
| 10 | MED | Prompts don't show what is sent: cross-site typing shows 9 chars; Gmail "Send" shows no recipients/body; handle_dialog prompt_text not passed to the gate. | safety (prompt) + page (formSummary) + server (prompt_text) |
| 11 | MED | Typing continues after TIMEOUT is returned (20k chars); leftover keystrokes can land in other fields. | page (+server cap) |
| 12 | MED | Single-key app shortcuts (Delete, Backspace, Gmail `#`/Shift+3, `e`) allowed when nothing editable has focus; non-English labels (Supprimer, Löschen, Envoyer) and Gmail "Create filter" not high-risk. | safety |
| 13 | MED | Snapshot redaction rules ≠ gate secret rules; payment frame lists differ. → now `src/shared/secrets.ts`. | page + safety |
| 14 | MED | Full-page screenshots uncapped (can exceed 8000px API limit; long sync PNG work). | page |
| D1 | — | Zen launch timeout SIGTERMs the Zen it started, incl. REAL profile (slow first launch after update). | server/drivers |
| D2 | — | Two Claude Code sessions vs one agent Zen: second gets session-limit error and is told to quit Zen (kills first session's work). Record owner pid. | server/drivers |
| D3 | — | Profile/state dirs created without 0700. | server/drivers |
| D4 | — | Chrome real mode: Allow timeout 20 s too short; pages() 10 s may time out with 100+ tabs. | server/drivers |
| D5 | — | Debug ports outlive the server (agent Zen/Chrome, real-mode Zen) — document; tell user to restart Zen after real-mode sessions. | server (README) |
| R1 | — | README: Enter claim; "values hidden" partly true; audit logs full URLs (tokens) and intent verbatim; recent_actions says newest last (it's newest first); `home` key undocumented; DESIGN says .parentlock checked (only pgrep); tab titles / element labels not wrapped as untrusted. | server + safety (URL redaction) |

Verified fine: osascript argv handling, stdout cleanliness, never close(), session.end on disconnect/signals, random runtime key.
