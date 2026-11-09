// Stephen Helper: the Stephen window, SwiftUI hosted in one reused NSWindow. The frame (sidebar, page router) is in
// MainWindow.swift, Home in HomeView.swift, Personal in PersonalView.swift; this file has the older screens (Memory,
// History, Settings, Jobs, Audit) that later UI PRs restyle, and the window controller.
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

// ───────────────────────────── history ─────────────────────────────

struct HistoryView: View {
  @ObservedObject var model: AppModel
  @State private var confirmClear = false

  var body: some View {
    VStack(spacing: 0) {
      if let notice = model.historyNotice {
        NoticeView(text: notice)
        Divider()
      }
      if model.history.isEmpty {
        EmptyStateView(symbol: "clock", text: "No history yet. Commands you give Stephen show up here.")
      } else {
        List {
          ForEach(model.historyDays) { day in
            Section(header: Text(verbatim: day.title)) {
              ForEach(day.entries) { entry in
                HistoryRowView(entry: entry, time: model.timeText(entry.ts), source: model.sourceLabel(entry.source))
              }
            }
          }
          if model.historyMayHaveMore {
            Button("Load older") { model.loadOlderHistory() }
          }
        }
      }
      Divider()
      HStack(spacing: 8) {
        Spacer()
        Button("Refresh") { model.refreshHistory() }
        Button("Clear history…") { confirmClear = true }
          .disabled(model.history.isEmpty)
      }
      .padding(10)
    }
    .onAppear { model.refreshHistory() }
    .alert("Clear all history?", isPresented: $confirmClear) {
      Button("Clear", role: .destructive) { model.clearHistory() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(verbatim: "Every saved command and reply is deleted. Memory is not affected.")
    }
  }
}

struct HistoryRowView: View {
  let entry: HistoryEntry
  let time: String
  let source: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Text(verbatim: time).font(Font.caption.monospacedDigit()).foregroundColor(.secondary)
        Text(verbatim: source).font(.caption).foregroundColor(.secondary)
        if entry.outcome != "ok" && !entry.outcome.isEmpty {
          Text(verbatim: entry.outcome)
            .font(.caption)
            .foregroundColor(entry.outcome == "error" ? .red : .secondary)
        }
      }
      Text(verbatim: entry.said).bold().textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      if !entry.reply.isEmpty {
        Text(verbatim: entry.reply).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      }
      if !entry.tools.isEmpty {
        Text(verbatim: toolsText)
          .font(.caption2)
          .foregroundColor(.secondary)
      }
    }
    .padding(.vertical, 3)
  }

  private var toolsText: String {
    var names: [String] = []
    for t in entry.tools { names.append(t.isError ? t.tool + " (failed)" : t.tool) }
    return names.joined(separator: ", ")
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

// ───────────────────────────── jobs ─────────────────────────────

struct JobsView: View {
  @ObservedObject var model: AppModel
  @State private var selectedId: String? = nil
  private let ticker = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

  private var selected: JobRow? {
    guard let id = selectedId else { return nil }
    return model.jobs.first(where: { $0.id == id })
  }

  var body: some View {
    VStack(spacing: 0) {
      if let notice = model.jobsNotice {
        NoticeView(text: notice)
        Divider()
      }
      if model.jobs.isEmpty {
        EmptyStateView(symbol: "tray.full", text: "No jobs yet. Say 'while I'm cooking, …' or 'start a job to …'")
      } else {
        HStack(spacing: 0) {
          List {
            ForEach(model.jobs) { job in
              JobRowView(job: job, selected: job.id == selectedId)
                .contentShape(Rectangle())
                .onTapGesture { selectedId = job.id }
            }
          }
          .frame(minWidth: 260)
          Divider()
          if let job = selected {
            JobDetailView(job: job, onStop: { model.stopJob(job.id) })
          } else {
            EmptyStateView(symbol: "doc.text", text: "Select a job to see its summary.")
          }
        }
      }
      Divider()
      HStack(spacing: 8) {
        Text(verbatim: "The summary is written by the job itself, so check it before you rely on it.")
          .font(.caption)
          .foregroundColor(.secondary)
        Spacer()
        Button("Refresh") { model.refreshJobs() }
      }
      .padding(10)
    }
    .onAppear { model.refreshJobs() }
    .onReceive(ticker) { _ in model.refreshJobs() }
  }
}

/** "3 min", "1 h 05 min": whole minutes between two epoch-millisecond times. */
func jobDurationText(from: Double, to: Double) -> String {
  let minutes = max(0, Int((to - from) / 60000.0))
  if minutes < 60 { return "\(minutes) min" }
  let rest = minutes % 60
  return "\(minutes / 60) h \(rest < 10 ? "0" : "")\(rest) min"
}

struct JobRowView: View {
  let job: JobRow
  let selected: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol).foregroundColor(tint).frame(width: 20)
      VStack(alignment: .leading, spacing: 3) {
        Text(verbatim: job.task).bold().lineLimit(2)
        Text(verbatim: detail).font(.caption).foregroundColor(.secondary)
      }
    }
    .padding(.vertical, 3)
    .background(selected ? Color.accentColor.opacity(0.15) : Color.clear)
  }

  private var symbol: String {
    switch job.status {
    case "done": return "checkmark.circle.fill"
    case "running": return "arrow.triangle.2.circlepath"
    case "queued": return "clock"
    case "stopped": return "stop.circle"
    default: return "exclamationmark.triangle.fill"
    }
  }

  private var tint: Color {
    switch job.status {
    case "done": return Color.green
    case "running", "queued": return Color.blue
    case "stopped": return Color.secondary
    default: return Color.orange
    }
  }

  private var detail: String {
    var parts: [String] = [job.status.capitalized]
    if let started = job.startedAt {
      let end = job.endedAt ?? Date().timeIntervalSince1970 * 1000.0
      parts.append(jobDurationText(from: started, to: end))
    }
    if let cost = job.costUsd { parts.append(String(format: "$%.2f", cost)) }
    return parts.joined(separator: " · ")
  }
}

struct JobDetailView: View {
  let job: JobRow
  let onStop: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(verbatim: job.task).font(.headline).fixedSize(horizontal: false, vertical: true)
      Text(verbatim: "\(job.status.capitalized) · \(job.turns) turns").font(.caption).foregroundColor(.secondary)
      ScrollView {
        Text(verbatim: bodyText)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      Text(verbatim: job.folder).font(.caption).foregroundColor(.secondary).lineLimit(2)
      HStack(spacing: 8) {
        Button("Reveal in Finder") {
          NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: job.folder)])
        }
        .disabled(job.folder.isEmpty)
        if job.isRunning {
          Button("Stop") { onStop() }
        }
        Spacer()
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var bodyText: String {
    if !job.summary.isEmpty { return job.summary }
    if !job.error.isEmpty { return job.error }
    return job.isRunning ? "Still working. The summary appears here when it finishes." : "(no summary)"
  }
}

// ───────────────────────────── audit ─────────────────────────────

struct AuditView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      if let notice = model.auditNotice {
        NoticeView(text: notice)
        Divider()
      }
      if model.audit.isEmpty {
        EmptyStateView(symbol: "list.bullet", text: "No browser actions logged yet.")
      } else {
        List {
          ForEach(model.audit.indices, id: \.self) { i in
            AuditRowView(entry: model.audit[i], when: model.dateText(model.audit[i].ts))
          }
        }
      }
      Divider()
      HStack(spacing: 8) {
        Text(verbatim: "Latest \(AppModel.auditLimit) browser actions, newest first.")
          .font(.caption)
          .foregroundColor(.secondary)
        Spacer()
        Button("Refresh") { model.refreshAudit() }
      }
      .padding(10)
    }
    .onAppear { model.refreshAudit() }
  }
}

struct AuditRowView: View {
  let entry: AuditEntry
  let when: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Text(verbatim: when).font(Font.caption.monospacedDigit()).foregroundColor(.secondary)
        Text(verbatim: entry.tool).font(.caption).bold()
        Text(verbatim: entry.outcome)
          .font(.caption)
          .foregroundColor(entry.outcome == "ok" ? .secondary : .red)
      }
      if !summary.isEmpty {
        Text(verbatim: summary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      }
      if !entry.urlBefore.isEmpty {
        Text(verbatim: entry.urlBefore).font(.caption2).foregroundColor(.secondary).lineLimit(1).truncationMode(.middle)
      }
      if !entry.error.isEmpty {
        Text(verbatim: entry.error).font(.caption).foregroundColor(.red)
      }
    }
    .padding(.vertical, 3)
  }

  private var summary: String {
    var parts: [String] = []
    if !entry.kind.isEmpty { parts.append(entry.kind) }
    if !entry.element.isEmpty { parts.append(entry.element) }
    if !entry.intent.isEmpty { parts.append("\"" + entry.intent + "\"") }
    if !entry.verdict.isEmpty { parts.append(entry.verdict) }
    return parts.joined(separator: " · ")
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

  @objc func askClicked(_ sender: Any?) { actions.ask() }

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
