// Stephen Helper: control of the listener, phone link, Zen and doctor (ROADMAP P2): StephenControl.
//
// Split out of AppClient.swift (no behaviour change). Threading notes: see AppClient.swift.

import Combine
import Darwin
import Foundation

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

/** Plain text for a `latency` answer, like `stephen latency` prints it. An older listener answers with an error. */
func latencyText(_ msg: AppMessage) -> String {
  guard msg.type == "latency" else { return msg.message ?? "error" }
  return msg.text ?? ""
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
  /** The poll ends early once this is true (the state settled). */
  private var pollDone: (ListenerStatus) -> Bool = { _ in false }
  /** Called after Start launched the listener (main.swift: the window connection retries soon again). */
  var onStart: (() -> Void)? = nil

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

  /** Refresh every second (after start / stop) until `done` says the state settled, at most `seconds` times. */
  private func poll(seconds: Int, until done: @escaping (ListenerStatus) -> Bool) {
    let running = pollsLeft > 0
    pollsLeft = seconds
    pollDone = done
    if running { return }
    func tick() {
      refresh()
      pollsLeft = pollDone(listener) ? 0 : pollsLeft - 1
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
    poll(seconds: 60) { $0 != .starting }
    onStart?()
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
    poll(seconds: 12) { $0 == .stopped }
    done(nil)
  }

  // MARK: control requests (need a running listener)

  func phoneOn(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .phoneOn("c-phone-on"), done) }
  func phoneOff(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .phoneOff("c-phone-off"), done) }
  /** On when the phone marker (<home>/phone/.on, src/phone/setup.ts) names a live process: true however it was turned
   *  on. The menu bar item and Settings > Connected read it. */
  func phoneLinkOn() -> Bool {
    guard let data = FileManager.default.contents(atPath: home + "/phone/.on"),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let pid = json["pid"] as? Int, pid > 0
    else { return false }
    return kill(pid_t(pid), 0) == 0
  }
  func openZen(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .zenOpen("c-zen"), done) }
  func runDoctor(_ done: @escaping (AppMessage) -> Void) { appRequestOnce(appSocketPath, .doctorRun("c-doctor"), done) }

  /**
   * F9 onboarding: where Claude Code stands, from `stephen setup --status` (fixed argv from the launch info, no shell).
   * `done` gets one of SETUP_CLAUDE_WORDS, or "unknown": never the command's own output, which the sheet does not show.
   */
  func setupStatus(_ done: @escaping (String, String) -> Void) {
    guard let info = readLaunchInfo() else { return done("no_launch_info", "unknown") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: info.node)
    p.arguments = [info.cli, "setup", "--status"]
    var env = ProcessInfo.processInfo.environment
    if !info.path.isEmpty { env["PATH"] = info.path }
    env["STEPHEN_HOME"] = home
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    p.standardInput = FileHandle.nullDevice
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    p.terminationHandler = { _ in
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      DispatchQueue.main.async { done(setupClaudeWord(data), setupModelsWord(data)) }
    }
    do { try p.run() } catch { done("unknown", "unknown") }
  }

  /**
   * F9b: `stephen voice-setup --json-progress`, streamed. Each line becomes a ModelProgress (code words and numbers
   * only; any other line is dropped). `done(true)` when it finished, `done(false)` when it failed or could not start.
   */
  func voiceSetup(progress: @escaping (ModelProgress) -> Void, done: @escaping (Bool) -> Void) {
    guard let info = readLaunchInfo() else { return done(false) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: info.node)
    p.arguments = [info.cli, "voice-setup", "--json-progress"]
    var env = ProcessInfo.processInfo.environment
    if !info.path.isEmpty { env["PATH"] = info.path }
    env["STEPHEN_HOME"] = home
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    p.standardInput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    let pipe = Pipe()
    p.standardOutput = pipe
    var pending = Data()
    pipe.fileHandleForReading.readabilityHandler = { h in
      let chunk = h.availableData
      if chunk.isEmpty { h.readabilityHandler = nil; return }
      pending.append(chunk)
      while let nl = pending.firstIndex(of: 10) {
        let line = pending[pending.startIndex..<nl]
        pending = Data(pending[(nl + 1)...])
        if let ev = parseModelProgress(Data(line)) { DispatchQueue.main.async { progress(ev) } }
      }
      if pending.count > 4096 { pending.removeAll() }  // no line is this long: drop it
    }
    p.terminationHandler = { proc in
      DispatchQueue.main.async { done(proc.terminationStatus == 0) }
    }
    do { try p.run() } catch { done(false) }
  }
  /** Settings > Speed: the latency report (ids and numbers only); quick, so a short timeout. */
  func latency(_ done: @escaping (AppMessage) -> Void) {
    appRequestOnce(appSocketPath, .latencyGet("c-latency"), timeout: APP_REQUEST_TIMEOUT_SECONDS, done)
  }
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


/** The code words `stephen setup --status` may give for Claude Code (src/setup.ts SetupStatus). */
let SETUP_CLAUDE_WORDS: Set<String> = ["missing", "signed_out", "ok"]

/** `{"models":"…"}` → "missing" or "ok", else "unknown". Pure. */
func setupModelsWord(_ data: Data) -> String {
  guard data.count <= 1024, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let w = j["models"] as? String, w == "missing" || w == "ok"
  else { return "unknown" }
  return w
}

/** One progress step of the model download (src/voice/models.ts ModelEvent, plus done and failed). */
struct ModelProgress: Equatable {
  let event: String
  let index: Int
  let total: Int
  let mb: Int
}

let MODEL_EVENTS: Set<String> = ["downloading", "extracting", "installed", "done", "failed"]

/** A `--json-progress` line → ModelProgress, or nil for anything else (unknown events, odd numbers). Pure. */
func parseModelProgress(_ data: Data) -> ModelProgress? {
  guard data.count <= 512, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let e = j["event"] as? String, MODEL_EVENTS.contains(e)
  else { return nil }
  let n = { (k: String) -> Int in
    guard let v = j[k] as? NSNumber, v.doubleValue >= 0, v.doubleValue <= 100_000 else { return 0 }
    return v.intValue
  }
  return ModelProgress(event: e, index: n("index"), total: n("total"), mb: n("mb"))
}

/** `{"claude":"…"}` → its word if it is one of ours, else "unknown". Pure. */
func setupClaudeWord(_ data: Data) -> String {
  guard data.count <= 1024,
    let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let w = j["claude"] as? String, SETUP_CLAUDE_WORDS.contains(w)
  else { return "unknown" }
  return w
}
