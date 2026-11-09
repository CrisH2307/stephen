// Stephen Helper: the Ask box (UI-PLAN v3.2 section 5). A 360 pt non-activating chat panel under the menu bar icon,
// opened by clicking the icon, by F5 (push-to-talk, shown while you talk) or by Cmd+K inside the app. It is a real
// chat: the current conversation as a scrolling thread (ChatThreadView, the same one Home shows), with the input at the
// bottom, all from AppModel (the same app.sock connection and chat as the Stephen window). Drag it by the strip on
// top; it remembers where you left it. The ... menu has New chat, pin (stay open), Reset position and usage.
//
// Untrusted text (replies, what was heard) is shown with Text(verbatim:), never as Markdown.
// Threading: main thread only (AskBoxController is @MainActor; main.swift reaches it like StatusMenu).

import AppKit
import Combine
import SwiftUI

/** Box-only state; everything else is read from AppModel. */
final class AskBoxState: ObservableObject {
  @Published var draft = ""
  @Published var menuOpen = false
  /** Push-to-talk started from the box's mic button (tap the box again to send). */
  @Published var micHeld = false
  /** Stay open when you click elsewhere. Remembered. */
  @Published var pinned = UserDefaults.standard.bool(forKey: "askBoxPinned") {
    didSet { UserDefaults.standard.set(pinned, forKey: "askBoxPinned") }
  }
}

enum AskBoxMode: Equatable {
  case offline
  case menu
  case listening
  case chat

  static func of(_ model: AppModel, _ box: AskBoxState) -> AskBoxMode {
    if !model.confirms.isEmpty { return .chat }  // the question is a message in the thread
    if box.menuOpen { return .menu }
    if model.connection != .online { return .offline }
    if model.state == "recording" || box.micHeld { return .listening }
    return .chat
  }
}

struct AskBoxActions {
  var close: () -> Void
  var micDown: () -> Void
  var micUp: () -> Void
  var openApp: () -> Void
  var reviewMemory: () -> Void
  var quit: () -> Void
  /** The owner let go of the drag strip: remember where the box is. */
  var dragEnded: () -> Void
  var resetPosition: () -> Void
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
    VStack(alignment: .leading, spacing: Space.s) {
      topStrip
      content(mode)
    }
    .padding(.horizontal, Space.l).padding(.bottom, Space.l).padding(.top, Space.xs)
    .frame(width: 360, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.askBox).fill(t.surface))
    .overlay(RoundedRectangle(cornerRadius: Corner.askBox).stroke(t.line, lineWidth: 1))
    .background(shortcuts)
    .stephenAnimation(value: mode)
    .onExitCommand { escape(mode) }
  }

  /// Drag the title area to move the box. The ... button sits beside it, not on top: an AppKit drag view would take
  /// its clicks (that was the "can't open the menu" bug).
  private var topStrip: some View {
    HStack(spacing: Space.xs) {
      ZStack {
        DragStrip(onEnd: actions.dragEnded)
        VStack(spacing: 2) {
          Capsule().fill(t.line).frame(width: 36, height: 4).accessibilityHidden(true)
          Text(verbatim: model.threadTitle).font(TypeScale.secondary.weight(.semibold)).foregroundColor(t.ink2).lineLimit(1)
        }
        .padding(.horizontal, Space.s).allowsHitTesting(false)
      }
      Button { box.menuOpen.toggle(); model.refreshUsage() } label: {
        Image(systemName: "ellipsis").font(.system(size: 16)).foregroundColor(t.ink2).frame(width: 28, height: 28).contentShape(Rectangle())
      }
      .buttonStyle(.plain).help("More").accessibilityLabel("More")
    }
    .frame(height: 32)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func content(_ mode: AskBoxMode) -> some View {
    switch mode {
    case .chat:
      if !model.thread.isEmpty || !model.confirms.isEmpty || model.isWorking {
        ChatThreadView(model: model).frame(maxHeight: 340).fixedSize(horizontal: false, vertical: true)
      }
      AskField(text: $box.draft, onMic: actions.micDown, onSubmit: send)
    case .listening:
      // No live words or level from the listener yet (`heard` arrives once the words are final), so this names the
      // state in words. Tapping sends when the box's mic started it.
      Button { if box.micHeld { actions.micUp() } } label: {
        Text(verbatim: "Listening…").font(TypeScale.body).foregroundColor(t.ink2)
          .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(box.micHeld ? "Listening. Activate to send." : "Listening")
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
      MenuRow(title: "Pin open", shortcut: box.pinned ? "✓" : nil, checked: box.pinned) { box.pinned.toggle() }
      MenuRow(title: "Reset position", shortcut: nil) { box.menuOpen = false; actions.resetPosition() }
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

  private func newChat() {
    box.menuOpen = false
    box.draft = ""
    model.newChat()
  }

  private func escape(_ mode: AskBoxMode) {
    if let q = model.confirms.first { model.answerConfirm(q.id, approve: false); return }  // Esc = Deny, like the dialog
    switch mode {
    case .menu: box.menuOpen = false
    case .listening where box.micHeld: actions.micUp()
    case .chat where model.isWorking: model.stopChat()
    default: actions.close()
    }
  }
}

/// The top strip: mouse down starts a window drag (performDrag returns when the button is released).
private struct DragStrip: NSViewRepresentable {
  let onEnd: () -> Void
  func makeNSView(context: Context) -> DragView { return DragView() }
  func updateNSView(_ v: DragView, context: Context) { v.onEnd = onEnd }

  final class DragView: NSView {
    var onEnd: () -> Void = {}
    override var mouseDownCanMoveWindow: Bool { return true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { return true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) {
      window?.performDrag(with: event)
      onEnd()
    }
  }
}

private struct MenuRow: View {
  @Environment(\.stephenTheme) var t
  let title: String
  let shortcut: String?
  var checked: Bool? = nil
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
    .accessibilityAddTraits(checked == true ? .isSelected : [])
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
      place(p, size: p.contentView?.fittingSize ?? NSSize(width: 360, height: 80))
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
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 80), styleMask: [.borderless, .nonactivatingPanel],
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
      quit: { [weak self] in self?.quit() },
      dragEnded: { [weak self] in self?.savePosition() },
      resetPosition: { [weak self] in self?.resetPosition() })
    let root = AskBoxView(model: model, box: box, actions: actions)
      .stephenThemedBySettings()
      .fixedSize()
      .background(GeometryReader { g in Color.clear.preference(key: AskBoxSizeKey.self, value: g.size) })
      .onPreferenceChange(AskBoxSizeKey.self) { [weak self, weak p] size in
        guard let self = self, let p = p, size.height > 0 else { return }
        MainActor.assumeIsolated { self.resize(p, to: size) }
      }
    p.contentView = NSHostingView(rootView: root)
    return p
  }

  /// Where the owner left the box: its left edge and top edge. The box resizes downward, so the top edge is the anchor.
  private static let savedXKey = "askBoxX", savedTopKey = "askBoxTop"

  private func savePosition() {
    guard let f = panel?.frame else { return }
    UserDefaults.standard.set(Double(f.minX), forKey: Self.savedXKey)
    UserDefaults.standard.set(Double(f.maxY), forKey: Self.savedTopKey)
  }

  /** "Reset position": forget the saved spot and go back under the menu bar icon. */
  private func resetPosition() {
    UserDefaults.standard.removeObject(forKey: Self.savedXKey)
    UserDefaults.standard.removeObject(forKey: Self.savedTopKey)
    if let p = panel { place(p, size: p.frame.size) }
  }

  /// The saved spot, only if it is still on a screen (a monitor may have been unplugged).
  private func savedOrigin(size: NSSize) -> NSPoint? {
    let d = UserDefaults.standard
    guard let x = d.object(forKey: Self.savedXKey) as? Double, let top = d.object(forKey: Self.savedTopKey) as? Double else { return nil }
    let r = NSRect(x: x, y: top - size.height, width: size.width, height: size.height)
    guard NSScreen.screens.contains(where: { $0.visibleFrame.intersects(r) }) else { return nil }
    return r.origin
  }

  /** Where the owner left it, else under the menu bar icon, inside the screen. */
  private func place(_ p: NSPanel, size: NSSize) {
    if let o = savedOrigin(size: size) {
      p.setFrame(NSRect(origin: o, size: size), display: true)
      return
    }
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
      MainActor.assumeIsolated { if self?.box.pinned == false { self?.close() } }
    }
  }
}
