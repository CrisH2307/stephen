// Stephen Helper: Home (UI-V4-IA-PLAN section 6.1), a chat layout. With no messages: "Morning, Cris.", the date and the
// Next up line ("1 job running · See jobs", or "Nothing waiting"; only what app.sock already knows), a large centred
// composer with Talk and Send, three suggestion chips. With messages: the same thread as the Ask box (ChatThreadView)
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
    .stephenAnimation(Motion.bar, value: empty)
    // Ready to type again: after New chat (toolbar, ⌘N) and when the palette closes (its Ask row fills the composer).
    .onChange(of: empty) { e in if e { composerFocused = true } }
    .onChange(of: nav.paletteOpen) { open in if !open { composerFocused = true } }
    .onAppear {
      model.refreshSettings()  // the name for the greeting
      model.refreshJobs()
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
    }
  }

  /// Messages: the same thread as the Ask box. The title and New chat are in the toolbar.
  private var thread: some View {
    ChatThreadView(model: model).frame(maxHeight: .infinity)
  }

  /// Next up (S8, R8): facts only. Running jobs first; else "Nothing waiting". The "Plan my day" chip asks about the day,
  /// so there is no second "What's my day?" link. (A waiting question is never here: it makes the chat non-empty, so
  /// Home shows the card instead, and the banner shows on every page, #138.)
  /// ponytail: no calendar item yet. app.sock has no calendar read; add it with a read-only request (S8, C5).
  private var nextUp: some View {
    let running = model.jobs.filter { $0.isRunning }.count
    return HStack(spacing: Space.s) {
      Text(verbatim: "Next up:").font(TypeScale.secondary.weight(.medium)).foregroundColor(t.ink2)
      if running > 0 {
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

  private func send() {
    if model.sendChat(draft) { draft = "" }  // the reply shows right here in the thread
  }
}
