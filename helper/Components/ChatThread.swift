// The chat thread (UI-PLAN v3.2 section 5): your messages and Stephen's replies for the current chat, shown by both the
// Ask box and Home from the one shared AppModel. A question from the safety gate ("Needs your OK") is a message at the
// bottom of the thread, with the same 0.75 s Allow/Deny delay as before (R9-6).
//
// Untrusted text (replies, what was heard, the gate's question) is shown with Text(verbatim:), never as Markdown.

import SwiftUI

struct ChatThreadView: View {
  @Environment(\.stephenTheme) var t
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ObservedObject var model: AppModel

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: Space.m) {
          let thread = model.thread
          ForEach(thread) { b in
            ChatBubbleRow(bubble: b, isLast: b.id == thread.last?.id) { retry() }.id(b.id)
          }
          if let q = model.confirms.first {
            ConfirmMessage(question: q, waiting: model.confirms.count) { model.answerConfirm(q.id, approve: $0) }.id("confirm")
          } else if model.isWorking {
            Text(verbatim: "Working…").font(TypeScale.secondary).foregroundColor(t.ink2)
              .accessibilityLabel("Working. Press Escape to stop.").id("working")
          }
          Color.clear.frame(height: 1).id("end")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Space.xs)
      }
      .onAppear { proxy.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.thread.count) { _ in toEnd(proxy) }
      .onChange(of: model.confirms.first?.id) { _ in toEnd(proxy) }
      .onChange(of: model.isWorking) { _ in toEnd(proxy) }
    }
  }

  private func toEnd(_ proxy: ScrollViewProxy) {
    if reduceMotion { proxy.scrollTo("end", anchor: .bottom) } else {
      withAnimation(.easeOut(duration: Motion.state)) { proxy.scrollTo("end", anchor: .bottom) }
    }
  }

  /** Send the last thing you said again (after a problem). */
  private func retry() {
    if let said = model.thread.last(where: { $0.kind == .said })?.text { model.sendChat(said) }
  }
}

/** One message. You: right, in a soft bubble. Stephen: left, plain. Problems and info lines are named in words. */
struct ChatBubbleRow: View {
  @Environment(\.stephenTheme) var t
  let bubble: ChatBubble
  let isLast: Bool
  let retry: () -> Void

  var body: some View {
    switch bubble.kind {
    case .said:
      HStack(spacing: 0) {
        Spacer(minLength: Space.xxl)
        Text(verbatim: bubble.text).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
          .padding(.horizontal, Space.m).padding(.vertical, Space.s)
          .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface2))
      }
      .accessibilityElement(children: .combine).accessibilityLabel("You: \(bubble.text)")
    case .reply:
      // The work first, small and folded; the answer after it, as the main text (owner, 2026-11-09).
      VStack(alignment: .leading, spacing: Space.s) {
        if !bubble.steps.isEmpty { ActionChain(steps: bubble.steps, seconds: bubble.detail) }
        Text(verbatim: bubble.text).font(TypeScale.reply).foregroundColor(t.ink).lineSpacing(3).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityLabel("Stephen: \(bubble.text)")
        if bubble.steps.isEmpty && !bubble.detail.isEmpty {
          Text(verbatim: bubble.detail).font(TypeScale.secondary).foregroundColor(t.ink2)
        }
      }
      .accessibilityElement(children: .contain)
    case .problem:
      VStack(alignment: .leading, spacing: Space.s) {
        Text(verbatim: "Problem").sectionLabelStyle(t)
        Text(verbatim: bubble.text).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
        if isLast { QuietButton("Try again", action: retry) }
      }
    case .info:
      Text(verbatim: bubble.text).font(TypeScale.secondary).foregroundColor(t.ink2)
    }
  }
}

/** "3 steps · 9.8 s", folded by default; open, one line per step, refusals and failures named in words. */
struct ActionChain: View {
  @Environment(\.stephenTheme) var t
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  let steps: [ChatStep]
  /** "9.8 s" (the reply's time line), may be empty. */
  let seconds: String
  @State private var open = false

  var body: some View {
    let refused = steps.filter { $0.status == "refused" }.count
    var parts = [steps.count == 1 ? "1 step" : "\(steps.count) steps"]
    if refused > 0 { parts.append(refused == 1 ? "1 refused" : "\(refused) refused") }
    if !seconds.isEmpty { parts.append(seconds) }
    let summary = parts.joined(separator: " · ")
    return VStack(alignment: .leading, spacing: Space.xs) {
      Button {
        if reduceMotion { open.toggle() } else { withAnimation(.easeInOut(duration: Motion.state)) { open.toggle() } }
      } label: {
        HStack(spacing: Space.xs) {
          Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
            .rotationEffect(.degrees(open ? 90 : 0))
          Text(verbatim: summary).font(TypeScale.secondary)
        }
        .foregroundColor(t.ink2).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("What Stephen did: \(summary)")
      .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
      if open {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
              Circle().fill(s.status == "ok" ? t.line : (s.status == "refused" ? t.warn : t.bad))
                .frame(width: 6, height: 6).accessibilityHidden(true)
              Text(verbatim: s.text).font(TypeScale.secondary)
                .foregroundColor(s.status == "ok" ? t.ink2 : t.ink).fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .padding(.leading, Space.m)
        .overlay(Rectangle().fill(t.line).frame(width: 1), alignment: .leading)
        .transition(.opacity)
      }
    }
  }
}

/// The gate's question as a message: computed facts first, model and page text quoted and labelled (the gate's own
/// text). The full fact list is kept, in a short scroll, so the owner can decide from it alone, as with the dialog.
struct ConfirmMessage: View {
  @Environment(\.stephenTheme) var t
  let question: PendingConfirm
  let waiting: Int
  let answer: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      Text(verbatim: "Needs your OK").sectionLabelStyle(t)
      Text(verbatim: question.title).font(TypeScale.body.weight(.semibold)).foregroundColor(t.ink).lineLimit(3)
      ScrollView {
        Text(verbatim: question.body).font(TypeScale.secondary).foregroundColor(t.ink2).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 160).fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel("Details: \(question.body)")
      ConfirmButtons(question: question, waiting: waiting, answer: answer)
    }
    .padding(Space.m)
    .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface2))
    .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.accent, lineWidth: 1))
    .accessibilityElement(children: .contain)
  }
}
