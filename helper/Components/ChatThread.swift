// The chat thread (UI-PLAN v3.2 section 5): your messages and Stephen's replies for the current chat, shown by both the
// Ask box and Home from the one shared AppModel. A question from the safety gate ("Needs your OK") is a message at the
// bottom of the thread, with the same 0.75 s Allow/Deny delay as before (R9-6).
//
// Untrusted text (replies, what was heard, the gate's question) is shown with Text(verbatim:), never as Markdown.

import SwiftUI

/// Where a chat line can take you (UI-V4-IA-PLAN L1, L2). Navigation only; nil hides the link (each place that shows
/// the thread wires its own).
struct ChatLinks {
  /// Settings > Privacy and permissions, where "What Stephen may do" is (L1).
  var permissions: (() -> Void)? = nil
}

struct ChatThreadView: View {
  @Environment(\.stephenTheme) var t
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ObservedObject var model: AppModel
  var links = ChatLinks()
  /// The main window's ⌘K palette is open: the hidden Esc button is off, so Esc only closes the palette (plan 7.5.4).
  @Environment(\.paletteOpen) var paletteOpen

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: Space.m) {
          let thread = model.thread
          let canRetry = retryableText(thread) != nil
          ForEach(thread) { b in
            ChatBubbleRow(bubble: b, isLast: b.id == thread.last?.id, retry: canRetry ? { retry() } : nil, links: links).id(b.id)
          }
          if let q = model.confirms.first {
            ConfirmMessage(question: q, waiting: model.confirms.count) { model.answerConfirm(q.id, approve: $0) }
              // Esc = Deny, in the Ask box and on Home, even while the text field has focus: a key equivalent runs
              // before the field editor. No 0.75 s delay: Esc can only deny. One card, so one question per press (R10a-5).
              .background(
                Button("") { model.denyFirstConfirm() }.keyboardShortcut(.cancelAction).disabled(paletteOpen)
                  .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
              )
              .id("confirm")
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
      .onChange(of: model.thread.last?.id) { _ in toEnd(proxy) }
      // A question appears without animation (#139): no scroll animation to it either.
      .onChange(of: model.confirms.first?.id) { _ in proxy.scrollTo("end", anchor: .bottom) }
      .onChange(of: model.isWorking) { _ in toEnd(proxy) }
    }
  }

  private func toEnd(_ proxy: ScrollViewProxy) {
    if reduceMotion { proxy.scrollTo("end", anchor: .bottom) } else {
      withAnimation(.easeOut(duration: Motion.state)) { proxy.scrollTo("end", anchor: .bottom) }
    }
  }

  /** Send the last thing you typed again (after a problem). Never spoken words: see retryableText. */
  private func retry() {
    if let typed = retryableText(model.thread) { model.sendChat(typed) }
  }
}

/// The text Try again may re-send: your last message, only if you typed it (no source label). Spoken or phone words
/// are never re-sent: chat.send runs as typed in the app, full trust, and the app must not claim another source (R10a-2).
func retryableText(_ thread: [ChatBubble]) -> String? {
  guard let last = thread.last(where: { $0.kind == .said }), last.detail.isEmpty else { return nil }
  return last.text
}

/**
 * One message. You: right, in a filled bubble. Stephen: left, in its own box, with the action chain above it. Both
 * containers are a step darker than the box around them so the messages stand out (owner, 2026-11-09: the containers,
 * not the text). Problems and info lines are named in words.
 */
struct ChatBubbleRow: View {
  @Environment(\.stephenTheme) var t
  let bubble: ChatBubble
  let isLast: Bool
  /** nil when the last message was not typed: no Try again (R10a-2). */
  let retry: (() -> Void)?
  var links = ChatLinks()

  /// A step was refused: the message says where the rules live (L1). Never hidden in the folded chain.
  private var refused: Bool { return bubble.steps.contains { StepStatus($0.status) == .refused } }

  var body: some View {
    switch bubble.kind {
    case .said:
      // Spoken or phone words carry where they came from, under the bubble; typed ones have no label.
      VStack(alignment: .trailing, spacing: 2) {
        HStack(spacing: 0) {
          Spacer(minLength: Space.xxl)
          Text(verbatim: bubble.text).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
            .padding(.horizontal, Space.m).padding(.vertical, Space.s)
            .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.line))
        }
        if !bubble.detail.isEmpty {
          Text(verbatim: bubble.detail).font(TypeScale.secondary).foregroundColor(t.ink2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(bubble.detail.isEmpty ? "You: \(bubble.text)" : "You, \(bubble.detail): \(bubble.text)")
    case .reply:
      // The work first, small and folded; the answer after it, as the main text (owner, 2026-11-09).
      VStack(alignment: .leading, spacing: Space.s) {
        if !bubble.steps.isEmpty { ActionChain(steps: bubble.steps, seconds: bubble.detail) }
        Text(verbatim: bubble.text).font(TypeScale.body).foregroundColor(t.ink).lineSpacing(2).textSelection(.enabled)
          .padding(.horizontal, Space.m).padding(.vertical, Space.s)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface2))
          .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.line, lineWidth: 1))
          .accessibilityLabel("Stephen: \(bubble.text)")
        if bubble.steps.isEmpty && !bubble.detail.isEmpty {
          Text(verbatim: bubble.detail).font(TypeScale.secondary).foregroundColor(t.ink2)
        }
        if refused, let open = links.permissions { link("See what Stephen may do", open) }
      }
      .accessibilityElement(children: .contain)
    case .problem:
      VStack(alignment: .leading, spacing: Space.s) {
        Text(verbatim: problemLabel(bubble.steps)).safetyLabelStyle(t)
        if !bubble.steps.isEmpty { ActionChain(steps: bubble.steps, seconds: bubble.detail) }
        Text(verbatim: bubble.text).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
        if refused, let open = links.permissions { link("See what Stephen may do", open) }
        if isLast, let retry = retry { QuietButton("Try again", action: retry) }
      }
    case .info:
      Text(verbatim: bubble.text).font(TypeScale.secondary).foregroundColor(t.ink2)
    }
  }

  /** A text link with a 24 pt target. It only navigates. */
  private func link(_ title: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(verbatim: title).font(TypeScale.secondary.weight(.medium)).foregroundColor(t.accent)
        .frame(minHeight: 24).contentShape(Rectangle())
    }
    .buttonStyle(.plain).accessibilityLabel(title)
  }
}

/** A step's outcome: the step text says it in words, the shape says it without colour (#140). */
enum StepStatus: Equatable {
  case ok, refused, failed
  /** From the listener's step status. ponytail: an unknown status shows as failed, never as done. */
  init(_ raw: String) {
    switch raw {
    case "ok": self = .ok
    case "refused": self = .refused
    default: self = .failed
    }
  }
}

/** Check = done, hand = refused, x mark = failed. Used by the action chain and by Conversations. */
struct StepMark: View {
  @Environment(\.stephenTheme) var t
  let status: StepStatus

  var body: some View {
    let (symbol, color): (String, Color) = {
      switch status {
      case .ok: return ("checkmark", t.ink2)
      case .refused: return ("hand.raised.fill", t.warn)
      case .failed: return ("xmark", t.bad)
      }
    }()
    return Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundColor(color)
      .frame(width: 12).accessibilityHidden(true)
  }
}

/**
 * The label over a problem message. "Didn't work" only when the steps show a failure and no refusal; "Refused" only
 * when they show a refusal and no failure. Anything else (no steps, both) stays "Problem": a refusal is never
 * called "Didn't work".
 */
func problemLabel(_ steps: [ChatStep]) -> String {
  let s = steps.map { StepStatus($0.status) }
  let refused = s.contains(.refused), failed = s.contains(.failed)
  if failed && !refused { return "Didn't work" }
  if refused && !failed { return "Refused" }
  return "Problem"
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
    let failed = steps.filter { $0.status == "failed" }.count
    if refused > 0 { parts.append(refused == 1 ? "1 refused" : "\(refused) refused") }
    if failed > 0 { parts.append("\(failed) failed") }
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
        .foregroundColor(t.ink2).frame(minHeight: 24).contentShape(Rectangle())  // a 24 pt target (#145)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("What Stephen did: \(summary)")
      .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
      if open {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
              StepMark(status: StepStatus(s.status))
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

/// The question card keeps its warn outline all round, no side stripe: the most distinct shape, in every theme (#139).
/// Paper: a white card, the warn edge at 2 pt and the hard ink shadow, so it still stands apart from the ink-edged
/// cards around it.
private struct ConfirmCard: ViewModifier {
  @Environment(\.stephenTheme) var t
  func body(content: Content) -> some View {
    if t.paper {
      content.paperBox(t, fill: t.surface, radius: 16, edge: t.warn)
    } else {
      content.background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface2))
        .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.warn, lineWidth: 1.5))
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
      Text(verbatim: "Needs your OK").safetyLabelStyle(t)
      Text(verbatim: question.title).font(t.paper ? paperHead(16) : TypeScale.body.weight(.semibold)).foregroundColor(t.ink).lineLimit(3)
      ScrollView {
        Text(verbatim: question.body).font(TypeScale.secondary).foregroundColor(t.paper ? t.ink : t.ink2).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(t.paper ? Space.s : 0)
          .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.paper ? Theme.sky : Color.clear))
      }
      .frame(maxHeight: 160).fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel("Details: \(question.body)")
      ConfirmButtons(question: question, waiting: waiting, answer: answer)
    }
    .padding(Space.m)
    .modifier(ConfirmCard())
    .accessibilityElement(children: .contain)
  }
}
