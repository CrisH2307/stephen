// Stephen Helper: client for `stephen listen`'s app socket (<home>/run/app.sock), used by the Stephen window.
//
// Wire contract: docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13 "app.sock protocol v1", with example lines in
// test/fixtures/app-protocol-v1.jsonl. Newline-delimited JSON, UTF-8, one object per line, at most 256 KiB per line;
// unknown types are ignored; every request carries a client `id` that the response echoes.
//
// Threading: AppConnection does its socket work on background queues and delivers everything on the main queue.
// AppModel is a plain (non-isolated) ObservableObject that is only ever touched on the main thread: by SwiftUI views
// and by the main-queue callbacks below. Nothing here is @MainActor, so no isolation hops are needed.
//
// macOS only (Foundation + Darwin). It reuses LineFramer and Locked from Core.swift.

import Combine
import CryptoKit
import Darwin
import Foundation

// ───────────────────────────── window model ─────────────────────────────

enum AppConnectionState: Equatable {
  case connecting
  case online
  case offline
}

struct ChatBubble: Identifiable, Equatable {
  enum Kind: Equatable {
    /** What the user typed (empty detail) or said (detail names where it came from, see heardLabel). Right side. */
    case said
    /** Stephen's reply (left side). */
    case reply
    /** A failed command or a refused request. */
    case problem
    /** Small grey status line (busy, stopped). */
    case info
  }
  let id: Int
  let kind: Kind
  let text: String
  /** Small line: time and (older listener) tool names, or where a command came from. */
  let detail: String
  /** What Stephen did for this reply, oldest first. */
  var steps: [ChatStep] = []
}

/// Where a spoken (not typed) command came from, shown under its bubble in #142's words ("From: F5"). Never empty,
/// even for an unknown or missing source: an empty label would make the bubble look typed, and Try again re-sends only
/// typed bubbles (R10a-2).
func heardLabel(_ source: String?) -> String {
  switch source {
  case "voice-ptt": return "From: F5"
  case "voice-wake": return "From: Hey Stephen"
  case "phone": return "From: Phone"
  case "cli": return "From: Command line"
  default: return "Not typed here"
  }
}

/** One line of the action chain. `text` can hold page text (a button label): shown with Text(verbatim:). */
struct ChatStep: Decodable, Equatable {
  let text: String
  /** ok, refused or failed. */
  let status: String
}

/// T6: the line after Stop. A tool that already ran (a click, typed text) can't be taken back, so say so.
func stoppedLine(tools: [String], steps: [ChatStep]) -> String {
  return tools.isEmpty && steps.isEmpty ? "Stopped." : "Stopped. The last browser step may already have happened."
}

/// T6 step 2: Stop leaves jobs alone. Under the stopped line, say how many still run.
func jobsStillRunning(_ n: Int) -> String {
  return n == 1 ? "1 job is still running." : "\(n) jobs are still running."
}

struct HistoryDay: Identifiable {
  /** Day key, e.g. "2026-11-01" (local time). */
  let id: String
  let title: String
  let entries: [HistoryEntry]
}

/**
 * Everything the Stephen window shows. Main thread only. Talks to `stephen listen` through one AppConnection while
 * the window is open; retries every few seconds while it can't reach it.
 */
final class AppModel: ObservableObject {
  @Published private(set) var connection: AppConnectionState = .offline
  @Published private(set) var offlineReason: String? = nil
  /** From hello: is the listener's microphone on, and which Claude model it uses. */
  @Published private(set) var listening = false
  @Published private(set) var modelName = ""
  /** Last `state` push: idle / listening / recording / working / speaking. */
  @Published private(set) var state = "idle"

  @Published private(set) var chat: [ChatBubble] = []
  /** Bubbles with an id at or below this belong to an earlier chat (⌘N). The Ask box and Home both show `thread`. */
  @Published private(set) var chatSince = 0
  @Published private(set) var awaitingReplies: Set<String> = []

  @Published private(set) var memory: [MemoryItem] = []
  @Published private(set) var memoryNotice: String? = nil

  @Published private(set) var history: [HistoryEntry] = []
  /** ADR-010: history.versions answers by the entry id a row asked for (versions oldest first, and the expired flag). */
  @Published private(set) var versions: [String: HistoryVersions] = [:]
  /** The entry ids of edits this window sent: their chat.done refreshes Conversations. */
  private var editsInFlight: Set<String> = []
  @Published private(set) var historyMayHaveMore = false
  @Published private(set) var historyNotice: String? = nil

  @Published private(set) var settingsText = ""
  @Published private(set) var configPath: String? = nil
  @Published private(set) var settingsNotice: String? = nil
  /** voice.aboutMe.name from settings.get, for Home's greeting; empty when not set. */
  @Published private(set) var ownerName = ""
  /** settings.get config.talk; nil until an answer arrives (or the listener is older). */
  @Published private(set) var talk: TalkSettings? = nil
  /** The raw config (voice.wakeWord and so on) for the read-only Settings rows. */
  @Published private(set) var configJSON: AppJSON? = nil
  /** The listener's `replay` push (issue #208): the switch as the recorder reads it, re-read every 2 s and on change. */
  @Published private(set) var replayOn = false
  /**
   * The replay recorder is saving F5 commands: the listener is connected and pushed replay on (issue #48, #208).
   * Drives the "Recording on" sign in the sidebar and the menu bar menu.
   */
  var recordingOn: Bool { connection == .online && replayOn }
  /**
   * ADR-007 v2: the listener's `resume` push. True while an "Open in chat" click is armed: the next message sent from
   * Home or the Ask box continues that earlier chat. Home shows it with Cancel.
   */
  @Published private(set) var resumeArmed = false

  @Published private(set) var audit: [AuditEntry] = []
  @Published private(set) var auditNotice: String? = nil

  @Published private(set) var accounts: [AccountRow] = []
  @Published private(set) var accountsNotice: String? = nil

  @Published private(set) var jobs: [JobRow] = []
  @Published private(set) var jobsNotice: String? = nil
  /// T6 step 2: the id of the last "Stopped." line. Under it the thread offers "Stop them too" while jobs run.
  @Published private(set) var stoppedBubble: Int? = nil
  /** ADR-010: "Job started: <id>" after an Edit request starts; the dialog never named the id (it is fixed at the start). */
  @Published private(set) var jobStarted: String? = nil

  /** Last `usage` answer; nil until one arrives (and again when the listener doesn't know the request). */
  @Published private(set) var usage: AppUsage? = nil
  /** personal.summary for the Personal page; personalNotice says why it is missing. */
  @Published private(set) var personal: PersonalSummary? = nil
  @Published private(set) var personalNotice: String? = nil
  /** Memory page (section 7a): the graph, proposals waiting for Keep/Skip, the memory bar, and why one is missing. */
  @Published private(set) var graphNodes: [GraphNode] = []
  @Published private(set) var graphLinks: [GraphLink] = []
  @Published private(set) var suggestions: [MemoryProposal] = []
  @Published private(set) var memoryUsage: UsageBar? = nil
  @Published private(set) var memoryPageNotice: String? = nil

  /** The gate's questions waiting for a click, oldest first. Cleared when the connection drops (the gate falls back). */
  /// Set only here and in AppConfirm.swift (the Allow / Deny code); a test checks no other file changes it. Not
  /// private(set) since the split: AppConfirm.swift's extension removes the answered question.
  @Published var confirms: [PendingConfirm] = []

  let socketPath: String
  let log: (String) -> Void  // internal for AppConfirm.swift
  private let link: AppConnection
  private var pending: [String: (AppMessage) -> Void] = [:]
  private var nextRequest = 1
  private var nextBubble = 1
  /** Who wants the connection ("window", "askbox"); it closes when nobody does. */
  private var users: Set<String> = []
  private var retryItem: DispatchWorkItem? = nil
  /** Wait before the next connect: 3 s, then 6 s, then 10 s while Stephen stays unreachable (#202 C1). */
  private var retryDelay = APP_RETRY_SECONDS
  /** The current wait: how long it is, and how much of it has passed (checked in steps of at most 3 s). */
  private var retryTarget = APP_RETRY_SECONDS
  private var retryWaited = 0.0
  private var socketSeen = false
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let isoFractional = ISO8601DateFormatter()
  private let isoPlain = ISO8601DateFormatter()
  private let dayKeyFormatter = DateFormatter()
  private let dayTitleFormatter = DateFormatter()
  private let timeFormatter = DateFormatter()

  static let historyPageSize = 50
  /// APP_AUDIT_LIMIT_MAX in src/app/protocol.ts: Activity shows the last 24 h, and says so when this many came back.
  static let auditLimit = 200

  init(socketPath: String, log: @escaping (String) -> Void) {
    self.socketPath = socketPath
    self.log = log
    link = AppConnection(path: socketPath)
    isoFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    isoPlain.formatOptions = [.withInternetDateTime]
    dayKeyFormatter.locale = Locale(identifier: "en_US_POSIX")
    dayKeyFormatter.dateFormat = "yyyy-MM-dd"
    dayTitleFormatter.dateStyle = .full
    dayTitleFormatter.timeStyle = .none
    timeFormatter.dateStyle = .none
    timeFormatter.timeStyle = .short
    link.onLine = { [weak self] line in self?.receive(line) }
    link.onClosed = { [weak self] in self?.connectionLost() }
  }

  // MARK: window lifecycle

  func opened(_ who: String) {
    users.insert(who)
    retryDelay = APP_RETRY_SECONDS
    if connection != .online { connect() }
  }

  func closed(_ who: String) {
    users.remove(who)
    if users.isEmpty { link.close() }
  }

  func retry() {
    retryDelay = APP_RETRY_SECONDS
    connect()
  }

  /** Start was clicked: back to the short delay; a waiting retry moves up. */
  func resetRetry() {
    retryDelay = APP_RETRY_SECONDS
    if let item = retryItem {
      item.cancel()
      retryItem = nil
      startWait()
      scheduleRetry()
    }
  }

  var isWorking: Bool { return state == "working" || !awaitingReplies.isEmpty }
  /// T6: Stop is offered while Stephen works or speaks (chat.stop also cuts a spoken reply short).
  var canStop: Bool { return isWorking || state == "speaking" }

  private func connect() {
    if connection == .connecting { return }
    retryItem?.cancel()
    retryItem = nil
    connection = .connecting
    link.open { [weak self] reason in
      guard let self = self else { return }
      if let reason = reason {
        self.goOffline(reason)
        return
      }
      self.request(AppRequest.hello(self.newId())) { [weak self] msg in
        guard let self = self else { return }
        if msg.type == "hello" {
          if let v = msg.version, v != APP_PROTOCOL_VERSION {
            self.log("app.sock: listener speaks protocol \(v), this helper \(APP_PROTOCOL_VERSION)")
          }
          self.listening = msg.listening ?? false
          self.modelName = msg.model ?? ""
          self.offlineReason = nil
          self.connection = .online
          self.retryDelay = APP_RETRY_SECONDS
          self.log("app.sock: connected")
        } else {
          self.link.close()
          self.goOffline(msg.message ?? "unexpected answer to hello")
        }
      }
    }
  }

  private func goOffline(_ reason: String) {
    connection = .offline
    resumeArmed = false
    offlineReason = reason
    startWait()
    scheduleRetry()
  }

  private func startWait() {
    retryWaited = 0
    retryTarget = retryDelay
    retryDelay = nextRetryDelay(retryDelay)
  }

  private func connectionLost() {
    let waiting = pending
    pending = [:]
    awaitingReplies = []
    confirms = []
    for (id, handler) in waiting { handler(AppMessage(localError: "not connected", id: id)) }
    if connection == .online { log("app.sock: disconnected") }
    goOffline(users.isEmpty ? "window closed" : "the connection to stephen listen closed")
  }

  private func scheduleRetry() {
    guard !users.isEmpty, retryItem == nil else { return }
    let step = min(APP_RETRY_SECONDS, retryTarget - retryWaited)
    let item = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.retryItem = nil
      guard !self.users.isEmpty, self.connection == .offline else { return }
      self.retryWaited += step
      // Every 3 s while offline: a file check only, no connect. app.sock newly there: connect now, short delay again.
      let seen = FileManager.default.fileExists(atPath: self.socketPath)
      let appeared = seen && !self.socketSeen
      self.socketSeen = seen
      if appeared { self.retryDelay = APP_RETRY_SECONDS }
      if appeared || self.retryWaited >= self.retryTarget { self.connect() } else { self.scheduleRetry() }
    }
    retryItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + step, execute: item)
  }

  // MARK: requests

  func newId() -> String {  // internal for AppConfirm.swift
    let id = "a\(nextRequest)"
    nextRequest += 1
    return id
  }

  /** Send a request; `handler` gets the response, or a local error ("not connected", "timed out"). */
  func request(_ req: AppRequest, timeout: Double = APP_REQUEST_TIMEOUT_SECONDS, then handler: @escaping (AppMessage) -> Void) {  // internal for AppConfirm.swift
    guard let data = try? encoder.encode(req) else {
      handler(AppMessage(localError: "could not encode the request", id: req.id))
      return
    }
    let line = String(decoding: data, as: UTF8.self)
    pending[req.id] = handler
    if !link.send(line) {
      pending[req.id] = nil
      handler(AppMessage(localError: link.isOpen ? "request too large" : "not connected", id: req.id))
      return
    }
    let id = req.id
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
      guard let self = self, let h = self.pending.removeValue(forKey: id) else { return }
      h(AppMessage(localError: "timed out", id: id))
    }
  }

  private func receive(_ line: String) {
    guard let msg = try? decoder.decode(AppMessage.self, from: Data(line.utf8)) else {
      log("app.sock: ignored a malformed line")
      return
    }
    if let id = msg.id, let handler = pending.removeValue(forKey: id) {
      handler(msg)
      return
    }
    switch msg.type {
    case "replay":
      replayOn = msg.on ?? false
    case "state":
      if let s = msg.state { assign(\.state, s) }
      if state == "idle" { assign(\.awaitingReplies, []) }
    case "resume":
      resumeArmed = msg.armed ?? false
    case "heard":
      // Typed commands are already in the chat; only voice commands are added here. The label is never empty: an
      // empty detail marks a typed bubble, the only kind Try again may re-send (R10a-2).
      if let text = msg.text, msg.source != "app" {
        addBubble(.said, text, detail: heardLabel(msg.source))
      }
    case "chat.done":
      chatDone(msg)
    case "confirm":
      if let id = msg.confirmId, !confirms.contains(where: { $0.id == id }) {
        confirms.append(PendingConfirm(id: id, title: msg.title ?? "", body: msg.body ?? ""))
      }
    case "confirm.end":
      confirms.removeAll { $0.id == msg.confirmId }
    default:
      break  // unknown types are ignored (protocol v1)
    }
  }

  // MARK: chat

  /** Send typed text. false (and nothing sent) when empty or not connected. */
  @discardableResult
  func sendChat(_ raw: String) -> Bool {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, connection == .online else { return false }
    let text = trimmed.count > APP_CHAT_MAX_CHARS ? String(trimmed.prefix(APP_CHAT_MAX_CHARS)) : trimmed
    addBubble(.said, text, detail: "")
    request(AppRequest.chatSend(newId(), text: text)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "chat.accepted", let entryId = msg.entryId {
        self.awaitingReplies.insert(entryId)
      } else if msg.type == "error" {
        let m = msg.message ?? "error"
        if m == "busy" {
          self.addBubble(.info, "Stephen is busy with another command. Try again when it's done.", detail: "")
        } else {
          self.addBubble(.problem, m, detail: "")
        }
      }
    }
    return true
  }

  /** The current chat. ponytail: held in memory for as long as the helper runs; older chats are in Conversations (history.list). */
  var thread: [ChatBubble] { return chat.filter { $0.id > chatSince } }

  /** What the chat is called, from your first message (one line, 40 characters), like other chat apps; "New chat" when empty. */
  var threadTitle: String {
    guard let first = thread.first(where: { $0.kind == .said })?.text else { return "New chat" }
    let line = first.split(whereSeparator: { $0.isNewline }).first.map(String.init) ?? first
    return line.count > 40 ? String(line.prefix(40)).trimmingCharacters(in: .whitespaces) + "…" : line
  }

  /** ⌘N: start a new chat. Nothing is deleted; the old messages stay in Conversations. An armed resume is dropped. */
  func newChat() {
    chatSince = chat.last?.id ?? 0
    if resumeArmed { cancelResume() }
  }

  /**
   * ADR-007 v2, [DEV REVIEW]: the Open in chat button on a Conversations row, and nothing else, calls this. It only
   * arms the resume in the listener: nothing goes to the model until the owner sends the next message from the window.
   */
  func resumeConversation(_ conv: String) {
    newChat()
    request(AppRequest.chatResume(newId(), conv: conv)) { [weak self] msg in
      if msg.type == "error" { self?.addBubble(.problem, msg.message ?? "could not continue that chat", detail: "") }
    }
  }

  /**
   * ADR-010, [DEV REVIEW]: Send (or Return) in a Conversations row's inline editor, and nothing else, calls this. It
   * sends the owner's text with the old message's id, the hash of its stored text and the conversation of the version
   * on screen; the listener builds the earlier
   * turns from its own store and runs it through the normal send path (every Allow asked again). false (nothing sent)
   * when the text is empty, the listener is offline or a command runs.
   */
  @discardableResult
  func editMessage(_ old: HistoryEntry, viewing conv: String, text raw: String) -> Bool {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, connection == .online, !isWorking, !conv.isEmpty else { return false }
    let text = trimmed.count > APP_CHAT_MAX_CHARS ? String(trimmed.prefix(APP_CHAT_MAX_CHARS)) : trimmed
    addBubble(.said, text, detail: "")
    request(AppRequest.chatEdit(newId(), oldId: old.id, oldHash: textHash(old.said), conv: conv, text: text)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "chat.accepted", let entryId = msg.entryId {
        self.awaitingReplies.insert(entryId)
        self.editsInFlight.insert(entryId)
      } else if msg.type == "error" {
        let m = msg.message ?? "error"
        if m == "busy" {
          self.addBubble(.info, "Stephen is busy with another command. Try again when it's done.", detail: "")
        } else {
          self.addBubble(.problem, m, detail: "")
          self.historyNotice = m
        }
      }
    }
    return true
  }

  /** ADR-010: the versions of one message (read only), for the row's "Version N of M" switch. */
  func loadVersions(_ entryId: String) {
    request(AppRequest.historyVersions(newId(), entryId: entryId)) { [weak self] msg in
      guard let self = self, msg.type == "versions" else { return }
      self.versions[entryId] = HistoryVersions(entries: msg.historyEntries ?? [], expired: msg.expired ?? false)
    }
  }

  /** ADR-010: "Delete this version", after its confirm alert. Deletes that version's own lines in the listener. */
  func deleteVersion(_ entryId: String) {
    request(AppRequest.historyDeleteVersion(newId(), entryId: entryId)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "ok" {
        self.versions = [:]
        self.refreshHistory()
      } else {
        self.historyNotice = msg.message ?? "error"
      }
    }
  }

  /** Cancel on Home (and New chat): the next message starts an ordinary chat. */
  func cancelResume() {
    resumeArmed = false
    request(AppRequest.chatResumeCancel(newId())) { _ in }
  }

  func stopChat() {
    request(AppRequest.chatStop(newId())) { [weak self] msg in
      if msg.type == "error" { self?.addBubble(.problem, msg.message ?? "could not stop", detail: "") }
    }
  }

  private func chatDone(_ msg: AppMessage) {
    if let entryId = msg.entryId { awaitingReplies.remove(entryId) }
    if let entryId = msg.entryId, editsInFlight.remove(entryId) != nil {
      versions = [:]
      refreshHistory()
    }
    let outcome = msg.outcome ?? "ok"
    var reply = msg.reply ?? ""
    // T6: a stopped command is one grey line, in words. A step that already ran can't be taken back.
    if reply.isEmpty && outcome == "cancelled" {
      addBubble(.info, stoppedLine(tools: msg.tools ?? [], steps: msg.steps ?? []), detail: "", steps: msg.steps ?? [])
      stoppedBubble = chat.last?.id
      refreshJobs()
      return
    }
    if reply.isEmpty { reply = "(no reply)" }
    let steps = msg.steps ?? []
    var detailParts: [String] = []
    let tools = msg.tools ?? []
    // The chain names the steps; an older listener without steps still gets the tool names.
    if steps.isEmpty && !tools.isEmpty { detailParts.append(tools.joined(separator: ", ")) }
    if let ms = msg.ms, ms > 0 { detailParts.append(String(format: "%.1f s", ms / 1000)) }
    addBubble(outcome == "error" ? .problem : .reply, reply, detail: detailParts.joined(separator: " · "), steps: steps)
  }

  private func addBubble(_ kind: ChatBubble.Kind, _ text: String, detail: String, steps: [ChatStep] = []) {
    chat.append(ChatBubble(id: nextBubble, kind: kind, text: text, detail: detail, steps: steps))
    nextBubble += 1
    if chat.count > APP_MAX_BUBBLES { chat.removeFirst(chat.count - APP_MAX_BUBBLES) }
  }

  // MARK: memory

  func refreshMemory() { memoryRequest(AppRequest.memoryList(newId())) }
  func updateMemory(_ memId: String, text: String) {
    memoryRequest(AppRequest.memoryUpdate(newId(), memId: memId, text: text))
  }
  func forgetMemory(_ memId: String) { memoryRequest(AppRequest.memoryForget(newId(), memId: memId)) }
  func clearMemory() { memoryRequest(AppRequest.memoryClear(newId())) }

  private func memoryRequest(_ req: AppRequest) {
    let isChange = req.type != "memory.list"
    request(req) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "memory" {
        self.assign(\.memory, msg.items ?? [])
        self.assign(\.memoryNotice, isChange ? "Saved. Stephen starts a fresh conversation with the next command." : nil)
      } else {
        self.assign(\.memoryNotice, msg.message ?? "error")
      }
    }
  }

  func memoryCaption(_ item: MemoryItem) -> String {
    let when = dateText(item.updatedAt.isEmpty ? item.createdAt : item.updatedAt)
    if let o = item.origin { return [originLabel(o), "you kept it", when].filter { !$0.isEmpty }.joined(separator: " · ") }
    let how = sourceLabel(item.source)
    return [how, when].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  // MARK: memory page (section 7a)

  /** Graph, proposals and the memory bar together. */
  func refreshMemoryPage() {
    request(AppRequest.memoryGraph(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "graph" {
        self.assign(\.graphNodes, msg.nodes ?? [])
        self.assign(\.graphLinks, msg.links ?? [])
        self.assign(\.memoryPageNotice, nil)
      } else {
        self.assign(\.memoryPageNotice, msg.message ?? "Couldn't read memory.")
      }
    }
    refreshSuggestions()
    request(AppRequest.memoryUsage(newId())) { [weak self] msg in
      self?.assign(\.memoryUsage, msg.type == "memory.usage" ? msg.memory : nil)
    }
    refreshMemory()
  }

  /** Proposals waiting for Keep or Skip (Personal shows the "N new" count). */
  func refreshSuggestions() {
    request(AppRequest.memorySuggestions(newId())) { [weak self] msg in self?.takeSuggestions(msg) }
  }

  /** Tell Stephen: the owner's words become a proposal (New), saved only after Keep. */
  func proposeMemory(_ text: String) {
    request(AppRequest.memoryPropose(newId(), text: text)) { [weak self] msg in
      self?.takeSuggestions(msg)
      self?.refreshMemoryPage()
    }
  }

  /** The owner's Keep (optionally with their edit): the only way a proposal becomes memory. */
  func keepProposal(_ propId: String, text: String? = nil) {
    request(AppRequest.memoryKeep(newId(), propId: propId, text: text)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "memory" {
        self.memory = msg.items ?? []
        self.memoryPageNotice = nil
      } else {
        self.memoryPageNotice = msg.message ?? "error"
      }
      self.refreshMemoryPage()
    }
  }

  func skipProposal(_ propId: String) {
    request(AppRequest.memorySkip(newId(), propId: propId)) { [weak self] msg in
      self?.takeSuggestions(msg)
      self?.refreshMemoryPage()
    }
  }

  private func takeSuggestions(_ msg: AppMessage) {
    if msg.type == "suggestions" {
      assign(\.suggestions, msg.suggestions ?? [])
    } else {
      assign(\.memoryPageNotice, msg.message ?? "error")
    }
  }

  /** Where a proposal or a kept item came from, in words. */
  func originLabel(_ origin: String) -> String {
    switch origin {
    case "you": return "You told Stephen"
    case "chat": return "From your chats"
    case "email": return "From email"
    case "canvas": return "From Canvas"
    case "web": return "From a web page"
    default: return "From \(origin)"
    }
  }

  // MARK: history

  func refreshHistory() {
    request(AppRequest.historyList(newId(), before: nil, limit: AppModel.historyPageSize)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "history" {
        let entries = msg.historyEntries ?? []
        self.assign(\.history, entries)
        self.assign(\.historyMayHaveMore, entries.count >= AppModel.historyPageSize)
        self.assign(\.historyNotice, nil)
      } else {
        self.assign(\.historyNotice, msg.message ?? "error")
      }
    }
  }

  func loadOlderHistory() {
    guard let oldest = history.last?.ts, !oldest.isEmpty else { return }
    request(AppRequest.historyList(newId(), before: oldest, limit: AppModel.historyPageSize)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "history" {
        let entries = msg.historyEntries ?? []
        let known = Set(self.history.map { $0.id })
        self.history.append(contentsOf: entries.filter { !known.contains($0.id) })
        self.historyMayHaveMore = entries.count >= AppModel.historyPageSize
      } else {
        self.historyNotice = msg.message ?? "error"
      }
    }
  }

  func clearHistory() {
    request(AppRequest.historyClear(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "ok" {
        self.history = []
        self.historyMayHaveMore = false
        self.historyNotice = "History cleared."
      } else {
        self.historyNotice = msg.message ?? "error"
      }
    }
  }

  /** History grouped by local day, newest day first (entries arrive newest first). */
  var historyDays: [HistoryDay] {
    var days: [HistoryDay] = []
    var key = ""
    var title = ""
    var bucket: [HistoryEntry] = []
    for e in history {
      let date = parseDate(e.ts)
      let k = date.map { dayKeyFormatter.string(from: $0) } ?? "unknown"
      if k != key {
        if !bucket.isEmpty { days.append(HistoryDay(id: key, title: title, entries: bucket)) }
        key = k
        title = date.map { dayTitleFormatter.string(from: $0) } ?? "Unknown date"
        bucket = []
      }
      bucket.append(e)
    }
    if !bucket.isEmpty { days.append(HistoryDay(id: key, title: title, entries: bucket)) }
    return days
  }

  // MARK: settings, audit

  func refreshSettings() {
    request(AppRequest.settingsGet(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "settings" {
        self.assign(\.settingsText, (msg.config ?? .object([:])).renderLines().joined(separator: "\n"))
        self.assign(\.ownerName, aboutMeName(msg.config))
        self.assign(\.talk, TalkSettings(msg.config))
        self.assign(\.configJSON, msg.config)
        self.assign(\.configPath, msg.configPath)
        self.assign(\.settingsNotice, nil)
      } else {
        self.assign(\.settingsNotice, msg.message ?? "error")
      }
    }
  }

  /** How Stephen talks > Save: only what changed; `done(nil)` on success, else the listener's words. */
  func saveTalk(_ values: [String: TalkValue], done: @escaping (String?) -> Void) {
    if values.isEmpty { return done(nil) }
    request(AppRequest.settingsSet(newId(), values: values)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "settings" {
        self.talk = TalkSettings(msg.config)
        self.configJSON = msg.config
        done(nil)
      } else {
        done(msg.message ?? "error")
      }
    }
  }

  /** Settings > Model > Save: only what changed; `done(nil)` on success, else the listener's words. */
  func saveModel(model: String?, effort: String?, done: @escaping (String?) -> Void) {
    if model == nil && effort == nil { return done(nil) }
    request(AppRequest.modelSet(newId(), model: model, effort: effort)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "settings" {
        self.configJSON = msg.config
        done(nil)
      } else {
        done(msg.message ?? "error")
      }
    }
  }

  /** Settings > Privacy and permissions: turn the replay recorder on or off; `done(nil)` on success, else the listener's words. */
  func saveReplay(_ on: Bool, done: @escaping (String?) -> Void) {
    request(AppRequest.replaySet(newId(), enabled: on)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "settings" {
        self.configJSON = msg.config
        done(nil)
      } else {
        done(msg.message ?? "error")
      }
    }
  }

  /** The switch's "Delete": every saved recording (`stephen replay delete --all`). */
  func deleteRecordings(done: @escaping (String?) -> Void) {
    request(AppRequest.replayDelete(newId())) { msg in done(msg.type == "ok" ? nil : (msg.message ?? "error")) }
  }

  func refreshAudit() {
    request(AppRequest.auditRecent(newId(), limit: AppModel.auditLimit)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "audit" {
        self.assign(\.audit, msg.auditEntries ?? [])
        self.assign(\.auditNotice, nil)
      } else {
        self.assign(\.auditNotice, msg.message ?? "error")
      }
    }
  }

  func refreshAccounts() {
    request(AppRequest.accountsStatus(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "accounts" {
        self.assign(\.accounts, msg.accounts ?? [])
        self.assign(\.accountsNotice, msg.note)
      } else {
        self.assign(\.accountsNotice, msg.message ?? "error")
      }
    }
  }

  func refreshJobs() {
    request(AppRequest.jobsList(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "jobs" {
        self.assign(\.jobs, msg.jobs ?? [])
        self.assign(\.jobsNotice, nil)
      } else {
        self.assign(\.jobsNotice, msg.message ?? "error")
      }
    }
  }

  func refreshPersonal() {
    request(AppRequest.personalSummary(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "personal", let p = msg.personal {
        self.assign(\.personal, p)
        self.assign(\.personalNotice, nil)
      } else {
        self.assign(\.personalNotice, msg.message ?? "Couldn't read the Personal summary.")
      }
    }
  }

  func refreshUsage() {
    request(AppRequest.usageGet(newId())) { [weak self] msg in
      guard let self = self else { return }
      self.assign(\.usage, msg.type == "usage" ? AppUsage(context: msg.context, memory: msg.memory) : nil)
    }
  }

  /** Stop a running job (the owner's own click, so no extra question). The list is refreshed from the answer. */
  func stopJob(_ jobId: String) {
    request(AppRequest.jobsStop(newId(), jobId: jobId)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "job", let row = msg.job {
        if let i = self.jobs.firstIndex(where: { $0.id == row.id }) { self.jobs[i] = row }
        self.jobsNotice = nil
      } else {
        self.jobsNotice = msg.message ?? "error"
      }
      self.refreshJobs()
    }
  }

  /** T6 step 2: "Stop them too", the owner's own click. Each running job gets its own jobs.stop. */
  func stopRunningJobs() {
    for j in jobs where j.isRunning { stopJob(j.id) }
  }

  /**
   * ADR-010 Edit request ([DEV REVIEW]): the owner's Continue in a stopped, finished or failed job's editor. The
   * listener plans a NEW job and shows the job dialog with every field; nothing starts until the owner allows it. The
   * answer waits for that dialog (up to two minutes), so this request gets the control timeout.
   */
  func editJob(_ jobId: String, request text: String) {
    request(AppRequest.jobsEdit(newId(), jobId: jobId, text: text), timeout: APP_CONTROL_TIMEOUT_SECONDS) { [weak self] msg in
      guard let self = self else { return }
      // The real id (with its -v<N>) is known only now that the job started; the dialog never named it.
      if msg.type == "job", let row = msg.job { self.jobsNotice = nil; self.jobStarted = "Job started: \(row.id)" } else { self.jobsNotice = msg.message ?? "error"; self.jobStarted = nil }
      self.refreshJobs()
    }
  }

  /// Write a @Published field only when the value changed (C7). Every write tells every view that watches AppModel to
  /// redraw, and most poll answers are the same as last time. A key path, not inout: inout always calls the setter.
  private func assign<T: Equatable>(_ field: ReferenceWritableKeyPath<AppModel, T>, _ value: T) {
    if self[keyPath: field] != value { self[keyPath: field] = value }
  }

  // MARK: formatting

  func parseDate(_ iso: String) -> Date? {
    if let d = isoFractional.date(from: iso) { return d }
    return isoPlain.date(from: iso)
  }

  func timeText(_ iso: String) -> String {
    guard let d = parseDate(iso) else { return iso }
    return timeFormatter.string(from: d)
  }

  func dateText(_ iso: String) -> String {
    guard let d = parseDate(iso) else { return iso }
    return dayKeyFormatter.string(from: d) + " " + timeFormatter.string(from: d)
  }

  func sourceLabel(_ source: String) -> String {
    switch source {
    case "voice-ptt": return "Fn+Option"
    case "voice-wake": return "Hey Stephen"
    case "app": return "Stephen app"
    case "cli": return "command line"
    case "phone": return "Phone"
    default: return source
    }
  }
}

/** ADR-010: the versions of one message, oldest first, and whether the earlier part of its branch has expired. */
struct HistoryVersions: Equatable {
  var entries: [HistoryEntry]
  var expired: Bool
}

/** chat.edit's oldHash: SHA-256 of the stored text, lowercase hex (textHash in src/history/branch.ts). */
func textHash(_ s: String) -> String {
  return SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}
