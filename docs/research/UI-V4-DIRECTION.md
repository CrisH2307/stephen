# Stephen app UI: v4 direction (2026-11)

Status: a proposal from the review lane, 2026-11-17. Nothing here is built. The dev team accepts, changes or rejects
each item; work on an item starts only after it is accepted. Tracking issue: see the PR body.

Builds on, does not replace: `docs/UI-PLAN.md` (v3.2, tokens in section 9), `docs/research/UI-REVIEW-2026-11.md`
(PR #133, the per-screen review with file and line references), tracking issue #136 and its stories #138 to #151,
and the window-size fix #154. Where this doc and the review agree, the review's story is linked, not repeated.

Mockups: `docs/research/ui-v4-mock/index.html` (open it in any browser; one file, no network). They are pictures for
discussion, not the app.

---

## 1. The direction in five sentences

1. Stephen should look like it belongs on a Mac: Apple's own sidebar, lists, switches and settings forms instead of
   hand-drawn copies of them.
2. Every page first answers "what needs me now?" in plain words, then shows the rest as simple lists.
3. Each theme has one accent colour (links, focus, selection) and one strong colour for main buttons; everything
   else is calm text on a calm background.
4. The safety moments (the Allow or Deny question, refusals, where a command came from) are the clearest things in the
   app, and nothing else competes with them for attention.
5. Less decoration and more real content: no cards around lists, smaller titles, and honest empty pages that say what
   to do next.

---

## 2. What the reference app teaches (and what it does not)

Cris pointed at a web app his team uses and likes (a campus planner built on Base44). It is a public demo with no
sign-in. It was studied for patterns only: no code, text, logo, screenshots or brand are copied into this repo.

What makes it feel good, measured in the browser:
- **Today first.** The home page opens with a greeting, the date, and one line about the very next thing and how much
  time is left before it. Everything below is ordered by "when".
- **Plain lists, few cards.** Only the top three items are cards. Schedules, due dates, rooms and people are plain rows
  with a hairline between them: a small label (course and kind), a bold title, one line of facts joined by middle dots.
- **Honest words.** Pages open with one sentence that says what the page shows and where the data comes from (for
  example, that locations come from the timetable and never from GPS). Empty states say what to do next ("No
  timetables yet. Build them above").
- **Status as a dot and a word** ("Open until 7:00 PM"), never colour alone.
- **Calm ground, dark ink.** A warm off-white page, near-black text, hairline borders, one highlight colour.
- **Roomy but not empty.** Large body text (18 px), clear rhythm between sections.

What fits Stephen, and how:

| Idea | Fits? | Why | Where in v4 |
|---|---|---|---|
| Today first: the next thing and the time until it | Yes | Cris uses Stephen for his day; one concrete line beats a greeting alone | Home "Next up" line (new story S8) |
| Plain lists with a small label, a title and one facts line | Yes | Conversations and Jobs are long lists; cards waste room and look like a web dashboard | List rows (S5) |
| One honest sentence under each page title | Yes | Stephen holds private data; saying where it comes from builds trust | Page intro line (S4) |
| Empty states that name the next step | Yes | Same reason; today some pages say only "Nothing yet." | S4 |
| Dot plus word for status | Already done | #140 and #143 shipped shapes and words | Keep |
| Calm off-white ground | Partly | The Light theme's white-to-grey wash makes fields vanish at the top; a flat soft grey fixes it | Tokens (S2) |
| Top tab bar for navigation | No | A Mac window with five or more places uses a sidebar (HIG, Sidebars); tabs are a web habit here | Keep the sidebar |
| Brand fonts (a grotesque display face plus a geometric sans) | No | On a Mac the system font is sharper, matches every menu and dialog, and needs no download. UI-PLAN already bans this kind of font as "the look" | System font |
| Handwritten script for a friendly note | No | Hard to read for a non-native reader, and a decoration, not content | None |
| Pastel tint per card, thick dark outlines, hard offset shadows | No | More than one accent per theme; a current web trend that clashes with macOS controls and menus | None |
| Fade-in when changing page | No | A native window shows the page at once; a fade on every click feels slow | Instant page change |
| 18 px body text | Partly | Mac body text is 13 pt; Stephen already uses 15 pt for comfort and #145 adds a Large size | Keep 15, Large 17 |
| Dotted grid behind the page | No | Pure decoration | None |

Short version: take its **content habits** (today first, plain lists, honest sentences), not its **look** (fonts,
pastel cards, shadows). A web dashboard is not a Mac menu bar assistant.

---

## 3. "No AI slop" list for Stephen

Every proposal in this doc and every mock was checked against this list. An independent review checked it again (section 12).

1. No purple-to-blue (or any colour-to-colour) gradients. The Light theme's grey wash is removed too (S2).
2. No glass or blur for its own sake. The only translucency is the system sidebar material in Light, Dark and Follow
   the Mac, because that is what macOS draws there.
3. No emoji as icons, no mascot, no robot. Icons are SF Symbols.
4. No "sparkle", "magic wand" or "brain" icons for Stephen or for memory.
5. No glow, no coloured shadows, no shadow on lists or cards. One shadow in the whole app: the Ask box panel (drawn by
   the app today, `helper/AskBox.swift:114`).
6. No animation that is not a state change. No fades between pages, no bouncing, no shimmer placeholders. Reduce
   Motion turns off the rest.
7. No filler copy ("Your AI-powered assistant", "Supercharge your day"). Every sentence says a fact or a next step.
8. No fake numbers: no stat tiles, no "92% productivity", no invented counts in mocks. Example content is labelled as
   an example.
9. No centred hero layouts inside the utility app, except Home's empty composer, which is the one place to start
   typing (already in v3.2).
10. One accent colour per theme, plus `primary` for filled buttons (Send, Allow, Keep). Status colours (ok, warn, bad) always come with a word or a shape.
11. No cards around list rows. Grouped lists (System Settings style) for settings; plain divided lists for records.
12. No custom-drawn copy of a control macOS already has, unless the theme needs it and it behaves the same for the
    keyboard and VoiceOver.

---

## 4. Built from open, well-made parts

**Platform first.** Everything below is part of macOS and costs nothing to download:
- **SwiftUI system controls:** `NavigationSplitView` sidebar, `List` with selection, `Form` with `.formStyle(.grouped)`,
  `Toggle` (switch), `Picker` (`.segmented`, `.menu`), `Table` where columns help. They bring keyboard focus,
  VoiceOver, Increase Contrast and right-to-left for free.
- **SF Symbols** for every icon, one weight (regular), monochrome. No glyph is missing today, so no extra icon set is
  needed.
- **The system font** (SF Pro, SF Mono for times and ids). Inter (OFL-1.1) was considered and rejected: on a Mac it
  only adds a download and a font that differs from every menu and dialog.
- **Semantic colours and materials** in Light, Dark and Follow the Mac; the five theme palettes stay as tokens.
- **Apple's Human Interface Guidelines** for menu bar extras, popovers, sidebars, settings windows, alerts and privacy
  requests.

**Open source, read for patterns only (no code copied).** Stephen's repo has no licence file (`package.json` says MIT), so this doc copies no
code from anywhere; if a builder wants to copy code later, that needs a licence decision first. Licences checked on
GitHub, 2026-11-17:

| Project | Licence | What to read it for |
|---|---|---|
| Maccy (`p0deje/Maccy`) | MIT | A menu bar popover that is fast with the keyboard; search field focus; asking for a permission only when the feature needs it |
| Rectangle (`rxhanson/Rectangle`) | MIT | First-run permission screen and a repair path for a stale Accessibility grant (for #141) |
| Stats (`exelban/stats`) | MIT | Menu bar item states and a settings window with a sidebar |
| CodeEdit (`CodeEditApp/CodeEdit`) | MIT | A SwiftUI `NavigationSplitView` app and a System Settings style settings window |
| NetNewsWire (`Ranchero-Software/NetNewsWire`) | MIT | Calm, dense, native lists; sidebar sections; keyboard use |
| Settings (`sindresorhus/Settings`) | MIT | How a settings window remembers its last pane (for #147) |
| Ice (`jordanbaird/Ice`) | GPL-3.0 | Menu bar item behaviour only. GPL: read, never copy |
| Loop (`MrKai77/Loop`) | GPL-3.0 | Restrained motion in a Mac utility. GPL: read, never copy |

Fallbacks, not used now: Lucide (ISC) or Phosphor (MIT) icons only if a needed glyph is missing from SF Symbols.

---

## 5. Design tokens v4

Changes from `docs/UI-PLAN.md` section 9 (as built in `helper/Theme.swift`) are marked **changed** or **new**.
Contrast numbers are WCAG 2 ratios computed from the hex values, 2026-11-17.

### 5.1 Type (all system font)

| Role | v3.2 | v4 | Why |
|---|---|---|---|
| Home greeting | 34 semibold | **changed: 26 semibold** | 34 reads like a web hero; 26 is the Mac large title |
| Page title | 28 semibold | **changed: 22 semibold** | 22 is the Mac's Title 1 text style; the review saw two 28 pt titles side by side in Settings |
| Section | 17 semibold | **changed: 15 semibold** | Same size as body, weight carries it; less shouting |
| Body | 15 | 15 (unchanged) | Bigger than the Mac's 13 on purpose, for reading comfort |
| Secondary | 13 | 13 (unchanged) | |
| Section label | 11 medium, UPPERCASE, +8% tracking | **changed: 12 semibold, Sentence case, no tracking** | Finder, Music and System Settings use sentence case; capitals with tracking are harder to read for a non-native reader and are a web habit |
| Eyebrow (small kind label above a list title) | none | **new: 12 regular, ink-2** | From the reference's list rows: "Typed · 2:14 PM" above the title |
| Mono | 13 | 13 (unchanged), only for times, sizes and ids | |
| Large text (#145) | none | +2 pt on every role | Already in #145; v4 only names the roles it scales |

All roles live in one place (`TypeScale`), so #145's text size choice is one multiplier.

### 5.2 Spacing

Unchanged values: 4, 10, 16, 20, 32, 40 (Cris asked for the roomier scale in v3.2; keep it).
**Changed use:** rows in long record lists (Conversations, Jobs, Memory list) use 12 vertical padding with a 44 pt
minimum height, instead of 16. Grouped settings rows keep 16. Why: the reference fits about twice as many records on
screen with the same calm feel, and 44 pt is still a comfortable target.

### 5.3 Corner radii

Unchanged: Ask box 14, lists and inputs 12, buttons 10, rows 8. Removing the unused `Corner.window` is already in #150. System controls (switches, segmented pickers, menus) keep their own system radii.

### 5.4 Colour roles per theme

Five themes stay: Light, Dark, Navy, Rose, Sun. Cris chose them, and once the tokens are one table a theme costs
little. Roles are unchanged (`ground`, `surface`, `surface-2`, `line`, `lineStrong`, `ink`, `ink-2`, `primary`,
`accent`, `ok`, `warn`, `bad`) with three changes and one new role:

| Change | Theme | v3.2 | v4 | Contrast | Why |
|---|---|---|---|---|---|
| **changed** `ground` | Light | #FFFFFF to #ECEEF2 wash | flat #F5F6F8 | ink 16.9, ink-2 5.9, accent 6.0, lineStrong 3.4 | The only gradient in the app; at the top it equals the white surface, so fields and lists had no edge (review 3.12) |
| **changed** `bad` | Navy | #F07167 | #FF8A80 | 5.5 on surface-2, 6.5 on surface, 7.5 on ground | Was 4.3 on surface-2, under 4.5 for text (review 3.12); `bad` is used for Failed, Never and Offline |
| **new** `selection` | all | "accent at 12%" written in prose | a named token: accent at 12% over surface | ink on it 15.2 (Light) | One value instead of a number repeated in code. The tint alone is only 1.0 to 1.5:1 against its neighbours, so it always comes with a second cue: the 3 pt accent bar of v3.2 or the system selection |

Everything else in section 9 and in `Theme.swift` (including #146's `lineStrong` and `lineHigh`) is unchanged.

### 5.5 Elevation

Unchanged and now explicit: one shadow, on the Ask box panel (today drawn by the app at `helper/AskBox.swift:114`). Menus and popovers use the system
shadow. No shadows on lists, cards, buttons or the question card. The reference's hard offset shadows are rejected
(section 2).

### 5.6 Motion

Unchanged: 150 ms for a state change, 220 ms for the sidebar. **New rules:** changing page is instant (no fade);
the Allow or Deny question appears without animation (today the card height animates, `helper/AskBox.swift:121-125`; added to #139), and its short wait is shown as words, not a moving bar; with
Reduce Motion nothing moves.

### 5.7 Icons

SF Symbols, regular weight, monochrome, 16 pt in lists. Sidebar: Home `house`, Conversations
`bubble.left.and.bubble.right`, Memory `note.text`, Jobs `tray.full`, Personal `person.crop.circle`, Settings `gearshape`.
Status shapes stay as #140 and #143 shipped them.

---

## 6. Per screen

Each row: today (what the code does on `qa` at `0c639dd`), proposed, why, and the story it belongs to. New stories are
S1 to S8 (section 9); existing ones are linked by number.

### 6.1 Menu bar item and its menu
- **Today:** a template symbol per state with words in the menu (#143, merged). Good.
- **Proposed:** no visual change. Menu wording follows #142 (one name per thing, no Terminal commands).
- **Why:** it already follows the HIG for menu bar extras.

### 6.2 Ask box
- **Today:** a 360 pt panel with a drag strip, the chat thread, the field and a ⋯ menu (`helper/AskBox.swift`). Calm,
  safe Esc order, refuses to close while a question waits.
- **Proposed:**
  - Top strip: keep the drag handle and Close; add Stephen's state as a word ("Ready", "Listening", "Working",
    "Stopped") in `ink` with a status dot, next to ⋯ (S9). The old chat title moves into the ⋯ menu.
  - Field placeholder "Type, hold F5, or say Hey Stephen" and a visible Send button (#142, #149 pattern).
  - Each of Cris's messages that was not typed shows its source under the bubble ("From: F5", "From: Hey Stephen",
    "From: Phone"), in #142's words, the same in Conversations.
  - Type roles and tokens from section 5 (S1, S2).
- **Why:** the box is for talking; the state word answers "is it listening?" without looking at the menu bar.

### 6.3 Home
- **Today:** a centred greeting (34 pt), the date, a big composer, three chips, a one-line Today summary
  (`helper/HomeView.swift`).
- **Proposed:**
  - Greeting at 26 pt (S1). The composer and chips stay.
  - **Next up line** under the date, from the calendar Stephen already reads: "Next: CSCI 3310 lab at 2:00 PM, in 45
    minutes" or "Nothing else on your calendar today". Read-only, one line, no card. It replaces the Today line
    when nothing waits; the "question waiting" case is #138 (S8).
  - A waiting question shows as a banner at the top (#138).
  - New chat button, composer focused, shortcut hints (#149).
- **Why:** the reference's best idea is one concrete line about what is next. It makes Home useful without a dashboard.

### 6.4 Conversations
- **Today:** rows with the request, the steps and refusals, filter and search (`helper/ConversationsPage.swift`).
- **Proposed:**
  - One sentence under the title: "What you asked, what Stephen did, and what it refused. The list is saved on this Mac." (S4)
  - Day headers ("Today", "Yesterday", then dates) and list rows with an eyebrow (source in #142's words and time), a title (the
    request, verbatim), one facts line in the chat's format ("3 steps · 1 refused", never just "done") and the status word with its shape (S5).
  - A "Loading" line while the first load runs (S5; no story had it, review 3.4).
- **Why:** a long record reads faster as a dated list than as boxed rows.

### 6.5 Memory
- **Today:** graph and list views, an inspector column, Keep or Skip for proposals (`helper/MemoryPage.swift`).
- **Proposed:**
  - Keep the graph (Cris asked for it). Small windows and Undo for Forget are #148.
  - One sentence under the title: "Things Stephen remembers about you. It only saves what you tell it or keep." (S4)
  - List view uses the S5 row: eyebrow (kind and where it came from), title (the fact, verbatim), Forget.
  - Graph labels at 12 pt (S1).
- **Why:** the safety rule (the model never writes memory) should be visible in words on the page itself.

### 6.6 Jobs
- **Today:** rows with a status pill, opened by a tap gesture (`helper/JobsPage.swift`).
- **Proposed:**
  - One sentence under the title: "Long tasks Stephen runs in the background. Each summary is written by the job:
    check it before you rely on it." (S4; keeps today's caution)
  - S5 rows: eyebrow ("Started 2:10 PM"), title, facts ("about $0.12 of Claude usage"), status word and shape. The chevron
    and real buttons for the keyboard are #145.
  - Empty state: "No jobs yet. Say 'start a job to find 5 internships'." (S4; only that phrase starts a job)
- **Why:** same list pattern everywhere, and the words explain the money line (#142).

### 6.7 Personal
- **Today:** grouped lists (About you, Memory, Connected, Routines) and the permission table
  (`helper/PersonalView.swift`).
- **Proposed:** keep the grouped lists; they are the System Settings pattern and they work. Field name as the row
  title and the value on the right (#142). One sentence under the title: "What Stephen knows about you and what it may
  do. Forget a memory here; some rules can be changed in Settings, Privacy and safety." (S4; the page is view only
  except Forget)
- **Why:** this page is already the most Mac-like in the app.

### 6.8 Settings
- **Today:** two navigation columns, two large titles, a custom segmented control, system switches with hidden labels
  (`helper/SettingsPage.swift`, `helper/Components/Controls.swift`).
- **Proposed:**
  - ⌘, opens the last pane, one title, captions (#147).
  - Then: each pane is a `Form` with `.formStyle(.grouped)`, system `Toggle` and `Picker`, a label on every control,
    the theme still applied (S7).
- **Why:** System Settings is the pattern Cris already knows on his Mac; system controls behave right with the keyboard
  and VoiceOver without extra code.

### 6.9 The Allow or Deny question
- **Today:** "Needs your OK", the exact question verbatim, Deny then Allow, both off for 0.75 s, Esc denies, no
  default button, never voice (`helper/Components/ChatThread.swift`, `helper/AskBox.swift`).
- **Proposed (look only; every rule stays):**
  - The card gets a 1.5 pt `warn` outline all round (no side stripe), so it stands out in every theme without a new
    colour (added to #139). The label stays "Needs your OK"; #142 may rename it to "Stephen asks first" if Cris
    agrees. The computed title and the scrolling facts body are unchanged.
  - Source line ("From: F5"), "Ready in a moment" while the buttons wait, and a record line after the click
    ("You allowed: send email to ...") are #139.
  - Visible on every page as a banner (#138).
- **Why:** this is the most important moment in the app; it should be the most distinct shape, not the loudest colour.

### 6.10 First run and permissions
- **Today:** no first-run screen; missing permissions show as a menu bar mark and menu lines.
- **Proposed:** the "Set up Stephen" checklist (#141), drawn as a grouped list with one status word and one button per
  row (Rectangle and Maccy as patterns).

### 6.11 Window frame and sidebar
- **Today:** a hand-built sidebar with an uppercase "STEPHEN" label under the "Stephen" wordmark, Start and Stop at
  the bottom (`helper/MainWindow.swift`, `helper/Components/Sidebar.swift`).
- **Proposed:** a `NavigationSplitView` sidebar: system selection and material, sentence-case section labels (the first label,
  "STEPHEN", is dropped because the wordmark already says it; "You" stays), a Memory row at ⌘6 (⌘1 to ⌘5 keep their pages, so #149's hints hold), the state word and Start
  at the top of the sidebar under the wordmark, where the HIG wants important controls, including today's "Running in
  Terminal" state (S6). **Decision for Cris:** the system sidebar hides fully; v3.2's 60 pt icon rail would go.
- **Why:** the most visible "this is a Mac app" change, and it removes code the system already provides.

---

## 7. What NOT to change

Product safety rules (any v4 change that touches them is rejected):
- Approvals are a click on Allow or Deny next to the exact question. Never voice, never a keyboard shortcut for Allow,
  Return never allows, Esc denies, and the buttons stay off for 0.75 s each time the question changes.
- Page, mail and model text is always shown verbatim (`Text(verbatim:)`), never as Markdown or links. This includes
  the new Next up line (calendar titles) and every list row title.
- The source of a command (typed, F5, wake word, phone) is visible.
- Steps and refusals are a truthful record: no summarising away a refusal, no hiding a failed step.
- The Ask box refuses to close while a question waits.
- The model never writes memory; Stephen proposes, Cris keeps.

Things that work and stay:
- The five themes and their measured palettes (#146 outlines included).
- The Ask box as a menu bar panel, its drag strip and pin option.
- Home's empty composer with chips.
- Personal's grouped lists and the permission table.
- The Memory graph.
- Reduce Motion support and the status shapes of #140 and #143.

---

## 8. Order (smallest and most visible first; big layout after C5)

1. **S3 contrast test** first: it guards every later token change. TS only.
2. **S1 type roles**, **S2 tokens** and **S9 Ask box state word**: two small Swift edits in `Theme.swift` plus call sites; visible on every page.
3. **S4 page intro lines and empty states**: words only, every page.
4. Existing stories already queued: #138 (open as PR #180), #149, #147, #145; #148's layout is on branch
   `feat/memory-layout-148` (no PR yet). v4 items that touch the same files wait for those: S6 after #180
   (`MainWindow.swift`), S5's Memory list after #148, S7 after #147.
5. **S7 Settings on system controls**, after #147 lands (same file).
6. After the `AppClient.swift` split (C5, #56) and #57 (section pages):
   **S5 list rows**, **S6 native sidebar** (owns the system sidebar material too) (coordinate with #57, it may fold in), **S8 Next up line** (needs a new
   read-only message, which touches `AppClient.swift`), and #139, #141, #142.

---

## 9. New stories (gaps only)

Each is a GitHub issue with the label `enhancement`, linked from the tracking issue.

| Id | Story | Size | Waits for |
|---|---|---|---|
| S1 | Type roles v4: calmer titles, sentence-case section labels, an eyebrow role | S | none |
| S2 | Theme tokens v4: flat Light ground, Navy `bad`, a `selection` token | S | none |
| S3 | A test that checks contrast of the theme tokens | S | none |
| S4 | One plain sentence under each page title, and honest empty states | S | none |
| S5 | Lists, not boxes: one list row for Conversations, Jobs and the Memory list | M | C5, #57 |
| S6 | Native sidebar (`NavigationSplitView`) with a Memory row and the state at the top | M | C5, #57 |
| S7 | Settings panes on system controls (`Form`, `Toggle`, `Picker`) | M | #147 |
| S8 | Home "Next up" line from the calendar | M | C5 |
| S9 | Ask box top strip: Stephen's state as a word | S | none |

Extended, not new: #139 gets the card's warn outline and "no animation when the card appears".

---

## 10. Sources

| Source | Use | Licence |
|---|---|---|
| Campus planner on Base44 (`ridge-track-campus.base44.app`), Cris's reference | Content patterns only (section 2) | Inspiration only; nothing copied, no screenshots committed |
| Apple Human Interface Guidelines: The menu bar, Popovers, Sidebars, Settings, Alerts, Privacy, Typography, Color | Platform rules | Inspiration only (Apple documentation) |
| SwiftUI and SF Symbols | The building blocks | Apple platform, free to use in Mac apps |
| WCAG 2.2, 1.4.3 and 1.4.11 | Contrast rules | W3C, free to cite |
| Maccy, Rectangle, Stats, CodeEdit, NetNewsWire, Settings | Patterns (section 4) | MIT; read only |
| Ice, Loop | Patterns (section 4) | GPL-3.0; read only, never copy |
| Lucide, Phosphor | Fallback icons, not used | ISC, MIT |
| Inter | Considered, rejected | OFL-1.1 |
| `docs/UI-PLAN.md`, `docs/research/UI-REVIEW-2026-11.md` (PR #133) | Stephen's own plan and review | This repo |

---

## 11. Review

An independent review (Opus) checked this doc and the mocks for AI-slop patterns, accessibility (contrast per theme,
keyboard, VoiceOver, Reduce Motion) and the safety rules. Its findings and what changed are in section 12.

## 12. Review findings and changes

The Opus review (2026-11-17) found 29 items: 3 blockers, the rest should-fix or nits. All were fixed in this doc,
the mock and the stories before filing. The main ones:
- **Blockers fixed:** the mock's "What Stephen may do" table now matches `src/app/personal.ts` (it made the rules look
  stricter than they are); the Personal sentence no longer says "you can change any of it" (the page is view only
  except Forget); the question card mock uses the real computed title and facts body instead of an invented title.
- **Truth in copy:** Jobs only start with "start a job to ..."; the Jobs caution "check it before you rely on it"
  stays; Memory saves what you tell it or keep; "The list is saved on this Mac" instead of "Kept on this Mac".
- **Same words everywhere:** source words are #142's (Typed, F5, Hey Stephen, Phone); Refused is the raised hand in
  `warn`, Failed is the x in `bad`, as #140 shipped; facts lines carry refused and failed counts.
- **Contrast:** every text pair passes 4.5:1 in all five themes. Two non-text cues did not: the selection tint alone
  (fixed by keeping the 3 pt accent bar) and the white switch knob on the Dark and Navy accent (dark knob; S3 checks
  it, S7 must keep it).
- **Accuracy:** the Ask box shadow is drawn by the app; Settings already uses system switches; 22 pt is the Title 1
  style; Settings icon is `gearshape`; Memory goes at ⌘6 so ⌘1 to ⌘5 keep their pages.
- **Duplicates removed:** job row buttons and chevrons (#145), `Corner.window` and the row divider (#150), the card
  heading rename (#142); the sidebar material lives only in S6.
- **Design hook (impeccable):** the leading warn stripe on the question card was flagged as a "side tab" AI pattern
  and replaced by a full outline; cramped padding in chips and tags fixed. The "card inside a card" flag is the
  question card inside the Ask box panel: kept, because the question must read as its own object.
