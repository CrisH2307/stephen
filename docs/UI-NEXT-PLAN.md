# UI next steps (from the owner's Mac test of v3.2, 2026-11-08)

Status: a plan for the main agent to order and decide. Only the bugs below were fixed (PR `ui/chat-fixes`); everything
else here is not built. Questions for the owner are at the end.

## Fixed now (bugs)
1. **Chat title.** The Ask box strip shows a title made from your first message (40 characters, "New chat" when empty),
   like other chat apps. Home shows the same title above the thread. No model call: a generated summary would cost a
   Claude run per chat, so start simple and upgrade later if wanted.
2. **The ⋯ menu could not be clicked.** An AppKit drag view sat under the button and took the click. The drag area is
   now beside the button.
3. **No way to start a new chat from Home** (only a hidden ⌘N). Home's thread view has a "New chat" button next to the
   title. Old chats are in Conversations.

## 1. Recent chats on Home (not built)
The problem: once you are in a thread, nothing says where the other chats are. Options:

| Option | Good | Bad |
|---|---|---|
| A. Recents in the sidebar (ChatGPT, Claude, Gemini) | always visible, one click from any page, familiar | sidebar gets long and busy, competes with the five pages, hard in the 60 pt rail |
| B. A few recents under the composer on the empty Home, "View all" opens a page (Claude home) | calm, Home stays the front door, the sidebar stays short | only visible on the empty Home, so inside a chat you need New chat first |
| C. Both: B plus a "Chats" entry or small list in the sidebar | best discovery | two places to maintain |

Recommendation: **B first** (it matches what the owner liked: few items plus "View all"). "View all" is the existing
Conversations page, extended so a row can be opened as a chat. Add **Recents in the sidebar later** only if B feels
hidden. Needs a read-only way to open an old chat in the thread: either `chat.history` (new app.sock request, TS mirror
test) or show it read-only from `history.list` with "Continue" starting a fresh chat that quotes it.
Open question: should "continue an old chat" really resume it (the listener keeps one warm conversation, so a resume
means replaying context) or just show it read-only?

## 2. Replies and actions look different (not built)
Chat apps show the answer as the main text and the work as a small collapsible block under or above it. For Stephen:
- The reply stays a bolder block (larger text, normal ink).
- The actions become a small "chain" section above the reply: one line per step ("Searched LinkedIn", "Opened a new tab",
  "Clicked Hai Phan"), collapsed by default to "3 steps · 9.8 s", expandable. Refusals are named in words.
- Data: today `chat.done` carries only tool names and time. Per-step lines need either the audit log joined by time (what
  Conversations already does, `conversationLines`) or a new `steps` list on `chat.done` (TS change, mirror test).
  Live steps while working ("Working…" becomes the latest step) need a new push message.
Risk: audit-by-time can mix two commands. A `steps` field from the listener is cleaner. Suggest doing `steps` on
`chat.done` first, live steps later.

## 3. More sidebar pages: Connected, What Stephen may do, Routines, Memory (not built)
Today these live on **Personal** (About you, Memory, Connected, Routines, What Stephen may do) and partly in **Settings**.
Duplication found:
| Thing | Where it shows now | Duplicate? |
|---|---|---|
| Connected accounts | Personal > Connected, Settings > Accounts, Settings > Browsers, Settings > Phone link | yes, three places |
| What Stephen may do | Personal table, Settings > Privacy and safety (text) | yes, table and prose |
| Memory | Personal (2 newest), Memory page, Ask box "Review memory" | Memory page is the full one, Personal only a summary |
| Routines | Personal only | no |
| About you | Personal, and Settings > How Stephen talks (name used in greeting) | small |

Proposal (keeps the sidebar short, removes duplicates):
- Sidebar section **Stephen**: Home, Conversations, Jobs. Section **You**: **Personal** (About you only, plus links),
  **Memory**, **Connected**, **Routines**, **Permissions** (the "What Stephen may do" table, with the Privacy and safety
  text moved into it). **Settings** keeps only preferences: How Stephen talks, Model and effort, Appearance, Wake word and
  F5.
- Settings > Accounts, Browsers and Phone link move into **Connected** (one list: accounts, browsers, phone, each with its
  state and fix button).
- That is 4 new rows, so the sidebar goes from 5 to 8 pages. Shortcuts: ⌘1 to ⌘9 would cover them, but the sidebar
  gets long. Alternative: keep the five and use tabs inside Personal (About, Memory, Connected, Routines, Permissions).
  Tabs avoid a long sidebar but hide the pages; separate rows match what the owner asked ("individual section navbar").
Recommendation: separate rows as asked, and merge Settings > Accounts/Browsers/Phone into Connected so nothing appears
twice. Do it in two PRs: (1) split Personal into pages, no data changes; (2) move the Settings panes into Connected and
Permissions and delete the old ones.

## Suggested order
1. Fixes in this PR (done).
2. Section pages (3, PR 1): visual only, safe.
3. Recents under the Home composer plus Conversations "View all" (1, option B), read-only open first.
4. Reply versus action chain (2), starting with `steps` on `chat.done`.
5. Move Settings panes into Connected and Permissions (3, PR 2).

## Owner's answers (2026-11-08)
1. Recents: the reviewer pick is **B** (a few under the composer, "View all" page). It keeps Home calm like Claude's home
   and the sidebar short for the eight pages. Sidebar recents can come later if B feels hidden.
2. Opening an old chat: **resume it** (not read-only). Needs `chat.history` plus the listener starting a conversation that
   replays the old turns; decide how many turns to replay (cost and context).
3. Sidebar: **eight pages as separate rows**, packed tight so it looks tidy (smaller row height, no section gaps beyond
   the two labels).
4. Chat title: **model-generated**, kept very simple: after the first reply, one cheap one-shot (Haiku, low effort, a
   fixed prompt that only sees your first message and the reply, no tools) returns 3 to 5 words; until then the first
   message is the title. The title is shown as plain text, never as instructions.

## Questions for the owner (answered above, kept for the record)
1. Recents: option B first (few under the composer, "View all"), sidebar later? Or A or C now?
2. Opening an old chat: read-only, or resume it for real?
3. Sidebar: eight pages (separate rows) or five pages with tabs inside Personal?
4. Chat title: first message is enough, or generate a short title with a model call?
