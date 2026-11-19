// Stephen Helper: app.sock protocol v1 types (requests, messages, the values the window shows).
// Wire contract: docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13 "app.sock protocol v1".
//
// Split out of AppClient.swift (no behaviour change). Threading notes: see AppClient.swift.

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
/** While someone (window or Ask box) wants the connection and Stephen isn't reachable, the first retry waits this long. */
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
  /** hello: this client shows the gate's questions (the Ask box). */
  var confirms: Bool? = nil
  var confirmId: String? = nil
  var approve: Bool? = nil
  /** memory.keep / memory.skip: a proposal id ("p3"). */
  var propId: String? = nil
  /** settings.set: the changed How-Stephen-talks settings (length, tone, speak, explain, voice). */
  var values: [String: TalkValue]? = nil
  /** model.set: a model alias or name ("haiku", "default") and/or an effort level ("low"..."max", "default"). */
  var model: String? = nil
  var effort: String? = nil
  /** replay.set: the replay recorder switch (Settings > Privacy and safety, the owner's click only). */
  var enabled: Bool? = nil

  static func hello(_ id: String) -> AppRequest {
    return AppRequest(id: id, type: "hello", version: APP_PROTOCOL_VERSION, confirms: true)
  }
  /** The owner's click in the Ask box: answers only the question with this exact id. */
  static func confirmAnswer(_ id: String, confirmId: String, approve: Bool) -> AppRequest {
    return AppRequest(id: id, type: "confirm.answer", confirmId: confirmId, approve: approve)
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
  static func settingsSet(_ id: String, values: [String: TalkValue]) -> AppRequest {
    return AppRequest(id: id, type: "settings.set", values: values)
  }
  static func modelSet(_ id: String, model: String?, effort: String?) -> AppRequest {
    return AppRequest(id: id, type: "model.set", model: model, effort: effort)
  }
  /** Settings > Privacy and safety (issue #48): the owner's switch and its Delete. Nothing else sends these. */
  static func replaySet(_ id: String, enabled: Bool) -> AppRequest {
    return AppRequest(id: id, type: "replay.set", enabled: enabled)
  }
  static func replayDelete(_ id: String) -> AppRequest { return AppRequest(id: id, type: "replay.delete") }
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
  /** `latency.get` (src/telemetry/cli.ts): the latency report of the last 7 days as text. */
  static func latencyGet(_ id: String) -> AppRequest { return AppRequest(id: id, type: "latency.get") }
  /** `personal.summary` (src/app/personal.ts), read-only. */
  static func personalSummary(_ id: String) -> AppRequest { return AppRequest(id: id, type: "personal.summary") }
  // Memory page (UI-PLAN v3.1 section 7a). Keep and Skip are only ever sent from the owner's click.
  static func memoryGraph(_ id: String) -> AppRequest { return AppRequest(id: id, type: "memory.graph") }
  static func memorySuggestions(_ id: String) -> AppRequest { return AppRequest(id: id, type: "memory.suggestions") }
  static func memoryPropose(_ id: String, text: String) -> AppRequest {
    return AppRequest(id: id, type: "memory.propose", text: text)
  }
  static func memoryKeep(_ id: String, propId: String, text: String?) -> AppRequest {
    return AppRequest(id: id, type: "memory.keep", text: text, propId: propId)
  }
  static func memorySkip(_ id: String, propId: String) -> AppRequest {
    return AppRequest(id: id, type: "memory.skip", propId: propId)
  }
  static func memoryUsage(_ id: String) -> AppRequest { return AppRequest(id: id, type: "memory.usage") }
}

/** A memory proposal waiting for Keep or Skip (src/memory/proposals.ts). Text is shown verbatim. */
struct MemoryProposal: Decodable, Identifiable, Equatable {
  let id: String
  let text: String
  /** "you" | "chat" | "email" | "canvas" | "web" */
  let origin: String
  /** Third-party text (email, Canvas, web). */
  let untrusted: Bool
  var createdAt: String = ""
}

/** One node of `memory.graph` (src/app/memory-graph.ts): a saved item ("m3") or a proposal ("p2", new). */
struct GraphNode: Decodable, Identifiable, Equatable {
  let id: String
  let text: String
  /** "people" | "school" | "places" | "habits" | "projects" | "other" */
  let kind: String
  let new: Bool
}

struct GraphLink: Decodable, Equatable {
  let a: String
  let b: String
}

/** The `personal` answer (src/app/personal.ts). The owner's own config and Stephen's fixed rules: shown verbatim. */
struct PersonalSummary: Decodable, Equatable {
  struct About: Decodable, Equatable {
    var name: String? = nil
    var school: String? = nil
    var work: String? = nil
    var notes: [String] = []
    var timeZone: String = ""
  }
  struct Routine: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let uses: String
    let say: String
    /** "ready" | "needs_setup" | "off" */
    let state: String
    var missing: [String]? = nil
  }
  struct Cell: Decodable, Equatable {
    /** "allowed" | "asks" | "never" */
    let level: String
    let rule: String
  }
  struct Row: Decodable, Equatable {
    let action: String
    let cells: [Cell]
  }
  struct Permissions: Decodable, Equatable {
    let columns: [String]
    let rows: [Row]
  }
  let about: About
  let routines: [Routine]
  let permissions: Permissions
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

/** The `usage` answer. context is nil when the listener doesn't know it (that bar is hidden). */
struct AppUsage: Equatable {
  var context: UsageBar?
  var memory: UsageBar?
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
  /** Set when the owner kept a proposal: where it came from. */
  var origin: String? = nil

  enum CodingKeys: String, CodingKey { case id, text, source, createdAt, updatedAt, origin }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
    source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
    createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
    updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? ""
    origin = (try? c.decodeIfPresent(String.self, forKey: .origin)) ?? nil
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
  /** chat.done: what Stephen did (src/app/steps.ts); absent from an older listener. */
  var steps: [ChatStep]? = nil
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
  // personal (the whole answer)
  var personal: PersonalSummary? = nil
  // Memory page: suggestions / graph
  var suggestions: [MemoryProposal]? = nil
  var nodes: [GraphNode]? = nil
  var links: [GraphLink]? = nil
  // state / heard pushes
  var state: String? = nil
  var text: String? = nil
  var source: String? = nil
  // confirm / confirm.end pushes
  var confirmId: String? = nil
  var title: String? = nil
  var body: String? = nil

  enum CodingKeys: String, CodingKey {
    case id, type, version, listening, model, entryId, reply, outcome, tools, ms, steps, message, entries, items, config,
      configPath, state, text, source, accounts, note, jobs, job, on, lines, ok, checks, problems, blocking, context, memory,
      confirmId, title, body, suggestions, nodes, links
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
    steps = try? c.decodeIfPresent([ChatStep].self, forKey: .steps)
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
    if type == "memory.usage" { memory = try? c.decodeIfPresent(UsageBar.self, forKey: .memory) }
    suggestions = try? c.decodeIfPresent([MemoryProposal].self, forKey: .suggestions)
    nodes = try? c.decodeIfPresent([GraphNode].self, forKey: .nodes)
    links = try? c.decodeIfPresent([GraphLink].self, forKey: .links)
    if type == "usage" {
      context = try? c.decodeIfPresent(UsageBar.self, forKey: .context)
      memory = try? c.decodeIfPresent(UsageBar.self, forKey: .memory)
    }
    if type == "personal" { personal = try? PersonalSummary(from: decoder) }
    state = try? c.decodeIfPresent(String.self, forKey: .state)
    text = try? c.decodeIfPresent(String.self, forKey: .text)
    source = try? c.decodeIfPresent(String.self, forKey: .source)
    confirmId = try? c.decodeIfPresent(String.self, forKey: .confirmId)
    title = try? c.decodeIfPresent(String.self, forKey: .title)
    body = try? c.decodeIfPresent(String.self, forKey: .body)
  }
}

/** One value of settings.set: an enum word or a switch. The listener refuses anything else. */
enum TalkValue: Encodable, Equatable {
  case word(String)
  case on(Bool)
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case let .word(s): try c.encode(s)
    case let .on(b): try c.encode(b)
    }
  }
}

/** settings.get config.talk (How Stephen talks): the saved values and the preview sentences (length, then tone). */
struct TalkSettings: Equatable {
  var length = "brief"
  var tone = "casual"
  var speak = true
  var explain = false
  var voice = "elevenlabs"
  var samples: [String: [String: String]] = [:]

  static var blank: TalkSettings { return TalkSettings() }
  private init() {}

  /** nil when the listener is older and sends no talk section. */
  init?(_ config: AppJSON?) {
    guard case .object(let c)? = config, case .object(let t)? = c["talk"] else { return nil }
    if case .string(let v)? = t["length"] { length = v }
    if case .string(let v)? = t["tone"] { tone = v }
    if case .bool(let v)? = t["speak"] { speak = v }
    if case .bool(let v)? = t["explain"] { explain = v }
    if case .string(let v)? = t["voice"] { voice = v }
    if case .object(let s)? = t["samples"] {
      for (l, row) in s { if case .object(let r) = row { samples[l] = r.compactMapValues { if case .string(let x) = $0 { return x } else { return nil } } } }
    }
  }

  /** The preview line: the listener's sample for this length and tone (computed here, no request). */
  var preview: String {
    let base = samples[length]?[tone] ?? "Bet, playing lofi beats."
    return explain ? base + " First I opened a tab, then I started it." : base
  }

  /** What differs from `old`, as a settings.set payload (empty when nothing changed). */
  func changes(from old: TalkSettings) -> [String: TalkValue] {
    var v: [String: TalkValue] = [:]
    if length != old.length { v["length"] = .word(length) }
    if tone != old.tone { v["tone"] = .word(tone) }
    if speak != old.speak { v["speak"] = .on(speak) }
    if explain != old.explain { v["explain"] = .on(explain) }
    if voice != old.voice { v["voice"] = .word(voice) }
    return v
  }
}

/** settings.get config → voice.aboutMe.name (the owner's own config), or "". */
func aboutMeName(_ config: AppJSON?) -> String {
  guard case .object(let c)? = config, case .object(let v)? = c["voice"], case .object(let a)? = v["aboutMe"],
    case .string(let n)? = a["name"]
  else { return "" }
  return n
}
