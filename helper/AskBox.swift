// Stephen Helper: the Ask box (UI-PLAN v3.1 section 5). A 300 pt non-activating panel under the menu bar icon,
// opened by clicking the icon, by F5 (push-to-talk, shown while you talk) or by Cmd+K inside the app. It shows one
// thing at a time, all derived from AppModel (the same app.sock connection and chat as the Stephen window):
// offline, idle, listening, working, reply, problem, and the ... menu.
//
// Untrusted text (replies, what was heard) is shown with Text(verbatim:), never as Markdown.
// Threading: main thread only (AskBoxController is @MainActor; main.swift reaches it like StatusMenu).

import AppKit
import Combine
import SwiftUI

/** Box-only state; everything else is read from AppModel. */
final class AskBoxState: ObservableObject {
  @Published var draft = ""
  /** Chat bubbles with an id at or below this are from before the box was opened: not shown. */
  @Published var since = 0
  @Published var menuOpen = false
  /** Push-to-talk started from the box's mic button (tap the box again to send). */
  @Published var micHeld = false
}

enum AskBoxMode: Equatable {
  case needsOK(PendingConfirm)
  case offline
  case menu
  case listening
  case working(said: String)
  case reply(String)
  case problem(String)
  case idle

  static func of(_ model: AppModel, _ box: AskBoxState) -> AskBoxMode {
    if let q = model.confirms.first { return .needsOK(q) }
    if box.menuOpen { return .menu }
    if model.connection != .online { return .offline }
    if model.state == "recording" || box.micHeld { return .listening }
    let lastSaid = model.chat.last(where: { $0.kind == .said })?.text ?? ""
    if model.isWorking { return .working(said: lastSaid) }
    guard let last = model.chat.last, last.id > box.since else { return .idle }
    switch last.kind {
    case .reply: return .reply(last.text)
    case .problem, .info: return .problem(last.text)
    case .said: return .working(said: last.text)  // sent, not accepted yet
    }
  }
}

struct AskBoxActions {
  var close: () -> Void
  var micDown: () -> Void
  var micUp: () -> Void
  var openApp: () -> Void
  var reviewMemory: () -> Void
  var quit: () -> Void
}

// ───────────────────────────── view ─────────────────────────────

/// Allow and Deny for one question. Both stay disabled for 0.75 s each time the shown question changes, so a double
/// click, or a click aimed at the menu bar icon as the box opens, can't answer a question the owner hasn't seen (R9-6).
struct ConfirmButtons: View {
  @Environment(\.stephenTheme) var t
  let question: PendingConfirm
  let waiting: Int
  let answer: (Bool) -> Void
  @State private var armed: String? = nil

  var body: some View {
    let live = armed == question.id
    HStack(spacing: Space.s) {
      if waiting > 1 { Text(verbatim: "1 of \(waiting)").font(TypeScale.secondary).foregroundColor(t.ink2) }
      Spacer()
      // Deny first, so keyboard focus (Full Keyboard Access) lands on it; Return is not bound to Allow.
      QuietButton("Deny") { answer(false) }
      PrimaryButton("Allow") { answer(true) }
    }
    .disabled(!live).opacity(live ? 1 : 0.5)
    .task(id: question.id) {
      armed = nil
      try? await Task.sleep(nanoseconds: 750_000_000)
      if !Task.isCancelled { armed = question.id }
    }
  }
}

struct AskBoxView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var box: AskBoxState
  let actions: AskBoxActions

  var body: some View {
    let mode = AskBoxMode.of(model, box)
    VStack(alignment: .leading, spacing: Space.s) { content(mode) }
      .padding(Space.m)
      .frame(width: 300, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Corner.askBox).fill(t.surface))
      .overlay(RoundedRectangle(cornerRadius: Corner.askBox).stroke(t.line, lineWidth: 1))
      .background(shortcuts)
      .stephenAnimation(value: mode)
      .onExitCommand { escape(mode) }
  }

  @ViewBuilder
  private func content(_ mode: AskBoxMode) -> some View {
    switch mode {
    case let .needsOK(q):
      // The gate's own question (computed facts first, model and page text quoted and labelled). The full fact list
      // is kept, in a short scroll, because the owner must be able to decide from it alone, as with the dialog.
      Text(verbatim: q.title).font(TypeScale.body.weight(.semibold)).foregroundColor(t.ink).lineLimit(3)
      ScrollView {
        Text(verbatim: q.body).font(TypeScale.secondary).foregroundColor(t.ink2).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 160).fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel("Details: \(q.body)")
      ConfirmButtons(question: q, waiting: model.confirms.count) { model.answerConfirm(q.id, approve: $0) }
    case .idle:
      HStack(spacing: Space.s) {
        AskField(text: $box.draft, onMic: actions.micDown, onSubmit: send)
        Button { box.menuOpen = true; model.refreshUsage() } label: {
          Image(systemName: "ellipsis").font(.system(size: 16)).foregroundColor(t.ink2).frame(width: 24, height: 24)
        }
        .buttonStyle(.plain).help("More").accessibilityLabel("More")
      }
    case .listening:
      // No live words or level from the listener yet (`heard` arrives once the words are final), so this names the
      // state in words. Tapping sends when the box's mic started it.
      Button { if box.micHeld { actions.micUp() } } label: {
        Text(verbatim: "Listening…").font(TypeScale.body).foregroundColor(t.ink2)
          .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(box.micHeld ? "Listening. Activate to send." : "Listening")
    case let .working(said):
      if !said.isEmpty {
        Text(verbatim: said).font(TypeScale.body).foregroundColor(t.ink2).lineLimit(4)
          .accessibilityLabel("You said: \(said)")
      }
      Text(verbatim: "Working…").font(TypeScale.secondary).foregroundColor(t.ink)
        .accessibilityLabel("Working. Press Escape to stop.")
    case let .reply(text):
      ScrollView {
        Text(verbatim: text).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 320).fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel("Stephen: \(text)")
    case let .problem(text):
      Text(verbatim: text).font(TypeScale.body).foregroundColor(t.ink).lineLimit(5)
      QuietButton("Try again") { retry() }
    case .offline:
      Text(verbatim: "Can't reach Stephen. Is stephen listen running?").font(TypeScale.body).foregroundColor(t.ink)
      QuietButton("Try again") { model.retry() }
    case .menu:
      menu
    }
  }

  private var menu: some View {
    VStack(alignment: .leading, spacing: 2) {
      MenuRow(title: "New chat", shortcut: "⌘N") { newChat() }
      MenuRow(title: "Open Stephen", shortcut: "⌘O") { actions.openApp() }
      // Shown only once a `usage` answer arrives (usage.get, P2); an older listener never answers.
      if let m = model.usage?.context { UsageBarView(title: "This chat", pct: Double(m.percent), warn: m.warn, word: "context used") }
      if let m = model.usage?.memory { UsageBarView(title: "Memory", pct: Double(m.percent), warn: m.warn, word: "full") }
      MenuRow(title: "Review memory", shortcut: nil) { actions.reviewMemory() }
      Divider().padding(.vertical, Space.xs)
      MenuRow(title: "Quit", shortcut: "⌘Q") { actions.quit() }
    }
  }

  /** Cmd+N / Cmd+O / Cmd+Q while the box has focus. */
  private var shortcuts: some View {
    ZStack {
      Button("") { newChat() }.keyboardShortcut("n")
      Button("") { actions.openApp() }.keyboardShortcut("o")
      Button("") { actions.quit() }.keyboardShortcut("q")
    }
    .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
  }

  private func send() {
    if model.sendChat(box.draft) { box.draft = "" }
  }

  private func retry() {
    if let said = model.chat.last(where: { $0.kind == .said })?.text { model.sendChat(said) }
  }

  private func newChat() {
    box.menuOpen = false
    box.draft = ""
    box.since = model.chat.last?.id ?? 0
  }

  private func escape(_ mode: AskBoxMode) {
    switch mode {
    case let .needsOK(q): model.answerConfirm(q.id, approve: false)  // Esc = Deny, like the dialog
    case .menu: box.menuOpen = false
    case .listening where box.micHeld: actions.micUp()
    case .working: model.stopChat()
    default: actions.close()
    }
  }
}

private struct MenuRow: View {
  @Environment(\.stephenTheme) var t
  let title: String
  let shortcut: String?
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack {
        Text(verbatim: title).font(TypeScale.body).foregroundColor(t.ink)
        Spacer()
        if let s = shortcut { Text(verbatim: s).font(TypeScale.secondary).foregroundColor(t.ink2).accessibilityHidden(true) }
      }
      .padding(.horizontal, Space.s).padding(.vertical, 6).contentShape(Rectangle())
    }
    .buttonStyle(.plain).accessibilityLabel(title)
  }
}

/** "Memory 85%" with a thin bar; amber with "almost full" when the listener says warn (from 80%). */
private struct UsageBarView: View {
  @Environment(\.stephenTheme) var t
  let title: String
  let pct: Double
  let warn: Bool
  let word: String
  var body: some View {
    let p = min(max(pct, 0), 100)
    let high = warn
    VStack(alignment: .leading, spacing: Space.xs) {
      HStack {
        Text(verbatim: title).font(TypeScale.secondary).foregroundColor(t.ink2)
        Spacer()
        Text(verbatim: high ? "almost full · \(Int(p))%" : "\(Int(p))%").font(TypeScale.mono)
          .foregroundColor(high ? t.warn : t.ink2)
      }
      GeometryReader { g in
        ZStack(alignment: .leading) {
          Capsule().fill(t.surface2)
          Capsule().fill(high ? t.warn : t.accent).frame(width: g.size.width * CGFloat(p / 100))
        }
      }
      .frame(height: 4)
    }
    .padding(.horizontal, Space.s).padding(.vertical, 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(title)
    .accessibilityValue("\(Int(p)) percent \(word)\(high ? ", almost full" : "")")
  }
}

// ───────────────────────────── panel ─────────────────────────────

private struct AskBoxSizeKey: PreferenceKey {
  static var defaultValue: CGSize = .zero
  static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/** Borderless, non-activating: it can take typing without pulling Stephen's other windows forward. */
final class AskPanel: NSPanel {
  var onEscape: () -> Void = {}
  override var canBecomeKey: Bool { return true }
  override func cancelOperation(_ sender: Any?) { onEscape() }
}

/**
 * Theme for the box: `defaults write dev.stephen.helper theme navy` (light, dark, navy, rose, sun, or "mac" for
 * Follow the Mac). Settings > Appearance will write the same key.
 */
func savedThemeChoice() -> ThemeChoice {
  let raw = UserDefaults.standard.string(forKey: "theme") ?? ""
  if raw == "mac" { return ThemeChoice(name: .light, followMac: true) }
  return ThemeChoice(name: ThemeName(rawValue: raw) ?? .light, followMac: false)
}

@MainActor
final class AskBoxController: NSObject {
  let model: AppModel
  let box = AskBoxState()
  private var panel: AskPanel? = nil
  private var clickMonitor: Any? = nil
  private var confirmWatch: AnyCancellable? = nil
  /** The menu bar button the box hangs under. */
  var anchor: () -> NSStatusBarButton? = { nil }
  var openWindow: (Page?) -> Void = { _ in }
  var quit: () -> Void = {}
  /** Push-to-talk down/up through the same path as F5. */
  var ptt: (Bool) -> Void = { _ in }

  init(model: AppModel) {
    self.model = model
    super.init()
    // A question from the gate opens the box (focused, so Esc works, but no button is the default).
    confirmWatch = model.$confirms.receive(on: DispatchQueue.main).sink { [weak self] list in
      guard !list.isEmpty else { return }
      MainActor.assumeIsolated { self?.show(focus: true, selectField: false) }
    }
  }

  var isShown: Bool { return panel?.isVisible ?? false }

  func toggle() {
    if isShown { close() } else { show(focus: true) }
  }

  /** focus: take the keyboard (click, Cmd+K). F5 shows it without taking focus from the app you are in. */
  func show(focus: Bool, selectField: Bool = true) {
    let p = panel ?? makePanel()
    panel = p
    if !isShown {
      box.menuOpen = false
      if !model.isWorking && model.state != "recording" { box.since = model.chat.last?.id ?? 0 }
      place(p, size: p.contentView?.fittingSize ?? NSSize(width: 300, height: 60))
      p.orderFrontRegardless()
      watchOutsideClicks()
    }
    if focus {
      p.makeKey()
      if selectField { DispatchQueue.main.async { p.selectKeyView(following: p.contentView ?? NSView()) } }
    }
  }

  /** Stays open while a question waits: it ends with Allow, Deny (or Esc), or the gate's timeout. */
  func close() {
    guard model.confirms.isEmpty else { return }
    if box.micHeld { micUp() }
    box.menuOpen = false
    if let m = clickMonitor { NSEvent.removeMonitor(m) }
    clickMonitor = nil
    panel?.orderOut(nil)
  }

  /** Home's Talk button: open the box and start talking (tap the box again to send). */
  func talk() {
    show(focus: true, selectField: false)
    micDown()
  }

  private func micDown() {
    box.micHeld = true
    ptt(true)
  }

  private func micUp() {
    box.micHeld = false
    ptt(false)
  }

  private func makePanel() -> AskPanel {
    let p = AskPanel(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 60), styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = true
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.setAccessibilityLabel("Ask Stephen")
    p.onEscape = { [weak self] in self?.close() }
    let actions = AskBoxActions(
      close: { [weak self] in self?.close() },
      micDown: { [weak self] in self?.micDown() },
      micUp: { [weak self] in self?.micUp() },
      openApp: { [weak self] in self?.close(); self?.openWindow(nil) },
      reviewMemory: { [weak self] in self?.close(); self?.openWindow(.memory) },
      quit: { [weak self] in self?.quit() })
    let root = AskBoxView(model: model, box: box, actions: actions)
      .stephenThemed(savedThemeChoice())
      .fixedSize()
      .background(GeometryReader { g in Color.clear.preference(key: AskBoxSizeKey.self, value: g.size) })
      .onPreferenceChange(AskBoxSizeKey.self) { [weak self, weak p] size in
        guard let self = self, let p = p, size.height > 0 else { return }
        MainActor.assumeIsolated { self.resize(p, to: size) }
      }
    p.contentView = NSHostingView(rootView: root)
    return p
  }

  /** Under the menu bar icon, inside the screen. */
  private func place(_ p: NSPanel, size: NSSize) {
    var origin = NSPoint(x: 0, y: 0)
    if let b = anchor(), let w = b.window {
      let r = w.convertToScreen(b.convert(b.bounds, to: nil))
      origin = NSPoint(x: r.midX - size.width / 2, y: r.minY - 6 - size.height)
      if let vis = w.screen?.visibleFrame {
        origin.x = min(max(origin.x, vis.minX + 8), vis.maxX - size.width - 8)
      }
    } else if let vis = NSScreen.main?.visibleFrame {
      origin = NSPoint(x: vis.maxX - size.width - 8, y: vis.maxY - 6 - size.height)
    }
    p.setFrame(NSRect(origin: origin, size: size), display: true)
  }

  /** Content changed size: keep the top edge where it is. */
  private func resize(_ p: NSPanel, to size: NSSize) {
    var f = p.frame
    let top = f.maxY
    f.size = size
    f.origin.y = top - size.height
    p.setFrame(f, display: true)
    p.invalidateShadow()
  }

  /** A click in another app closes the box (clicks in Stephen's own windows don't reach a global monitor). */
  private func watchOutsideClicks() {
    guard clickMonitor == nil else { return }
    clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      MainActor.assumeIsolated { self?.close() }
    }
  }
}
