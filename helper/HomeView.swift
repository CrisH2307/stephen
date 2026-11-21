// Stephen Helper: Home (UI-V4-IA-PLAN section 6.1), a chat layout. With no messages: "Morning, Cris.", the date and the
// Next up line ("1 job running · See jobs", or "Nothing waiting"; only what app.sock already knows), a large centred
// composer with Talk and Send, three suggestion chips, and the Recent accordion. With messages: the same thread as the Ask box (ChatThreadView)
// and the composer at the bottom. No weather, no cards. The chat title and New chat (⌘N) are in the window toolbar
// (UI v4, MainWindow.swift).
//
// Motion: one layout, not two swapped views. The composer is the same view in both states; the space under it shrinks
// to nothing when the chat starts, so the composer glides from the centre to the bottom while the greeting and chips
// fade out and the thread fades in (above and below it, never pushing it). Instant with Reduce Motion.

import SwiftUI

/** "Morning, Cris." / "Afternoon." Name is the first word of voice.aboutMe.name; none when it isn't set. */
func homeGreeting(hour: Int, name: String) -> String {
  let part = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening"
  let first = name.split(separator: " ").first.map(String.init) ?? ""
  return first.isEmpty ? "\(part)." : "\(part), \(first)."
}

/// A past chat's status word for Home's Recent (plan 6.1). A refusal is named first and never called done; a
/// failed step or an error is Failed. Same words and shapes as Conversations and the chat (#140).
func recentChatWord(_ entry: HistoryEntry, lines: [DoneLine]) -> (word: String, kind: StatusKind) {
  if lines.contains(where: { $0.status == .refused }) { return ("Refused", .warn) }
  if entry.outcome == "error" || lines.contains(where: { $0.status == .failed }) { return ("Failed", .bad) }
  if entry.outcome == "cancelled" { return ("Stopped", .idle) }
  return ("Done", .ok)
}

/// "Recent (3, 1 refused)": the closed accordion still counts the problems in it (plan section 6).
func recentChatsTitle(_ words: [String]) -> String {
  var parts = ["\(words.count)"]
  let refused = words.filter { $0 == "Refused" }.count, failed = words.filter { $0 == "Failed" }.count
  if refused > 0 { parts.append("\(refused) refused") }
  if failed > 0 { parts.append("\(failed) failed") }
  return "Recent (\(parts.joined(separator: ", ")))"
}

/** Suggestion chips: a click puts the words in the field, nothing is sent until Send. */
let HOME_SUGGESTIONS = ["Plan my day", "Find internships", "Start a job"]

struct HomeView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let actions: WindowActions
  @FocusState private var composerFocused: Bool

  /// The composer text lives in WindowNav, so the ⌘K palette's Ask row can fill it (it never sends).
  private var draft: String {
    get { return nav.draft }
    nonmutating set { nav.draft = newValue }
  }

  /// No messages yet in this chat (a waiting question or a running command counts as a chat).
  private var isEmpty: Bool { return model.thread.isEmpty && model.confirms.isEmpty && !model.isWorking }

  /// What the composer's glide follows: messages or work, never the waiting questions, so a question never animates in
  /// or out, before or during a chat (#139).
  private var glide: Bool { return model.thread.isEmpty && !model.isWorking }

  var body: some View {
    let empty = isEmpty
    VStack(spacing: Space.m) {
      // Above the composer: the greeting (empty, sits on the composer) or the title and thread (chat, fills).
      ZStack(alignment: empty ? .bottom : .top) {
        if empty { greeting.transition(.opacity) } else { thread.transition(.opacity) }
      }
      .frame(maxHeight: .infinity)
      composer
      // Under the composer: chips and Today while empty. It takes half the free height (so the composer sits in the
      // middle), then none once the chat starts, which is what moves the composer down.
      ZStack(alignment: .top) {
        if empty { extras.transition(.opacity) }
      }
      .frame(maxHeight: empty ? .infinity : 0, alignment: .top)
      .clipped()
    }
    .frame(maxWidth: 720)
    .padding(.horizontal, Space.xxl).padding(.vertical, Space.xl)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .stephenAnimation(Motion.bar, value: glide)
    // Ready to type again: after New chat (toolbar, ⌘N) and when the palette closes (its Ask row fills the composer).
    .onChange(of: empty) { e in if e { composerFocused = true; refreshRecent() } }
    .onChange(of: nav.paletteOpen) { open in if !open { composerFocused = true } }
    .onAppear {
      model.refreshSettings()  // the name for the greeting
      model.refreshJobs()
      refreshRecent()
      // Ready to type when Home opens (#149). Next turn: the field must be in the window before it can take focus.
      DispatchQueue.main.async { composerFocused = true }
    }
  }

  private var greeting: some View {
    let now = Date()
    return VStack(spacing: Space.xs) {
      Text(verbatim: homeGreeting(hour: Calendar.current.component(.hour, from: now), name: model.ownerName))
        .font(TypeScale.homeTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
      Text(verbatim: now.formatted(date: .complete, time: .omitted)).font(TypeScale.body).foregroundColor(t.ink2)
      nextUp.padding(.top, Space.xs)
    }
    .padding(.bottom, Space.l)
  }

  /// The one composer, the same in both states (large, Talk and Send).
  private var composer: some View {
    HStack(spacing: Space.s) {
      AskField(text: $nav.draft, onMic: actions.talk, large: true, onSubmit: send).focused($composerFocused)
      PrimaryButton("Send", action: send)
    }
  }

  private var extras: some View {
    VStack(spacing: Space.m) {
      HStack(spacing: Space.s) {
        ForEach(HOME_SUGGESTIONS, id: \.self) { s in Tag(s) { draft = s } }
      }
      if !model.history.isEmpty { recentChats.padding(.top, Space.s) }
    }
  }

  /// Messages: the same thread as the Ask box. The title and New chat are in the toolbar.
  private var thread: some View {
    ChatThreadView(model: model, links: ChatLinks(permissions: { selectSettingsPane(.privacy); nav.page = .settings }))
      .frame(maxHeight: .infinity)
  }

  /// Next up (S8, R8): facts only. Running jobs first; else "Nothing waiting". The "Plan my day" chip asks about the day,
  /// so there is no second "What's my day?" link. (A waiting question is never here: it makes the chat non-empty, so
  /// Home shows the card instead, and the banner shows on every page, #138.)
  /// ponytail: no calendar item yet. app.sock has no calendar read; add it with a read-only request (S8, C5).
  private var nextUp: some View {
    let running = model.jobs.filter { $0.isRunning }.count
    return HStack(spacing: Space.s) {
      if running > 0 {
        Text(verbatim: "Next up:").font(TypeScale.secondary.weight(.medium)).foregroundColor(t.ink2)
        Text(verbatim: running == 1 ? "1 job running" : "\(running) jobs running").font(TypeScale.secondary).foregroundColor(t.ink)
        Text(verbatim: "·").font(TypeScale.secondary).foregroundColor(t.ink2).accessibilityHidden(true)
        Button { nav.page = .jobs } label: {
          Text(verbatim: "See jobs").font(TypeScale.secondary.weight(.medium)).foregroundColor(t.accent)
            .frame(minHeight: 24).contentShape(Rectangle())  // a 24 pt target (#149)
        }
        .buttonStyle(.plain).accessibilityLabel("See jobs")
      } else {
        Text(verbatim: "Nothing waiting").font(TypeScale.secondary).foregroundColor(t.ink)
      }
    }
    .frame(minHeight: 24)
    .accessibilityElement(children: .contain)
  }

  /// The 3 newest chats, closed by default (owner's option B). Each row: what you said (verbatim, one line) and its
  /// status word. Only "View all" acts: it opens Conversations.
  private var recentChats: some View {
    let rows = model.history.prefix(3).map { e -> (entry: HistoryEntry, word: (word: String, kind: StatusKind)) in
      (entry: e, word: recentChatWord(e, lines: conversationLines(entry: e, audit: model.audit, parse: model.parseDate)))
    }
    return Accordion(recentChatsTitle(rows.map { $0.word.word }), key: "acc.home.recent") {
      VStack(alignment: .leading, spacing: Space.s) {
        ForEach(rows, id: \.entry.id) { r in
          HStack(spacing: Space.s) {
            Text(verbatim: r.entry.said).font(TypeScale.secondary).foregroundColor(t.ink).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: Space.s)
            StatusPill(r.word.word, kind: r.word.kind)
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel("You said: \(r.entry.said). \(r.word.word).")
        }
        Button { nav.page = .conversations } label: {
          Text(verbatim: "View all").font(TypeScale.secondary.weight(.medium)).foregroundColor(t.accent)
            .frame(minHeight: 24).contentShape(Rectangle())  // a 24 pt target (#149)
        }
        .buttonStyle(.plain).accessibilityLabel("View all conversations")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /** Recent and their status words (refusals come from the audit log, as in Conversations). */
  private func refreshRecent() { model.refreshHistory(); model.refreshAudit() }

  private func send() {
    if model.sendChat(draft) { draft = "" }  // the reply shows right here in the thread
  }
}
