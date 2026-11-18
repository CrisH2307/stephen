// Stephen Helper: the main window's frame (UI-PLAN v3.1 section 4). Sidebar: wordmark and collapse (⌘\, 60 pt icon
// rail, remembered), the "Ask Stephen ⌘K" field (opens the Ask box), STEPHEN (Home, Conversations, Jobs) and YOU
// (Personal, Settings) with ⌘1…⌘5, and the status row (dot + word, Start/Stop through StephenControl).
// Pages: Page (the router enum) and WindowNav (the selection, also set by the Ask box). Later UI PRs add or restyle
// pages here.

import AppKit
import SwiftUI

/** The window's pages. The first five are the sidebar rows (⌘1…⌘5); memory is opened from Personal and the Ask box. */
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
  /** Open the Ask box with the keyboard in it (the waiting-question banner's Open, #138). */
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
      .stephenThemedBySettings()
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
        .frame(width: SidebarMetrics.column(collapsed), alignment: .leading).clipped()
      Rectangle().fill(t.line).frame(width: 1)
      VStack(spacing: 0) {
        if !model.confirms.isEmpty { questionBanner }
        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .stephenAnimation(Motion.bar, value: collapsed)
    .background(t.ground)
    .frame(minWidth: WindowMetrics.minContent.width, minHeight: WindowMetrics.minContent.height)
  }

  /// On every page while a question waits (#138). Safety: it only opens the Ask box, where the card is. No Allow, no
  /// keyboard shortcut, and not the question's text (that is shown, as data, on the card).
  private var questionBanner: some View {
    let n = model.confirms.count
    return HStack(spacing: Space.s) {
      Image(systemName: "questionmark.circle.fill").foregroundColor(t.warn).accessibilityHidden(true)
      Text(verbatim: n == 1 ? "Stephen is waiting for your OK" : "Stephen is waiting for your OK (\(n) questions)")
        .font(TypeScale.body.weight(.medium)).foregroundColor(t.ink)
      Spacer(minLength: Space.s)
      QuietButton("Open") { actions.ask() }
    }
    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
    .background(t.surface)
    .overlay(Rectangle().fill(t.line).frame(height: 1), alignment: .bottom)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private var detail: some View {
    if model.connection != .online {
      if nav.page == .settings {
        // Appearance needs no listener, so Settings keeps it while offline (#144). The other panes do need it.
        ScrollView {
          VStack(alignment: .leading, spacing: Space.xl) {
            OfflineView(model: model, control: control).frame(maxWidth: .infinity)
            AppearanceSettings()
          }
          .padding(Space.xxl)
          .frame(maxWidth: 640, alignment: .leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        OfflineView(model: model, control: control).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      switch nav.page {
      case .home: HomeView(model: model, nav: nav, actions: actions)
      case .conversations: ConversationsPage(model: model)
      case .jobs: JobsView(model: model)
      case .personal: PersonalView(model: model, nav: nav)
      case .settings: SettingsView(model: model, control: control)
      case .memory: MemoryPage(model: model, nav: nav)
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
    // One layout for both states: only the width (animated by the window), the fades and the toggle's side change.
    VStack(alignment: .leading, spacing: Space.xl) {
      ZStack(alignment: .leading) {
        Text(verbatim: "Stephen").font(TypeScale.section).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
          .padding(.leading, Space.s).opacity(collapsed ? 0 : 1).fixedSize()
        Button { collapsed.toggle() } label: {
          Image(systemName: "sidebar.left").font(.system(size: 16)).foregroundColor(t.ink2).frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
        .keyboardShortcut("\\", modifiers: .command)
        .help(collapsed ? "Show sidebar (⌘\\)" : "Hide sidebar (⌘\\)")
        .accessibilityLabel(collapsed ? "Show sidebar" : "Hide sidebar")
        .padding(.leading, collapsed ? 8 : 0)
        .frame(width: SidebarMetrics.content(collapsed), alignment: collapsed ? .leading : .trailing)
      }
      .frame(width: SidebarMetrics.content(collapsed), alignment: .leading)
      VStack(alignment: .leading, spacing: Space.m) {
        askField
        SidebarSection("Stephen", collapsed: collapsed) { rows(Page.stephen) }
        SidebarSection("You", collapsed: collapsed) { rows(Page.you) }
      }
      Spacer(minLength: 0)
      StatusRow(model: model, control: control, collapsed: collapsed)
    }
    .frame(width: SidebarMetrics.content(collapsed), alignment: .leading)
    .padding(.horizontal, SidebarMetrics.pad)
    .padding(.vertical, Space.l)
  }

  /** Looks like a field, acts as a button: it opens the Ask box, and so does ⌘K (issue #87). */
  private var askField: some View {
    Button(action: actions.ask) {
      HStack(spacing: Space.s) {
        Image(systemName: "text.bubble").font(.system(size: 14)).foregroundColor(t.ink2).frame(width: 20)
        Text(verbatim: "Ask Stephen").font(TypeScale.body).foregroundColor(t.ink2).lineLimit(1).fixedSize().opacity(collapsed ? 0 : 1)
        Spacer(minLength: 0)
        Text(verbatim: "⌘K").font(TypeScale.secondary).foregroundColor(t.ink2).opacity(collapsed ? 0 : 1)
      }
      .padding(.horizontal, Space.s).padding(.vertical, 9)
      .frame(width: SidebarMetrics.content(collapsed), alignment: .leading)
      .clipShape(RoundedRectangle(cornerRadius: Corner.row))
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
      SidebarRow(p.title, symbol: p.symbol, selected: nav.page == p, collapsed: collapsed, shortcut: p.key.map { "⌘\($0.character)" },
                 badge: p == .home ? model.confirms.count : 0) { nav.page = p }
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
      HStack(spacing: Space.s) {
        StatusPill(s.word, kind: s.kind, showWord: !collapsed).padding(.leading, Space.s + 6)  // the dot sits under the icons
        Spacer(minLength: 0)
        startStop.opacity(collapsed ? 0 : 1).allowsHitTesting(!collapsed)
      }
      .frame(width: SidebarMetrics.content(collapsed), alignment: .leading)
      .help(collapsed ? s.word : "")
      if let p = problem, !collapsed {
        Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      }
      // The replay recorder is on (issue #48): in words with a waveform, not a red dot that looks like the mic.
      if model.recordingOn {
        HStack(spacing: Space.s) {
          Image(systemName: "waveform").foregroundColor(t.ink2).accessibilityHidden(true)
          if !collapsed { Text(verbatim: "Recording on").font(TypeScale.secondary).foregroundColor(t.ink2) }
        }
        .padding(.leading, Space.s + 6)
        .help("Your F5 commands are saved on this Mac for 30 days. Turn it off in Settings, Privacy and safety.")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Recording on. F5 commands are saved on this Mac for 30 days.")
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
