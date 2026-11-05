// Stephen Helper: the Stephen window (Chat / Memory / History / Settings / Audit), SwiftUI hosted in one reused
// NSWindow. Data comes from AppModel (AppClient.swift), which talks to `stephen listen` over <home>/run/app.sock.
//
// Untrusted text (replies, memory, history, audit, settings) is always shown with Text(verbatim:), never as a
// LocalizedStringKey, so nothing is interpreted as Markdown.
//
// Threading: AppWindowController is @MainActor (it owns AppKit objects); main.swift reaches it the same way as
// StatusMenu. The SwiftUI views run on the main thread and call AppModel directly.

import AppKit
import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
  case chat, memory, history, settings, accounts, jobs, audit

  var id: String { return rawValue }

  var title: String {
    switch self {
    case .chat: return "Chat"
    case .memory: return "Memory"
    case .history: return "History"
    case .settings: return "Settings"
    case .accounts: return "Accounts"
    case .jobs: return "Jobs"
    case .audit: return "Audit"
    }
  }

  var symbol: String {
    switch self {
    case .chat: return "bubble.left.and.bubble.right"
    case .memory: return "lightbulb"
    case .history: return "clock"
    case .settings: return "gearshape"
    case .accounts: return "key"
    case .jobs: return "tray.full"
    case .audit: return "list.bullet"
    }
  }
}

// ───────────────────────────── root ─────────────────────────────

struct AppRootView: View {
  @ObservedObject var model: AppModel
  @State private var selection: AppTab? = .chat

  var body: some View {
    HStack(spacing: 0) {
      List(selection: $selection) {
        ForEach(AppTab.allCases) { tab in
          Label(tab.title, systemImage: tab.symbol).tag(tab)
        }
      }
      .listStyle(SidebarListStyle())
      .frame(width: 170)
      Divider()
      VStack(spacing: 0) {
        AppHeaderView(model: model)
        Divider()
        detail
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(minWidth: 640, minHeight: 420)
  }

  @ViewBuilder
  private var detail: some View {
    if model.connection != .online {
      OfflineView(model: model)
    } else {
      switch selection ?? .chat {
      case .chat: ChatView(model: model)
      case .memory: MemoryView(model: model)
      case .history: HistoryView(model: model)
      case .settings: SettingsView(model: model)
      case .accounts: AccountsView(model: model)
      case .jobs: JobsView(model: model)
      case .audit: AuditView(model: model)
      }
    }
  }
}

struct AppHeaderView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(dotColor).frame(width: 10, height: 10)
      Text(verbatim: model.headerText).font(.headline)
      Spacer()
      if model.connection == .online && !model.modelName.isEmpty {
        Text(verbatim: model.modelName).font(.caption).foregroundColor(.secondary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
  }

  private var dotColor: Color {
    if model.connection != .online { return Color.gray.opacity(0.5) }
    switch model.state {
    case "listening": return Color.green
    case "recording": return Color.red
    case "working": return Color.orange
    case "speaking": return Color.blue
    default: return Color.gray
    }
  }
}

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
        Text(verbatim: "Can't reach Stephen. Run `stephen listen`.").font(.title3)
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

// ───────────────────────────── chat ─────────────────────────────

struct ChatView: View {
  @ObservedObject var model: AppModel
  @State private var draft = ""

  var body: some View {
    VStack(spacing: 0) {
      TodayCardView(model: model)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            if model.chat.isEmpty {
              Text(verbatim: "Type a command below, or hold Fn+Option and talk. Voice commands show up here too.")
                .foregroundColor(.secondary)
                .padding(.vertical, 20)
            }
            ForEach(model.chat) { bubble in
              ChatBubbleView(bubble: bubble).id(bubble.id)
            }
          }
          .padding(12)
        }
        .onAppear { scrollToEnd(proxy) }
        .onChange(of: model.chat.count) { _ in scrollToEnd(proxy) }
      }
      Divider()
      HStack(spacing: 8) {
        TextField("Type a command for Stephen", text: $draft)
          .textFieldStyle(RoundedBorderTextFieldStyle())
          .onSubmit { send() }
        if model.isWorking {
          Button("Stop") { model.stopChat() }
        }
        Button("Send") { send() }
          .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .padding(10)
      if draft.count > APP_CHAT_MAX_CHARS - 200 {
        NoticeView(text: "\(draft.count) / \(APP_CHAT_MAX_CHARS) characters (longer text is cut).")
      }
    }
  }

  private func send() {
    if model.sendChat(draft) { draft = "" }
  }

  private func scrollToEnd(_ proxy: ScrollViewProxy) {
    guard let last = model.chat.last else { return }
    proxy.scrollTo(last.id, anchor: .bottom)
  }
}

/** Header card on the Chat tab: one button that sends APP_TODAY_PROMPT through the normal chat request. */
struct TodayCardView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "sun.max").font(.title2).foregroundColor(.accentColor)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: "Today").font(.headline)
        Text(verbatim: "Ask: what's my day?").font(.caption).foregroundColor(.secondary)
      }
      Spacer()
      Button("What's my day?") { model.sendChat(APP_TODAY_PROMPT) }
        .disabled(model.isWorking || model.connection != .online)
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
    .padding(.horizontal, 12)
    .padding(.top, 10)
  }
}

struct ChatBubbleView: View {
  let bubble: ChatBubble

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if bubble.kind == .said { Spacer(minLength: 60) }
      VStack(alignment: bubble.kind == .said ? .trailing : .leading, spacing: 3) {
        Text(verbatim: bubble.text)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
          .foregroundColor(bubble.kind == .info ? .secondary : .primary)
        if !bubble.detail.isEmpty {
          Text(verbatim: bubble.detail).font(.caption2).foregroundColor(.secondary)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(fill))
      if bubble.kind != .said { Spacer(minLength: 60) }
    }
  }

  private var fill: Color {
    switch bubble.kind {
    case .said: return Color.accentColor.opacity(0.18)
    case .reply: return Color(nsColor: .controlBackgroundColor)
    case .problem: return Color.red.opacity(0.15)
    case .info: return Color.clear
    }
  }
}

// ───────────────────────────── memory ─────────────────────────────

struct MemoryView: View {
  @ObservedObject var model: AppModel
  @State private var newText = ""
  @State private var editingId: String? = nil
  @State private var editText = ""
  @State private var confirmClear = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        TextField("Something Stephen should remember", text: $newText)
          .textFieldStyle(RoundedBorderTextFieldStyle())
          .onSubmit { add() }
        Button("Add") { add() }
          .disabled(newText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .padding(10)
      if let notice = model.memoryNotice {
        NoticeView(text: notice)
      }
      Divider()
      if model.memory.isEmpty {
        EmptyStateView(symbol: "lightbulb", text: "No memories yet. Say \"remember …\" or add one above.")
      } else {
        List {
          ForEach(model.memory) { item in
            row(item)
          }
        }
      }
      Divider()
      HStack(spacing: 8) {
        Text(verbatim: "\(model.memory.count) of \(APP_MEMORY_MAX_ITEMS)").font(.caption).foregroundColor(.secondary)
        Spacer()
        Button("Refresh") { model.refreshMemory() }
        Button("Forget all…") { confirmClear = true }
          .disabled(model.memory.isEmpty)
      }
      .padding(10)
    }
    .onAppear { model.refreshMemory() }
    .alert("Forget everything?", isPresented: $confirmClear) {
      Button("Forget all", role: .destructive) { model.clearMemory() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(verbatim: "Stephen will forget all \(model.memory.count) saved items. This can't be undone.")
    }
  }

  @ViewBuilder
  private func row(_ item: MemoryItem) -> some View {
    if editingId == item.id {
      HStack(spacing: 8) {
        TextField("Memory text", text: $editText)
          .textFieldStyle(RoundedBorderTextFieldStyle())
          .onSubmit { saveEdit(item) }
        Button("Save") { saveEdit(item) }
        Button("Cancel") { editingId = nil }
      }
      .padding(.vertical, 2)
    } else {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: item.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          Text(verbatim: model.memoryCaption(item)).font(.caption).foregroundColor(.secondary)
        }
        Spacer()
        Button("Edit") {
          editText = item.text
          editingId = item.id
        }
        Button("Forget") { model.forgetMemory(item.id) }
      }
      .padding(.vertical, 2)
    }
  }

  private func add() {
    let text = newText.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return }
    model.addMemory(text)
    newText = ""
  }

  private func saveEdit(_ item: MemoryItem) {
    let text = editText.trimmingCharacters(in: .whitespacesAndNewlines)
    editingId = nil
    if text.isEmpty || text == item.text { return }
    model.updateMemory(item.id, text: text)
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

// ───────────────────────────── settings ─────────────────────────────

struct SettingsView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(verbatim: "Read-only. To change a setting, edit the config file and restart stephen listen.")
        .foregroundColor(.secondary)
      if let notice = model.settingsNotice {
        NoticeView(text: notice)
      }
      ScrollView {
        Text(verbatim: model.settingsText)
          .font(.system(.body, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
      }
      .background(Color(nsColor: .textBackgroundColor))
      HStack(spacing: 8) {
        if let path = model.configPath {
          Text(verbatim: path)
            .font(.caption)
            .foregroundColor(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer()
        Button("Refresh") { model.refreshSettings() }
        Button("Open config file") { openConfig() }
          .disabled(model.configPath == nil)
      }
    }
    .padding(14)
    .onAppear { model.refreshSettings() }
  }

  /** Opens the config file in its default app. Only a .json path is opened; if it doesn't exist yet, its folder. */
  private func openConfig() {
    guard let path = model.configPath, path.hasPrefix("/") else { return }
    let url = URL(fileURLWithPath: path)
    guard url.pathExtension.lowercased() == "json" else { return }
    var isDir: ObjCBool = false
    if FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue {
      _ = NSWorkspace.shared.open(url)
    } else {
      _ = NSWorkspace.shared.open(url.deletingLastPathComponent())
    }
  }
}

// ───────────────────────────── accounts ─────────────────────────────

struct AccountsView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      if let notice = model.accountsNotice {
        NoticeView(text: notice)
        Divider()
      }
      if model.accounts.isEmpty {
        EmptyStateView(symbol: "key", text: "No account information yet. Press Refresh.")
      } else {
        List {
          ForEach(model.accounts) { account in
            AccountRowView(account: account)
          }
        }
      }
      Divider()
      HStack(spacing: 8) {
        Text(verbatim: "Secrets stay in the Keychain or .env. Only where they were found is shown.")
          .font(.caption)
          .foregroundColor(.secondary)
        Spacer()
        Button("Refresh") { model.refreshAccounts() }
      }
      .padding(10)
    }
    .onAppear { model.refreshAccounts() }
  }
}

struct AccountRowView: View {
  let account: AccountRow

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol).foregroundColor(tint).frame(width: 20)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(verbatim: account.name).bold()
          Text(verbatim: status).font(.caption).foregroundColor(.secondary)
        }
        Text(verbatim: account.hint).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 3)
  }

  private var symbol: String {
    switch account.state {
    case "connected": return "checkmark.circle.fill"
    case "off": return "minus.circle"
    default: return "exclamationmark.circle"
    }
  }

  private var tint: Color {
    switch account.state {
    case "connected": return Color.green
    case "off": return Color.secondary
    default: return Color.orange
    }
  }

  private var status: String {
    var parts: [String] = []
    switch account.state {
    case "connected": parts.append("Connected")
    case "off": parts.append("Turned off")
    default: parts.append("Not set")
    }
    if let source = account.source { parts.append(source == "keychain" ? "Keychain" : source) }
    if let detail = account.detail, !detail.isEmpty { parts.append(detail) }
    return parts.joined(separator: " · ")
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
  private var window: NSWindow? = nil

  init(socketPath: String, log: @escaping (String) -> Void) {
    model = AppModel(socketPath: socketPath, log: log)
    super.init()
  }

  func show() {
    let w: NSWindow
    if let existing = window {
      w = existing
    } else {
      w = makeWindow()
      window = w
    }
    installEditMenuIfNeeded()
    model.windowOpened()
    // LSUIElement app: it is never frontmost by itself, so bring it forward with its window.
    NSApp.activate(ignoringOtherApps: true)
    w.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    model.windowClosed()
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
    w.contentView = NSHostingView(rootView: AppRootView(model: model))
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
