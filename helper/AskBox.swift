// Stephen Helper: the Ask box (UI-PLAN v3.2 section 5). A 360 pt non-activating chat panel under the menu bar icon,
// opened by clicking the icon, by F5 (push-to-talk, shown while you talk) or by Cmd+K inside the app. It is a real
// chat: the current conversation as a scrolling thread (ChatThreadView, the same one Home shows), with the input at the
// bottom, all from AppModel (the same app.sock connection and chat as the Stephen window). Drag it by the strip on
// top; it remembers where you left it. The strip shows Stephen's state as a word (S9). The ... button opens a normal
// pop-up menu over the box (the chat title, New chat, pin, Reset position, usage), so the chat stays in view.
//
// Motion: the panel window never changes size. It is a fixed, transparent canvas; only the card inside it grows and
// shrinks, one SwiftUI animation of its height (clicks on the transparent part go through to the app below). Resizing
// the window while SwiftUI also animated the content was the jumpy look in the owner's recording of 2026-11-09.
//
// Untrusted text (replies, what was heard) is shown with Text(verbatim:), never as Markdown.
// Threading: main thread only (AskBoxController is @MainActor; main.swift reaches it like StatusMenu).

import AppKit
import Combine
import SwiftUI

/** Box-only state; everything else is read from AppModel. */
final class AskBoxState: ObservableObject {
  @Published var draft = ""
  /** Push-to-talk started from the box's mic button (tap the box again to send). */
  @Published var micHeld = false
  /** The helper has no working key listener (no Input Monitoring): F5, Fn+Option and Esc never reach Stephen. */
  @Published var keysOff = false
  /** Why the box's Start button couldn't start Stephen, or nil. */
  @Published var startProblem: String? = nil
  /** Stay open when you click elsewhere. Remembered. */
  @Published var pinned = UserDefaults.standard.bool(forKey: "askBoxPinned") {
    didSet { UserDefaults.standard.set(pinned, forKey: "askBoxPinned") }
  }
}

enum AskBoxMode: Equatable {
  case offline
  case listening
  case chat

  static func of(_ model: AppModel, _ box: AskBoxState) -> AskBoxMode {
    if !model.confirms.isEmpty { return .chat }  // the question is a message in the thread
    if model.connection != .online { return .offline }
    if model.state == "recording" || box.micHeld { return .listening }
    return .chat
  }
}

/// The Ask box strip's state word (S9): is Stephen ready, listening or busy, in words with a dot (never colour alone).
/// The box can't tell a stopped listener from an unreachable one, so offline says only "Offline".
func askBoxStateWord(connection: AppConnectionState, state: String, listening: Bool, working: Bool) -> (word: String, kind: StatusKind) {
  switch connection {
  case .offline: return ("Offline", .bad)
  case .connecting: return ("Connecting", .warn)
  case .online: break
  }
  if state == "recording" { return ("Listening", .ok) }
  if working { return ("Working", .idle) }
  if state == "speaking" { return ("Speaking", .idle) }
  return listening ? ("Ready", .ok) : ("Microphone off", .warn)
}

struct AskBoxActions {
  var close: () -> Void
  var micDown: () -> Void
  var micUp: () -> Void
  /** Esc while the box's mic is on: cancel through the helper's Esc path (never sends). */
  var micCancel: () -> Void
  var openApp: () -> Void
  var reviewMemory: () -> Void
  var quit: () -> Void
  /** The owner let go of the drag strip: remember where the box is. */
  var dragEnded: () -> Void
  var resetPosition: () -> Void
  /** Start `stephen listen`, the sidebar's Start: done(nil) when started, else why not (#144). */
  var start: (@escaping (String?) -> Void) -> Void
}

// ───────────────────────────── view ─────────────────────────────

/// Allow and Deny for one question. Both stay disabled for 0.75 s each time the shown question changes, so a double
/// click, or a click aimed at the menu bar icon as the box opens, can't answer a question the owner hasn't seen (R9-6).
struct ConfirmButtons: View {
  @Environment(\.stephenTheme) var t
  let question: PendingConfirm
  let waiting: Int
  let answer: (Bool) -> Void
  /// The main window's ⌘K palette is open: both buttons are off until it closes (UI-V4-IA-PLAN 7.5.4).
  @Environment(\.paletteOpen) var paletteOpen
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
    .disabled(!live || paletteOpen).opacity(live ? 1 : 0.5)
    .task(id: question.id) {
      armed = nil
      try? await Task.sleep(nanoseconds: 750_000_000)
      if !Task.isCancelled { armed = question.id }
    }
  }
}

struct AskBoxView: View {
  @Environment(\.stephenTheme) var t
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ObservedObject var model: AppModel
  @ObservedObject var box: AskBoxState
  let actions: AskBoxActions
  /// The card's shown height. It follows the content's own height with one ease, so the card opens and closes like a
  /// drawer; the content itself switches at once and is clipped to the card while it moves.
  @State private var cardHeight: CGFloat = 0

  var body: some View {
    let mode = AskBoxMode.of(model, box)
    VStack(alignment: .leading, spacing: Space.s) {
      topStrip
      content(mode)
    }
    .padding(.horizontal, Space.l).padding(.bottom, Space.l).padding(.top, Space.xs)
    .frame(width: AskBoxController.cardWidth, alignment: .leading)
    .fixedSize(horizontal: false, vertical: true)
    .background(GeometryReader { g in Color.clear.preference(key: AskBoxSizeKey.self, value: g.size) })
    .frame(height: cardHeight > 0 ? cardHeight : nil, alignment: .top)
    .clipShape(RoundedRectangle(cornerRadius: Corner.askBox))
    .background(RoundedRectangle(cornerRadius: Corner.askBox).fill(t.surface).shadow(color: .black.opacity(0.18), radius: 14, y: 6))
    .overlay(RoundedRectangle(cornerRadius: Corner.askBox).stroke(t.line, lineWidth: 1))
    .background(shortcuts)
    .onPreferenceChange(AskBoxSizeKey.self) { size in follow(size.height) }
    .onChange(of: model.thread.last?.id) { _ in model.refreshUsage() }  // the menu's usage lines stay current
    .onExitCommand { escape(mode) }
  }

  private func follow(_ h: CGFloat) {
    guard h > 0, abs(h - cardHeight) > 0.5 else { return }
    if cardHeight == 0 || reduceMotion { cardHeight = h; return }
    withAnimation(.easeInOut(duration: Motion.bar)) { cardHeight = h }
  }

  /// Drag the strip to move the box. The ... button sits beside it, not on top: an AppKit drag view would take
  /// its clicks (that was the "can't open the menu" bug). The state word sits next to ... (S9); the chat title is in
  /// the ... menu (R7).
  private var topStrip: some View {
    let s = askBoxStateWord(connection: model.connection, state: model.state, listening: model.listening, working: model.isWorking)
    return HStack(spacing: Space.xs) {
      ZStack {
        DragStrip(onEnd: actions.dragEnded)
        Capsule().fill(t.line).frame(width: 36, height: 4).accessibilityHidden(true).allowsHitTesting(false)
        HStack {
          Spacer(minLength: 0)
          StatusPill(s.word, kind: s.kind)
        }
        .padding(.horizontal, Space.xs).allowsHitTesting(false)
      }
      menu
      Button(action: actions.close) {
        Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundColor(t.ink2)
          .frame(width: 28, height: 28).contentShape(Rectangle())
      }
      .buttonStyle(.plain).help("Close (Esc)").accessibilityLabel("Close")
    }
    .frame(height: 32)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func content(_ mode: AskBoxMode) -> some View {
    switch mode {
    case .chat:
      if !model.thread.isEmpty || !model.confirms.isEmpty || model.isWorking {
        // Fixed height once the chat has started (owner, 2026-11-09): the box keeps one size and a long chat scrolls,
        // instead of growing with every message.
        ChatThreadView(model: model).frame(height: 340)
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
      if box.keysOff {
        Text(verbatim: "F5 and Esc don't reach Stephen from other apps (needs Input Monitoring). Here: click to send, Esc to cancel.")
          .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      }
    case .offline:
      // The box can't tell stopped from unreachable, so it says only what is true; Start explains if it is running.
      Text(verbatim: "Can't reach Stephen.").font(TypeScale.body).foregroundColor(t.ink)
      if let p = box.startProblem {
        Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      }
      PrimaryButton("Start") { box.startProblem = nil; actions.start { box.startProblem = $0 } }
    }
  }

  /// A normal pop-up menu: it opens over the box and the chat stays where it is. The shortcuts (⌘N, ⌘O, ⌘Q) are the
  /// hidden buttons below, so they also work with the menu closed.
  private var menu: some View {
    Menu {
      // The chat's title (your first words, verbatim); a label, not a button.
      Text(verbatim: model.threadTitle)
      Divider()
      Button("New chat  ⌘N") { newChat() }
      Button("Open Stephen  ⌘O") { actions.openApp() }
      Toggle("Pin open", isOn: $box.pinned)
      Button("Reset position") { actions.resetPosition() }
      // Shown only once a `usage` answer arrives (usage.get, P2); an older listener never answers.
      if model.usage?.context != nil || model.usage?.memory != nil {
        Divider()
        if let m = model.usage?.context { Text(verbatim: usageLine("This chat", m.percent, m.warn, "context used")) }
        if let m = model.usage?.memory { Text(verbatim: usageLine("Memory", m.percent, m.warn, "full")) }
      }
      Button("Review memory") { actions.reviewMemory() }
      Divider()
      Button("Quit  ⌘Q") { actions.quit() }
    } label: {
      Image(systemName: "ellipsis").font(.system(size: 16)).foregroundColor(t.ink2)
    }
    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    .frame(width: 28, height: 28)
    .help("More").accessibilityLabel("More")
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
    box.draft = ""
    model.newChat()
  }

  private func escape(_ mode: AskBoxMode) {
    if model.denyFirstConfirm() { return }  // Esc = Deny, like the dialog
    switch mode {
    case .listening where box.micHeld: actions.micCancel()
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

/** "Memory: 85% full, almost full". Words, not color: the menu is plain text (UI-PLAN section 2). */
func usageLine(_ title: String, _ percent: Int, _ warn: Bool, _ word: String) -> String {
  let p = min(max(percent, 0), 100)
  return "\(title): \(p)% \(word)" + (warn ? ", almost full" : "")
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
  /** The Esc key's path in the helper (esc, then the press ends): Esc in the box cancels, never sends. */
  var cancelTalk: () -> Void = {}
  /** Start the listener (main.swift wires StephenControl.start). */
  var start: (@escaping (String?) -> Void) -> Void = { $0("Stephen Helper can't start Stephen from here.") }

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
      place(p)
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
    // A click outside (or any close) while listening cancels like Esc; it never sends (#107).
    if box.micHeld { box.micHeld = false; cancelTalk() }
    if let m = clickMonitor { NSEvent.removeMonitor(m) }
    clickMonitor = nil
    panel?.orderOut(nil)
  }

  /** Home's Talk button: open the box and start talking; press it again (or tap the box) to send. */
  func talk() {
    if box.micHeld { return micUp() }
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

  /// The card, and the fixed transparent panel around it. The panel is as tall as the card can get (strip, a 340 pt
  /// thread, the field) plus a margin for the card's shadow, so the window itself never resizes.
  static let cardWidth: CGFloat = 360
  private static let cardMaxHeight: CGFloat = 520
  private static let margin: CGFloat = 24
  private static var panelSize: NSSize {
    return NSSize(width: cardWidth + 2 * margin, height: cardMaxHeight + 2 * margin)
  }

  private func makePanel() -> AskPanel {
    let p = AskPanel(
      contentRect: NSRect(origin: .zero, size: Self.panelSize), styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = false  // the card draws its own shadow; a window shadow would outline the whole canvas
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.setAccessibilityLabel("Ask Stephen")
    // Esc that reaches the panel itself (not the SwiftUI view): a waiting question first (Deny, R10a-5), then cancel a
    // recording (never send it through close()), then close.
    p.onEscape = { [weak self] in
      guard let self else { return }
      if self.model.denyFirstConfirm() { return }
      if self.box.micHeld { self.box.micHeld = false; self.cancelTalk() } else { self.close() }
    }
    let actions = AskBoxActions(
      close: { [weak self] in self?.close() },
      micDown: { [weak self] in self?.micDown() },
      micUp: { [weak self] in self?.micUp() },
      micCancel: { [weak self] in self?.box.micHeld = false; self?.cancelTalk() },
      openApp: { [weak self] in self?.close(); self?.openWindow(nil) },
      reviewMemory: { [weak self] in self?.close(); self?.openWindow(.memory) },
      quit: { [weak self] in self?.quit() },
      dragEnded: { [weak self] in self?.savePosition() },
      resetPosition: { [weak self] in self?.resetPosition() },
      start: { [weak self] done in self?.start(done) })
    let root = AskBoxView(model: model, box: box, actions: actions)
      .stephenThemedBySettings()
      .padding(Self.margin)
      .frame(width: Self.panelSize.width, height: Self.panelSize.height, alignment: .top)
    p.contentView = NSHostingView(rootView: root)
    return p
  }

  /// Where the owner left the box: the card's left edge and top edge. The card grows downward, so the top is the anchor.
  private static let savedXKey = "askBoxX", savedTopKey = "askBoxTop"

  private func savePosition() {
    guard let f = panel?.frame else { return }
    UserDefaults.standard.set(Double(f.minX + Self.margin), forKey: Self.savedXKey)
    UserDefaults.standard.set(Double(f.maxY - Self.margin), forKey: Self.savedTopKey)
  }

  /** The panel frame for a card whose top-left corner is at (left, top), in screen coordinates. */
  private static func panelFrame(cardLeft: CGFloat, cardTop: CGFloat) -> NSRect {
    let s = panelSize
    return NSRect(x: cardLeft - margin, y: cardTop + margin - s.height, width: s.width, height: s.height)
  }

  /** "Reset position": forget the saved spot and go back under the menu bar icon. */
  private func resetPosition() {
    UserDefaults.standard.removeObject(forKey: Self.savedXKey)
    UserDefaults.standard.removeObject(forKey: Self.savedTopKey)
    if let p = panel { place(p) }
  }

  /// The saved spot, only if the card's top part is still on a screen (a monitor may have been unplugged).
  private func savedFrame() -> NSRect? {
    let d = UserDefaults.standard
    guard let x = d.object(forKey: Self.savedXKey) as? Double, let top = d.object(forKey: Self.savedTopKey) as? Double else { return nil }
    let strip = NSRect(x: x, y: top - 80, width: Double(Self.cardWidth), height: 80)
    guard NSScreen.screens.contains(where: { $0.visibleFrame.intersects(strip) }) else { return nil }
    return Self.panelFrame(cardLeft: CGFloat(x), cardTop: CGFloat(top))
  }

  /** Where the owner left it, else under the menu bar icon, inside the screen. */
  private func place(_ p: NSPanel) {
    if let f = savedFrame() {
      p.setFrame(f, display: true)
      return
    }
    let w = Self.cardWidth
    var left: CGFloat = 0, top: CGFloat = 0
    if let b = anchor(), let bw = b.window {
      let r = bw.convertToScreen(b.convert(b.bounds, to: nil))
      left = r.midX - w / 2
      top = r.minY - 6
      if let vis = bw.screen?.visibleFrame { left = min(max(left, vis.minX + 8), vis.maxX - w - 8) }
    } else if let vis = NSScreen.main?.visibleFrame {
      left = vis.maxX - w - 8
      top = vis.maxY - 6
    }
    p.setFrame(Self.panelFrame(cardLeft: left, cardTop: top), display: true)
  }

  /** A click in another app closes the box (clicks in Stephen's own windows don't reach a global monitor). */
  private func watchOutsideClicks() {
    guard clickMonitor == nil else { return }
    clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      MainActor.assumeIsolated { if self?.box.pinned == false { self?.close() } }
    }
  }
}
