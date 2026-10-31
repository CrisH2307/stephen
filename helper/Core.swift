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
  case hello(version: String, inputMonitoring: Bool)
  case pttDown(at: Int64)
  case pttUp(at: Int64, heldMs: Int64)
  case esc(at: Int64)
  case audio(playing: Bool, at: Int64)
  case error(message: String)

  /** One JSON object followed by "\n". */
  var jsonLine: String {
    switch self {
    case let .hello(version, inputMonitoring):
      return "{\"type\":\"hello\",\"version\":\(jsonString(version)),\"inputMonitoring\":\(inputMonitoring)}\n"
    case let .pttDown(at):
      return "{\"type\":\"ptt_down\",\"at\":\(at)}\n"
    case let .pttUp(at, heldMs):
      return "{\"type\":\"ptt_up\",\"at\":\(at),\"heldMs\":\(heldMs)}\n"
    case let .esc(at):
      return "{\"type\":\"esc\",\"at\":\(at)}\n"
    case let .audio(playing, at):
      return "{\"type\":\"audio\",\"playing\":\(playing),\"at\":\(at)}\n"
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

  /** Menu-bar text glyph (recording is drawn red by the UI). */
  var glyph: String {
    switch self {
    case .idle: return "○"
    case .listening: return "●"
    case .recording: return "●"
    case .working: return "◐"
    case .speaking: return "🔈"
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
 */
final class PushToTalk {
  let maxHoldMs: Int64
  private(set) var isDown = false
  private(set) var latched = false
  private var downAtMono: Int64 = 0

  init(maxHoldMs: Int64 = PTT_MAX_HOLD_MS) { self.maxHoldMs = maxHoldMs }

  static func comboActive(_ m: Modifiers) -> Bool {
    return m.fn && m.option && !m.command && !m.control
  }

  func flagsChanged(_ m: Modifiers, at t: Stamp) -> [HelperEventOut] {
    if latched && !(m.fn && m.option) { latched = false }
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

  /** Esc key-downs (auto-repeats ignored). */
  func keyDown(keyCode: Int64, isRepeat: Bool, at t: Stamp) -> [HelperEventOut] {
    guard keyCode == KEYCODE_ESCAPE, !isRepeat else { return [] }
    return [.esc(at: t.wallMs)]
  }

  private func release(at t: Stamp, stillHeld: Bool) -> [HelperEventOut] {
    isDown = false
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

/**
 * One-client-at-a-time newline-JSON server on a Unix domain socket. A new connection replaces the current one
 * (the old socket is shut down). All writes go through one serial queue, so lines never interleave and the
 * per-client `hello` always precedes any event sent after the client became current.
 */
final class SocketServer {
  let path: String
  var log: (String) -> Void = { _ in }
  /** Called on the accept thread; its line is written to a new client before anything else. */
  var helloLine: () -> String = { "" }
  /** Called on the client's reader thread, in order. */
  var onCommand: (HelperCommandIn) -> Void = { _ in }
  /** A client became current (accept thread, after its hello was queued). */
  var onConnect: () -> Void = {}
  /** The current client went away without being replaced (reader thread). */
  var onDisconnect: () -> Void = {}

  private var listenFd: Int32 = -1
  private var socketInode: UInt64? = nil
  private let current = Locked<SocketClient?>(nil)
  private let stopped = Locked(false)
  private var nextId = 1
  private let writeQueue = DispatchQueue(label: "dev.stephen.helper.write")

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

  /** Close everything and remove the socket file (only if it is still ours). */
  func stop() {
    if stopped.with({ s -> Bool in let was = s; s = true; return was }) { return }
    if let c = current.with({ c -> SocketClient? in let old = c; c = nil; return old }) {
      shutdown(c.fd, Int32(SHUT_RDWR))
    }
    if listenFd >= 0 { close(listenFd) }
    if let ino = socketInode, inodeOf(path) == ino { unlink(path) }
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

    let c = SocketClient(fd: fd, id: nextId)
    nextId += 1
    let hello = helloLine()
    let old = current.with { cur -> SocketClient? in
      let old = cur
      write(hello, to: c)  // queued before c becomes current → always the first line
      cur = c
      if let o = old { shutdown(o.fd, Int32(SHUT_RDWR)) }  // its reader exits and closes it
      return old
    }
    if let o = old { log("client \(o.id) replaced by client \(c.id)") } else { log("client \(c.id) connected") }
    DispatchQueue.global().async { [self] in readLoop(c) }
    onConnect()
  }

  private func readLoop(_ c: SocketClient) {
    var framer = LineFramer(maxBytes: MAX_LINE_BYTES)
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
      HelperEventOut.hello(version: HELPER_PROTOCOL_VERSION, inputMonitoring: inputMonitoringFlag.get()).jsonLine
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
    server.send(.hello(version: HELPER_PROTOCOL_VERSION, inputMonitoring: granted))
  }

  func handleFlags(_ m: Modifiers, at t: Stamp = .now()) {
    emit(ptt.flagsChanged(m, at: t))
  }

  func handleKeyDown(keyCode: Int64, isRepeat: Bool, at t: Stamp = .now()) {
    emit(ptt.keyDown(keyCode: keyCode, isRepeat: isRepeat, at: t))
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
    }
  }
}
