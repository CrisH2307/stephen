// Stephen Helper: Home (UI-PLAN v3.1 section 6). "Morning, Cris." and the date, a plain Today list (only what
// app.sock already knows: questions waiting in the Ask box, running jobs; due items and to-dos come from asking
// "what's my day?"), then a wide ask field with Talk and Send and three suggestion chips. No weather, no cards.

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

  var body: some View {
    let now = Date()
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(verbatim: homeGreeting(hour: Calendar.current.component(.hour, from: now), name: model.ownerName))
            .font(TypeScale.homeTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
          Text(verbatim: now.formatted(date: .complete, time: .omitted)).font(TypeScale.body).foregroundColor(t.ink2)
        }
        GroupedList("Today") { today }
        VStack(alignment: .leading, spacing: Space.m) {
          HStack(spacing: Space.s) {
            AskField(text: $draft, onMic: actions.talk, onSubmit: send)
            PrimaryButton("Send", action: send)
          }
          HStack(spacing: Space.s) {
            ForEach(HOME_SUGGESTIONS, id: \.self) { s in Tag(s) { draft = s } }
          }
        }
      }
      .padding(Space.xxl)
      .frame(maxWidth: 720, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear {
      model.refreshSettings()  // the name for the greeting
      model.refreshJobs()
    }
  }

  @ViewBuilder
  private var today: some View {
    let waiting = model.confirms.count
    let running = model.jobs.filter { $0.isRunning }.count
    if waiting > 0 {
      GroupedRow(waiting == 1 ? "1 question waiting for you" : "\(waiting) questions waiting for you", first: true) {
        QuietButton("Answer") { actions.ask() }
      }
    }
    if running > 0 {
      GroupedRow(running == 1 ? "1 job running" : "\(running) jobs running", first: waiting == 0) {
        QuietButton("See jobs") { nav.page = .jobs }
      }
    }
    if waiting == 0 && running == 0 {
      GroupedRow("Nothing is waiting for you", first: true)
    }
    GroupedRow("What's due and your to-dos", detail: "Stephen checks Canvas, Calendar and Notion when you ask") {
      QuietButton("What's my day?") { if model.sendChat(APP_TODAY_PROMPT) { actions.ask() } }
    }
  }

  private func send() {
    if model.sendChat(draft) {
      draft = ""
      actions.ask()  // the reply shows in the Ask box
    }
  }
}
