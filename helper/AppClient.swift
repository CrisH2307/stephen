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
import Darwin
import Foundation

let APP_PROTOCOL_VERSION = "1"
/** Max bytes per line (without the newline), both directions. */
let APP_MAX_LINE_BYTES = 256 * 1024
/** chat.send text limit (characters). */
let APP_CHAT_MAX_CHARS = 2000
/** memory.json holds at most this many items (section 2). */
let APP_MEMORY_MAX_ITEMS = 30
/** Requests without a response after this long fail with "timed out". */
let APP_REQUEST_TIMEOUT_SECONDS = 15.0
/** While the window is open and Stephen isn't reachable, try again this often. */
let APP_RETRY_SECONDS = 3.0
/** What the Today card on the Chat tab submits, exactly as if it were typed (test/helper/app-protocol.test.ts). */
let APP_TODAY_PROMPT = "what's my day?"
/** Chat bubbles kept in the window. */
let APP_MAX_BUBBLES = 300

// ───────────────────────────── JSON values the app only displays ─────────────────────────────

/** Any JSON value (settings config, audit args). Decoded leniently, rendered as plain text only. */
enum AppJSON: Decodable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([AppJSON])
  case object([String: AppJSON])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let d = try? c.decode(Double.self) {
      self = .number(d)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([AppJSON].self) {
      self = .array(a)
    } else if let o = try? c.decode([String: AppJSON].self) {
      self = .object(o)
    } else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }
  }

  /** Readable multi-line text: `key: value`, nested objects indented, keys sorted. */
  func renderLines(indent: Int = 0) -> [String] {
    let pad = String(repeating: "  ", count: indent)
    switch self {
    case let .object(obj):
      if obj.isEmpty { return [pad + "{}"] }
      var out: [String] = []
      for key in obj.keys.sorted() {
        guard let value = obj[key] else { continue }
        if value.isScalar || value.isEmptyContainer {
          out.append(pad + key + ": " + value.scalarText)
        } else {
          out.append(pad + key + ":")
          out.append(contentsOf: value.renderLines(indent: indent + 1))
        }
      }
      return out
    case let .array(items):
      if items.isEmpty { return [pad + "[]"] }
      if items.allSatisfy({ $0.isScalar }) {
        return [pad + "[" + items.map { $0.scalarText }.joined(separator: ", ") + "]"]
      }
      var out: [String] = []
      for item in items {
        if item.isScalar {
          out.append(pad + "- " + item.scalarText)
        } else {
          out.append(pad + "-")
          out.append(contentsOf: item.renderLines(indent: indent + 1))
        }
      }
      return out
    default:
      return [pad + scalarText]
    }
  }

  var isScalar: Bool {
    switch self {
    case .array, .object: return false
    default: return true
    }
  }

  var isEmptyContainer: Bool {
    switch self {
    case let .array(a): return a.isEmpty
    case let .object(o): return o.isEmpty
    default: return false
    }
  }

  var scalarText: String {
    switch self {
    case let .string(s): return s
    case let .number(d):
      if d == d.rounded() && abs(d) < 1e15 { return String(Int64(d)) }
      return String(d)
    case let .bool(b): return b ? "true" : "false"
    case .null: return "null"
    case let .array(a): return a.isEmpty ? "[]" : "[…]"
    case let .object(o): return o.isEmpty ? "{}" : "{…}"
    }
  }
}

// ───────────────────────────── protocol v1 messages ─────────────────────────────

/** One app → node request. Optional fields that are nil are left out of the JSON line. */
struct AppRequest: Encodable {
  let id: String
  let type: String
  var version: String? = nil
  var text: String? = nil
  var memId: String? = nil
  var before: String? = nil
  var limit: Int? = nil
  var jobId: String? = nil

  static func hello(_ id: String) -> AppRequest {
    return AppRequest(id: id, type: "hello", version: APP_PROTOCOL_VERSION)
  }
  static func chatSend(_ id: String, text: String) -> AppRequest {
    return AppRequest(id: id, type: "chat.send", text: text)
  }
  static func chatStop(_ id: String) -> AppRequest { return AppRequest(id: id, type: "chat.stop") }
  static func historyList(_ id: String, before: String?, limit: Int) -> AppRequest {
    return AppRequest(id: id, type: "history.list", before: before, limit: limit)
  }
  static func historyClear(_ id: String) -> AppRequest { return AppRequest(id: id, type: "history.clear") }
  static func memoryList(_ id: String) -> AppRequest { return AppRequest(id: id, type: "memory.list") }
  static func memoryAdd(_ id: String, text: String) -> AppRequest {
    return AppRequest(id: id, type: "memory.add", text: text)
  }
  static func memoryUpdate(_ id: String, memId: String, text: String) -> AppRequest {
    return AppRequest(id: id, type: "memory.update", text: text, memId: memId)
  }
  static func memoryForget(_ id: String, memId: String) -> AppRequest {
    return AppRequest(id: id, type: "memory.forget", memId: memId)
  }
  static func memoryClear(_ id: String) -> AppRequest { return AppRequest(id: id, type: "memory.clear") }
  static func settingsGet(_ id: String) -> AppRequest { return AppRequest(id: id, type: "settings.get") }
  static func auditRecent(_ id: String, limit: Int) -> AppRequest {
    return AppRequest(id: id, type: "audit.recent", limit: limit)
  }
  static func accountsStatus(_ id: String) -> AppRequest { return AppRequest(id: id, type: "accounts.status") }
  static func jobsList(_ id: String) -> AppRequest { return AppRequest(id: id, type: "jobs.list") }
  static func jobsStop(_ id: String, jobId: String) -> AppRequest {
    return AppRequest(id: id, type: "jobs.stop", jobId: jobId)
  }
  // ROADMAP P2 control (src/app/control.ts); sent by StephenControl below.
  static func phoneOn(_ id: String) -> AppRequest { return AppRequest(id: id, type: "phone.on") }
  static func phoneOff(_ id: String) -> AppRequest { return AppRequest(id: id, type: "phone.off") }
  static func zenOpen(_ id: String) -> AppRequest { return AppRequest(id: id, type: "zen.open") }
  static func doctorRun(_ id: String) -> AppRequest { return AppRequest(id: id, type: "doctor.run") }
  static func usageGet(_ id: String) -> AppRequest { return AppRequest(id: id, type: "usage.get") }
}

/** One bar of the `usage` answer (src/app/usage.ts): context has tokens/window, memory has bytes/budget. */
struct UsageBar: Decodable, Equatable {
  let percent: Int
  let warn: Bool
  var tokens: Int? = nil
  var window: Int? = nil
  var bytes: Int? = nil
  var budget: Int? = nil
}

/** One check of the `doctor` answer (src/cli.ts doctor --json). */
struct DoctorCheck: Decodable, Equatable {
  let ok: Bool
  let label: String
  var detail: String? = nil
  var fix: String? = nil
  var blocking: Bool? = nil
  var info: Bool? = nil
}

/** One row of `jobs.list` / the `job` answer to `jobs.stop` (src/app/jobs-status.ts). Summary and task are the job's own words: shown verbatim. */
struct JobRow: Decodable, Identifiable, Equatable {
  var id: String = ""
  var task: String = ""
  /** "queued" | "running" | "done" | "failed" | "stopped" | "timeout" */
  var status: String = ""
  /** Epoch milliseconds. */
  var createdAt: Double = 0
  var startedAt: Double? = nil
  var endedAt: Double? = nil
  var turns: Int = 0
  var costUsd: Double? = nil
  var folder: String = ""
  var summary: String = ""
  var error: String = ""

  var isRunning: Bool { return status == "queued" || status == "running" }

  enum CodingKeys: String, CodingKey {
    case id, task, status, createdAt, startedAt, endedAt, turns, costUsd, folder, summary, error
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
    task = (try? c.decodeIfPresent(String.self, forKey: .task)) ?? ""
    status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
    createdAt = (try? c.decodeIfPresent(Double.self, forKey: .createdAt)) ?? 0
    startedAt = (try? c.decodeIfPresent(Double.self, forKey: .startedAt)) ?? nil
    endedAt = (try? c.decodeIfPresent(Double.self, forKey: .endedAt)) ?? nil
    turns = (try? c.decodeIfPresent(Int.self, forKey: .turns)) ?? 0
    costUsd = (try? c.decodeIfPresent(Double.self, forKey: .costUsd)) ?? nil
    folder = (try? c.decodeIfPresent(String.self, forKey: .folder)) ?? ""
    summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
    error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? ""
  }
}

/** One row of `accounts.status` (src/app/accounts-status.ts). Never holds a secret, only where it was found. */
struct AccountRow: Decodable, Identifiable, Equatable {
  var id: String = ""
  var name: String = ""
  /** "connected" | "not_set" | "off" */
  var state: String = ""
  /** "keychain" | ".env" | nil */
  var source: String? = nil
  var detail: String? = nil
  var hint: String = ""

  enum CodingKeys: String, CodingKey { case id, name, state, source, detail, hint }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
    name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
    state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? ""
    source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? nil
    detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? nil
    hint = (try? c.decodeIfPresent(String.self, forKey: .hint)) ?? ""
  }
}

/** A saved memory item (section 2). */
struct MemoryItem: Decodable, Identifiable, Equatable {
  var id: String = ""
  var text: String = ""
  var source: String = ""
  var createdAt: String = ""
  var updatedAt: String = ""

  enum CodingKeys: String, CodingKey { case id, text, source, createdAt, updatedAt }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
    source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
    createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
    updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? ""
  }
}

/** One tool call inside a history entry. */
struct HistoryTool: Decodable, Equatable {
  var tool: String = ""
  var isError: Bool = false
  var ms: Double = 0

  enum CodingKeys: String, CodingKey { case tool, isError, ms }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? ""
    isError = (try? c.decodeIfPresent(Bool.self, forKey: .isError)) ?? false
    ms = (try? c.decodeIfPresent(Double.self, forKey: .ms)) ?? 0
  }
}

/** One command from <home>/history (section 2). */
struct HistoryEntry: Decodable, Identifiable, Equatable {
  var id: String = ""
  var ts: String = ""
  var source: String = ""
  var said: String = ""
  var reply: String = ""
  var outcome: String = ""
  var tools: [HistoryTool] = []
  var followUp: Bool = false
  var ms: Double = 0

  enum CodingKeys: String, CodingKey { case id, ts, source, said, reply, outcome, tools, followUp, ms }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    ts = (try? c.decodeIfPresent(String.self, forKey: .ts)) ?? ""
    source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
    said = (try? c.decodeIfPresent(String.self, forKey: .said)) ?? ""
    reply = (try? c.decodeIfPresent(String.self, forKey: .reply)) ?? ""
    outcome = (try? c.decodeIfPresent(String.self, forKey: .outcome)) ?? ""
    tools = (try? c.decodeIfPresent([HistoryTool].self, forKey: .tools)) ?? []
    followUp = (try? c.decodeIfPresent(Bool.self, forKey: .followUp)) ?? false
    ms = (try? c.decodeIfPresent(Double.self, forKey: .ms)) ?? 0
  }
}

/** One browser-action audit log line (src/types.ts AuditEntry); only the displayed fields. */
struct AuditEntry: Decodable, Equatable {
  var ts: String = ""
  var tool: String = ""
  var outcome: String = ""
  var kind: String = ""
  var intent: String = ""
  var element: String = ""
  var urlBefore: String = ""
  var urlAfter: String = ""
  var verdict: String = ""
  var error: String = ""

  enum CodingKeys: String, CodingKey { case ts, tool, outcome, kind, intent, element, urlBefore, urlAfter, verdict, error }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ts = (try? c.decodeIfPresent(String.self, forKey: .ts)) ?? ""
    tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? ""
    outcome = (try? c.decodeIfPresent(String.self, forKey: .outcome)) ?? ""
    kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
    intent = (try? c.decodeIfPresent(String.self, forKey: .intent)) ?? ""
    element = (try? c.decodeIfPresent(String.self, forKey: .element)) ?? ""
    urlBefore = (try? c.decodeIfPresent(String.self, forKey: .urlBefore)) ?? ""
    urlAfter = (try? c.decodeIfPresent(String.self, forKey: .urlAfter)) ?? ""
    verdict = (try? c.decodeIfPresent(String.self, forKey: .verdict)) ?? ""
    error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? ""
  }
}

/**
 * Any node → app line (responses and pushes), flattened: every field is optional and decoded leniently, so one
 * odd field never loses the whole message. `type` is required.
 */
struct AppMessage: Decodable {
  var id: String? = nil
  var type: String = ""
  // hello
  var version: String? = nil
  var listening: Bool? = nil
  var model: String? = nil
  // chat.accepted / chat.done
  var entryId: String? = nil
  var reply: String? = nil
  var outcome: String? = nil
  var tools: [String]? = nil
  var ms: Double? = nil
  // error
  var message: String? = nil
  // history / memory / audit / settings
  var historyEntries: [HistoryEntry]? = nil
  var auditEntries: [AuditEntry]? = nil
  var items: [MemoryItem]? = nil
  var config: AppJSON? = nil
  var configPath: String? = nil
  // accounts
  var accounts: [AccountRow]? = nil
  var note: String? = nil
  // jobs / job
  var jobs: [JobRow]? = nil
  var job: JobRow? = nil
  // phone (on, lines) / zen (ok, message) / doctor (checks, problems, blocking)
  var on: Bool? = nil
  var lines: [String]? = nil
  var ok: Bool? = nil
  var checks: [DoctorCheck]? = nil
  var problems: Int? = nil
  var blocking: Int? = nil
  // usage (context is nil when unknown)
  var context: UsageBar? = nil
  var memory: UsageBar? = nil
  // state / heard pushes
  var state: String? = nil
  var text: String? = nil
  var source: String? = nil

  enum CodingKeys: String, CodingKey {
    case id, type, version, listening, model, entryId, reply, outcome, tools, ms, message, entries, items, config,
      configPath, state, text, source, accounts, note, jobs, job, on, lines, ok, checks, problems, blocking, context, memory
  }

  init(localError: String, id: String?) {
    self.id = id
    type = "error"
    message = localError
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    type = try c.decode(String.self, forKey: .type)
    id = try? c.decodeIfPresent(String.self, forKey: .id)
    version = try? c.decodeIfPresent(String.self, forKey: .version)
    listening = try? c.decodeIfPresent(Bool.self, forKey: .listening)
    model = try? c.decodeIfPresent(String.self, forKey: .model)
    entryId = try? c.decodeIfPresent(String.self, forKey: .entryId)
    reply = try? c.decodeIfPresent(String.self, forKey: .reply)
    outcome = try? c.decodeIfPresent(String.self, forKey: .outcome)
    tools = try? c.decodeIfPresent([String].self, forKey: .tools)
    ms = try? c.decodeIfPresent(Double.self, forKey: .ms)
    message = try? c.decodeIfPresent(String.self, forKey: .message)
    // `entries` holds history entries or audit entries depending on `type`.
    if type == "history" {
      historyEntries = try? c.decodeIfPresent([HistoryEntry].self, forKey: .entries)
    } else if type == "audit" {
      auditEntries = try? c.decodeIfPresent([AuditEntry].self, forKey: .entries)
    }
    items = try? c.decodeIfPresent([MemoryItem].self, forKey: .items)
    config = try? c.decodeIfPresent(AppJSON.self, forKey: .config)
    configPath = try? c.decodeIfPresent(String.self, forKey: .configPath)
    accounts = try? c.decodeIfPresent([AccountRow].self, forKey: .accounts)
    note = try? c.decodeIfPresent(String.self, forKey: .note)
    jobs = try? c.decodeIfPresent([JobRow].self, forKey: .jobs)
    job = try? c.decodeIfPresent(JobRow.self, forKey: .job)
    on = try? c.decodeIfPresent(Bool.self, forKey: .on)
    lines = try? c.decodeIfPresent([String].self, forKey: .lines)
    ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
    checks = try? c.decodeIfPresent([DoctorCheck].self, forKey: .checks)
    problems = try? c.decodeIfPresent(Int.self, forKey: .problems)
    blocking = try? c.decodeIfPresent(Int.self, forKey: .blocking)
    if type == "usage" {
      context = try? c.decodeIfPresent(UsageBar.self, forKey: .context)
      memory = try? c.decodeIfPresent(UsageBar.self, forKey: .memory)
    }
    state = try? c.decodeIfPresent(String.self, forKey: .state)
    text = try? c.decodeIfPresent(String.self, forKey: .text)
    source = try? c.decodeIfPresent(String.self, forKey: .source)
  }
}

// ───────────────────────────── transport ─────────────────────────────

/**
 * One connection to app.sock. `connect` and reads run on background queues, writes on one serial queue (lines never
 * interleave); `onLine` and `onClosed` are called on the main queue.
 */
final class AppConnection {
  let path: String
  /** One received line (main queue). */
  var onLine: (String) -> Void = { _ in }
  /** The open connection went away (main queue). Not called for a failed connect. */
  var onClosed: () -> Void = {}

  private let current = Locked<Int32>(-1)
  private let writeQueue = DispatchQueue(label: "dev.stephen.helper.app.write")

  init(path: String) { self.path = path }

  var isOpen: Bool { return current.get() >= 0 }

  /** Connect in the background; `done(nil)` on success or `done(reason)` on failure, on the main queue. */
  func open(_ done: @escaping (String?) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async { [self] in
      if current.get() >= 0 {
        DispatchQueue.main.async { done(nil) }
        return
      }
      let result = connectSocket()
      if result.fd < 0 {
        let reason = result.error
        DispatchQueue.main.async { done(reason) }
        return
      }
      let fd = result.fd
      current.set(fd)
      let reader = Thread { [self] in readLoop(fd) }
      reader.name = "dev.stephen.helper.app.read"
      reader.start()
      DispatchQueue.main.async { done(nil) }
    }
  }

  /** Close the connection (if any). `onClosed` still fires once the reader notices. */
  func close() {
    let fd = current.get()
    if fd >= 0 { _ = Darwin.shutdown(fd, Int32(SHUT_RDWR)) }
  }

  /** Queue one line (a trailing newline is added). false when not connected or the line is too long. */
  @discardableResult
  func send(_ line: String) -> Bool {
    let fd = current.get()
    guard fd >= 0 else { return false }
    let bytes = Array((line + "\n").utf8)
    guard bytes.count <= APP_MAX_LINE_BYTES + 1 else { return false }
    writeQueue.async { [self] in
      guard current.get() == fd else { return }
      var off = 0
      while off < bytes.count {
        let n = bytes.withUnsafeBytes { raw -> Int in
          guard let base = raw.baseAddress else { return -1 }
          return Darwin.write(fd, base + off, bytes.count - off)
        }
        if n > 0 {
          off += n
        } else if n < 0 && errno == EINTR {
          continue
        } else {
          _ = Darwin.shutdown(fd, Int32(SHUT_RDWR))
          return
        }
      }
    }
    return true
  }

  private func connectSocket() -> (fd: Int32, error: String) { return connectAppSocket(path) }

  private func readLoop(_ fd: Int32) {
    var framer = LineFramer(maxBytes: APP_MAX_LINE_BYTES)
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = buf.withUnsafeMutableBytes { raw -> Int in
        guard let base = raw.baseAddress else { return -1 }
        return Darwin.read(fd, base, raw.count)
      }
      if n > 0 {
        let lines = framer.push(buf[0..<n])
        if !lines.isEmpty {
          DispatchQueue.main.async { [self] in
            for line in lines { onLine(line) }
          }
        }
        continue
      }
      if n < 0 && errno == EINTR { continue }
      break
    }
    let wasCurrent = current.with { cur -> Bool in
      if cur == fd {
        cur = -1
        return true
      }
      return false
    }
    // Close on the write queue so no queued write can hit a reused descriptor.
    writeQueue.async { _ = Darwin.close(fd) }
    if wasCurrent {
      DispatchQueue.main.async { [self] in onClosed() }
    }
  }
}

/** Connect to a same-user Unix socket (app.sock). fd < 0 with a reason on failure. */
func connectAppSocket(_ path: String) -> (fd: Int32, error: String) {
  var addr = sockaddr_un()
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  addr.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(path.utf8)
  let capacity = MemoryLayout.size(ofValue: addr.sun_path)
  guard !pathBytes.isEmpty, pathBytes.count < capacity else {
    return (-1, "socket path too long (\(pathBytes.count) bytes): \(path)")
  }
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (k, c) in pathBytes.enumerated() { raw[k] = c }
    raw[pathBytes.count] = 0
  }

  let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 { return (-1, "socket(): \(String(cString: strerror(errno)))") }
  var one: Int32 = 1
  _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  // A server that stops reading must not block the write queue forever.
  var tv = timeval(tv_sec: 5, tv_usec: 0)
  _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  let rc = withUnsafePointer(to: &addr) { p -> Int32 in
    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa -> Int32 in Darwin.connect(fd, sa, len) }
  }
  if rc != 0 {
    let code = errno
    _ = Darwin.close(fd)
    if code == ENOENT || code == ECONNREFUSED { return (-1, "nothing is listening on \(path)") }
    return (-1, "connect \(path): \(String(cString: strerror(code)))")
  }
  // Only talk to a server run by this same user.
  var uid: uid_t = 0
  var gid: gid_t = 0
  if getpeereid(fd, &uid, &gid) != 0 || uid != getuid() {
    _ = Darwin.close(fd)
    return (-1, "\(path) belongs to another user; not using it")
  }
  return (fd, "")
}

// ───────────────────────────── window model ─────────────────────────────

enum AppConnectionState: Equatable {
  case connecting
  case online
  case offline
}

struct ChatBubble: Identifiable, Equatable {
  enum Kind: Equatable {
    /** What the user typed or said (right side). */
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
  /** Small line under the text: tool names, or where a command came from. */
  let detail: String
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
  @Published private(set) var awaitingReplies: Set<String> = []

  @Published private(set) var memory: [MemoryItem] = []
  @Published private(set) var memoryNotice: String? = nil

  @Published private(set) var history: [HistoryEntry] = []
  @Published private(set) var historyMayHaveMore = false
  @Published private(set) var historyNotice: String? = nil

  @Published private(set) var settingsText = ""
  @Published private(set) var configPath: String? = nil
  @Published private(set) var settingsNotice: String? = nil

  @Published private(set) var audit: [AuditEntry] = []
  @Published private(set) var auditNotice: String? = nil

  @Published private(set) var accounts: [AccountRow] = []
  @Published private(set) var accountsNotice: String? = nil

  @Published private(set) var jobs: [JobRow] = []
  @Published private(set) var jobsNotice: String? = nil

  let socketPath: String
  private let log: (String) -> Void
  private let link: AppConnection
  private var pending: [String: (AppMessage) -> Void] = [:]
  private var nextRequest = 1
  private var nextBubble = 1
  private var windowOpen = false
  private var retryScheduled = false
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let isoFractional = ISO8601DateFormatter()
  private let isoPlain = ISO8601DateFormatter()
  private let dayKeyFormatter = DateFormatter()
  private let dayTitleFormatter = DateFormatter()
  private let timeFormatter = DateFormatter()

  static let historyPageSize = 50
  static let auditLimit = 100

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

  func windowOpened() {
    windowOpen = true
    if connection != .online { connect() }
  }

  func windowClosed() {
    windowOpen = false
    link.close()
  }

  func retry() {
    connect()
  }

  var isWorking: Bool { return state == "working" || !awaitingReplies.isEmpty }

  var headerText: String {
    switch connection {
    case .connecting: return "Connecting…"
    case .offline: return "Not connected"
    case .online:
      var s = "Idle"
      if !state.isEmpty { s = state.prefix(1).uppercased() + String(state.dropFirst()) }
      return listening ? s : s + " (microphone off)"
    }
  }

  private func connect() {
    if connection == .connecting { return }
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
    offlineReason = reason
    scheduleRetry()
  }

  private func connectionLost() {
    let waiting = pending
    pending = [:]
    awaitingReplies = []
    for (id, handler) in waiting { handler(AppMessage(localError: "not connected", id: id)) }
    if connection == .online { log("app.sock: disconnected") }
    goOffline(windowOpen ? "the connection to stephen listen closed" : "window closed")
  }

  private func scheduleRetry() {
    guard windowOpen, !retryScheduled else { return }
    retryScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + APP_RETRY_SECONDS) { [weak self] in
      guard let self = self else { return }
      self.retryScheduled = false
      if self.windowOpen && self.connection == .offline { self.connect() }
    }
  }

  // MARK: requests

  private func newId() -> String {
    let id = "a\(nextRequest)"
    nextRequest += 1
    return id
  }

  /** Send a request; `handler` gets the response, or a local error ("not connected", "timed out"). */
  private func request(_ req: AppRequest, then handler: @escaping (AppMessage) -> Void) {
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
    DispatchQueue.main.asyncAfter(deadline: .now() + APP_REQUEST_TIMEOUT_SECONDS) { [weak self] in
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
    case "state":
      if let s = msg.state { state = s }
      if state == "idle" { awaitingReplies = [] }
    case "heard":
      // Typed commands are already in the chat; only voice commands are added here.
      if let text = msg.text, msg.source != "app" {
        addBubble(.said, text, detail: sourceLabel(msg.source ?? ""))
      }
    case "chat.done":
      chatDone(msg)
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

  func stopChat() {
    request(AppRequest.chatStop(newId())) { [weak self] msg in
      if msg.type == "error" { self?.addBubble(.problem, msg.message ?? "could not stop", detail: "") }
    }
  }

  private func chatDone(_ msg: AppMessage) {
    if let entryId = msg.entryId { awaitingReplies.remove(entryId) }
    let outcome = msg.outcome ?? "ok"
    var reply = msg.reply ?? ""
    if reply.isEmpty && outcome == "cancelled" { reply = "Stopped." }
    if reply.isEmpty { reply = "(no reply)" }
    var detailParts: [String] = []
    let tools = msg.tools ?? []
    if !tools.isEmpty { detailParts.append(tools.joined(separator: ", ")) }
    if let ms = msg.ms, ms > 0 { detailParts.append(String(format: "%.1f s", ms / 1000)) }
    addBubble(outcome == "error" ? .problem : .reply, reply, detail: detailParts.joined(separator: " · "))
  }

  private func addBubble(_ kind: ChatBubble.Kind, _ text: String, detail: String) {
    chat.append(ChatBubble(id: nextBubble, kind: kind, text: text, detail: detail))
    nextBubble += 1
    if chat.count > APP_MAX_BUBBLES { chat.removeFirst(chat.count - APP_MAX_BUBBLES) }
  }

  // MARK: memory

  func refreshMemory() { memoryRequest(AppRequest.memoryList(newId())) }
  func addMemory(_ text: String) { memoryRequest(AppRequest.memoryAdd(newId(), text: text)) }
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
        self.memory = msg.items ?? []
        self.memoryNotice = isChange ? "Saved. Stephen starts a fresh conversation with the next command." : nil
      } else {
        self.memoryNotice = msg.message ?? "error"
      }
    }
  }

  func memoryCaption(_ item: MemoryItem) -> String {
    let when = dateText(item.updatedAt.isEmpty ? item.createdAt : item.updatedAt)
    let how = sourceLabel(item.source)
    return [how, when].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  // MARK: history

  func refreshHistory() {
    request(AppRequest.historyList(newId(), before: nil, limit: AppModel.historyPageSize)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "history" {
        let entries = msg.historyEntries ?? []
        self.history = entries
        self.historyMayHaveMore = entries.count >= AppModel.historyPageSize
        self.historyNotice = nil
      } else {
        self.historyNotice = msg.message ?? "error"
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
        self.settingsText = (msg.config ?? .object([:])).renderLines().joined(separator: "\n")
        self.configPath = msg.configPath
        self.settingsNotice = nil
      } else {
        self.settingsNotice = msg.message ?? "error"
      }
    }
  }

  func refreshAudit() {
    request(AppRequest.auditRecent(newId(), limit: AppModel.auditLimit)) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "audit" {
        self.audit = msg.auditEntries ?? []
        self.auditNotice = nil
      } else {
        self.auditNotice = msg.message ?? "error"
      }
    }
  }

  func refreshAccounts() {
    request(AppRequest.accountsStatus(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "accounts" {
        self.accounts = msg.accounts ?? []
        self.accountsNotice = msg.note
      } else {
        self.accountsNotice = msg.message ?? "error"
      }
    }
  }

  func refreshJobs() {
    request(AppRequest.jobsList(newId())) { [weak self] msg in
      guard let self = self else { return }
      if msg.type == "jobs" {
        self.jobs = msg.jobs ?? []
        self.jobsNotice = nil
      } else {
        self.jobsNotice = msg.message ?? "error"
      }
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

// ───────────────────────────── control: listener, phone, Zen, doctor (ROADMAP P2) ─────────────────────────────

/** app.sock requests that run tools (the phone lock-down check starts Claude Code) get this long. */
let APP_CONTROL_TIMEOUT_SECONDS = 150.0
/** listen.log is moved to listen.log.1 when a start finds it bigger than this. */
let LISTEN_LOG_MAX_BYTES: UInt64 = 2_000_000
/** Log lines kept for the window. */
let LISTEN_LOG_MAX_LINES = 500

/** The pid of the process serving a same-user Unix socket (LOCAL_PEERPID), or nil when nothing answers. */
func appSocketPeerPid(_ path: String) -> pid_t? {
  let r = connectAppSocket(path)
  guard r.fd >= 0 else { return nil }
  defer { _ = Darwin.close(r.fd) }
  var pid: pid_t = 0
  var len = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(r.fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0, pid > 0 else { return nil }
  return pid
}

/** A pid's argv (KERN_PROCARGS2), or [] when gone or not readable. */
func processArgv(_ pid: pid_t) -> [String] {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
  var buf = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
  let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
  var i = MemoryLayout<Int32>.size
  while i < size && buf[i] != 0 { i += 1 }  // the exec path
  while i < size && buf[i] == 0 { i += 1 }  // its padding
  var args: [String] = []
  while args.count < argc && i < size {
    let start = i
    while i < size && buf[i] != 0 { i += 1 }
    args.append(String(decoding: buf[start..<i], as: UTF8.self))
    i += 1
  }
  return args
}

/** Is this pid still `<node> <…/dist/cli.js> listen` (the process Stop meant to signal)? */
func isStephenListen(_ pid: pid_t) -> Bool {
  let a = processArgv(pid)
  return a.count >= 3 && a[1].hasSuffix("/dist/cli.js") && a[2] == "listen"
}

/**
 * One request on its own short connection to app.sock (works with the window closed): send, wait for the answer with
 * the same id, close. `done` runs on the main queue with the answer or a local error.
 */
func appRequestOnce(
  _ path: String, _ req: AppRequest, timeout: Double = APP_CONTROL_TIMEOUT_SECONDS,
  _ done: @escaping (AppMessage) -> Void
) {
  DispatchQueue.global(qos: .userInitiated).async {
    let answer = { (m: AppMessage) in DispatchQueue.main.async { done(m) } }
    guard let data = try? JSONEncoder().encode(req) else {
      return answer(AppMessage(localError: "could not encode the request", id: req.id))
    }
    let r = connectAppSocket(path)
    guard r.fd >= 0 else { return answer(AppMessage(localError: "Stephen isn't running (\(r.error))", id: req.id)) }
    defer { _ = Darwin.close(r.fd) }
    var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
    _ = setsockopt(r.fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    let out = Array(data) + [0x0A]
    var off = 0
    while off < out.count {
      let n = out.withUnsafeBytes { Darwin.write(r.fd, $0.baseAddress! + off, out.count - off) }
      if n <= 0 { return answer(AppMessage(localError: "could not send the request", id: req.id)) }
      off += n
    }
    var framer = LineFramer(maxBytes: APP_MAX_LINE_BYTES)
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = buf.withUnsafeMutableBytes { Darwin.read(r.fd, $0.baseAddress!, $0.count) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { return answer(AppMessage(localError: n < 0 ? "timed out" : "Stephen closed the connection", id: req.id)) }
      for line in framer.push(buf[0..<n]) {
        if let m = try? JSONDecoder().decode(AppMessage.self, from: Data(line.utf8)), m.id == req.id { return answer(m) }
      }
    }
  }
}

/** Plain text for a `phone` answer (what `stephen phone on|off` printed) or an error. */
func phoneText(_ msg: AppMessage) -> String {
  return msg.type == "phone" ? (msg.lines ?? []).joined(separator: "\n") : msg.message ?? "error"
}

/** nil when Zen for Stephen is ready, else why not (the `zen` answer's message or an error). */
func zenProblem(_ msg: AppMessage) -> String? {
  return msg.type == "zen" && msg.ok == true ? nil : msg.message ?? "error"
}

/** Plain text for a `doctor` answer, like `stephen doctor` prints it. */
func doctorText(_ msg: AppMessage) -> String {
  guard msg.type == "doctor" else { return msg.message ?? "error" }
  var out: [String] = []
  for c in msg.checks ?? [] {
    let mark = c.info == true ? "•" : c.ok ? "✓" : "✗"
    out.append("\(mark) \(c.label)" + (c.detail.map { ": \($0)" } ?? ""))
    if !c.ok, let fix = c.fix { out.append("    fix: \(fix)") }
  }
  let problems = msg.problems ?? 0
  out.append(problems == 0 ? "All good." : "\(problems) problem\(problems == 1 ? "" : "s") (\(msg.blocking ?? 0) blocking).")
  return out.joined(separator: "\n")
}

enum ListenerStatus: Equatable {
  case stopped
  /** Started by this helper; app.sock isn't up yet. */
  case starting
  /** app.sock answers. `fromApp`: the listener this helper started (only that one can be stopped from the app). */
  case running(fromApp: Bool)
}

/**
 * Starts and stops `stephen listen` (ROADMAP P2) and sends the control requests. Main thread only; owned by main.swift,
 * not by the window, so a listener started here keeps running when the window closes (and even when the helper quits).
 *
 *  - One owner: start does nothing while app.sock answers (a listener runs, from here or from Terminal) or while our
 *    child is still starting. The child's pid goes to <home>/run/listen.pid; app.sock's peer pid (LOCAL_PEERPID) equal
 *    to it means "ours", so a restarted helper still knows its listener. Stop refuses a Terminal listener.
 *    listen.pid is removed when our child exits, or when nothing serves app.sock and we have no child (after a reboot).
 *  - How to start it: <home>/run/launch.json (node, cli.js, PATH), written only by `stephen install-helper`
 *    (src/app/control.ts), so a listener run from another checkout never changes what Start runs. It must be ours and
 *    not group/world-writable; missing or unsafe, Start says to run `stephen install-helper`.
 *  - Output: <home>/logs/listen.log (0600, rotated at 2 MB); the window tails it with watchLog.
 *  - Stop: SIGINT (idle: "Bye."; busy: cancels the command), SIGINT again after 3 s, SIGKILL after 10 s. The delayed
 *    signals go only if that pid's command line is still `<node> <…/dist/cli.js> listen` (REVIEW-9 R9-8: a pid
 *    reused in between is left alone).
 */
final class StephenControl: ObservableObject {
  @Published private(set) var listener: ListenerStatus = .stopped
  /** Last lines of listen.log while watchLog(true). */
  @Published private(set) var logLines: [String] = []

  let home: String
  private let log: (String) -> Void
  private var child: Process? = nil
  private var logTimer: DispatchSourceTimer? = nil
  private var logOffset: UInt64 = 0
  private var logPartial = ""
  private var pollsLeft = 0

  init(home: String, log: @escaping (String) -> Void) {
    self.home = home
    self.log = log
  }

  var appSocketPath: String { return home + "/run/app.sock" }
  var launchInfoPath: String { return home + "/run/launch.json" }
  var pidPath: String { return home + "/run/listen.pid" }
  var logPath: String { return home + "/logs/listen.log" }

  private func recordedPid() -> pid_t? {
    guard let s = try? String(contentsOfFile: pidPath, encoding: .utf8) else { return nil }
    return pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  /** Look again: is app.sock answering, and is it our listener? */
  func refresh() {
    if let peer = appSocketPeerPid(appSocketPath) {
      listener = .running(fromApp: peer == recordedPid() || peer == child?.processIdentifier)
    } else if child?.isRunning == true {
      listener = .starting
    } else {
      listener = .stopped
      if child == nil { try? FileManager.default.removeItem(atPath: pidPath) }  // stale (helper restarted, reboot)
    }
  }

  /** Refresh every second for a while (after start / stop). */
  private func poll(seconds: Int) {
    let running = pollsLeft > 0
    pollsLeft = seconds
    if running { return }
    func tick() {
      refresh()
      pollsLeft -= 1
      if pollsLeft > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { tick() } }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { tick() }
  }

  /** How to run `stephen listen`, or why not. */
  func readLaunchInfo() -> (node: String, cli: String, path: String)? {
    var st = stat()
    guard lstat(launchInfoPath, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(),
      st.st_mode & 0o022 == 0,
      let data = FileManager.default.contents(atPath: launchInfoPath),
      let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let node = j["node"] as? String, let cli = j["cli"] as? String,
      node.hasPrefix("/"), cli.hasPrefix("/"),
      FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: cli)
    else { return nil }
    return (node, cli, j["path"] as? String ?? "")
  }

  /** Start `stephen listen` in the background. `done(nil)` when started (or already starting), else why not. */
  func start(_ done: (String?) -> Void) {
    refresh()
    if case .running = listener { return done("Stephen is already running.") }
    if listener == .starting { return done(nil) }
    guard let info = readLaunchInfo() else {
      return done("Stephen Helper doesn't know how to start Stephen: \(launchInfoPath) is missing or unsafe. Run `stephen install-helper` once in Terminal.")
    }
    try? makePrivateDir(home + "/logs")
    let fm = FileManager.default
    if let size = (try? fm.attributesOfItem(atPath: logPath))?[.size] as? NSNumber, size.uint64Value > LISTEN_LOG_MAX_BYTES {
      try? fm.removeItem(atPath: logPath + ".1")
      try? fm.moveItem(atPath: logPath, toPath: logPath + ".1")
    }
    let fd = Darwin.open(logPath, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return done("Couldn't open \(logPath): \(String(cString: strerror(errno)))") }
    let out = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: info.node)
    p.arguments = [info.cli, "listen"]
    var env = ProcessInfo.processInfo.environment
    if !info.path.isEmpty { env["PATH"] = info.path }
    env["STEPHEN_HOME"] = home
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = out
    p.standardError = out
    p.terminationHandler = { [weak self] proc in
      let code = proc.terminationStatus
      DispatchQueue.main.async {
        if let path = self?.pidPath { try? FileManager.default.removeItem(atPath: path) }
        self?.log("stephen listen exited (\(code))")
        self?.refresh()
      }
    }
    do {
      try p.run()
    } catch {
      return done("Couldn't start stephen listen: \(error.localizedDescription)")
    }
    try? out.close()  // the child has its own copy
    child = p
    _ = fm.createFile(atPath: pidPath, contents: Data("\(p.processIdentifier)\n".utf8), attributes: [.posixPermissions: 0o600])
    log("started stephen listen, pid \(p.processIdentifier)")
    listener = .starting
    poll(seconds: 60)
    done(nil)
  }

  /** Stop the listener this helper started. `done(nil)` when asked to stop, else why not. */
  func stop(_ done: (String?) -> Void) {
    var target: pid_t? = nil
    if let peer = appSocketPeerPid(appSocketPath) {
      guard peer == recordedPid() || peer == child?.processIdentifier else {
        return done("This Stephen was started in Terminal. Stop it there with Ctrl-C.")
      }
      target = peer
    } else if let c = child, c.isRunning {
      target = c.processIdentifier
    }
    guard let pid = target else {
      refresh()
      return done("Stephen isn't running.")
    }
    log("stopping stephen listen, pid \(pid)")
    kill(pid, SIGINT)
    let alive = { isStephenListen(pid) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if alive() { kill(pid, SIGINT) } }
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      if alive() {
        self?.log("stephen listen didn't stop; killing pid \(pid)")
        kill(pid, SIGKILL)
      }
    }
    poll(seconds: 12)
    done(nil)
  }

  // MARK: control requests (need a running listener)

  func phoneOn(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .phoneOn("c-phone-on"), done) }
  func phoneOff(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .phoneOff("c-phone-off"), done) }
  func openZen(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .zenOpen("c-zen"), done) }
  func runDoctor(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .doctorRun("c-doctor"), done) }
  /** This chat's context % (nil when unknown) and memory % for the ⋯ menu; quick, so a short timeout. */
  func usage(_ done: @escaping (AppMessage) -> Void) {
    appRequestOnce(appSocketPath, .usageGet("c-usage"), timeout: APP_REQUEST_TIMEOUT_SECONDS, done)
  }

  // MARK: log

  /** Tail listen.log into logLines every second while on (the window calls this when it shows the log). */
  func watchLog(_ on: Bool) {
    logTimer?.cancel()
    logTimer = nil
    guard on else { return }
    logLines = []
    logPartial = ""
    let size = (try? FileManager.default.attributesOfItem(atPath: logPath))?[.size] as? NSNumber
    logOffset = (size?.uint64Value ?? 0) > 64_000 ? size!.uint64Value - 64_000 : 0
    readLog()
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 1, repeating: 1)
    t.setEventHandler { [weak self] in self?.readLog() }
    t.resume()
    logTimer = t
  }

  private func readLog() {
    guard let h = FileHandle(forReadingAtPath: logPath) else { return }
    defer { try? h.close() }
    let size = h.seekToEndOfFile()
    if size < logOffset { logOffset = 0 }  // rotated
    guard size > logOffset else { return }
    h.seek(toFileOffset: logOffset)
    let data = h.readData(ofLength: Int(min(size - logOffset, 1_000_000)))
    logOffset += UInt64(data.count)
    var parts = (logPartial + String(decoding: data, as: UTF8.self)).components(separatedBy: "\n")
    logPartial = parts.removeLast()
    logLines.append(contentsOf: parts)
    if logLines.count > LISTEN_LOG_MAX_LINES { logLines.removeFirst(logLines.count - LISTEN_LOG_MAX_LINES) }
  }
}
