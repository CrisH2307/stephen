// Linux/macOS test harness for helper/Core.swift (no AppKit). Built by test/helper/swift-harness.int.test.ts:
//   swiftc -o harness helper/Core.swift test/helper/swift/main.swift
// It runs the real socket server and push-to-talk logic, takes simulated OS events on stdin and reports the UI
// side on stdout, so the Node HelperClient can be tested against the actual Swift code.
//
// stdin (one per line):  flags [fn] [opt] [cmd] [ctrl] [shift] | key <code> [repeat] | keyup <code> | audio 0|1 | perm 0|1
//                        | interrupt | press_over | postkeys 0|1 | exit
// stdout:                ready | ui <state> | quit | open_window | media_key <key> | error <message>
// args:                  --socket <path> [--max-hold-ms <n>]

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Dispatch

setvbuf(stdout, nil, _IOLBF, 0)

var socketPath = ""
var maxHold = PTT_MAX_HOLD_MS
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
  if a == "--socket", let v = args.next() { socketPath = v }
  if a == "--max-hold-ms", let v = args.next(), let n = Int64(v) { maxHold = n }
}
if socketPath.isEmpty {
  print("error missing --socket")
  exit(2)
}

var simulatedAudio: Bool? = false
let core = HelperCore(socketPath: socketPath, maxHoldMs: maxHold, log: { msg in
  fputs("[harness] \(msg)\n", stderr)
})
core.readAudio = { simulatedAudio }
core.onUIState = { s in print("ui \(s.rawValue)") }
core.onOpenWindow = { print("open_window") }
var postKeys = true
core.readPostEvents = { postKeys }
core.onMediaKey = { k in
  print("media_key \(k)")
  return postKeys ? nil : "Stephen Helper needs the Accessibility permission"
}
/** exit() would wait for the stdin reader thread's lock on stdin; flush and leave directly. */
func leave(_ code: Int32) -> Never {
  fflush(stdout)
  _exit(code)
}

core.onQuit = {
  core.stop()
  print("quit")
  leave(0)
}

do {
  try core.start(inputMonitoring: true)
} catch {
  print("error \(error)")
  exit(1)
}
print("ready")

DispatchQueue.global().async {
  while let line = readLine() {
    let parts = line.split(separator: " ").map(String.init)
    guard let cmd = parts.first else { continue }
    DispatchQueue.main.async {
      switch cmd {
      case "flags":
        var m = Modifiers()
        m.fn = parts.contains("fn")
        m.option = parts.contains("opt")
        m.command = parts.contains("cmd")
        m.control = parts.contains("ctrl")
        m.shift = parts.contains("shift")
        core.handleFlags(m)
      case "key":
        core.handleKeyDown(keyCode: Int64(parts.count > 1 ? parts[1] : "") ?? -1, isRepeat: parts.contains("repeat"))
      case "keyup":
        core.handleKeyUp(keyCode: Int64(parts.count > 1 ? parts[1] : "") ?? -1)
      case "audio":
        simulatedAudio = parts.count > 1 && parts[1] == "1"
        core.handleAudio(playing: simulatedAudio ?? false)
      case "perm":
        core.setInputMonitoring(parts.count > 1 && parts[1] == "1")
      case "interrupt":
        core.handleTapInterrupted()
      case "press_over":
        core.handle(.pressOver)
      case "postkeys":
        postKeys = parts.count > 1 && parts[1] == "1"
      case "exit":
        core.stop()
        leave(0)
      default:
        print("error unknown \(cmd)")
      }
    }
  }
  DispatchQueue.main.async {
    core.stop()
    leave(0)
  }
}

dispatchMain()
