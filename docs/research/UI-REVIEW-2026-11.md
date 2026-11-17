# Stephen app UI review (2026-11)

Status: proposals from the review lane, 2026-11-17. Nothing here is built. Each proposal becomes a GitHub issue; the
dev team accepts or rejects each one, and work starts only after it is accepted. Tracking issue: see the PR body.

Scope: the Swift helper in `helper/` on `qa` at `c7406d9`: the menu bar item, the Ask box, the main window (Home,
Conversations, Memory, Jobs, Personal, Settings), the Allow/Deny question, and first-run and permission states.
Read first and kept: `docs/UI-PLAN.md` (v3.2), `docs/UI-NEXT-PLAN.md`, `docs/DESIGN.md`, `docs/REVIEW-10A.md`,
`docs/REVIEW-10B.md` (branch `docs/review-10b`), `docs/research/FINDINGS-LEDGER.md`, `docs/HANDOFF-NEXT.md`.

How this was done, and its limits:
- The Swift code was read, not built or run. Every claim below points to a file and line on `qa`. Sizes such as hit
  targets are worked out from font size plus padding, not measured.
- Screenshots: after Cris turned on Screen Recording (2026-11-17), two screens were captured with Stephen stopped, in
  the Navy theme: the main window and the Ask box, both offline. They confirm P5 and P7 (see 3.13). The other screens
  need the listener running and were not seen. Questions for Cris at the end.
- Contrast was computed from the hex tokens in `helper/Theme.swift:55-86` with the WCAG 2 formula.
- Outside references were used for patterns only, never copied. Sources are named next to each idea (section 7).

---

## 1. Verdict in plain words

**What is good now.** The app already has the hard parts right. It is calm and quiet: one accent, no cards of
statistics, no mascot. The safety rules are built carefully: the Allow and Deny buttons wait 0.75 s, Deny comes first,
Return never allows, Esc denies, and every piece of page, mail and model text is drawn as plain text
(`Text(verbatim:)`, no Markdown, no links; checked by search across `helper/`). States are named in words, not colour
alone, almost everywhere. Reduce Motion is respected. The five themes pass 4.5:1 for normal text in nearly every pair.

**The five changes that would help Cris most.**
1. **A waiting question is visible on every page, not only in the Ask box and on Home** (P1). Today, if Cris is on
   Jobs or Settings, nothing in the window says Stephen is waiting for him.
2. **A setup checklist for first run and missing permissions** (P4). Input Monitoring, the microphone and "Stephen is
   not running" are today a "!" in the menu bar and a line in a menu. Cris should see one list with a fix button for
   each.
3. **Plain words everywhere** (P5). The same thing has two or three names ("Push to talk", "Fn+Option", "F5"), and some
   messages ask Cris to edit `config.json` or type commands in Terminal.
4. **The question card shows where the command came from and leaves a record** (P2). After Cris clicks Allow or Deny,
   the chat shows nothing. The card also does not show, as its own line, whether the command was typed, spoken or from
   the phone.
5. **A failed step reads as failed** (P3, finding R10a-3). #134 shipped the words and the failed count; P3 is now the
   shape per status and Conversations.

---

## 2. Ratings used below

- **Impact for Cris:** high, medium, low (how much it changes his daily use).
- **Effort:** S (a day or less), M (two to four days), L (a week or more).
- **Safety surface:** yes when it touches the question card, the source label, steps or refusals. Every "yes" has a
  line saying how the product rule is kept.
- **Waits for C5:** yes when the change touches `helper/AppClient.swift`, which is being split first (#56). Building it
  before the split would conflict.

| Id | Proposal | Impact | Effort | Safety surface | Waits for C5 |
|---|---|---|---|---|---|
| P1 | Waiting question visible on every page | high | M | yes | no |
| P2 | Question card: source line, visible arming, decision record | high | M | yes | yes |
| P3 | Steps and refusals read the same, with shapes, in chat and Conversations | high | S | yes | no |
| P4 | Setup checklist: first run and missing permissions | high | M | no | yes |
| P5 | Plain words: one name for each thing, no commands in messages | high | M | yes (source words) | yes |
| P6 | Menu bar item: a real icon, a label, words in the menu | medium | S | no | no |
| P7 | Offline: a themed view with Start, and settings that still work | medium | S | no | no |
| P8 | Keyboard, VoiceOver and hit targets | medium | M | yes (announce the question) | no |
| P9 | Contrast: field borders and the Sun accent | medium | S | no | no |
| P10 | Settings shell: ⌘, one title, remember the last pane | low | S | no | no |
| P11 | Memory page at small widths, and Undo for Forget | medium | M | no | no |
| P12 | Home: clear New chat button, focus, shortcut hints | medium | S | no | no |
| P13 | Shared page header, search field and surface box | low | M | no | after #57 |

Items already queued are not repeated here, only linked: #88 (multi-line input), #89 (Zen message), #57 (C2: live
steps, section pages, Connected and Permissions, recents), #77 (chat titles), #107 (outside click sends the recording).

---

## 3. Per screen

### 3.1 Menu bar item and its menu

What works:
- Left click opens the Ask box, right click the menu (`helper/main.swift:320-323`). This is the pattern Apple
  describes for a menu bar extra that needs more than a menu (HIG, The menu bar).
- The tooltip names the state in words (`helper/main.swift:417,423`).

What is weak:
- The item is a text glyph, not an image: "○", "●", "◐" or a speaker emoji (`helper/Core.swift:107-115`). "Listening"
  and "recording" are the same "●" and differ only by red (`helper/main.swift:420`): colour alone. No accessibility
  label is set, so VoiceOver reads the glyph (inferred).
- Missing Input Monitoring is a "!" after the glyph (`helper/main.swift:421`). Easy to miss.
- The menu mixes states and commands: "Phone link on" and "Phone link off" are two commands that read like states
  (`helper/main.swift:306-307`). "Run doctor…" is jargon. A menu header and an error line contain an em dash in the
  source (`helper/main.swift:287,426`; house style says no dashes).
- Apple notes the system can hide menu bar extras when space runs out (notch, many items), so no state should live
  only there (HIG, The menu bar). Today the "!" for Input Monitoring lives only there and in the menu.

Proposal **P6** (medium, S, not a safety surface): a template SF Symbol per state with a different shape per state
(for example a filled circle for listening, a waveform for recording, a spinner-like symbol for working), the state as
the accessibility label, and "Input Monitoring is off" as words in the menu header with the fix as the first item. One
"Phone link" item with a check mark instead of two. Keep Quit last.

### 3.2 Ask box

What works:
- Fixed panel size, only the card eases (`helper/AskBox.swift:343-348,118-122`): no jumping.
- Esc order is well thought out: deny a waiting question first, then cancel recording, then stop, then close
  (`helper/AskBox.swift:220-227`).
- It refuses to close while a question waits (`helper/AskBox.swift:316-317`). Apple says not to put warnings in a
  popover because it can be dismissed by accident (HIG, Popovers); this rule is what makes the Ask box safe for the
  question. Keep it (section 5).

What is weak:
- Empty state is only "New chat" and a field "Ask Stephen" (`helper/AskBox.swift:151-156`). No hint that F5 or the
  wake word works, and no Send button (Home has one, `helper/HomeView.swift:74-75`).
- Offline text is "Can't reach Stephen. Is stephen listen running?" with "Try again" only (`helper/AskBox.swift:170-173`).
  No Start button although the window has one.
- "Working…" has no visible way to stop; Esc is only in the VoiceOver label (`helper/Components/ChatThread.swift:33-34`).
- At the 300-message cap new replies stop scrolling into view (R10a-8).
- "Problem" is the one word for every failure (`helper/Components/ChatThread.swift:114`); a refusal and a crash look
  the same.
- ⌘Q in the box quits the whole helper with no question (`helper/AskBox.swift:206`).

Proposals: offline gets a Start button and plain words (part of **P7**); a small "Esc to stop" next to "Working…"
(part of **P8**); "Problem" splits into "Didn't work" and "Refused" (part of **P3**); an empty-state line "Type, hold
F5, or say Hey Stephen" (part of **P5**). The multi-line field is #88.

### 3.3 Home

What works:
- Calm, centred, one composer, three chips that only fill the field (`helper/HomeView.swift:20,72-82`). This is the
  v3.2 plan as built.
- The composer glides between centre and bottom and is instant with Reduce Motion (`helper/HomeView.swift:37-53`).

What is weak:
- The round back button (chevron left) starts a new chat; its tooltip says "Go back (⌘N)"
  (`helper/HomeView.swift:93-98`). A back arrow that throws the chat away is surprising.
- `composerFocused` is declared but never set, so the field is not focused when Home opens
  (`helper/HomeView.swift:28,74`).
- "1 question waiting · Answer" can never show: the line is drawn only while Home is empty, and Home is not empty while
  a question waits (`helper/HomeView.swift:31,45,112`; R10a-11).
- The Today line "What's my day?" is a 13 pt text button with no padding, under 24 pt high
  (`helper/HomeView.swift:119`).
- The mic on Home opens the Ask box and listens there (`helper/HomeView.swift:74`, `helper/main.swift:462`), so focus
  jumps away from the page Cris is on.
- R10a-4: Home's Allow can already be live when the window comes back, because the 0.75 s delay starts when the view
  appears, not when the window is shown (`helper/HomeView.swift:105`, `helper/AppWindow.swift:126-131`).

Proposal **P12** (medium, S): replace the back chevron with a "New chat" button (plus icon and word); focus the
composer when Home opens and after New chat; remove the dead branch (P1 replaces it); show the shortcut hints that
`SidebarRow.shortcut` already supports but never receives (`helper/MainWindow.swift:183`). R10a-4 is a safety bug and
belongs to P2.

### 3.4 Conversations

What works:
- A truthful record: refused actions say "Refused: … <reason>" with a hand icon and the bad colour
  (`helper/ConversationsPage.swift:35-48,166-172`). "Clear all" asks first, and says memory is kept
  (`helper/ConversationsPage.swift:122-127`).

What is weak:
- Source words differ from the chat: here "Fn+Option", "Hey Stephen", "Phone", "command line"
  (`helper/AppClient.swift:1477-1486`); in the chat "Push to talk", "Heard by wake word", "From your phone"
  (`helper/AppClient.swift:843-851`). The source is a safety label; it should read the same everywhere.
- Raw audit text reaches the page, for example `click button "Send"` and "Used gmail_search" (tool names)
  (`helper/ConversationsPage.swift:15-19,47-48`).
- No loading state: the empty text "Nothing yet." shows while the first load runs (inferred, no loading flag).
- Rows cannot be opened (`helper/ConversationsPage.swift:142-180`); that is the queued recents item in #57.
- Each row is one long VoiceOver label with every action line in it (`helper/ConversationsPage.swift:178-179`).

Proposals: same source words (P5), same step words and shapes as the chat (P3), a "Loading" line (P8).

### 3.5 Memory (graph and list)

What works:
- The rule that the model never writes memory is visible: proposals need Keep, third-party ones are marked
  "third-party text, check it" in the warn colour (`helper/MemoryPage.swift:374,414-418`). Forget all asks first
  (`helper/MemoryPage.swift:126-134`).
- A List view exists as the keyboard and VoiceOver alternative to the graph (`helper/MemoryPage.swift:256-285`).

What is weak:
- The right column is a fixed 300 pt (`helper/MemoryPage.swift:108`). At the minimum window width of 720 pt the graph
  column is about 67 pt wide (720 minus sidebar 241, padding 80, gap 32, column 300; arithmetic, not measured).
- Graph node labels are 11 pt and cut at 110 pt (`helper/MemoryPage.swift:241-242`); no overlap avoidance beyond two
  rings (`helper/MemoryPage.swift:60-79`).
- Graph links are ink-2 at 50%: 2.2:1 to 2.9:1 against the surface, under the 3:1 needed for meaningful lines
  (`helper/MemoryPage.swift:205`).
- "Forget" on one item has no confirmation and no undo (`helper/MemoryPage.swift:353`, `helper/PersonalView.swift:95`).
- Memory has no sidebar row, so no row is marked while it is open (`helper/MainWindow.swift:183`); the sidebar row is
  in #57 (section pages).
- "Choose an item in the graph" also shows in List view (`helper/MemoryPage.swift:366`).

Proposal **P11** (medium, M): below about 1000 pt of content width the inspector moves under the graph; graph links at
full ink-2 (3:1 or more); a short Undo after Forget instead of a confirmation (Apple: do not confirm common actions that
can be undone; HIG, Alerts); the inspector text says "Choose an item" in both views.

### 3.6 Jobs

What works:
- Status is a word plus a pill: Waiting, Running, Finished, Stopped, Failed (`helper/JobsPage.swift:9-18`). The footer
  warns that the summary is written by the job itself (`helper/JobsPage.swift:55`): honest.

What is weak:
- A row opens by a tap on the whole row with no visible chevron, and it is not a button, so the keyboard cannot reach
  it (`helper/JobsPage.swift:113-114`).
- "$0.12 spent" and "N turns" are not explained (`helper/JobsPage.swift:24,104`).
- "Stop" has no confirmation (`helper/JobsPage.swift:99`). Acceptable (it can be started again), but say so.

Proposals: real buttons with a chevron (P8), "about $0.12 of Claude usage" and drop "turns" (P5).

### 3.7 Personal

What works:
- The "What Stephen may do" table: each cell is a word plus a dot, and one VoiceOver line per row
  (`helper/Components/Lists.swift:73-105`). Read only, from the safety rules. Good.

What is weak:
- About-you rows put the value as the title and the field name as the small line (`helper/PersonalView.swift:47`), the
  opposite of every other list.
- Empty About you says "Stephen reads this from voice.aboutMe in config.json." (`helper/PersonalView.swift:44`).
- Personal and Settings > Privacy and safety point at each other (`helper/PersonalView.swift:77`,
  `helper/SettingsPage.swift:336`).
- Accounts show here and again in Settings > Accounts (#57 merges them into Connected).

Proposals: P5 (words), P13 (row order). The page split is #57.

### 3.8 Settings and Appearance

What works:
- How Stephen talks has a live preview and names the voice fallback order (`helper/SettingsPage.swift:92-183`).
- Appearance applies live to the window and the Ask box (`helper/AppearanceSettings.swift:29-45`).

What is weak:
- Two navigation columns (sidebar 240 plus a 230 pt sub-list) before any content, and two 28 pt titles side by side
  (`helper/SettingsPage.swift:48-66,250-255`).
- Always opens on the first pane (`helper/SettingsPage.swift:45`); Apple expects Settings to reopen on the last pane
  used and to open with ⌘, (HIG, Settings). There is no ⌘, today (`helper/AppWindow.swift:142-171`).
- Segmented controls have no visible caption, only a VoiceOver label (`helper/Components/Controls.swift:100`).
- Several panes tell Cris to use Terminal or `config.json` (`helper/SettingsPage.swift:280,314`).
- The Model pane has six effort steps and an "Other" model field: power-user controls on the same level as Appearance.
- No text size setting, and every font is a fixed point size (`helper/Theme.swift:110-118`).
- "Bet, playing lofi beats." is the preview sample (`helper/AppClient.swift:633`): slang for a non-native reader.

Proposal **P10** (low, S): ⌘, opens Settings on the last pane, one title only, visible captions above segmented
controls. Text size is in P8.

### 3.9 The Allow/Deny question

As coded (`helper/Components/ChatThread.swift:172-197`, `helper/AskBox.swift:63-86`): label "Needs your OK", title
(up to 3 lines), body (selectable, scrolls at 160 pt), then Deny (outlined) and Allow (filled). Both buttons are off
and at 50% for 0.75 s each time the question changes. Esc denies at once. No default button. All text verbatim.

What works: almost everything that matters. It follows the rules for agent approval prompts that careful products
share: the exact action, no default button, a delay against stray clicks, Esc is the safe exit (HIG, Alerts; Firefox
keeps security dialog buttons off for about a second; Windows UAC names who asked; see section 7).

What is weak:
- **Only visible in the Ask box and on Home** (`helper/Components/ChatThread.swift:23`). If Cris is on Jobs, the window
  shows nothing; there is no sidebar badge (P1).
- **The delay is invisible.** The buttons are grey for 0.75 s with no word why (`helper/AskBox.swift:79-84`). Cris may
  think the app is frozen (P2).
- **No record after the click.** The question disappears and the chat gets no "You allowed …" or "You denied …" line
  (`helper/AppClient.swift:1412-1417`) (P2).
- **The source is not its own line.** Whatever the card says about source is inside the listener's text
  (`helper/Components/ChatThread.swift:172-173`) (P2).
- **The title is cut at 3 lines** (`helper/Components/ChatThread.swift:183`). For a send action the hidden part could
  matter (P2).
- **Not announced** to VoiceOver when it appears; the label "Needs your OK" is not a heading
  (`helper/AskBox.swift:288-291`) (P8).
- **"1 of N" can only read "1 of"** (`helper/AskBox.swift:73`); fine, but say "2 more waiting" instead.
- R10a-4 (Home's delay may start before the window is shown) and R10a-11 (one card identity for all questions, so the
  scroll position carries to the next question) are open (P2).
- In the Sun theme the disarmed Allow label is 2.96:1 and in Rose 2.84:1. Disabled controls are exempt from WCAG, but
  it is the moment Cris reads the card; the "Ready in a moment" text in P2 carries it.

### 3.10 First run and permission states

As coded: there is no first-run screen. Input Monitoring is asked once at launch by the system prompt
(`helper/main.swift:532-537`); after that the only signs are the "!" in the menu bar, a menu line, and a note shown
only while listening in the Ask box (`helper/AskBox.swift:166-169`). The sidebar may say "Microphone off" with no next
step (`helper/MainWindow.swift:64`). No Accessibility state at all. A missing launch file says "Run `stephen
install-helper` once in Terminal." (`helper/AppClient.swift:1701`).

Proposal **P4** (high, M): a "Set up Stephen" checklist on Home when anything is missing, and always reachable from
Settings > About: Stephen is running, Microphone, Input Monitoring (F5 from other apps), Zen for Stephen, accounts.
Each row: a status word, one sentence of why, and one button that opens the exact System Settings pane or starts the
thing. Apple's rules for a screen before a permission request: one forward button only, never labelled Allow, never a
picture of the system prompt (HIG, Privacy). The live-status checklist pattern is common in open-source Mac utilities
(Rectangle, MIT, documents a repair path for a stale Accessibility grant; Maccy, MIT, asks for a permission only when
the one feature that needs it is used).

### 3.11 Main window frame and sidebar

- AppKit minimum 640 x 420 and SwiftUI minimum 720 x 440 disagree (`helper/AppWindow.swift:129`,
  `helper/MainWindow.swift:101`). Part of P13.
- The word "Stephen" twice at the top: wordmark, then the section label "STEPHEN" (`helper/MainWindow.swift:133,148`).
  #57 reworks the sidebar; note it there.
- The status row and Start/Stop sit at the bottom of the sidebar (`helper/MainWindow.swift:190-232`). Apple advises
  against critical controls at the bottom of a sidebar, since the window's lower edge is often off screen (HIG,
  Sidebars). P1's top banner and P4's checklist cover the critical cases, so the row can stay.
- When the listener is offline, every page, including Settings > Appearance, is replaced by the offline view, which
  uses system fonts, not the theme (`helper/MainWindow.swift:106-108`, `helper/AppWindow.swift:43-65`). P7.

### 3.12 Contrast in each of the five themes

Computed from `helper/Theme.swift:55-86` (script in the review lane's notes; same numbers as UI-PLAN section 9 where
they overlap).

| Pair | Light | Dark | Navy | Rose | Sun | Rule |
|---|---|---|---|---|---|---|
| ink-2 on ground | 5.5 | 7.8 | 8.4 | 6.0 | 6.1 | 4.5 text: pass |
| ink-2 on surface-2 | 5.7 | 6.7 | 6.1 | 5.5 | 5.5 | pass |
| accent on surface | 6.5 | 7.3 | 7.0 | 6.3 | 5.1 | pass |
| accent on surface-2 (selected chip) | 5.8 | 6.6 | 5.8 | 5.4 | **4.4** | Sun fails 4.5 |
| ok on surface-2 | 4.8 | 7.1 | 5.7 | 4.6 | 4.6 | pass, thin |
| bad on surface-2 | 5.9 | 5.4 | 4.3 | 5.6 | 5.8 | Navy under 4.5 if used as text |
| primary text on primary | 15.2 | 14.6 | 14.6 | 10.0 | 12.7 | pass |
| line (border) on surface | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | **under 3:1** |

- All normal text passes except the Sun accent on surface-2 (the selected Memory filter chip,
  `helper/Components/Controls.swift:58-60`).
- Every border is 1.1 to 1.5:1. That is fine for decoration, but for the AskField, search fields, QuietButton and
  unselected chips the border is the only outline of a control (`helper/Components/Controls.swift:43,61,129`). WCAG
  1.4.11 asks 3:1 for the parts needed to see a control. In Light, surface and ground top are both #FFFFFF, so a field
  near the top of the window has only that line.
- Increase Contrast and Differentiate Without Colour are not read anywhere (search for `colorSchemeContrast`,
  `accessibilityDifferentiateWithoutColor`: no match).

Proposal **P9** (medium, S): a `lineStrong` token at 3:1 or more for the outlines of interactive controls only (fields,
quiet buttons, chips); darken the Sun accent one step (for example #7A5E00: 5.4:1 on surface-2, 6.1:1 on surface); for Light, a grey such as
#8C94A3 is 3.05:1 on white but only 2.6:1 on the gradient bottom, so `lineStrong` needs a value per theme, measured on
both ground colours;
with Increase Contrast on, use `lineStrong` for all borders.

### 3.13 What the screenshots confirmed (Navy theme, Stephen stopped)

- Main window, offline: the message shows the backticks literally ("run `stephen listen`."), and under it the raw
  reason "nothing is listening on /Users/.../run/app.sock". The button says "Retry"; the Ask box says "Try again". The
  Start button is at the bottom of the sidebar, far from the message that names it. (P5, P7)
- Ask box, offline: "Can't reach Stephen. Is stephen listen running?" with "Try again" only; no Start button. The chat
  title of the earlier chat ("hello") still shows in the strip. (P5, P7)
- The offline view does sit on the Navy ground, but its text and button use system styles, as the code says
  (`helper/AppWindow.swift:43-65`).
- The sidebar shows "Stephen" then the label "STEPHEN" right under it, as noted in 3.11.

Running (Navy theme, Stephen started in Terminal, two typed messages):
- Ask box: the time of each reply ("1.7 s", "0.9 s") is a bare number under the reply with no label; a reader cannot
  tell what it measures. (P5: "Answered in 1.7 s", or move it into the folded steps line.)
- Ask box: the field outline is barely visible against the card, as the 1.3:1 border contrast predicts. (P9)
- Ask box: typed messages correctly have no source line.
- Home in a chat: the round back chevron and the chat title; the big composer with Send. (P12)
- Sidebar status row: when Stephen runs in Terminal, the Start button is replaced by a small terminal icon with no word
  (the explanation is only a tooltip, `helper/MainWindow.swift:228-229`). (P5)
- Home and the Ask box show the same thread; spoken messages carry "Heard by wake word" under the bubble, typed ones
  carry nothing, as coded. (An earlier capture of an off-screen window was stale; checked on screen.)
- The chat title stays the first message ("hello") after the talk moves on; chat titles are #77.
- Settings > How Stephen talks: two large titles side by side ("Settings" and "How Stephen talks") after two navigation
  columns; the two segmented controls have no visible caption (nothing says Length or Tone). (P10)
- Settings: the selected segment ("Brief", "Casual") is only slightly darker than the track, as the 1.1 to 1.2:1
  surface-on-surface-2 ratio predicts. In Navy the "on" switch track is grey, not the accent, so on and off differ
  mainly by knob position. (P9: selected segment and switch "on" state need 3:1 against their track.)
- The preview line is "Bet, playing lofi beats." (P5)
- **Bug, seen on screen:** making the window as small as it goes cuts text off on every page (Cris). On Memory the
  sidebar is cut on the left, the right column on the right, the page header is not visible, and graph labels overlap
  dots. Likely cause: the window's `minSize` is 640 x 420 (`helper/AppWindow.swift:129`) while the content asks for
  720 x 440 (`helper/MainWindow.swift:101`), and Memory needs more than that (`helper/MemoryPage.swift:119,222`).
  Filed as a bug, #154, not as a proposal.

---

## 4. Proposals in detail

Each line is what the issue will say. Files are the likely ones; the dev team decides the final scope.

**P1. A waiting question is visible on every page.** When a question waits: a one-line banner at the top of every main
window page ("Stephen is waiting for your OK · Open"), a badge on the Home row, and the menu bar icon changes shape.
"Open" brings the Ask box forward; the card itself stays in the Ask box and on Home, so there is still one place where
Allow is clicked. Files: `helper/MainWindow.swift`, `helper/Components/Sidebar.swift`, `helper/main.swift`. No
`AppClient.swift` change: the waiting questions are already `model.confirms` (`helper/AppClient.swift:924`) and "Open"
is the existing `actions.ask()` (`helper/MainWindow.swift:56`). Replaces the dead Home branch (R10a-11).
Safety: the banner has no Allow button and no shortcut; it only opens the card. The 0.75 s delay still runs when the
card is shown (fix R10a-4 at the same time: start the delay when the window or box becomes visible).

**P2. Question card: source line, visible arming, decision record.** (a) A "From: typed / F5 / Hey Stephen / phone"
line on the card, taken from a new field in the `confirm` push (listener change plus a TS mirror test), shown verbatim;
until that field exists, show nothing extra rather than guess. (b) During the 0.75 s, a small text "Ready in a moment"
that becomes nothing when the buttons work (no countdown animation). (c) After a click, a small info line in the thread:
"You allowed: <title>" or "You denied: <title>", verbatim. (d) No 3-line cut on the title: the card scrolls instead.
(e) Fix R10a-4 and R10a-11 (one card identity per question id). Files: `helper/Components/ChatThread.swift`,
`helper/AskBox.swift`, `helper/AppClient.swift`, `src/app/` (push field).
Safety: Deny stays first, Allow stays last and filled, no default button, no Allow shortcut, Esc still denies, the
delay is not shortened, and all new text is `Text(verbatim:)`. The decision line is a record written by the helper
after the click, not by the model.

**P3. Steps and refusals read the same everywhere.** One small component for a step: an SF Symbol shape per status
(check for done, hand for refused, x mark for failed) plus the word, used in the chat's action chain and in
Conversations. (R10a-3: #134 shipped the words and the failed count; P3 is now the shape per status and Conversations.) The "Problem"
label becomes "Didn't work" for failures and "Refused" for refusals. Files: `helper/Components/ChatThread.swift`,
`helper/ConversationsPage.swift`.
Safety: nothing is hidden or renamed into something softer; a refusal is still called refused; step text stays
verbatim; the chain stays folded by default as Cris decided (HANDOFF-NEXT section 2).

**P4. Setup checklist.** As in 3.10. Files: new `helper/SetupChecklist.swift`, `helper/HomeView.swift`,
`helper/SettingsPage.swift`, `helper/main.swift` (Input Monitoring state), `helper/AppClient.swift` (state). Not a
safety surface, but it must never grant anything itself: every button only opens System Settings or starts Stephen.

**P5. Plain words.** One word list, used in every file:
- Source: "Typed", "F5", "Hey Stephen", "Phone", "Command line" in both the chat and Conversations
  (`helper/AppClient.swift:843-851,1477-1486`). Unknown stays "Not typed here" (never empty, R10a-2).
- The entry point is "Ask box" in text and "Ask Stephen" only as the field placeholder.
- No Terminal commands or config keys in messages; say what to do in the app, and keep the command in a "Details" line
  for the dev team (`helper/AppWindow.swift:54`, `helper/AskBox.swift:171`, `helper/PersonalView.swift:44`,
  `helper/SettingsPage.swift:280,314`, `helper/AppClient.swift:1701`).
- "Stopped" only for the listener; a cancelled command is "Cancelled"; a stopped job stays "Stopped".
- "Try again" everywhere (not "Retry"); "…" everywhere (not "...").
- Replace "Bet, playing lofi beats." with a plain sample; "Needs your OK" becomes "Stephen asks first".
- Lower-case fallbacks ("error", "timed out", "not connected") get a sentence: "Something went wrong. Try again."
Safety: the source words are a safety label. They may become clearer, never vaguer, and never empty.

**P6. Menu bar item.** As in 3.1. Files: `helper/main.swift`, `helper/Core.swift`.

**P7. Offline view.** The offline view uses the theme, says "Stephen is not running" with a Start button (the same one
as the sidebar), shows the technical reason under a "Details" disclosure, and Appearance (which needs no listener)
stays usable. The Ask box offline text gets the same Start button. Files: `helper/AppWindow.swift`,
`helper/MainWindow.swift`, `helper/AskBox.swift`.

**P8. Keyboard, VoiceOver and hit targets.**
- Job rows and voice rows become real Buttons (Tab and Full Keyboard Access reach them)
  (`helper/JobsPage.swift:113-114`, `helper/Components/Lists.swift:128-129`).
- Hit targets 24 pt or more for: the action chain toggle, Home's text links, "‹ Personal", Related links, the mic, play
  and Memory menu icons (`helper/Components/ChatThread.swift:140-150`, `helper/HomeView.swift:119`,
  `helper/MemoryPage.swift:141-169,337-340`, `helper/Components/Controls.swift:123`, `helper/Components/Lists.swift:124`).
- VoiceOver announcements: a new question ("Stephen asks first: <title>"), a new reply, "Saved". The question's label is
  a heading.
- "Esc to stop" shown next to "Working…".
- A "Text size: Standard / Large" choice in Appearance (Large = every TypeScale step plus 2 pt), since macOS does not
  scale fixed `Font.system(size:)` with the system setting.
Safety: the announcement reads the question; it never offers to approve by voice.

**P9. Contrast.** As in 3.12. File: `helper/Theme.swift`, plus the controls that draw outlines.

**P10. Settings shell.** As in 3.8. Files: `helper/SettingsPage.swift`, `helper/AppWindow.swift` (⌘, in the menu).
Coordinate with #57, which moves Accounts, Browsers and Phone link out of Settings.

**P11. Memory page.** As in 3.5. File: `helper/MemoryPage.swift`, `helper/PersonalView.swift` (Forget undo).

**P12. Home.** As in 3.3. File: `helper/HomeView.swift`, `helper/MainWindow.swift` (shortcut hints).

**P13. Shared page parts.** One `PageHeader` (title, optional back link, trailing controls), one `SearchField`, one
`SurfaceBox` modifier, one row divider; the same content width and section gap on every page; remove `NoticeView`,
`EmptyStateView` and the unused `Corner.window`; one window minimum size. Today the same box is declared inline in at
least seven places and the two search fields differ in radius, padding and width
(`helper/MemoryPage.swift:150-157`, `helper/ConversationsPage.swift:130-139`). Do it after #57 lands, since #57 adds
pages.

---

## 5. What NOT to change, and why

These look like small UX wins but would weaken a safety rule. Nobody should "improve" them away.

| Keep | Why |
|---|---|
| Allow and Deny are clicks only; no keyboard shortcut for Allow, Return never allows | A shortcut or Return can be hit by accident or by a stray key while typing; the owner's rule is a click next to the question |
| The 0.75 s delay before the buttons work, each time the question changes | Stops a click that was already on its way from landing on a new question. Make it visible (P2), never shorter |
| Deny first, Allow last and filled, no default button | Apple: no default button when the text must be read; Cancel never the default. Keyboard focus reaches Deny first |
| Esc denies at once, with no delay | The safe exit must always be instant |
| No voice approval of any kind, including from P8 announcements | A spoken yes never counts for sending (product rule) |
| The Ask box will not close while a question waits | A popover can be dismissed by accident (HIG, Popovers); the question must not vanish |
| `Text(verbatim:)` for every reply, step, page, mail, memory and question text; no Markdown, no links, no `AttributedString` from data | Page and mail text is data, never instructions or clickable targets. A pretty Markdown reply is not worth a hidden link |
| The source label under every non-typed message, never empty ("Not typed here" for unknown) | Try again re-sends only typed text (R10a-2); an empty label would make spoken text look typed |
| Refusals and failures named in words in the chain and in Conversations | The record must be truthful; a refusal is never shown as done |
| Memory is saved only by Keep; third-party proposals are marked | The model never writes memory |
| The permission table is read only in the app | Changing safety rules from a click in the UI needs its own threat model |
| Forget all and Clear all ask first | They cannot be undone |
| No colour-only state; every status has a word | Five themes and colour-blind use |

---

## 6. Order and what waits for C5

Can start as soon as each is accepted (no `AppClient.swift` change): P1, P3, P6, P7, P8, P9, P10, P11, P12.
Wait for the `AppClient.swift` split (C5, #56): P2, P4, P5.
After #57 (section pages): P13. P10 and P11 should be planned with #57 so they do not edit the same lines.
Suggested first three after acceptance: P3 (small, safety, already a finding), P9 (small, all five themes), P2 after C5.

---

## 7. Where the ideas came from (patterns only, nothing copied)

- Apple Human Interface Guidelines, macOS: The menu bar, Popovers, Settings, Sidebars, Alerts, Onboarding, Privacy,
  Accessibility, VoiceOver, Motion, Loading (https://developer.apple.com/design/human-interface-guidelines/). Used for
  P1, P4, P6, P8, P10, P11 and section 5.
- Approval prompts: Windows UAC names the program that asks
  (https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works);
  Firefox keeps security dialog buttons off for about a second (from search results, not verified in source);
  1Password's SSH agent names the requesting process and scopes approval (https://www.1password.dev/ssh/agent/security/);
  the Model Context Protocol says a human must always be able to deny a tool call
  (https://modelcontextprotocol.io/specification/2025-06-18/server/tools); Anthropic reported people approved about
  93 percent of prompts, so prompts must stay rare to stay meaningful
  (https://www.anthropic.com/engineering/claude-code-auto-mode); Nielsen Norman Group on naming the affected item in a
  confirmation (https://www.nngroup.com/articles/confirmation-dialog/). Used for P2 and section 5.
- Open-source Mac apps, read for ideas only: Maccy (MIT), Rectangle (MIT, LICENSE file read), Stats (MIT); Ice, VoiceInk
  and Loop are GPL-3.0, so ideas only and no code. Used for P4 and P6.
- Design galleries Cris named: inspora.design (quiet chrome, skeletons shaped like the final content), designeer.xyz
  (sidebar with the search shortcut shown inside the field), 21st.dev, uiverse.io, reactbits.dev and magicui.design
  (component libraries; their animated effects are mostly wrong for a safety product, see the marketing doc),
  impeccable.style (lists generic "AI design" tells to avoid, such as uppercase kickers and coloured side stripes),
  stickitupx.com (keep personality to low-stakes places like empty states). mobbin.com returned 403 and was skipped.
  None of their code is proposed: the app is SwiftUI, and they are React.

---

## 8. Questions for Cris

1. With Stephen running, screenshots of: the Ask box with a question waiting, Home empty, Memory at the smallest window
   size, Settings > How Stephen talks, and the menu bar item while recording. The offline screens are done (3.13).
2. P2(a) needs the listener to send where a command came from with each question. Is a small listener change OK for
   this, or should the card stay as it is until later?
3. P5 changes "Needs your OK" to "Stephen asks first". Do you like that, or do you prefer another short line?
