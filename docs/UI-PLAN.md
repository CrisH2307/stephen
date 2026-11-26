# Stephen app: UI plan (v3.2, build-ready)

Status: the owner's direction of 2026-11-08, ready for a new chat to build (roadmap P3, after P1 reliable clicks and
P2 app-first). SwiftUI, in `helper/` (`AppWindow.swift`, `AppClient.swift`, new files as listed in §10).
**v3.2 (2026-11-08, after the owner tested the v3.1 build):** the Ask box is a draggable chat thread (§5, replaces the
"one thing at a time" rule), Home uses a chat layout (§6), the sidebar collapses smoothly and marks the current page
(§4), and the spacing scale is larger (§9). Every changed default is listed in "Decisions to confirm (v3.2)" (§12).

Mockups (row "v3.1"): https://claude.ai/artifact/LPZoKp4HvKkyjAM2ysAUrd (private to the owner).

History: v1 "Storefront" (orange cards) → v2 (anti-slop pass, still card dashboards) → v3 (the owner liked the calm
feel of a friend's product, Coco) → **v3.1**: the owner asked that Stephen must not copy Coco, so every distinctive
Coco element was replaced with Stephen's own design drawn from other, widely used patterns (§3). Older rows stay on
the canvas for reference only; **build v3.1**.

## 1. What Stephen's UI is for
Stephen connects your work, so the app has two jobs: (1) **talk** (fast, small, anywhere) and (2) **understand you and
stay in your control** (what it knows, what it may use, what it may do). Everything else is secondary.
- Talking: the **Ask box**, a small popover from Stephen's menu bar icon (hold F5 to talk, ⌘K or click to type).
  Never a full window.
- Understanding and control: the **main window**: Home, Conversations, Jobs, **Personal**, Settings.

## 2. Rules (not AI slop)
- **No filler.** A screen shows only what you can act on now. No stat tiles, no "insights", no dashboards of cards.
- **Calm surface.** Grayscale, one blue accent, navy for primary buttons. A very light neutral top-to-bottom wash on
  the window ground is the only gradient (white → #ECEEF2); never colored gradients, glows, orbs or glass.
- **Type.** SF Pro (system) only: Display weights for big titles, Text for everything else, SF Mono for numbers and
  ids. Banned as the look: Inter, Space Grotesk, DM Sans, Plus Jakarta Sans, Poppins.
- **No mascot, no emoji, no sparkle icons.** Stephen's mark is the wordmark "Stephen" plus a small status dot.
- **Honest states.** Listening, working, stopped, needs approval, offline: always named in words, never color alone.
- **Safety is visible.** Approvals happen in the Ask box; what Stephen did is listed under each reply; Personal shows
  what Stephen may do with each thing it knows.

## 3. Originality (the owner's rule: inspired, never copied)
Kept from Coco only what many apps share: a calm light look, a sidebar app with settings, a quick way to talk. Replaced
everything distinctive:

| Distinctive in Coco | Stephen v3.1 instead | Drawn from |
|---|---|---|
| "Context network": columns of agents, skills, knowledge and sources with lines and an inspector | **Personal**: grouped lists (About you, Memory, Connected, Routines) plus a **permissions table** (what Stephen may do by F5, wake word and phone) | macOS System Settings (grouped inset lists), ChatGPT Personalization (memory list you can edit), iOS Privacy & Security (per-item access), Stephen's own safety model |
| Floating chat window with name/tagline header, agent dropdown, "Stopped · All tasks" strip | **Ask box**: a 300 pt popover under Stephen's menu bar icon; one thing at a time (input, or your words while listening, or one question with two buttons); usage hidden in a ⋯ menu | macOS menu bar extras (Now Playing, Control Center), Spotlight |
| Personality preset cards (Natural, Cowboy, Butler…) with a sample line and "Hear sample" | **How Stephen talks**: two segmented controls (Length, Tone) and two switches (Speak replies, Explain steps), live preview; a **voice list** with play buttons showing Stephen's real fallback chain (ElevenLabs → Kokoro → macOS) | macOS Spoken Content voice list, iOS segmented controls, Stephen's TTS design |
| Home: "Hey, <name>. What are we up to?" + 4 starter cards + input | **Home**: "Morning, Cris." + the date; a **Today** list first; the input; small suggestion chips under it | Apple Reminders "Today", Things 3 (today first) |
| Sidebar: big "New conversation" button, "Recent conversations", Quit and Quick ask rows at the bottom | **Sidebar**: an "Ask Stephen ⌘K" field at the top; two sections, **Stephen** (Home, Conversations, Jobs) and **You** (Personal, Settings); a status row at the bottom; Quit stays in the app menu | macOS source lists with sections (Finder, Music), Arc/Raycast search-first sidebars |
| Robot mascot, "A little help, right here." copy, the name | None. Plain wordmark, Stephen's own copy | n/a |
Rule for the builder: if a screen starts to look like a specific other product, change the layout, not just colors.

## 4. Sidebar (main window)
- Top: wordmark "Stephen" and a collapse button (⌘\). Collapsed = 60 pt icon rail with tooltips; state remembered.
  **Motion (v3.2):** the icons never move; the wordmark and labels fade while the width animates (0.22 s). There is
  no layout switch, so nothing jumps. With Reduce Motion it changes at once.
- **Current page (v3.2):** semibold label, an accent-tinted row background (accent at 12%) and a small accent bar on
  the leading edge; the change fades. It is also in the accessibility traits, never color alone.
- **Ask Stephen** field (opens the Ask box, shows "⌘K").
- Section label "STEPHEN" (11 pt uppercase): **Home**, **Conversations** (what you asked, what Stephen did, refusals;
  replaces History + Audit), **Jobs**.
- Section label "YOU": **Personal**, **Settings**.
- Bottom: status row (dot + word: Listening / Stopped / Offline) with **Start/Stop** (P2). Quit is ⌘Q in the menu.

## 5. Ask box (a chat thread, in the menu bar)
A 360 pt panel under Stephen's menu bar icon, 14 pt corners. Opened by clicking the icon, ⌘K, or F5. It is a real chat,
like the ones people already know: the current conversation as a scrolling thread, your messages on the right in a soft
bubble, Stephen's replies on the left, the input at the bottom. (v3.1 showed one thing at a time and only the last
reply; the owner asked for a thread.) The thread is the same one Home shows, from the one chat in `AppModel`.
- **Top strip**: drag it to move the box; the position is remembered (and ignored if that spot is off every screen).
  The ⋯ button is on the strip.
- **Thread**: your words, Stephen's replies (tools used as a small line), problems named "Problem" with Try again,
  small grey lines for busy and stopped. "Working…" under the last message; Esc stops it.
- **Listening**: the thread is replaced by "Listening…" (tap to send when the box's mic started it).
- **Click outside while listening**: cancels the recording and closes the box, like Esc; it never sends. Only tapping
  the box, the Talk button, or releasing F5 sends.
- **Needs your OK**: a message at the bottom of the thread with the gate's own question and facts and two buttons.
  Allow and Deny stay off for 0.75 s each time the question changes, Esc denies, and a spoken yes never counts for
  sending (enforced, not printed).
- **Offline**: what failed and Try again.
- **⋯ menu**: New chat ⌘N (the old chat stays in Conversations), Open Stephen ⌘O, **Pin open** (stay open when you
  click elsewhere), **Reset position**, **This chat: % of context used**, **Memory: % full** (amber over 80%),
  Review memory, Quit ⌘Q.

## 6. Home (chat layout, v3.2)
Inspired by common chat apps, never a copy of one product's layout (§3).
- **Empty (no messages in this chat)**: the greeting ("Morning, Cris.", 34 pt) and the date, a large centred composer
  (with Talk and Send), and the three suggestion chips under it ("Plan my day", "Find internships", "Start a job").
- **With messages**: the same thread as the Ask box, scrolling, with the composer at the bottom. ⌘N starts a new chat
  (back to the empty layout).
- **Today** is one compact line, not a list: "Nothing waiting · What's my day?", "1 question waiting · Answer" or
  "2 jobs running · See jobs". No weather, no cards.

## 7. Personal (replaces "Context network")
One scrolling page of grouped lists (System Settings style), with a narrow right column for permissions:
- **About you**: name, school, time zone, how Stephen talks (link to Settings). Editable.
- **Memory**: the 2 newest items with Forget, then "See all 48, as a graph ›" with a "2 new" count. Opens §7a.
- **Connected**: Canvas, Google Calendar, Notion, Gmail, Weather, Zen, Chrome (later `~/ai-job-search`): name, state
  in words ("Read-only · connected", "Not set up"), a Fix or Connect button when needed.
- **Routines**: Morning briefing, Play music, Background jobs, Read inboxes; each row says what it uses ("Canvas,
  Notion, Weather") and has Run.
- **What Stephen may do** (right column): a small table, rows Read · Open pages · Type and click · Send or submit,
  columns F5 · "Hey Stephen" · Phone; cells say Allowed / Asks you / Never. Read from the safety rules, not editable
  here (changing them stays in Privacy and safety).

## 7a. Memory page (from Personal)
A full page of what Stephen knows about you, kept up to date from your chats and work.
- Header: "‹ Personal", title, a "86% full" chip only when over 80%, a search field, ⋯ (usage, export, clear).
- Filter chips: All, People, School, Places, Habits, Projects, New.
- **Graph** (left): you in the center, things as small nodes grouped by kind (group labels, no colors per kind);
  lines join related things; the selected node is accent blue; a **new** (not yet kept) item is dashed amber.
- **Inspector** (right): the selected item, its facts, where each came from ("You said · Nov 3", "From Canvas · you
  kept it"), Edit and Forget.
- **New from your chats** (right): items Stephen proposes, each with Skip / Keep.
- **Tell Stephen** box under the graph: "I moved to Fit4Less", "what do you know about Lab 4?"; changes it proposes
  show as New items to Keep.
- **Safety (unchanged rule: the model never writes memory)**: Stephen only *proposes*; nothing is saved until you
  press Keep or Edit. Proposals from third-party text (email, Canvas, web) are labelled with their source.
- Data: existing `memory.list` / `memory.update` / `memory.forget`, plus new `memory.graph` (nodes, links, kinds),
  `memory.suggestions`, `memory.keep` / `memory.skip`, `memory.usage` (bytes used / budget).

## 8. Settings
Left sub-list: **How Stephen talks**, **Appearance**, Wake word and F5, Phone link, Accounts, Browsers, Privacy and safety, About.
- How Stephen talks: **Length** (Brief · Balanced · Detailed), **Tone** (Casual · Friendly · Formal), switches
  **Speak replies out loud**, **Explain steps as you go**. A live preview line updates with every change.
  **Voice**: a list (Noah Yang · ElevenLabs, Kokoro · on this Mac, macOS voice) with a play button each and the
  current one checked; a note that Stephen falls back down the list when one isn't available. Save shows "Saved".
- **Appearance**: theme tiles (each a tiny preview of the Ask box): **Light, Dark, Navy, Rose, Sun**, plus a switch
  "Follow the Mac" (Light by day, Dark at night). Applies to the main window and the Ask box. Theme tokens in §9.

## 9. Visual tokens (measured contrast ≥ 4.5:1, 2026-11-08)
| Token | Light | Dark | Use |
|---|---|---|---|
| `ground` | #FFFFFF → #ECEEF2 (vertical) | #12151B | window background |
| `surface` | #FFFFFF | #171A21 | Ask box, lists, inputs |
| `surface-2` | #F2F3F6 | #1F232C | selected rows, chips, segmented control track |
| `line` | #E3E5EA | #2A2F3A | borders and dividers |
| `ink` | #0E1525 | #EEF0F4 | text (18.2 / 15.3) |
| `ink-2` | #556070 | #A3AAB7 | secondary text, section labels (6.4 / 7.5) |
| `primary` | #13244A navy, white text | #DCE6FF, #0E1525 text | Send, Run, Save, Allow (15.2 / 14.6) |
| `accent` | #2456C9 | #7FA6FF | selection, links, focus, active sidebar icon (6.5 / 7.3) |
| `ok` / `warn` / `bad` | #1E7A4F / #8A5A00 / #B42318 | #5CC28B / #E0B04A / #F07167 | status, always with a word |
Extra themes (same roles; ok/warn/bad use the Light or Dark set by brightness; contrast measured 2026-11-08):
| Theme | ground | surface | line | ink | ink-2 | primary (text) | accent |
|---|---|---|---|---|---|---|---|
| Navy | #0F1B33 | #16264A | #26385F | #EEF2FA (13.3) | #A9B6CF (7.3) | #DCE6FF (#0E1525, 14.6) | #8FB0FF (7.0) |
| Rose | #FFF5F7 | #FFFFFF | #F1DCE2 | #2A1219 (17.5) | #7A5560 (6.4) | #7A1F3D (white, 10.0) | #B4235A (6.3) |
| Sun | #FFFBEA | #FFFFFF | #EFE6C4 | #221C08 (17.0) | #6B5F35 (6.3) | #3D3200 (white, 12.7) | #8A6A00 (5.1) |

Type: page title 28 Display semibold (-2%), Home title 34; section 17 semibold; body 15/22; secondary 13; section
label 11 uppercase +8% ink-2. Corners: window 12, Ask box 14, lists and inputs 12, buttons 10, rows 8. Spacing (v3.2,
roomier): 4, 10, 16, 20, 32, 40 (xs to xxl); page padding 40, section gaps 32, list rows 16 vertical. Shadow only on the Ask box (system floating window shadow). Motion 150 ms state, 200 ms bar
expand; none with Reduce Motion. Icons: SF Symbols, regular, 16/18 pt.

## 10. Build plan (new chat)
1. `helper/Theme.swift` (tokens, light/dark) and `helper/Components/` (SidebarSection, SidebarRow, StatusPill,
   PrimaryButton, QuietButton, Tag, AskField, GroupedList/Row, PermissionTable, Segmented, VoiceRow), with previews.
2. **Ask box** first: an `NSStatusItem` popover (or a non-activating `NSPanel` anchored under the icon), opened on
   click / F5 / ⌘K, wired to the existing app.sock `chat.send` / `chat.done` / `state` messages; the OK question wired
   to the gate's confirm; the ⋯ menu reads new `usage` (chat context %, memory %).
3. Main window: sidebar (sections, collapsible) → Home → Personal (new read-only `personal.summary` request: about-me
   fields, connected-account states, routines; memory summary via the existing memory messages; the permission table from a
   static description of the safety rules) → Settings › How Stephen talks (new `settings.set` for length, tone, speak,
   explain, voice; the persona text stays in `src/voice/claude.ts`, chosen by these keys) → Memory page (§7a) → Settings › Appearance (themes) → Conversations → Jobs.
4. Each screen: rules (§2), originality check (§3), states (§5.3), VoiceOver labels, keyboard (⌘1…⌘5, ⌘\, ⌘K, Esc),
   all five themes. TS mirror tests for every new protocol message (`test/helper/app-protocol.test.ts` pattern).

## 11. Open questions for the owner
1. Ask box shortcut: ⌘K only inside the app, or also a global one (⌥⌘Space, needs the helper)?
2. Length and Tone options (§8): keep these three each?
3. Personal: may you edit About you and Routines here, or view only at first?
4. Memory budget: what counts as "full" (the size Stephen loads into each chat)? Suggest 8 KB to start.
5. Should Stephen propose memory from every chat automatically, or only when you say "remember"?

## 12. Decisions to confirm (v3.2)
Defaults changed from v3.1. Say so if any should go back.
1. **Ask box is a thread** (was one thing at a time). It keeps your messages when closed and reopened, until ⌘N.
2. **Ask box is 360 pt wide** (was 300), thread capped at 340 pt tall.
3. **Position is remembered after a drag**; the box no longer always opens under the icon. "Reset position" undoes it.
4. **Pin open is off by default** and remembered once switched on.
5. **Home opens as a centred composer** (greeting, date, composer, chips). Today is one line instead of a list.
6. **Spacing scale is larger** (10, 16, 20, 32, 40 instead of 8, 12, 16, 24, 32); minimum window 720 x 440.
7. **Current sidebar page** is semibold with an accent-tinted row and a leading accent bar (was a grey row).
8. **The chat is the helper's in-memory chat**: it starts empty after the helper restarts. A read-only `chat.history`
   request could fill it from the listener's history; not built.
