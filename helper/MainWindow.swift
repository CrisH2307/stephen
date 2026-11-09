// Stephen Helper: the main window's frame (UI-PLAN v3.1 section 4). Sidebar: wordmark and collapse (⌘\, 60 pt icon
// rail, remembered), the "Ask Stephen ⌘K" field (opens the Ask box), STEPHEN (Home, Conversations, Jobs) and YOU
// (Personal, Settings) with ⌘1…⌘5, and the status row (dot + word, Start/Stop through StephenControl).
// Pages: Page (the router enum) and WindowNav (the selection, also set by the Ask box). Later UI PRs add or restyle
// pages here; Conversations, Jobs, Settings and Personal still show the older screens from AppWindow.swift.

import AppKit
import SwiftUI

/** The window's pages. The first five are the sidebar rows (⌘1…⌘5); memory is opened from the Ask box. */
enum Page: String, CaseIterable, Identifiable {
  case home, conversations, jobs, personal, settings, memory

  static let stephen: [Page] = [.home, .conversations, .jobs]
  static let you: [Page] = [.personal, .settings]

  var id: String { return rawValue }

  var title: String {
    switch self {
    case .home: return "Home"
    case .conversations: return "Conversations"
    case .jobs: return "Jobs"
    case .personal: return "Personal"
    case .settings: return "Settings"
    case .memory: return "Memory"
    }
  }

  var symbol: String {
    switch self {
    case .home: return "house"
    case .conversations: return "bubble.left.and.bubble.right"
    case .jobs: return "tray.full"
    case .personal: return "person.crop.circle"
    case .settings: return "gearshape"
    case .memory: return "lightbulb"
    }
  }

  /** "1"…"5" for the sidebar pages (⌘1…⌘5). */
  var key: KeyEquivalent? {
    guard let i = (Page.stephen + Page.you).firstIndex(of: self) else { return nil }
    return KeyEquivalent(Character(String(i + 1)))
  }
}

/** Which page the window shows. Outside the views so the Ask box can set it ("Review memory"). */
final class WindowNav: ObservableObject {
  @Published var page: Page = .home
}

/** What the window asks of the rest of the helper (main.swift fills it). */
struct WindowActions {
  /** Open the Ask box with the keyboard in it (⌘K, the sidebar field, Home's Send). */
  var ask: () -> Void = {}
  /** Open the Ask box and start push-to-talk (Home's Talk). */
  var talk: () -> Void = {}
}

/** The status row's word and dot. States are named in words (UI-PLAN section 2), never by color alone. */
func listenerWord(connection: AppConnectionState, listening: Bool, listener: ListenerStatus) -> (word: String, kind: StatusKind) {
  switch (connection, listener) {
  case (.online, _): return listening ? ("Listening", .ok) : ("Microphone off", .warn)
  case (_, .starting): return ("Starting", .warn)
  case (_, .stopped): return ("Stopped", .idle)
  case (.connecting, .running): return ("Connecting", .warn)
  case (.offline, .running): return ("Offline", .bad)
  }
}

struct AppRootView: View {
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  let actions: WindowActions

  var body: some View {
    MainWindowView(model: model, nav: nav, control: control, actions: actions)
      .stephenThemed(savedThemeChoice())
  }
}

private struct MainWindowView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  let actions: WindowActions
  @AppStorage("sidebarCollapsed") private var collapsed = false

  var body: some View {
    HStack(spacing: 0) {
      SidebarView(model: model, nav: nav, control: control, actions: actions, collapsed: $collapsed)
        .frame(width: collapsed ? 60 : 220)
      Rectangle().fill(t.line).frame(width: 1)
      detail.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .stephenAnimation(Motion.bar, value: collapsed)
    .background(t.ground)
    .frame(minWidth: 640, minHeight: 420)
  }

  @ViewBuilder
  private var detail: some View {
    if model.connection != .online {
      OfflineView(model: model)
    } else {
      switch nav.page {
      case .home: HomeView(model: model, nav: nav, actions: actions)
      case .conversations: ConversationsPage(model: model)
      case .jobs: JobsView(model: model)
      case .personal: PersonalView(model: model, nav: nav)
      case .settings: SettingsView(model: model)
      case .memory: MemoryView(model: model)
      }
    }
  }
}

private struct SidebarView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  let actions: WindowActions
  @Binding var collapsed: Bool

  var body: some View {
    VStack(alignment: collapsed ? .center : .leading, spacing: Space.l) {
      HStack(spacing: Space.s) {
        if !collapsed {
          Text(verbatim: "Stephen").font(TypeScale.section).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
          Spacer(minLength: 0)
        }
        Button { collapsed.toggle() } label: {
          Image(systemName: "sidebar.left").font(.system(size: 16)).foregroundColor(t.ink2).frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
        .keyboardShortcut("\\", modifiers: .command)
        .help(collapsed ? "Show sidebar (⌘\\)" : "Hide sidebar (⌘\\)")
        .accessibilityLabel(collapsed ? "Show sidebar" : "Hide sidebar")
      }
      askField
      if collapsed {
        VStack(spacing: Space.xs) { rows(Page.stephen) }
        Rectangle().fill(t.line).frame(height: 1)
        VStack(spacing: Space.xs) { rows(Page.you) }
      } else {
        SidebarSection("Stephen") { rows(Page.stephen) }
        SidebarSection("You") { rows(Page.you) }
      }
      Spacer(minLength: 0)
      StatusRow(model: model, control: control, collapsed: collapsed)
    }
    .padding(.horizontal, collapsed ? Space.s : Space.m)
    .padding(.vertical, Space.m)
  }

  /** Looks like a field, acts as a button: the Ask box is where you type (UI-PLAN section 5). */
  private var askField: some View {
    Button(action: actions.ask) {
      HStack(spacing: Space.s) {
        Image(systemName: "text.bubble").font(.system(size: 14)).foregroundColor(t.ink2)
        if !collapsed {
          Text(verbatim: "Ask Stephen").font(TypeScale.body).foregroundColor(t.ink2)
          Spacer(minLength: 0)
          Text(verbatim: "⌘K").font(TypeScale.secondary).foregroundColor(t.ink2)
        }
      }
      .padding(.horizontal, Space.s).padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: collapsed ? .center : .leading)
      .background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface))
      .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.line, lineWidth: 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Ask Stephen (⌘K)")
    .accessibilityLabel("Ask Stephen")
    .accessibilityHint("Opens the Ask box. Shortcut Command K.")
  }

  private func rows(_ pages: [Page]) -> some View {
    ForEach(pages) { p in
      SidebarRow(p.title, symbol: p.symbol, selected: nav.page == p, collapsed: collapsed) { nav.page = p }
        .keyboardShortcut(p.key!, modifiers: .command)  // rows() only gets sidebar pages
    }
  }
}

/** Dot + word, and Start/Stop for the listener this helper owns (StephenControl, ROADMAP P2). */
private struct StatusRow: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var control: StephenControl
  let collapsed: Bool
  @State private var problem: String? = nil

  var body: some View {
    let s = listenerWord(connection: model.connection, listening: model.listening, listener: control.listener)
    VStack(alignment: .leading, spacing: Space.xs) {
      if collapsed {
        Circle().fill(s.kind.color(t)).frame(width: 8, height: 8).frame(width: 24, height: 24)
          .help(s.word).accessibilityLabel("Stephen: \(s.word)")
      } else {
        HStack(spacing: Space.s) {
          StatusPill(s.word, kind: s.kind)
          Spacer(minLength: 0)
          startStop
        }
        if let p = problem {
          Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .onAppear { control.refresh() }
    .onChange(of: model.connection) { _ in control.refresh() }
    .onChange(of: control.listener) { l in
      // The listener came up: connect now instead of waiting for the next retry.
      if case .running = l, model.connection == .offline { model.retry() }
    }
  }

  @ViewBuilder
  private var startStop: some View {
    switch control.listener {
    case .stopped:
      QuietButton("Start") { problem = nil; control.start { problem = $0 } }
    case .starting, .running(fromApp: true):
      QuietButton("Stop") { problem = nil; control.stop { problem = $0 } }
    case .running(fromApp: false):
      // Started in Terminal: only Ctrl-C there stops it (StephenControl.stop refuses).
      Image(systemName: "terminal").foregroundColor(t.ink2).help("Running in Terminal. Stop it there with Ctrl-C.")
        .accessibilityLabel("Running in Terminal. Stop it there with Control C.")
    }
  }
}

/** History ("what you asked") and the audit log ("what Stephen did") until the Conversations PR merges them. */
private struct ConversationsPage: View {
  @ObservedObject var model: AppModel
  @State private var showAudit = false

  var body: some View {
    VStack(spacing: 0) {
      Segmented("Show", options: [(value: false, title: "What you asked"), (value: true, title: "What Stephen did")], selection: $showAudit)
        .frame(width: 320).padding(Space.m)
      if showAudit { AuditView(model: model) } else { HistoryView(model: model) }
    }
  }
}
