// Stephen Helper: the Stephen window, SwiftUI hosted in one reused NSWindow. The frame (sidebar, page router) is in
// MainWindow.swift, Home in HomeView.swift, Personal in PersonalView.swift, Conversations and Jobs in their own files; this
// file has the Accounts helper and the window controller.
// Data comes from AppModel (AppClient.swift), which talks to `stephen listen` over <home>/run/app.sock.
//
// Untrusted text (replies, memory, history, audit, settings) is always shown with Text(verbatim:), never as a
// LocalizedStringKey, so nothing is interpreted as Markdown.
//
// Threading: AppWindowController is @MainActor (it owns AppKit objects); main.swift reaches it the same way as
// StatusMenu. The SwiftUI views run on the main thread and call AppModel directly.

import AppKit
import SwiftUI

struct NoticeView: View {
  let text: String

  var body: some View {
    Text(verbatim: text)
      .font(.callout)
      .foregroundColor(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
  }
}

/** A centred symbol and one line, for lists with nothing in them yet. */
struct EmptyStateView: View {
  let symbol: String
  let text: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: symbol).font(.largeTitle).foregroundColor(.secondary)
      Text(verbatim: text).foregroundColor(.secondary).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(20)
  }
}

struct OfflineView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(spacing: 12) {
      Spacer()
      if model.connection == .connecting {
        ProgressView().controlSize(.small)
        Text(verbatim: "Connecting to Stephen…").foregroundColor(.secondary)
      } else {
        Image(systemName: "bolt.horizontal.circle").font(.largeTitle).foregroundColor(.secondary)
        Text(verbatim: "Can't reach Stephen. Press Start in the sidebar, or run `stephen listen`.").font(.title3)
        if let reason = model.offlineReason {
          Text(verbatim: reason).font(.caption).foregroundColor(.secondary)
        }
        Button("Retry") { model.retry() }
      }
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(20)
  }
}

// ───────────────────────────── accounts ─────────────────────────────

/** An accounts.status row in words (Personal > Connected). Where the secret was found, never the secret. */
func accountStateWord(_ account: AccountRow) -> (word: String, kind: StatusKind) {
  let place = account.source.map { $0 == "keychain" ? " · Keychain" : " · \($0)" } ?? ""
  switch account.state {
  case "connected": return ("Connected" + place, .ok)
  case "off": return ("Turned off", .idle)
  default: return ("Not set up", .warn)
  }
}

// ───────────────────────────── window ─────────────────────────────

/** Owns the one Stephen window; `show()` creates it the first time and reuses it after that. */
@MainActor
final class AppWindowController: NSObject, NSWindowDelegate {
  static let frameName = "StephenWindow"
  private let model: AppModel
  private let control: StephenControl
  private let nav = WindowNav()
  private var window: NSWindow? = nil
  /** Ask box hooks (⌘K, the sidebar field, Home's Talk and Send). Set before the first show(). */
  var actions = WindowActions()

  init(model: AppModel, control: StephenControl) {
    self.model = model
    self.control = control
    super.init()
  }

  /// ⌘K: Home's composer when the window is in front, else the Ask box.
  @objc func askClicked(_ sender: Any?) {
    if window?.isKeyWindow == true { nav.askHere() } else { actions.ask() }
  }

  func show(page: Page? = nil) {
    if let page = page { nav.page = page }
    let w: NSWindow
    if let existing = window {
      w = existing
    } else {
      w = makeWindow()
      window = w
    }
    installEditMenuIfNeeded()
    model.opened("window")
    // LSUIElement app: it is never frontmost by itself, so bring it forward with its window.
    NSApp.activate(ignoringOtherApps: true)
    w.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    model.closed("window")
  }

  private func makeWindow() -> NSWindow {
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 860, height: 580),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false)
    w.title = "Stephen"
    w.isReleasedWhenClosed = false
    w.minSize = NSSize(width: 640, height: 420)
    w.contentView = NSHostingView(rootView: AppRootView(model: model, nav: nav, control: control, actions: actions))
    w.delegate = self
    w.center()
    // Remembers size and position across launches (stored in the helper's user defaults).
    _ = w.setFrameAutosaveName(AppWindowController.frameName)
    return w
  }

  /**
   * An accessory app has no main menu, and without one Cmd+C / Cmd+V / Cmd+A / Cmd+W do nothing in the window.
   * This menu is never drawn (no menu bar for LSUIElement apps); it only provides the key equivalents.
   */
  private func installEditMenuIfNeeded() {
    guard NSApp.mainMenu == nil else { return }
    let main = NSMenu()

    let appItem = NSMenuItem(title: "Stephen", action: nil, keyEquivalent: "")
    let appMenu = NSMenu(title: "Stephen")
    let ask = NSMenuItem(title: "Ask Stephen", action: #selector(askClicked(_:)), keyEquivalent: "k")
    ask.target = self
    appMenu.addItem(ask)
    appMenu.addItem(
      NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let edit = NSMenu(title: "Edit")
    edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
    let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(redo)
    edit.addItem(NSMenuItem.separator())
    edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
    edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
    edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
    edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    editItem.submenu = edit
    main.addItem(editItem)

    NSApp.mainMenu = main
  }
}
