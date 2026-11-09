// Stephen Helper: Home (UI-PLAN v3.2 section 6), a chat layout. With no messages: "Morning, Cris." and the date, a
// large centred composer with Talk and Send, three suggestion chips, and Today as one line ("Nothing waiting · What's
// my day?"; only what app.sock already knows, due items and to-dos come from asking). With messages: the same thread
// as the Ask box (ChatThreadView) and the composer at the bottom. No weather, no cards.

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

  /// No messages yet in this chat (a waiting question or a running command counts as a chat).
  private var isEmpty: Bool { return model.thread.isEmpty && model.confirms.isEmpty && !model.isWorking }

  var body: some View {
    Group {
      if isEmpty { start.transition(.opacity) } else { chat.transition(.opacity) }
    }
    .stephenAnimation(value: isEmpty)
    .background(Button("") { newChat() }.keyboardShortcut("n").opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
    .onAppear {
      model.refreshSettings()  // the name for the greeting
      model.refreshJobs()
    }
  }

  /// Empty chat: greeting and date, a large centred composer, chips under it, one line for Today.
  private var start: some View {
    let now = Date()
    return ScrollView {
      VStack(spacing: Space.xl) {
        VStack(spacing: Space.xs) {
          Text(verbatim: homeGreeting(hour: Calendar.current.component(.hour, from: now), name: model.ownerName))
            .font(TypeScale.homeTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
          Text(verbatim: now.formatted(date: .complete, time: .omitted)).font(TypeScale.body).foregroundColor(t.ink2)
        }
        VStack(spacing: Space.m) {
          HStack(spacing: Space.s) {
            AskField(text: $draft, onMic: actions.talk, large: true, onSubmit: send)
            PrimaryButton("Send", action: send)
          }
          HStack(spacing: Space.s) {
            ForEach(HOME_SUGGESTIONS, id: \.self) { s in Tag(s) { draft = s } }
          }
          todayLine.padding(.top, Space.xs)
        }
      }
      .padding(Space.xxl)
      .frame(maxWidth: 680)
      .frame(maxWidth: .infinity, minHeight: 360)
    }
  }

  /// Messages: the same thread as the Ask box, the composer at the bottom.
  private var chat: some View {
    VStack(spacing: Space.m) {
      HStack(spacing: Space.m) {
        // Back to the empty Home. The chat is not lost: it stays in Conversations.
        Button { newChat() } label: {
          Image(systemName: "chevron.left").font(.system(size: 16, weight: .semibold)).foregroundColor(t.ink)
            .frame(width: 32, height: 32).background(Circle().fill(t.surface)).overlay(Circle().stroke(t.line, lineWidth: 1))
            .contentShape(Circle())
        }
        .buttonStyle(.plain).help("Go back (⌘N)").accessibilityLabel("Go back")
        Text(verbatim: model.threadTitle).font(TypeScale.section).foregroundColor(t.ink).lineLimit(1)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 0)
      }
      .frame(maxWidth: 720).frame(maxWidth: .infinity)
      ChatThreadView(model: model).frame(maxWidth: 720).frame(maxWidth: .infinity)
      AskField(text: $draft, onMic: actions.talk, onSubmit: send).frame(maxWidth: 720)
    }
    .padding(.horizontal, Space.xxl).padding(.vertical, Space.xl)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  /// "Nothing waiting · What's my day?" Waiting questions and running jobs come first when there are any.
  private var todayLine: some View {
    let waiting = model.confirms.count
    let running = model.jobs.filter { $0.isRunning }.count
    let (text, word, act): (String, String, () -> Void) = {
      if waiting > 0 { return (waiting == 1 ? "1 question waiting" : "\(waiting) questions waiting", "Answer", { actions.ask() }) }
      if running > 0 { return (running == 1 ? "1 job running" : "\(running) jobs running", "See jobs", { nav.page = .jobs }) }
      return ("Nothing waiting", "What's my day?", { model.sendChat(APP_TODAY_PROMPT) })
    }()
    return HStack(spacing: Space.s) {
      Text(verbatim: text).font(TypeScale.secondary).foregroundColor(t.ink2)
      Text(verbatim: "·").font(TypeScale.secondary).foregroundColor(t.ink2).accessibilityHidden(true)
      Button(action: act) { Text(verbatim: word).font(TypeScale.secondary.weight(.medium)).foregroundColor(t.accent) }
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
  }
}
