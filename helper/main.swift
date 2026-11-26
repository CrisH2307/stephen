// Stephen Helper — macOS menu-bar agent (LSUIElement). Built by `stephen install-helper`:
//   swiftc -O -swift-version 5 -o "Stephen Helper" <HELPER_SOURCES in src/helper/install.ts, main.swift last> \
//     -framework AppKit -framework CoreAudio -framework CoreGraphics -framework SwiftUI
//
// It owns the Input Monitoring permission (a listen-only CGEventTap for Fn+Option and Esc), watches whether the
// default output device is playing (CoreAudio), shows Stephen's state in the menu bar, and talks to
// `stephen listen` over <home>/run/helper.sock (newline JSON; src/helper/protocol.ts). It never records audio
// and never sees what you type: only modifier-key state and Esc key-downs reach it from the tap.
//
// Threading: everything here runs on the main thread (event tap on the main run loop, CoreAudio listeners and
// timers on the main queue). Only StatusMenu and AppWindowController are @MainActor; they are reached through
// MainActor.assumeIsolated.
//
// The Stephen window (AppWindow.swift, AppClient.swift) opens from the menu ("Open Stephen…"), from the launch
// argument --open-window, or from the `open_window` command on helper.sock. It talks to `stephen listen` over
// <home>/run/app.sock; nothing above (tap, audio, helper.sock) depends on it. The Ask box (AskBox.swift) opens
// from a click on the menu bar icon (right-click shows the menu), from F5, and from Cmd+K in the window; it shares the
// window's AppModel, which stays connected while the helper runs.

import AppKit
import CoreAudio
import CoreGraphics

// ───────────────────────────── arguments, log ─────────────────────────────

func resolveHome(_ argv: [String]) -> String {
  var home = ""
  if let i = argv.firstIndex(of: "--home"), i + 1 < argv.count { home = argv[i + 1] }
  if home.isEmpty, let env = ProcessInfo.processInfo.environment["STEPHEN_HOME"], !env.isEmpty { home = env }
  if home.isEmpty {
    // Same default as Node's resolveStephenHome: ~/.stephen, or the pre-rename ~/.browser-hub while only it exists.
    let fm = FileManager.default
    let stephen = NSHomeDirectory() + "/.stephen"
    let legacy = NSHomeDirectory() + "/.browser-hub"
    home = !fm.fileExists(atPath: stephen) && fm.fileExists(atPath: legacy) ? legacy : stephen
  }
  home = (home as NSString).expandingTildeInPath
  while home.count > 1 && home.hasSuffix("/") { home.removeLast() }
  return home
}

final class FileLog {
  private let handle: FileHandle?
  private let queue = DispatchQueue(label: "dev.stephen.helper.log")
  private let formatter = ISO8601DateFormatter()

  init(path: String) {
    let dir = (path as NSString).deletingLastPathComponent
    try? makePrivateDir(dir)
    let fm = FileManager.default
    if let attrs = try? fm.attributesOfItem(atPath: path), let size = attrs[.size] as? NSNumber,
      size.int64Value > 1_000_000
    {
      try? fm.removeItem(atPath: path + ".1")
      try? fm.moveItem(atPath: path, toPath: path + ".1")
    }
    if !fm.fileExists(atPath: path) {
      _ = fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    handle = FileHandle(forWritingAtPath: path)
    _ = handle?.seekToEndOfFile()
  }

  func write(_ message: String) {
    let date = Date()
    queue.async { [self] in
      let line = "\(formatter.string(from: date)) \(message)\n"
      if let h = handle { h.write(Data(line.utf8)) } else { fputs(line, stderr) }
    }
  }
}

// ───────────────────────────── keyboard: listen-only event tap ─────────────────────────────

/** C callback for the tap; `refcon` is an unretained KeyTap. Runs on the main run loop. */
func keyTapCallback(
  proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  if let refcon = refcon {
    Unmanaged<KeyTap>.fromOpaque(refcon).takeUnretainedValue().handle(type: type, event: event)
  }
  return Unmanaged.passUnretained(event)
}

final class KeyTap {
  private let core: HelperCore
  private let log: (String) -> Void
  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  /** F5 went down (not an auto-repeat): show the Ask box while you talk. */
  var onF5Down: () -> Void = {}

  init(core: HelperCore, log: @escaping (String) -> Void) {
    self.core = core
    self.log = log
  }

  var isInstalled: Bool { return tap != nil }
  var isEnabled: Bool {
    guard let t = tap else { return false }
    return CGEvent.tapIsEnabled(tap: t)
  }

  /** (Re)create the tap. Fails (false) without Input Monitoring. */
  @discardableResult
  func install() -> Bool {
    remove()
    let mask: CGEventMask =
      (CGEventMask(1) << CGEventType.flagsChanged.rawValue) | (CGEventMask(1) << CGEventType.keyDown.rawValue)
      | (CGEventMask(1) << CGEventType.keyUp.rawValue)
    guard
      let t = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: keyTapCallback,
        userInfo: Unmanaged.passUnretained(self).toOpaque())
    else {
      return false
    }
    guard let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0) else {
      CFMachPortInvalidate(t)
      return false
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), src, CFRunLoopMode.commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    tap = t
    source = src
    log("event tap installed")
    return true
  }

  func remove() {
    if let t = tap {
      CGEvent.tapEnable(tap: t, enable: false)
      CFMachPortInvalidate(t)
    }
    if let s = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, CFRunLoopMode.commonModes) }
    tap = nil
    source = nil
  }

  func handle(type: CGEventType, event: CGEvent) {
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
      log("event tap disabled by \(type == .tapDisabledByTimeout ? "timeout" : "user input"); re-enabling")
      core.handleTapInterrupted()
      if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
    case .flagsChanged:
      let f = event.flags
      var m = Modifiers()
      m.fn = f.contains(.maskSecondaryFn)
      m.option = f.contains(.maskAlternate)
      m.command = f.contains(.maskCommand)
      m.control = f.contains(.maskControl)
      m.shift = f.contains(.maskShift)
      core.handleFlags(m)
    case .keyDown:
      // Only the key code is examined, and only to recognise Esc and F5; nothing about other keys is kept or sent.
      let code = event.getIntegerValueField(.keyboardEventKeycode)
      if code == KEYCODE_ESCAPE || code == KEYCODE_F5 {
        let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        core.handleKeyDown(keyCode: code, isRepeat: isRepeat)
        if code == KEYCODE_F5 && !isRepeat { onF5Down() }
      }
    case .keyUp:
      let code = event.getIntegerValueField(.keyboardEventKeycode)
      if code == KEYCODE_F5 { core.handleKeyUp(keyCode: code) }
    default:
      break
    }
  }
}

// ───────────────────────────── audio: is the default output device playing? ─────────────────────────────

final class AudioWatcher {
  private let log: (String) -> Void
  var onChange: (Bool) -> Void = { _ in }
  private var device = AudioObjectID(kAudioObjectUnknown)
  private var runningListener: AudioObjectPropertyListenerBlock?
  private var defaultListener: AudioObjectPropertyListenerBlock?
  private var defaultAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  private var runningAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

  init(log: @escaping (String) -> Void) { self.log = log }

  func start() {
    let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.defaultDeviceChanged() }
    let status = AudioObjectAddPropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject), &defaultAddress, DispatchQueue.main, block)
    if status == 0 {
      defaultListener = block
    } else {
      log("could not watch the default output device (OSStatus \(status))")
    }
    attach(to: currentDefaultDevice())
  }

  /** Current state, read fresh (nil when there is no output device or CoreAudio fails). */
  func isPlaying() -> Bool? {
    guard device != AudioObjectID(kAudioObjectUnknown) else { return nil }
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(device, &runningAddress, 0, nil, &size, &running)
    return status == 0 ? running != 0 : nil
  }

  private func currentDefaultDevice() -> AudioObjectID {
    var id = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &defaultAddress, 0, nil, &size, &id)
    return status == 0 ? id : AudioObjectID(kAudioObjectUnknown)
  }

  private func defaultDeviceChanged() {
    let id = currentDefaultDevice()
    if id == device { return }
    log("default output device changed (\(device) → \(id))")
    attach(to: id)
  }

  private func attach(to id: AudioObjectID) {
    if let old = runningListener, device != AudioObjectID(kAudioObjectUnknown) {
      _ = AudioObjectRemovePropertyListenerBlock(device, &runningAddress, DispatchQueue.main, old)
    }
    runningListener = nil
    device = id
    guard id != AudioObjectID(kAudioObjectUnknown) else {
      log("no default output device")
      return
    }
    let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.report() }
    let status = AudioObjectAddPropertyListenerBlock(id, &runningAddress, DispatchQueue.main, block)
    if status == 0 {
      runningListener = block
    } else {
      log("could not watch output device \(id) (OSStatus \(status))")
    }
    report()
  }

  private func report() {
    if let playing = isPlaying() { onChange(playing) }
  }
}

// ───────────────────────────── menu bar ─────────────────────────────

let INPUT_MONITORING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"

@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
  private let item: NSStatusItem
  private let menu = NSMenu()
  private let header: NSMenuItem
  private let permission: NSMenuItem
  private var state: UIState = .idle
  private var granted = false
  private var problem: String?
  private let checkPermission: () -> Bool
  private let quitAction: () -> Void
  private let openWindowAction: @MainActor () -> Void
  private let clickAction: @MainActor () -> Void
  private let control: StephenControl
  private let startStop: NSMenuItem
  private let phoneItem: NSMenuItem
  /** "Recording F5 commands": shown only while the replay recorder is on (issue #48). Not clickable. */
  private let recordingItem: NSMenuItem
  private let recordingOn: @MainActor () -> Bool
  /** T6: "Stop", shown only while Stephen works on a command. It sends chat.stop; running jobs keep going. */
  private let stopItem: NSMenuItem
  private let working: @MainActor () -> Bool
  private let stopWork: @MainActor () -> Void

  init(
    checkPermission: @escaping () -> Bool, openWindow: @escaping @MainActor () -> Void,
    click: @escaping @MainActor () -> Void, control: StephenControl, recordingOn: @escaping @MainActor () -> Bool,
    working: @escaping @MainActor () -> Bool, stopWork: @escaping @MainActor () -> Void, quit: @escaping () -> Void
  ) {
    self.checkPermission = checkPermission
    openWindowAction = openWindow
    clickAction = click
    self.control = control
    quitAction = quit
    startStop = NSMenuItem(title: "Start Stephen", action: nil, keyEquivalent: "")
    phoneItem = NSMenuItem(title: "Phone link", action: nil, keyEquivalent: "")
    recordingItem = NSMenuItem(title: "Recording F5 commands", action: nil, keyEquivalent: "")
    self.recordingOn = recordingOn
    stopItem = NSMenuItem(title: "Stop", action: nil, keyEquivalent: "")
    self.working = working
    self.stopWork = stopWork
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    header = NSMenuItem(title: "Stephen Helper", action: nil, keyEquivalent: "")
    permission = NSMenuItem(title: "Input Monitoring", action: nil, keyEquivalent: "")
    super.init()

    menu.autoenablesItems = false
    header.isEnabled = false
    menu.addItem(header)
    permission.target = self
    permission.action = #selector(openSettings(_:))
    permission.isEnabled = true
    menu.addItem(permission)
    recordingItem.isEnabled = false
    recordingItem.isHidden = true
    menu.addItem(recordingItem)
    stopItem.target = self
    stopItem.action = #selector(stopClicked(_:))
    stopItem.isHidden = true
    menu.addItem(stopItem)
    let openItem = NSMenuItem(title: "Open Stephen…", action: #selector(openWindowClicked(_:)), keyEquivalent: "")
    openItem.target = self
    openItem.isEnabled = true
    menu.addItem(openItem)
    // ROADMAP P2 controls (plain items until the redesign gives them a home in the window).
    startStop.target = self
    startStop.action = #selector(startStopClicked(_:))
    menu.addItem(startStop)
    // One item with a check mark, not two commands that read like states (#143).
    phoneItem.target = self
    phoneItem.action = #selector(phoneClicked(_:))
    menu.addItem(phoneItem)
    for (title, action) in [
      ("Open Zen for Stephen", #selector(zenClicked(_:))), ("Run doctor…", #selector(doctorClicked(_:))),
      ("Report a problem…", #selector(reportClicked(_:))),
    ] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    menu.addItem(NSMenuItem.separator())
    let quitItem = NSMenuItem(title: "Quit", action: #selector(quitClicked(_:)), keyEquivalent: "q")
    quitItem.target = self
    quitItem.isEnabled = true
    menu.addItem(quitItem)
    menu.delegate = self
    // Click: the Ask box. Right-click or Control-click: this menu (status, Input Monitoring, Open, Quit).
    item.button?.target = self
    item.button?.action = #selector(buttonClicked(_:))
    item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    granted = checkPermission()
    render()
  }

  func setState(_ s: UIState) {
    state = s
    render()
  }

  func setGranted(_ g: Bool) {
    if g == granted { return }
    granted = g
    render()
  }

  func setProblem(_ p: String?) {
    problem = p
    render()
  }

  func menuWillOpen(_ menu: NSMenu) {
    granted = checkPermission()
    control.refresh()
    switch control.listener {
    case .stopped: startStop.title = "Start Stephen"
    case .starting: startStop.title = "Stop Stephen (starting…)"
    case .running(let fromApp): startStop.title = fromApp ? "Stop Stephen" : "Stephen is running in Terminal"
    }
    startStop.isEnabled = control.listener != .running(fromApp: false)
    phoneItem.state = control.phoneLinkOn() ? .on : .off
    recordingItem.isHidden = !recordingOn()
    stopItem.isHidden = !working()
    render()
  }

  var button: NSStatusBarButton? { return item.button }

  @objc func buttonClicked(_ sender: Any?) {
    let e = NSApp.currentEvent
    if e?.type == .rightMouseUp || e?.modifierFlags.contains(.control) == true {
      item.menu = menu
      item.button?.performClick(nil)
      item.menu = nil
    } else {
      clickAction()
    }
  }

  private func show(_ title: String, _ text: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.runModal()
  }

  @objc func startStopClicked(_ sender: Any?) {
    let report: (String?) -> Void = { [weak self] why in if let why = why { self?.show("Stephen", why) } }
    if control.listener == .stopped { control.start(report) } else { control.stop(report) }
  }

  @objc func stopClicked(_ sender: Any?) {
    stopWork()
  }

  @objc func phoneClicked(_ sender: Any?) {
    let done: (AppMessage) -> Void = { [weak self] m in
      MainActor.assumeIsolated { self?.show(m.on == true ? "Phone link on" : "Phone link off", phoneText(m)) }
    }
    if control.phoneLinkOn() { control.phoneOff(done) } else { control.phoneOn(done) }
  }

  @objc func zenClicked(_ sender: Any?) {
    control.openZen { [weak self] m in
      MainActor.assumeIsolated { if let why = zenProblem(m) { self?.show("Zen for Stephen", why) } }
    }
  }

  @objc func doctorClicked(_ sender: Any?) {
    control.runDoctor { [weak self] m in MainActor.assumeIsolated { self?.show("Stephen doctor", doctorText(m)) } }
  }

  @objc func reportClicked(_ sender: Any?) {
    control.reportProblem { [weak self] text in MainActor.assumeIsolated { self?.show("Report a problem", text) } }
  }

  @objc func openSettings(_ sender: Any?) {
    if let url = URL(string: INPUT_MONITORING_SETTINGS_URL) { _ = NSWorkspace.shared.open(url) }
  }

  @objc func openWindowClicked(_ sender: Any?) {
    openWindowAction()
  }

  @objc func quitClicked(_ sender: Any?) {
    quitAction()
  }

  private func render() {
    // Words first: a problem, then a missing permission, then the state.
    let status = problem ?? (granted ? state.label : "Input Monitoring is off")
    if let button = item.button {
      let image = NSImage(systemSymbolName: state.symbol, accessibilityDescription: nil)
      image?.isTemplate = true  // the menu bar tints it for light and dark
      button.image = image
      button.imagePosition = .imageLeading
      button.contentTintColor = state == .recording ? .systemRed : nil
      button.title = problem != nil || !granted ? "!" : ""
      button.toolTip = "Stephen: \(status)"
      button.setAccessibilityLabel("Stephen, \(status == state.label ? status.lowercased() : status)")
    }
    header.title = "Stephen: \(status)"
    // The fix sits right under the header, and only while it is needed.
    permission.title = "Open Input Monitoring settings…"
    permission.isHidden = granted
  }
}

// ───────────────────────────── main ─────────────────────────────

let home = resolveHome(CommandLine.arguments)
let fileLog = FileLog(path: home + "/logs/helper.log")
let log: (String) -> Void = { message in fileLog.write(message) }
log("Stephen Helper \(HELPER_VERSION) (protocol \(HELPER_PROTOCOL_VERSION)) starting, pid \(getpid()), home \(home)")

let core = HelperCore(socketPath: home + "/run/helper.sock", log: log)
let audioWatcher = AudioWatcher(log: log)
let keyTap = KeyTap(core: core, log: log)
var statusMenu: StatusMenu? = nil
/** Starts / stops `stephen listen` and sends the control requests; lives as long as the helper, not the window. */
let stephenControl = StephenControl(home: home, log: log)
var appWindow: AppWindowController? = nil
var appModel: AppModel? = nil
var askBox: AskBoxController? = nil

/** The one AppModel (window and Ask box). Created at launch and kept connected while the helper runs. */
@MainActor
func sharedAppModel() -> AppModel {
  if let m = appModel { return m }
  let m = AppModel(socketPath: home + "/run/app.sock", log: log)
  appModel = m
  log("Stephen window and Ask box: talking to \(home)/run/app.sock")
  return m
}

/** Show the Stephen window (created on first use, then reused). */
@MainActor
func showStephenWindow(page: Page? = nil) {
  if appWindow == nil {
    let w = AppWindowController(model: sharedAppModel(), control: stephenControl)
    w.actions = WindowActions(ask: { askBox?.show(focus: true) }, talk: { askBox?.talk() })
    appWindow = w
  }
  appWindow?.show(page: page)
}

func shutdownAndExit(_ code: Int32) {
  keyTap.remove()
  core.stop()
  log("exiting (\(code))")
  // Let the log queue flush.
  usleep(100_000)
  exit(code)
}

/**
 * Post a Mac media key (issue #205), like the keyboard's play/pause, next and previous keys: an NX system-defined
 * event, subtype 8 (NX_SUBTYPE_AUX_CONTROL_BUTTONS), key down then key up. The app that plays sound reacts (Zen,
 * YouTube in any browser, Spotify, Apple Music). Needs the Accessibility permission. nil when posted, else why not.
 */
func postMediaKey(_ key: String) -> String? {
  if !CGPreflightPostEventAccess() {
    _ = CGRequestPostEventAccess()  // the system prompt, the first time
    return "Stephen Helper needs the Accessibility permission (System Settings > Privacy & Security > Accessibility)"
  }
  // NX_KEYTYPE_PLAY 16, NX_KEYTYPE_NEXT 17, NX_KEYTYPE_PREVIOUS 18 (IOKit/hidsystem/ev_keymap.h).
  let code = key == "next" ? 17 : key == "previous" ? 18 : 16
  for down in [true, false] {
    let state = down ? 0xA : 0xB
    guard
      let event = NSEvent.otherEvent(
        with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)),
        timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: (code << 16) | (state << 8), data2: -1),
      let cg = event.cgEvent
    else { return "could not make the media key event" }
    cg.post(tap: .cghidEventTap)
  }
  return nil
}

core.readAudio = { audioWatcher.isPlaying() }
core.readPostEvents = { CGPreflightPostEventAccess() }
core.onMediaKey = { key in MainActor.assumeIsolated { postMediaKey(key) } }
core.onUIState = { s in MainActor.assumeIsolated { statusMenu?.setState(s) } }
core.onQuit = { shutdownAndExit(0) }
core.onOpenWindow = { MainActor.assumeIsolated { showStephenWindow() } }
// The Ask box's mic shows "Listening" only while the helper's press is really down (F5 can end a press the box started).
core.onPressEnded = { MainActor.assumeIsolated { askBox?.box.micHeld = false } }
keyTap.onF5Down = { MainActor.assumeIsolated { askBox?.show(focus: false) } }
audioWatcher.onChange = { playing in core.handleAudio(playing: playing) }

// SIGTERM/SIGINT (e.g. `killall "Stephen Helper"`): remove the socket before exiting.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { shutdownAndExit(0) }
sigterm.resume()
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler { shutdownAndExit(0) }
sigint.resume()

// Every 2 s: notice Input Monitoring being granted/revoked, and recreate the tap if macOS disabled it.
let watchdog = DispatchSource.makeTimerSource(queue: .main)
watchdog.schedule(deadline: .now() + .seconds(2), repeating: .seconds(2))
watchdog.setEventHandler {
  let granted = CGPreflightListenEventAccess()
  core.setInputMonitoring(granted)
  MainActor.assumeIsolated { statusMenu?.setGranted(granted) }
  if !keyTap.isInstalled {
    if granted && keyTap.install() { log("Input Monitoring available; listening for Fn+Option and Esc") }
  } else if !keyTap.isEnabled {
    log("event tap found disabled; recreating it")
    core.handleTapInterrupted()
    keyTap.install()
  }
  let keysOff = !keyTap.isEnabled
  MainActor.assumeIsolated { if askBox?.box.keysOff != keysOff { askBox?.box.keysOff = keysOff } }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  statusMenu = StatusMenu(
    checkPermission: { CGPreflightListenEventAccess() }, openWindow: { showStephenWindow() },
    click: { askBox?.toggle() }, control: stephenControl, recordingOn: { appModel?.recordingOn ?? false },
    working: { appModel?.canStop ?? false }, stopWork: { appModel?.stopChat() },
    quit: { shutdownAndExit(0) })
  let model = sharedAppModel()
  model.opened("askbox")
  stephenControl.onStart = { [weak model] in model?.resetRetry() }
  let box = AskBoxController(model: model)
  box.anchor = { statusMenu?.button }
  box.openWindow = { page in showStephenWindow(page: page) }
  box.quit = { shutdownAndExit(0) }
  box.start = { done in stephenControl.start(done) }
  box.ptt = { down in
    if down { core.handleKeyDown(keyCode: KEYCODE_F5, isRepeat: false) } else { core.handleKeyUp(keyCode: KEYCODE_F5) }
  }
  box.cancelTalk = { core.handleKeyDown(keyCode: KEYCODE_ESCAPE, isRepeat: false) }
  askBox = box

  var granted = CGPreflightListenEventAccess()
  if !granted {
    // Shows the system prompt the first time; afterwards the user grants it in System Settings.
    granted = CGRequestListenEventAccess()
    log("Input Monitoring not granted yet; requested it")
  }
  do {
    try core.start(inputMonitoring: granted)
  } catch {
    log("cannot start: \(error)")
    let text = "\(error)"
    if text.contains("already listening") {
      exit(0)  // another helper for this home is running; it keeps serving
    }
    statusMenu?.setProblem("error: \(text) (see \(home)/logs/helper.log)")
  }
  audioWatcher.start()
  if granted && !keyTap.install() { log("event tap could not be created even though Input Monitoring is granted") }
  watchdog.resume()
  if CommandLine.arguments.contains("--open-window") {
    // After the run loop starts, so activation and the window happen in a launched app.
    DispatchQueue.main.async { MainActor.assumeIsolated { showStephenWindow() } }
  }
  app.run()
}
