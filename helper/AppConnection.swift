// Stephen Helper: the app.sock transport (AppConnection, connectAppSocket).
//
// Split out of AppClient.swift (no behaviour change). Threading notes: see AppClient.swift.

import Combine
import Darwin
import Foundation

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
