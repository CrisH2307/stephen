// Stephen Helper: Home (UI-PLAN v3.2 section 6), a chat layout. With no messages: "Morning, Cris." and the date, a
// large centred composer with Talk and Send, three suggestion chips, and Today as one line ("Nothing waiting · What's
// my day?"; only what app.sock already knows, due items and to-dos come from asking). With messages: the same thread
// as the Ask box (ChatThreadView) and the composer at the bottom. No weather, no cards.
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
  @State private var draft = ""
  @FocusState private var composerFocused: Bool

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
    .background(Button("") { newChat() }.keyboardShortcut("n").opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
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
    }
    .padding(.bottom, Space.l)
  }

  /// The one composer, the same in both states (large, Talk and Send).
  private var composer: some View {
    HStack(spacing: Space.s) {
      AskField(text: $draft, onMic: actions.talk, large: true, onSubmit: send).focused($composerFocused)
      PrimaryButton("Send", action: send)
    }
  }

  private var extras: some View {
    VStack(spacing: Space.m) {
      HStack(spacing: Space.s) {
        ForEach(HOME_SUGGESTIONS, id: \.self) { s in Tag(s) { draft = s } }
      }
      todayLine.padding(.top, Space.xs)
    }
  }

  /// Messages: New chat and the title, then the same thread as the Ask box.
  private var thread: some View {
    VStack(spacing: Space.m) {
      HStack(spacing: Space.m) {
        // Back to the empty Home. The chat is not lost: it stays in Conversations (and can be picked up again, #55).
        QuietButton("New chat", symbol: "plus") { newChat() }.help("New chat (⌘N)")
        Text(verbatim: model.threadTitle).font(TypeScale.section).foregroundColor(t.ink).lineLimit(1)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 0)
      }
      ChatThreadView(model: model).frame(maxHeight: .infinity)
    }
  }

  /// "Nothing waiting · What's my day?" Running jobs come first when there are any. (A waiting question is never here:
  /// it makes the chat non-empty, so Home shows the card instead, and the banner shows on every page, #138.)
  private var todayLine: some View {
    let running = model.jobs.filter { $0.isRunning }.count
    let (text, word, act): (String, String, () -> Void) = {
      if running > 0 { return (running == 1 ? "1 job running" : "\(running) jobs running", "See jobs", { nav.page = .jobs }) }
      return ("Nothing waiting", "What's my day?", { model.sendChat(APP_TODAY_PROMPT) })
    }()
    return HStack(spacing: Space.s) {
      Text(verbatim: text).font(TypeScale.secondary).foregroundColor(t.ink2)
      Text(verbatim: "·").font(TypeScale.secondary).foregroundColor(t.ink2).accessibilityHidden(true)
      Button(action: act) {
        Text(verbatim: word).font(TypeScale.secondary.weight(.medium)).foregroundColor(t.accent)
          .frame(minHeight: 24).contentShape(Rectangle())  // a 24 pt target (#149)
      }
      .buttonStyle(.plain).accessibilityLabel(word)
    }
    .accessibilityElement(children: .contain)
  }

  private func send() {
    if model.sendChat(draft) { draft = "" }  // the reply shows right here in the thread
  }

  /// Cmd+N: a new chat (back to the empty layout). Older chats stay in Conversations.
  private func newChat() {
    draft = ""
    model.newChat()
    composerFocused = true
  }
}
