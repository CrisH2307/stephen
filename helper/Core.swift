// Stephen Helper — platform-neutral core.
//
// No Apple frameworks here: only the C library (Darwin on macOS, Glibc on Linux) and Dispatch. This file holds the
// push-to-talk state machine, the newline-JSON framing and parsing, and the Unix-socket server, so it can be
// compiled and run on Linux (see test/helper/swift/) against the Node client. `main.swift` (macOS only) feeds it
// key and audio events from CGEventTap / CoreAudio and draws the menu-bar item.
//
// Wire contract: src/helper/protocol.ts (FROZEN). Keep this file in sync with it.

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Dispatch

let HELPER_PROTOCOL_VERSION = "1"
let HELPER_VERSION = "0.1.0"
/** Shorter presses are still sent; Node ignores them (protocol.ts PTT_MIN_HOLD_MS). */
let PTT_MIN_HOLD_MS: Int64 = 250
/** `ptt_up` is sent automatically after this long, even if the keys are still held. */
let PTT_MAX_HOLD_MS: Int64 = 30_000
/** Lines longer than this (bytes, without the newline) are dropped. */
let MAX_LINE_BYTES = 4096
/** macOS virtual key code for Escape (kVK_Escape). */
let KEYCODE_ESCAPE: Int64 = 53
/** macOS virtual key code for F5 (kVK_F5): hold it to talk, like Fn+Option. */
let KEYCODE_F5: Int64 = 96
/** The media keys `media_key` may post (src/helper/protocol.ts MEDIA_KEYS). */
let MEDIA_KEYS: Set<String> = ["play_pause", "next", "previous"]
/** The window's app.sock reconnect wait doubles up to this while Stephen stays unreachable (#202 C1). */
let APP_RETRY_MAX_SECONDS = 10.0

/** The next reconnect wait after `current` seconds: 3, 6, 10, 10, ... (AppClient.swift). */
func nextRetryDelay(_ current: Double) -> Double {
  return min(current * 2, APP_RETRY_MAX_SECONDS)
}

// ───────────────────────────── time ─────────────────────────────

/** Wall-clock milliseconds since the Unix epoch (the `at` field, comparable with Node's Date.now()). */
func wallClockMs() -> Int64 {
  var tv = timeval()
  gettimeofday(&tv, nil)
  return Int64(tv.tv_sec) * 1000 + Int64(tv.tv_usec) / 1000
}

/** Monotonic milliseconds (for durations such as `heldMs`). */
func monotonicMs() -> Int64 {
  return Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
}

struct Stamp {
  var wallMs: Int64
  var monoMs: Int64
  static func now() -> Stamp { return Stamp(wallMs: wallClockMs(), monoMs: monotonicMs()) }
}

// ───────────────────────────── events out (helper → node) ─────────────────────────────

enum HelperEventOut: Equatable {
  /** `postEvents`: Accessibility granted (needed to post media keys); nil = not reported. */
  case hello(version: String, inputMonitoring: Bool, postEvents: Bool? = nil)
  case pttDown(at: Int64)
  case pttUp(at: Int64, heldMs: Int64)
  case esc(at: Int64)
  case audio(playing: Bool, at: Int64)
  /** Answer to `media_key` (issue #205): ok, or why the key was not posted. */
  case mediaKeyDone(key: String, ok: Bool, message: String?)
  case error(message: String)

  /** One JSON object followed by "\n". */
  var jsonLine: String {
    switch self {
    case let .hello(version, inputMonitoring, postEvents):
      let post = postEvents.map { ",\"postEvents\":\($0)" } ?? ""
      return "{\"type\":\"hello\",\"version\":\(jsonString(version)),\"inputMonitoring\":\(inputMonitoring)\(post)}\n"
    case let .pttDown(at):
      return "{\"type\":\"ptt_down\",\"at\":\(at)}\n"
    case let .pttUp(at, heldMs):
      return "{\"type\":\"ptt_up\",\"at\":\(at),\"heldMs\":\(heldMs)}\n"
    case let .esc(at):
      return "{\"type\":\"esc\",\"at\":\(at)}\n"
    case let .audio(playing, at):
      return "{\"type\":\"audio\",\"playing\":\(playing),\"at\":\(at)}\n"
    case let .mediaKeyDone(key, ok, message):
      let why = message.map { ",\"message\":\(jsonString($0))" } ?? ""
      return "{\"type\":\"media_key_done\",\"key\":\(jsonString(key)),\"ok\":\(ok)\(why)}\n"
    case let .error(message):
      return "{\"type\":\"error\",\"message\":\(jsonString(message))}\n"
    }
  }
}

/** A JSON string literal (quotes included). Non-ASCII is kept as UTF-8; control characters are \u-escaped. */
func jsonString(_ s: String) -> String {
  var out = "\""
  for scalar in s.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if scalar.value < 0x20 || scalar.value == 0x7F || scalar.value == 0x2028 || scalar.value == 0x2029 {
        let hex = String(scalar.value, radix: 16)
        out += "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}

// ───────────────────────────── commands in (node → helper) ─────────────────────────────

enum UIState: String, CaseIterable {
  case idle, listening, recording, working, speaking

  /** Menu-bar SF Symbol: a different shape per state, so it reads without colour (#143). */
  var symbol: String {
    switch self {
    case .idle: return "circle"
    case .listening: return "ear"
    case .recording: return "mic.fill"
    case .working: return "hourglass"
    case .speaking: return "speaker.wave.2.fill"
    }
  }

  var label: String {
    switch self {
    case .idle: return "Idle"
    case .listening: return "Listening"
    case .recording: return "Recording"
    case .working: return "Working"
    case .speaking: return "Speaking"
    }
  }
}

enum HelperCommandIn: Equatable {
  case state(UIState)
  case queryAudio
  case quit
  /** Show the Stephen window (additive: older helpers log it as an unknown type and ignore it). */
  case openWindow
  /** The listener dropped the recording: end the press if one is down (additive, like openWindow). */
  case pressOver
  /** Post a Mac media key: play_pause, next or previous (issue #205; additive, like openWindow). */
  case mediaKey(String)
  /** Valid JSON object with an unknown `type` (ignored, per the protocol). */
  case unknown(type: String)
  /** Not a JSON object, no string `type`, or a known type with bad fields. */
  case invalid(reason: String)
}

func parseCommand(_ line: String) -> HelperCommandIn {
  guard case let .object(obj)? = parseJSON(line) else { return .invalid(reason: "not a JSON object") }
  guard case let .string(type)? = obj["type"] else { return .invalid(reason: "missing \"type\"") }
  switch type {
  case "state":
    guard case let .string(s)? = obj["state"], let st = UIState(rawValue: s) else {
      return .invalid(reason: "state: bad \"state\" field")
    }
    return .state(st)
  case "query_audio": return .queryAudio
  case "quit": return .quit
  case "open_window": return .openWindow
  case "press_over": return .pressOver
  case "media_key":
    guard case let .string(k)? = obj["key"], MEDIA_KEYS.contains(k) else {
      return .invalid(reason: "media_key: bad \"key\" field")
    }
    return .mediaKey(k)
  default: return .unknown(type: type)
  }
}

// ───────────────────────────── minimal JSON parser ─────────────────────────────

indirect enum JSONValue: Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([JSONValue])
  case object([String: JSONValue])
}

/** Parse one complete JSON value (RFC 8259, depth ≤ 32). nil on any error or trailing garbage. */
func parseJSON(_ text: String) -> JSONValue? {
  var p = JSONParser(bytes: Array(text.utf8))
  guard let v = p.value(depth: 0) else { return nil }
  p.skipWS()
  return p.i == p.b.count ? v : nil
}

struct JSONParser {
  let b: [UInt8]
  var i = 0

  init(bytes: [UInt8]) { b = bytes }

  mutating func skipWS() {
    while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0A || b[i] == 0x0D { i += 1 }
  }

  mutating func value(depth: Int) -> JSONValue? {
    if depth > 32 { return nil }
    skipWS()
    guard i < b.count else { return nil }
    switch b[i] {
    case UInt8(ascii: "{"): return object(depth: depth)
    case UInt8(ascii: "["): return array(depth: depth)
    case UInt8(ascii: "\""): return string().map { .string($0) }
    case UInt8(ascii: "t"): return literal("true", .bool(true))
    case UInt8(ascii: "f"): return literal("false", .bool(false))
    case UInt8(ascii: "n"): return literal("null", .null)
    default: return number()
    }
  }

  mutating func literal(_ word: String, _ v: JSONValue) -> JSONValue? {
    let w = Array(word.utf8)
    guard i + w.count <= b.count, Array(b[i..<(i + w.count)]) == w else { return nil }
    i += w.count
    return v
  }

  mutating func number() -> JSONValue? {
    let start = i
    while i < b.count {
      let c = b[i]
      if (c >= 0x30 && c <= 0x39) || c == UInt8(ascii: "-") || c == UInt8(ascii: "+") || c == UInt8(ascii: ".")
        || c == UInt8(ascii: "e") || c == UInt8(ascii: "E")
      {
        i += 1
      } else {
        break
      }
    }
    guard i > start, let d = Double(String(decoding: b[start..<i], as: UTF8.self)) else { return nil }
    return .number(d)
  }

  mutating func hex4() -> UInt32? {
    guard i + 4 <= b.count else { return nil }
    var v: UInt32 = 0
    for _ in 0..<4 {
      let c = b[i]
      var d: UInt32
      switch c {
      case 0x30...0x39: d = UInt32(c - 0x30)
      case 0x41...0x46: d = UInt32(c - 0x41 + 10)
      case 0x61...0x66: d = UInt32(c - 0x61 + 10)
      default: return nil
      }
      v = v * 16 + d
      i += 1
    }
    return v
  }

  mutating func string() -> String? {
    i += 1  // opening quote
    var out: [UInt8] = []
    while i < b.count {
      let c = b[i]
      if c == UInt8(ascii: "\"") {
        i += 1
        return String(decoding: out, as: UTF8.self)
      }
      if c < 0x20 { return nil }
      if c != UInt8(ascii: "\\") {
        out.append(c)
        i += 1
        continue
      }
      i += 1
      guard i < b.count else { return nil }
      let e = b[i]
      i += 1
      switch e {
      case UInt8(ascii: "\""): out.append(0x22)
      case UInt8(ascii: "\\"): out.append(0x5C)
      case UInt8(ascii: "/"): out.append(0x2F)
      case UInt8(ascii: "b"): out.append(0x08)
      case UInt8(ascii: "f"): out.append(0x0C)
      case UInt8(ascii: "n"): out.append(0x0A)
      case UInt8(ascii: "r"): out.append(0x0D)
      case UInt8(ascii: "t"): out.append(0x09)
      case UInt8(ascii: "u"):
        guard var code = hex4() else { return nil }
        if code >= 0xD800 && code < 0xDC00 {
          // High surrogate: must be followed by \uDC00–\uDFFF.
          guard i + 2 <= b.count, b[i] == UInt8(ascii: "\\"), b[i + 1] == UInt8(ascii: "u") else { return nil }
          i += 2
          guard let low = hex4(), low >= 0xDC00 && low < 0xE000 else { return nil }
          code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
        } else if code >= 0xDC00 && code < 0xE000 {
          return nil
        }
        guard let scalar = Unicode.Scalar(code) else { return nil }
        out.append(contentsOf: Array(String(Character(scalar)).utf8))
      default:
        return nil
      }
    }
    return nil
  }

  mutating func array(depth: Int) -> JSONValue? {
    i += 1
    var items: [JSONValue] = []
    skipWS()
    if i < b.count, b[i] == UInt8(ascii: "]") {
      i += 1
      return .array(items)
    }
    while true {
      guard let v = value(depth: depth + 1) else { return nil }
      items.append(v)
      skipWS()
      guard i < b.count else { return nil }
      if b[i] == UInt8(ascii: ",") {
        i += 1
        continue
      }
      if b[i] == UInt8(ascii: "]") {
        i += 1
        return .array(items)
      }
      return nil
    }
  }

  mutating func object(depth: Int) -> JSONValue? {
    i += 1
    var obj: [String: JSONValue] = [:]
    skipWS()
    if i < b.count, b[i] == UInt8(ascii: "}") {
      i += 1
      return .object(obj)
    }
    while true {
      skipWS()
      guard i < b.count, b[i] == UInt8(ascii: "\""), let key = string() else { return nil }
      skipWS()
      guard i < b.count, b[i] == UInt8(ascii: ":") else { return nil }
      i += 1
      guard let v = value(depth: depth + 1) else { return nil }
      obj[key] = v
      skipWS()
      guard i < b.count else { return nil }
      if b[i] == UInt8(ascii: ",") {
        i += 1
        continue
      }
      if b[i] == UInt8(ascii: "}") {
        i += 1
        return .object(obj)
      }
      return nil
    }
  }
}

// ───────────────────────────── line framing ─────────────────────────────

/**
 * Splits a byte stream into newline-terminated lines. A line longer than `maxBytes` is dropped entirely (up to
 * its newline) and counted in `dropped`. "\r\n" is accepted; empty lines are skipped.
 */
struct LineFramer {
  let maxBytes: Int
  private(set) var dropped = 0
  private var buf: [UInt8] = []
  private var discarding = false

  init(maxBytes: Int = MAX_LINE_BYTES) { self.maxBytes = maxBytes }

  mutating func push<S: Sequence>(_ bytes: S) -> [String] where S.Element == UInt8 {
    var lines: [String] = []
    for c in bytes {
      if c == 0x0A {
        if discarding {
          discarding = false
        } else {
          if buf.last == 0x0D { buf.removeLast() }
          if !buf.isEmpty { lines.append(String(decoding: buf, as: UTF8.self)) }
        }
        buf.removeAll(keepingCapacity: true)
        continue
      }
      if discarding { continue }
      buf.append(c)
      if buf.count > maxBytes {
        discarding = true
        dropped += 1
        buf.removeAll(keepingCapacity: true)
      }
    }
    return lines
  }
}

// ───────────────────────────── push-to-talk ─────────────────────────────

struct Modifiers: Equatable {
  var fn = false
  var option = false
  var command = false
  var control = false
  var shift = false
}

/**
 * Fn+Option push-to-talk.
 *  - `ptt_down` when Fn and Option are both held and neither Command nor Control is (so Fn+Option+Cmd/Ctrl
 *    shortcuts never start a recording). Shift is allowed.
 *  - `ptt_up` as soon as that stops being true (Fn or Option released, or Cmd/Ctrl added), carrying `heldMs`.
 *  - After any `ptt_up`, Fn or Option must be released before the next `ptt_down` (so letting go of Cmd, or the
 *    max-hold cut-off, never starts a second recording by itself).
 *  - Short taps are still reported; Node drops presses under PTT_MIN_HOLD_MS.
 *  - `tick` sends `ptt_up` once the press reaches `maxHoldMs`.
 *  - `interrupt` (event tap disabled: key-ups may have been missed) sends `ptt_up` if down and latches.
 *  - `pressOver` (the listener cancelled the recording) ends a press like Esc does, without the `esc` (#106).
 */
final class PushToTalk {
  let maxHoldMs: Int64
  private(set) var isDown = false
  /** The current press came from holding F5 (only an F5 key-up ends it, not modifier changes). */
  private(set) var byF5 = false
  private(set) var latched = false
  private var downAtMono: Int64 = 0

  init(maxHoldMs: Int64 = PTT_MAX_HOLD_MS) { self.maxHoldMs = maxHoldMs }

  static func comboActive(_ m: Modifiers) -> Bool {
    return m.fn && m.option && !m.command && !m.control
  }

  func flagsChanged(_ m: Modifiers, at t: Stamp) -> [HelperEventOut] {
    if latched && !(m.fn && m.option) { latched = false }
    if isDown && byF5 { return [] }
    let active = PushToTalk.comboActive(m)
    if !isDown {
      if active && !latched {
        isDown = true
        downAtMono = t.monoMs
        return [.pttDown(at: t.wallMs)]
      }
      return []
    }
    if !active {
      return release(at: t, stillHeld: m.fn && m.option)
    }
    return []
  }

  func tick(at t: Stamp) -> [HelperEventOut] {
    guard isDown, t.monoMs - downAtMono >= maxHoldMs else { return [] }
    return release(at: t, stillHeld: true)
  }

  func interrupt(at t: Stamp) -> [HelperEventOut] {
    guard isDown else { return [] }
    return release(at: t, stillHeld: true)
  }

  /** The listener dropped this recording: end the press (a held Fn+Option must be let go first, like after Esc). */
  func pressOver(at t: Stamp) -> [HelperEventOut] {
    guard isDown else { return [] }
    return release(at: t, stillHeld: !byF5)
  }

  /**
   * Esc key-downs → esc; an F5 key-down starts a press (auto-repeats ignored for both). Esc during a press also ends
   * the press (after the esc, so Node cancels instead of sending): the listener has dropped that recording, so the
   * next F5 must start a new one, not be swallowed by a press nobody is holding (#86).
   */
  func keyDown(keyCode: Int64, isRepeat: Bool, at t: Stamp) -> [HelperEventOut] {
    guard !isRepeat else { return [] }
    if keyCode == KEYCODE_F5 {
      guard !isDown else { return [] }
      isDown = true
      byF5 = true
      downAtMono = t.monoMs
      return [.pttDown(at: t.wallMs)]
    }
    guard keyCode == KEYCODE_ESCAPE else { return [] }
    return [.esc(at: t.wallMs)] + (isDown ? release(at: t, stillHeld: !byF5) : [])
  }

  /** F5 released → ends an F5 press. Other key-ups are ignored. */
  func keyUp(keyCode: Int64, at t: Stamp) -> [HelperEventOut] {
    guard keyCode == KEYCODE_F5, isDown, byF5 else { return [] }
    return release(at: t, stillHeld: false)
  }

  private func release(at t: Stamp, stillHeld: Bool) -> [HelperEventOut] {
    isDown = false
    byF5 = false
    latched = stillHeld
    return [.pttUp(at: t.wallMs, heldMs: max(0, t.monoMs - downAtMono))]
  }
}

/** Remembers the last reported `audio.playing` so only changes are pushed. */
struct AudioTracker {
  private(set) var last: Bool? = nil
  /** true when `playing` differs from the last reported value (the first value always counts as a change). */
  mutating func update(_ playing: Bool) -> Bool {
    if last == playing { return false }
    last = playing
    return true
  }
}

// ───────────────────────────── small lock ─────────────────────────────

final class Locked<T> {
  private var value: T
  private let q = DispatchQueue(label: "dev.stephen.helper.lock")
  init(_ v: T) { value = v }
  func get() -> T { return q.sync { value } }
  func set(_ v: T) { q.sync { value = v } }
  func with<R>(_ body: (inout T) -> R) -> R { return q.sync { body(&value) } }
}

// ───────────────────────────── Unix socket server ─────────────────────────────

struct HelperFailure: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}

private func errnoText() -> String {
  return String(cString: strerror(errno))
}

#if canImport(Darwin)
private let SOCK_STREAM_VALUE = SOCK_STREAM
#else
private let SOCK_STREAM_VALUE = Int32(SOCK_STREAM.rawValue)
#endif

/** Fill a sockaddr_un for `path`; nil if the path does not fit (macOS: 103 bytes). */
private func makeUnixAddress(_ path: String) -> sockaddr_un? {
  var addr = sockaddr_un()
  #if canImport(Darwin)
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  #endif
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  let capacity = MemoryLayout.size(ofValue: addr.sun_path)
  guard !bytes.isEmpty, bytes.count < capacity else { return nil }
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    for (k, c) in bytes.enumerated() { raw[k] = c }
    raw[bytes.count] = 0
  }
  return addr
}

private func withSockaddr<R>(_ addr: inout sockaddr_un, _ body: (UnsafePointer<sockaddr>, socklen_t) -> R) -> R {
  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  return withUnsafePointer(to: &addr) { p in
    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, len) }
  }
}

private func isSocketFile(_ path: String) -> Bool? {
  var st = stat()
  if lstat(path, &st) != 0 { return nil }
  return (st.st_mode & 0o170000) == 0o140000
}

private func inodeOf(_ path: String) -> UInt64? {
  var st = stat()
  if lstat(path, &st) != 0 { return nil }
  return UInt64(st.st_ino)
}

/** mkdir -p with `mode` on every directory it creates; the last component is chmod-ed to `mode` too. */
func makePrivateDir(_ path: String, mode: mode_t = 0o700) throws {
  var prefix = path.hasPrefix("/") ? "" : "."
  for part in path.split(separator: "/") {
    prefix += "/" + part
    if mkdir(prefix, mode) != 0 && errno != EEXIST {
      throw HelperFailure("mkdir \(prefix): \(errnoText())")
    }
  }
  // lstat, not stat: a link in place of the folder must never get its target's permissions changed (#392 review).
  var st = stat()
  guard lstat(path, &st) == 0 else { throw HelperFailure("lstat \(path): \(errnoText())") }
  guard (st.st_mode & S_IFMT) == S_IFDIR else { throw HelperFailure("\(path) is a link or not a folder; not using it") }
  guard st.st_uid == getuid() else { throw HelperFailure("\(path) belongs to another user; not using it") }
  if chmod(path, mode) != 0 { throw HelperFailure("chmod \(path): \(errnoText())") }
}

final class SocketClient {
  let fd: Int32
  let id: Int
  /** Only touched on the server's write queue. */
  fileprivate var closed = false
  init(fd: Int32, id: Int) {
    self.fd = fd
    self.id = id
  }
}

/** Equal strings, in time that does not depend on where they differ. */
func sameSecret(_ a: String, _ b: String) -> Bool {
  let x = Array(a.utf8), y = Array(b.utf8)
  guard x.count == y.count else { return false }
  var d: UInt8 = 0
  for i in 0..<x.count { d |= x[i] ^ y[i] }
  return d == 0
}

/**
 * One-client-at-a-time newline-JSON server on a Unix domain socket. A new connection replaces the current one
 * (the old socket is shut down). All writes go through one serial queue, so lines never interleave and the
 * per-client `hello` always precedes any event sent after the client became current.
 */
final class SocketServer {
  let path: String
  var log: (String) -> Void = { _ in }
  /** Called once a client has authenticated (on its own thread); its line is written to it before anything else. */
  var helloLine: () -> String = { "" }
  /** Called on the client's reader thread, in order. */
  var onCommand: (HelperCommandIn) -> Void = { _ in }
  /** A client became current (after its hello was queued). */
  var onConnect: () -> Void = {}
  /** The current client went away without being replaced (reader thread). */
  var onDisconnect: () -> Void = {}

  private var listenFd: Int32 = -1
  private var socketInode: UInt64? = nil
  private let current = Locked<SocketClient?>(nil)
  private let stopped = Locked(false)
  private var nextId = 1
  private let writeQueue = DispatchQueue(label: "dev.stephen.helper.write")
  /**
   * F15 / C6: a fresh secret per launch. A client must send `{"type":"auth","nonce":"…"}` as its first line, or it is
   * dropped before it sees hello or replaces the current client. The nonce is in `<run>/helper.nonce` (0600, this
   * user only). It does not stop a process of the same user (out of scope, product plan Q10); the uid check below
   * stops other users.
   */
  let nonce: String = {
    var g = SystemRandomNumberGenerator()
    return (0..<4).map { _ in let v = g.next() as UInt64; return String(repeating: "0", count: 16 - String(v, radix: 16).count) + String(v, radix: 16) }.joined()
  }()
  var noncePath: String {
    guard let slash = path.lastIndex(of: "/") else { return "helper.nonce" }
    return String(path[path.startIndex..<slash]) + "/helper.nonce"
  }

  init(path: String) { self.path = path }

  var hasClient: Bool { return current.get() != nil }

  func start() throws {
    signal(SIGPIPE, SIG_IGN)
    let lastSlash = path.lastIndex(of: "/")
    if let slash = lastSlash, slash != path.startIndex {
      try makePrivateDir(String(path[path.startIndex..<slash]))
    }
    guard var addr = makeUnixAddress(path) else {
      throw HelperFailure("socket path too long for a Unix socket (\(path.utf8.count) bytes): \(path)")
    }

    // Another live helper on this path? Then do not steal its socket.
    if let isSock = isSocketFile(path) {
      guard isSock else { throw HelperFailure("\(path) exists and is not a socket; not removing it") }
      let probe = socket(AF_UNIX, SOCK_STREAM_VALUE, 0)
      if probe >= 0 {
        let rc = withSockaddr(&addr) { connect(probe, $0, $1) }
        close(probe)
        if rc == 0 { throw HelperFailure("another Stephen Helper is already listening on \(path)") }
      }
      unlink(path)  // stale socket from a helper that did not exit cleanly
    }

    try writeNonceFile()

    let fd = socket(AF_UNIX, SOCK_STREAM_VALUE, 0)
    guard fd >= 0 else { throw HelperFailure("socket(): \(errnoText())") }
    let oldMask = umask(0o177)  // the socket file is created 0600
    let rc = withSockaddr(&addr) { bind(fd, $0, $1) }
    umask(oldMask)
    guard rc == 0 else {
      let e = errnoText()
      close(fd)
      throw HelperFailure("bind \(path): \(e)")
    }
    chmod(path, 0o600)
    guard listen(fd, 4) == 0 else {
      let e = errnoText()
      close(fd)
      unlink(path)
      throw HelperFailure("listen: \(e)")
    }
    listenFd = fd
    socketInode = inodeOf(path)
    log("listening on \(path)")
    DispatchQueue.global().async { [self] in acceptLoop() }
  }

  /** `{"nonce":"…"}` into a fresh 0600 temp file (O_EXCL, O_NOFOLLOW), then renamed over helper.nonce. */
  private func writeNonceFile() throws {
    let tmp = noncePath + ".\(getpid()).tmp"
    unlink(tmp)
    let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw HelperFailure("open \(tmp): \(errnoText())") }
    let bytes = Array("{\"nonce\":\"\(nonce)\"}\n".utf8)
    let n = bytes.withUnsafeBytes { raw in Glue.write(fd, raw.baseAddress!, bytes.count) }
    fchmod(fd, 0o600)
    fsync(fd)
    close(fd)
    guard n == bytes.count, rename(tmp, noncePath) == 0 else {
      unlink(tmp)
      throw HelperFailure("could not write \(noncePath): \(errnoText())")
    }
  }

  /** Close everything and remove the socket file (only if it is still ours). */
  func stop() {
    if stopped.with({ s -> Bool in let was = s; s = true; return was }) { return }
    if let c = current.with({ c -> SocketClient? in let old = c; c = nil; return old }) {
      shutdown(c.fd, Int32(SHUT_RDWR))
    }
    if listenFd >= 0 { close(listenFd) }
    if let ino = socketInode, inodeOf(path) == ino { unlink(path) }
    unlink(noncePath)
  }

  /** Send one line to the current client (dropped if none). */
  func send(_ line: String) {
    guard let c = current.get() else { return }
    write(line, to: c)
  }

  func send(_ event: HelperEventOut) { send(event.jsonLine) }

  private func write(_ line: String, to c: SocketClient) {
    let bytes = Array(line.utf8)
    writeQueue.async { [self] in
      if c.closed { return }
      var off = 0
      while off < bytes.count {
        let n = bytes.withUnsafeBytes { raw in Glue.write(c.fd, raw.baseAddress! + off, bytes.count - off) }
        if n > 0 {
          off += n
        } else if n < 0 && errno == EINTR {
          continue
        } else {
          log("client \(c.id): write failed (\(errnoText())); dropping it")
          shutdown(c.fd, Int32(SHUT_RDWR))
          return
        }
      }
    }
  }

  private func acceptLoop() {
    while true {
      let fd = accept(listenFd, nil, nil)
      if stopped.get() {
        if fd >= 0 { close(fd) }
        return
      }
      if fd < 0 {
        if errno == EINTR || errno == ECONNABORTED { continue }
        log("accept failed: \(errnoText())")
        usleep(200_000)
        continue
      }
      handleAccepted(fd)
    }
  }

  private func handleAccepted(_ fd: Int32) {
    #if canImport(Darwin)
    var uid: uid_t = 0
    var gid: gid_t = 0
    if getpeereid(fd, &uid, &gid) != 0 || uid != getuid() {
      log("rejected a connection from another user (uid \(uid))")
      close(fd)
      return
    }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    #endif
    // A client that stops reading must not block the helper forever.
    var tv = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    let id = nextId
    nextId += 1
    // The auth line is read off the accept thread, so a silent client cannot hold up the next one.
    DispatchQueue.global().async { [self] in
      guard let rest = readAuth(fd) else {
        log("client \(id): rejected (no valid auth line within 2 s)")
        close(fd)
        return
      }
      adopt(SocketClient(fd: fd, id: id), rest: rest)
    }
  }

  /**
   * Read the first line (at most 200 bytes, 2 s) and check it is `{"type":"auth","nonce":"<ours>"}`. Returns the bytes
   * after that line (to hand to the reader), or nil to drop the client.
   */
  private func readAuth(_ fd: Int32) -> [UInt8]? {
    var tv = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var got: [UInt8] = []
    var buf = [UInt8](repeating: 0, count: 256)
    while got.firstIndex(of: 10) == nil {
      if got.count > 200 { return nil }
      let n = buf.withUnsafeMutableBytes { raw in Glue.read(fd, raw.baseAddress!, raw.count) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { return nil }
      got += buf[0..<n]
    }
    var off = timeval(tv_sec: 0, tv_usec: 0)  // back to blocking reads for the reader loop
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &off, socklen_t(MemoryLayout<timeval>.size))
    let nl = got.firstIndex(of: 10)!
    guard nl <= 200, case let .object(obj)? = parseJSON(String(decoding: got[0..<nl], as: UTF8.self)),
      obj["type"] == JSONValue.string("auth"),
      case let .string(sent)? = obj["nonce"], sameSecret(sent, nonce)
    else { return nil }
    return Array(got[(nl + 1)...])
  }

  private func adopt(_ c: SocketClient, rest: [UInt8]) {
    let hello = helloLine()
    let old = current.with { cur -> SocketClient? in
      let old = cur
      write(hello, to: c)  // queued before c becomes current → always the first line
      cur = c
      if let o = old { shutdown(o.fd, Int32(SHUT_RDWR)) }  // its reader exits and closes it
      return old
    }
    if let o = old { log("client \(o.id) replaced by client \(c.id)") } else { log("client \(c.id) connected") }
    DispatchQueue.global().async { [self] in readLoop(c, rest: rest) }
    onConnect()
  }

  private func readLoop(_ c: SocketClient, rest: [UInt8]) {
    var framer = LineFramer(maxBytes: MAX_LINE_BYTES)
    for line in framer.push(rest[...]) { onCommand(parseCommand(line)) }
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
      let n = buf.withUnsafeMutableBytes { raw in Glue.read(c.fd, raw.baseAddress!, raw.count) }
      if n > 0 {
        let before = framer.dropped
        for line in framer.push(buf[0..<n]) { onCommand(parseCommand(line)) }
        if framer.dropped > before { log("client \(c.id): dropped an over-long line") }
        continue
      }
      if n < 0 && errno == EINTR { continue }
      break
    }
    let wasCurrent = current.with { cur -> Bool in
      if cur === c {
        cur = nil
        return true
      }
      return false
    }
    writeQueue.async {
      if !c.closed {
        c.closed = true
        close(c.fd)
      }
    }
    log("client \(c.id) disconnected")
    if wasCurrent && !stopped.get() { onDisconnect() }
  }
}

/** `read`/`write` without clashing with SocketServer's own `write(_:to:)`. */
private enum Glue {
  static func read(_ fd: Int32, _ p: UnsafeMutableRawPointer, _ n: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.read(fd, p, n)
    #else
    return Glibc.read(fd, p, n)
    #endif
  }
  static func write(_ fd: Int32, _ p: UnsafeRawPointer, _ n: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.write(fd, p, n)
    #else
    return Glibc.write(fd, p, n)
    #endif
  }
}

// ───────────────────────────── the helper, minus the OS ─────────────────────────────

/**
 * Wires the socket, push-to-talk, audio and UI state together. Every `handle*` method must be called on the main
 * queue; commands from the socket are hopped onto the main queue here. The platform layer (main.swift, or the
 * Linux test harness) supplies the hooks and feeds OS events in.
 */
final class HelperCore {
  let server: SocketServer
  let ptt: PushToTalk
  private var audio = AudioTracker()
  private let inputMonitoringFlag = Locked(false)

  /** Reads whether the default output device is playing now (nil = unknown). Main queue. */
  var readAudio: () -> Bool? = { nil }
  var onUIState: (UIState) -> Void = { _ in }
  var onQuit: () -> Void = {}
  /** `open_window` from the client (main queue). */
  var onOpenWindow: () -> Void = {}
  /** A push-to-talk press ended, however it ended (F5 or keys released, Esc, max hold, tap lost). Main queue. */
  var onPressEnded: () -> Void = {}
  /** Post a media key (main queue): nil when posted, else why not. The answer goes back as `media_key_done`. */
  var onMediaKey: (String) -> String? = { _ in "media keys are not supported here" }
  /** Whether posting keys is allowed (Accessibility), for `hello`; nil = not reported. Any thread. */
  var readPostEvents: () -> Bool? = { nil }
  var log: (String) -> Void

  init(socketPath: String, maxHoldMs: Int64 = PTT_MAX_HOLD_MS, log: @escaping (String) -> Void) {
    server = SocketServer(path: socketPath)
    ptt = PushToTalk(maxHoldMs: maxHoldMs)
    self.log = log
  }

  func start(inputMonitoring: Bool) throws {
    inputMonitoringFlag.set(inputMonitoring)
    server.log = log
    server.helloLine = { [unowned self] in
      HelperEventOut.hello(
        version: HELPER_PROTOCOL_VERSION, inputMonitoring: inputMonitoringFlag.get(), postEvents: readPostEvents()
      ).jsonLine
    }
    server.onCommand = { [unowned self] cmd in DispatchQueue.main.async { self.handle(cmd) } }
    server.onConnect = { [unowned self] in DispatchQueue.main.async { self.sendAudio(force: true) } }
    server.onDisconnect = { [unowned self] in DispatchQueue.main.async { self.onUIState(.idle) } }
    try server.start()
  }

  func stop() { server.stop() }

  /** Input Monitoring changed (e.g. granted while running): a fresh `hello` tells the client. */
  func setInputMonitoring(_ granted: Bool) {
    if inputMonitoringFlag.get() == granted { return }
    inputMonitoringFlag.set(granted)
    log("Input Monitoring \(granted ? "granted" : "not granted")")
    server.send(.hello(version: HELPER_PROTOCOL_VERSION, inputMonitoring: granted, postEvents: readPostEvents()))
  }

  func handleFlags(_ m: Modifiers, at t: Stamp = .now()) {
    emit(ptt.flagsChanged(m, at: t))
  }

  func handleKeyDown(keyCode: Int64, isRepeat: Bool, at t: Stamp = .now()) {
    emit(ptt.keyDown(keyCode: keyCode, isRepeat: isRepeat, at: t))
  }

  func handleKeyUp(keyCode: Int64, at t: Stamp = .now()) {
    emit(ptt.keyUp(keyCode: keyCode, at: t))
  }

  /** The event tap was disabled (timeout/user input) — key-ups may have been lost. */
  func handleTapInterrupted(at t: Stamp = .now()) {
    emit(ptt.interrupt(at: t))
  }

  func handleAudio(playing: Bool) {
    if audio.update(playing) { server.send(.audio(playing: playing, at: wallClockMs())) }
  }

  func tick(at t: Stamp = .now()) {
    emit(ptt.tick(at: t))
  }

  func handle(_ cmd: HelperCommandIn) {
    switch cmd {
    case let .state(s): onUIState(s)
    case .queryAudio: sendAudio(force: true)
    case .quit:
      log("quit requested by client")
      onQuit()
    case .openWindow:
      log("open_window requested by client")
      onOpenWindow()
    case .pressOver:
      emit(ptt.pressOver(at: .now()))
    case let .mediaKey(k):
      let why = onMediaKey(k)
      log("media_key \(k): \(why ?? "posted")")
      server.send(.mediaKeyDone(key: k, ok: why == nil, message: why))
    case let .unknown(type): log("ignored unknown command type \(jsonString(type))")
    case let .invalid(reason): log("ignored malformed command: \(reason)")
    }
  }

  private func sendAudio(force: Bool) {
    guard let playing = readAudio() else {
      if force { server.send(.error(message: "audio state unavailable")) }
      return
    }
    _ = audio.update(playing)
    server.send(.audio(playing: playing, at: wallClockMs()))
  }

  private func emit(_ events: [HelperEventOut]) {
    for e in events {
      server.send(e)
      if case .pttDown = e {
        let ms = Int(ptt.maxHoldMs) + 5  // + slack so the tick never lands a millisecond early
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in self?.tick() }
      }
      if case .pttUp = e { onPressEnded() }
    }
  }
}
