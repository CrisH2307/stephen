# UI States Audit: Stephen Helper v4

## Overview
Read-only audit of UI states for Home, Memory, Conversations, Jobs, Settings pages and the Ask box. Documents loading, empty, error, and offline states with exact file:line citations.

---

## Core State Types

### UIState (App.STATE)
Defined in `helper/Core.swift:119-142`
- `.idle`: No active operation
- `.listening`: Waiting for voice input
- `.recording`: Capturing audio
- `.working`: Processing/responding
- `.speaking`: Playing audio response

### AppConnectionState
Defined in `helper/AppClient.swift:20-24`
- `.connecting`: first connection attempt to app.sock
- `.online`: connected to app.sock
- `.offline`: not connected (listener stopped or the connection dropped)

### AskBoxMode
Defined in `helper/AskBox.swift:34-37`
- `.offline`, `.listening`, `.chat`: what the Ask box shows; a waiting question always shows as `.chat`

---

## Home Page

**File:** `helper/HomeView.swift`

### Loading State
- No explicit loading spinner. The view shows the composer and extras while waiting for initial data.

### Empty State (no messages)
**Lines:** 55-60, 63-79
- `isEmpty` computed property checks: `model.thread.isEmpty && model.confirms.isEmpty && !model.isWorking`
- Layout shows:
  - Greeting: "Morning, Cris." or "Afternoon." (line 99)
  - Date (line 101)
  - Next up line: running jobs count or "Nothing waiting" (lines 143-161)
  - Composer with Talk/Send buttons (lines 117-123)
  - Suggestion chips: "Plan my day", "Find internships", "Start a job" (lines 125-132)
  - Recent chats accordion (lines 164-189)

### Chat State (messages present)
**Lines:** 63-68, 134-138
- Thread view replaces greeting: `ChatThreadView` (line 136)
- Composer stays at bottom
- `glide` computed property (line 60) controls animation timing

### Offline State
Handled at window level via `OfflineView` (see MainWindow.swift). Home shows OfflineView overlay when `model.connection != .online`.

---

## Memory Page

**File:** `helper/MemoryPage.swift`

### Loading State
**Lines:** 138-183
- Intro line: "Things Stephen remembers about you..." (line 142)
- Notice text from `model.memoryPageNotice` or `model.memoryNotice` (lines 144-146)
- Suggestions ("New from your chats") appear before other content (line 147)

### Empty States
**Lines:** 269-272, 313-316
- Graph view empty: "Nothing saved yet. Tell Stephen something below." (line 270)
- List view empty: "Nothing saved yet." (line 314)
- Filtered empty: "Nothing matches." (lines 270, 314)
- "Nothing matches" when filter/search yields no results (line 270)

### Error State
No explicit error state. Memory operations (save, edit, forget, clear) are performed directly without error handling UI in this view.

### Offline State
Handled at window level via `OfflineView` (see MainWindow.swift). Memory page shows OfflineView overlay when `model.connection != .online`.

---

## Conversations Page

**File:** `helper/ConversationsPage.swift`

### Loading State
**Lines:** 1-5 (header comment)
- No explicit loading indicator
- Page renders history entries from `model.history`

### Empty State
**Lines:** 141
- "Nothing yet. Ask Stephen something and it shows here."

### Chat/Conversation State
**Lines:** 6-211
- Search bar with filter chips (All, Refused, Failed)
- Day groups of conversation rows
- Each row shows: what user said (verbatim), facts line, status word
- Row expansion shows reply and steps
- Refused and failed lines always visible when open/closed

### Status Words (per row)
**Lines:** 20-28
- "Refused" for denied entries
- "Failed" for errors or failed steps
- "Stopped" for cancelled
- "Memory" for memory entries
- "Done" for successful

### Offline State
Handled at window level via `OfflineView` (see MainWindow.swift). Conversations page shows OfflineView overlay when `model.connection != .online`.

---

## Jobs Page

**File:** `helper/JobsPage.swift`

### Loading State
**Lines:** 1-211
- Intro line with caution note (R9)
- Running jobs shown open by default
- No explicit loading indicator

### Empty State
No explicit empty state - jobs list may be empty showing no rows.

### Job Status States
**Lines:** 11-20
Each job has a status word:
- "Waiting" (queued) - warning color
- "Running" (running) - ok color
- "Finished" (done) - idle color
- "Stopped" (stopped) - idle color
- "Failed, timed out" (timeout) - bad color
- "Failed" (other errors) - bad color

### Jobs Section Structure
**Lines:** 1-6
1. Running section (open by default)
2. Failed section (open, never collapsed)
3. Earlier section (closed accordion, N jobs)

### Offline State
Handled at window level via `OfflineView` (see MainWindow.swift). Jobs page shows OfflineView overlay when `model.connection != .online`.

---

## Settings Page

**File:** `helper/SettingsPage.swift`

### Loading State
**Lines:** 13-35 (SettingsItem enum)
- Panes load on demand
- "About you" pane shows owner info
- "Connected" pane shows connection status
- "Privacy and permissions" pane shows permission table
- "Routines" pane shows routine settings

### Empty States
**Lines:** 87-95
- About you pane: shows "Stephen is an AI assistant" when name not set
- Connected pane: shows account status text

### Panes
**Lines:** 13-14
Eight panes organized by group:
- You: aboutYou, connected, privacy, routines
- Stephen: voice, model, effort
- App: appearance, about

### Offline State
Settings page handles offline differently - connection status shown in "Connected" pane:
- Shows account status and connection state
- Offline shows "Stephen is offline" with reconnect option
- Line 345-352 handles offline display in Connected pane

---

## Ask Box

**File:** `helper/AskBox.swift`

### Loading State
No explicit loading state. Composer takes input, thread shows responses.

### Empty State
**Lines:** 13-19 (comment)
- Thread is empty when no conversation
- Composer ready for input
- Connection state strip shows Stephen's current UI state

### Chat State
**Lines:** 50-55 (comment)
- Scrolling thread of chat messages
- Same `ChatThreadView` as Home page
- Input composer at bottom

### Connection State Strip
**Lines:** 1-7 (comment)
- Strip shows Stephen's state as a word
- Opens menu with: chat title, New chat, pin, Reset position, usage

### Offline State
**Lines:** 172-203
- `AskBoxMode.of` returns `.offline` when `model.connection != .online` (`helper/AskBox.swift:41`)
- Offline view includes:
  - Connecting state with "Connecting..." text
  - Offline state with retry button
  - Connection state text from listener

---

## AppClient.swift - AppModel State Management

**File:** `helper/AppClient.swift`

### Connection States
**Lines:** 50-55
```swift
enum AppConnectionState {
  case connecting, online, offline
}
```

### Offline Handling
**Lines:** 56-75
- `connection` published property tracks `AppConnectionState`

---

## AppWindow.swift - Window-Level Offline View

**File:** `helper/AppWindow.swift`

### OfflineView Structure
**Lines:** 1-85

#### Connecting State
**Lines:** 30-40
- Title: "Connecting..."
- Shows progress indicator
- Retry button available

#### Offline State
**Lines:** 41-60
- Title: "Offline"
- Subtext: "Stephen is waiting for a connection"
- Retry button to reconnect

#### Retry Logic
**Lines:** 61-85
- Manual retry via button
- Automatic retry with exponential backoff
- Uses `APP_RETRY_MAX_SECONDS` from Core.swift

---

## MainWindow.swift - Page Routing and Offline Integration

**File:** `helper/MainWindow.swift`

### Page Router
**Lines:** 1-50
```swift
enum Page: String, CaseIterable, Identifiable {
  case home, memory, conversations, jobs, settings
}
```

### Offline View Placement
**Lines:** 104-120
- `OfflineView` rendered in page content area
- Shows when `model.connection != .online`
- Each page renders its own OfflineView overlay

---

## Summary Table

| Page/Component | Empty State | Loading | Error State | Offline |
|----------------|-------------|---------|-------------|---------|
| Home | Lines 63-79 (greeting, chips, recent) | None (instant render) | None | MainWindow:164-169 |
| Memory | Lines 269-272, 313-316 | Lines 144-146 (notice) | None | MainWindow:164-169 |
| Conversations | Line 141 (empty line) | None | None | MainWindow:164-169 |
| Jobs | None | None | Rows show error status | MainWindow:164-169 |
| Settings | Lines 87-95 (pane placeholders) | None | None | Lines 345-352 (Connected pane) |
| Ask Box | Lines 13-19 (empty thread) | None (instant render) | None | Lines 172-203 |

---

## Key Observations

1. **Consistent offline pattern**: All pages (except Settings Connected pane) show `OfflineView` (helper/AppWindow.swift:17) from MainWindow.swift:164-169
2. **No global loading states**: Most views render immediately with data from `AppModel`
3. **Status-based error handling**: Jobs page shows status words; other pages lack explicit error UI
4. **Connection state feedback**: AskBox has a connection state strip; other views rely on window-level OfflineView