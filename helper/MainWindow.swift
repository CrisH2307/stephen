// Stephen Helper: the main window's frame (UI v4 shell, docs/research/UI-V4-IA-PLAN.md sections 5, 7 and 8).
// Sidebar (glass): wordmark and collapse (⌘\, 60 pt icon rail, remembered), two groups: Talk (Home, Conversations,
// Jobs) and Control (Memory, Settings), ⌘1…⌘5, then at the bottom left the solid "Recording on" sign and the state row.
// Content column: the toolbar (glass: page title, page actions, Search ⌘K), the waiting-question banner (solid), then
// the page. The ⌘K palette (Palette.swift) opens over the page, under the banner.

import AppKit
import SwiftUI

/** The window's pages. The five sidebar rows are Page.talk + Page.control (⌘1…⌘5). */
enum Page: String, CaseIterable, Identifiable {
  case home, conversations, jobs, memory, settings

  static let talk: [Page] = [.home, .conversations, .jobs]
  static let control: [Page] = [.memory, .settings]

  var id: String { return rawValue }

  var title: String {
    switch self {
    case .home: return "Home"
    case .conversations: return "Conversations"
    case .jobs: return "Jobs"
    case .memory: return "Memory"
    case .settings: return "Settings"
    }
  }

  var symbol: String {
    switch self {
    case .home: return "house"
    case .conversations: return "bubble.left.and.bubble.right"
    case .jobs: return "tray.full"
    case .memory: return "note.text"
    case .settings: return "gearshape"
    }
  }

  /** "1"…"5" for the sidebar pages (⌘1…⌘5). */
  var key: KeyEquivalent? {
    guard let i = (Page.talk + Page.control).firstIndex(of: self) else { return nil }
    return KeyEquivalent(Character(String(i + 1)))
  }
}

/** The window's shared view state. Outside the views so the Ask box, the app menu and the palette can set it. */
final class WindowNav: ObservableObject {
  @Published var page: Page = .home
  /// The ⌘K palette is open. While it is, the question card's keys are off (\.paletteOpen, Palette.swift).
  @Published var paletteOpen = false
  /// Home's composer text. The palette's Ask row fills it; only Home's Send sends it.
  @Published var draft = ""
  /// Conversations' "Clear all…" (toolbar ⋯ menu) asks first; the page shows the alert.
  @Published var confirmClearAll = false
  /// Settings > About's doctor result, so the palette's "Run doctor" shows it there.
  @Published var doctor = ""
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

/** Home has no messages yet (a waiting question or a running command counts as a chat). */
func homeChatEmpty(_ model: AppModel) -> Bool {
  return model.thread.isEmpty && model.confirms.isEmpty && !model.isWorking
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
  /// The expanded sidebar's content width, dragged on the divider (clamped by SidebarMetrics).
  @AppStorage("sidebarWidth") private var sidebarWidth = Double(SidebarMetrics.expanded)

  var body: some View {
    let width = SidebarMetrics.clamp(CGFloat(sidebarWidth))
    HStack(spacing: 0) {
      SidebarView(model: model, nav: nav, control: control, collapsed: $collapsed)
        .frame(width: SidebarMetrics.column(collapsed, width), alignment: .leading).clipped()
        .frame(maxHeight: .infinity, alignment: .top)
        .glassBackground(.sidebar)
        .environment(\.sidebarWidth, width)
      Rectangle().fill(t.line).frame(width: 1)
        // Drag the divider to resize the sidebar. The icon rail (collapsed) keeps its fixed width.
        .overlay { if !collapsed { SidebarResizeHandle(width: $sidebarWidth) } }
      VStack(spacing: 0) {
        WindowToolbar(model: model, nav: nav)
        if !model.confirms.isEmpty { questionBanner }
        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
          // Safety (plan 7.5.4): while the palette is open, the question card's buttons and its Esc are off.
          .environment(\.paletteOpen, nav.paletteOpen)
          // Over the page, under the banner: the palette never covers the waiting question's banner.
          .overlay(alignment: .top) {
            if nav.paletteOpen {
              CommandPalette(model: model, nav: nav, control: control, actions: actions, sidebarCollapsed: $collapsed)
            }
          }
      }
      .background(t.ground)
    }
    .stephenAnimation(Motion.bar, value: collapsed)
    // A wider sidebar needs a wider window, so the pages keep their measured room (#154). The icon rail needs none.
    .frame(minWidth: WindowMetrics.minContent.width + (collapsed ? 0 : max(0, width - SidebarMetrics.expanded)),
           minHeight: WindowMetrics.minContent.height)
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
        // No ScrollView around it: the pane is a Form, which scrolls itself.
        VStack(alignment: .leading, spacing: 0) {
          OfflineView(model: model, control: control).frame(maxWidth: .infinity).padding(Space.xl)
          AppearanceSettings().frame(maxWidth: 640, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      } else {
        OfflineView(model: model, control: control).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      switch nav.page {
      case .home: HomeView(model: model, nav: nav, actions: actions)
      case .conversations: ConversationsPage(model: model, nav: nav)
      case .jobs: JobsView(model: model)
      case .settings: SettingsView(model: model, nav: nav, control: control)
      case .memory: MemoryPage(model: model)
      }
    }
  }
}

/// The window header (plan 5.2): page title on the left, the page's own actions, then Search ⌘K on the right. Glass.
private struct WindowToolbar: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  @AppStorage("settingsPane") private var pane: SettingsItem = .voice

  var body: some View {
    let online = model.connection == .online
    HStack(spacing: Space.m) {
      // A chat title is the owner's own words or a model reply: verbatim, one line.
      Text(verbatim: title(online: online)).font(TypeScale.section).foregroundColor(t.ink).lineLimit(1)
        .truncationMode(.tail).accessibilityAddTraits(.isHeader)
        .accessibilityHidden(title(online: online).isEmpty)  // empty Home: no empty heading for VoiceOver
      if online { pageActions }
      Spacer(minLength: Space.m)
      searchButton
    }
    .padding(.horizontal, Space.l)
    .frame(height: 52)
    .glassBackground(.toolbar)
    .overlay(Rectangle().fill(t.line).frame(height: 1), alignment: .bottom)
  }

  private func title(online: Bool) -> String {
    switch nav.page {
    case .home: return online && !homeChatEmpty(model) ? model.threadTitle : ""  // empty Home: the greeting is the title
    case .settings: return online ? pane.title : "Appearance"
    default: return nav.page.title
    }
  }

  @ViewBuilder
  private var pageActions: some View {
    switch nav.page {
    case .home:
      if !homeChatEmpty(model) {
        // Back to the empty Home. The chat is not lost: it stays in Conversations.
        QuietButton("New chat", symbol: "plus") { nav.draft = ""; model.newChat() }
          .keyboardShortcut("n").help("New chat (⌘N)")
      }
    case .conversations:
      if !model.history.isEmpty {
        Menu {
          Button("Clear all…", role: .destructive) { nav.confirmClearAll = true }
        } label: {
          Image(systemName: "ellipsis.circle").font(.system(size: 16)).foregroundColor(t.ink2)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("More").accessibilityLabel("More")
      }
    default:
      EmptyView()
    }
  }

  /// Looks like a small field, acts as a button: it opens the palette, like ⌘K.
  private var searchButton: some View {
    Button { nav.paletteOpen = true } label: {
      HStack(spacing: Space.s) {
        Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundColor(t.ink2)
        Text(verbatim: "Search").font(TypeScale.secondary).foregroundColor(t.ink2)
        Spacer(minLength: Space.s)
        Text(verbatim: "⌘K").font(TypeScale.secondary).foregroundColor(t.ink2)
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .frame(width: 200)
      .background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface))
      .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.lineStrong, lineWidth: 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Search and actions (⌘K)")
    .accessibilityLabel("Search and actions")
    .accessibilityHint("Shortcut Command K.")
  }
}

/// A 9 pt wide grab area over the 1 pt divider: the resize cursor on hover, and a drag that sets the sidebar width.
private struct SidebarResizeHandle: View {
  @Binding var width: Double
  @State private var start: Double? = nil
  @State private var hovering = false

  var body: some View {
    Color.clear.frame(width: 9).contentShape(Rectangle())
      .onHover { inside in
        if inside && !hovering { NSCursor.resizeLeftRight.push() } else if !inside && hovering { NSCursor.pop() }
        hovering = inside
      }
      .onDisappear { if hovering { NSCursor.pop(); hovering = false } }  // ⌘\ while the pointer is on it
      .gesture(
        DragGesture(minimumDistance: 1, coordinateSpace: .global)
          .onChanged { v in
            let from = start ?? Double(SidebarMetrics.clamp(CGFloat(width)))
            start = from
            width = Double(SidebarMetrics.clamp(CGFloat(from) + v.translation.width))
          }
          .onEnded { _ in start = nil }
      )
      .help("Drag to resize the sidebar")
      .accessibilityHidden(true)  // ⌘\ (collapse) is the keyboard way
  }
}

private struct SidebarView: View {
  @Environment(\.stephenTheme) var t
  @Environment(\.sidebarWidth) var sidebarWidth
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  @Binding var collapsed: Bool

  var body: some View {
    // One layout for both states: only the width (animated by the window), the fades and the toggle's side change.
    VStack(alignment: .leading, spacing: Space.l) {
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
        .frame(width: SidebarMetrics.content(collapsed, sidebarWidth), alignment: collapsed ? .leading : .trailing)
      }
      .frame(width: SidebarMetrics.content(collapsed, sidebarWidth), alignment: .leading)
      VStack(alignment: .leading, spacing: Space.m) {
        SidebarSection("Talk", collapsed: collapsed) { rows(Page.talk) }
        SidebarSection("Control", collapsed: collapsed) { rows(Page.control) }
      }
      Spacer(minLength: 0)
      // At the bottom left, with the Recording on sign right next to it (owner, 2026-11-21).
      StatusRow(model: model, control: control, collapsed: collapsed)
    }
    .frame(width: SidebarMetrics.content(collapsed, sidebarWidth), alignment: .leading)
    .padding(.horizontal, SidebarMetrics.pad)
    .padding(.vertical, Space.l)
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
  @Environment(\.sidebarWidth) var sidebarWidth
  @ObservedObject var model: AppModel
  @ObservedObject var control: StephenControl
  let collapsed: Bool
  @State private var problem: String? = nil

  var body: some View {
    let s = listenerWord(connection: model.connection, listening: model.listening, listener: control.listener)
    VStack(alignment: .leading, spacing: Space.s) {
      // The replay recorder is on (issue #48): in words with a waveform, not a red dot that looks like the mic.
      // Solid, even in the glass sidebar (plan 8.1): surface fill and a strong outline. Always right above the state row.
      if model.recordingOn {
        HStack(spacing: Space.s) {
          Image(systemName: "waveform").foregroundColor(t.ink2).accessibilityHidden(true)
          if !collapsed { Text(verbatim: "Recording on").font(TypeScale.secondary).foregroundColor(t.ink2) }
        }
        .padding(.horizontal, Space.s).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.lineStrong, lineWidth: 1))
        .help("Your F5 commands are saved on this Mac for 30 days. Turn it off in Settings, Privacy and permissions.")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Recording on. F5 commands are saved on this Mac for 30 days.")
      }
      HStack(spacing: Space.s) {
        StatusPill(s.word, kind: s.kind, showWord: !collapsed).padding(.leading, Space.s + 6)  // the dot sits under the icons
        Spacer(minLength: 0)
        startStop.opacity(collapsed ? 0 : 1).allowsHitTesting(!collapsed)
      }
      .frame(width: SidebarMetrics.content(collapsed, sidebarWidth), alignment: .leading)
      .help(collapsed ? s.word : "")
      if let p = problem, !collapsed {
        Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
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
