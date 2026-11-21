// Stephen Helper: Settings (UI v4 step c, docs/research/UI-V4-IA-PLAN.md section 6.5). A left sub-list with 3
// labelled groups and 8 panes (You: About you, Connected, Privacy and permissions, Routines; Stephen: Voice, Model and
// effort; App: Appearance, About), and one pane. Every pane is a `Form` with `.formStyle(.grouped)`; a table goes
// straight into its section. Rare things sit in closed accordions at the end of a pane. The toolbar shows the pane's
// name, so panes have no big title. Personal's parts live here (About you, the permission table, Connected, Routines).

import AppKit
import SwiftUI

/** Show `item` when Settings opens next (the pane is remembered under "settingsPane"). */
func selectSettingsPane(_ item: SettingsItem) { UserDefaults.standard.set(item.rawValue, forKey: "settingsPane") }

enum SettingsItem: String, CaseIterable, Identifiable {
  case aboutYou, connected, privacy, routines, voice, model, appearance, about

  /// "settingsPane" may still hold a pane from before step c: send it to its new home.
  init?(rawValue: String) {
    switch rawValue {
    case "aboutYou": self = .aboutYou
    case "connected", "phone", "accounts", "browsers": self = .connected
    case "privacy": self = .privacy
    case "routines": self = .routines
    case "voice", "talk", "wake": self = .voice
    case "model": self = .model
    case "appearance": self = .appearance
    case "about", "speed": self = .about
    default: return nil
    }
  }

  /// The sub-list: 3 labelled groups, 8 panes (plan 6.5).
  static let groups: [(title: String, items: [SettingsItem])] = [
    ("You", [.aboutYou, .connected, .privacy, .routines]),
    ("Stephen", [.voice, .model]),
    ("App", [.appearance, .about]),
  ]

  var id: String { return rawValue }
  var title: String {
    switch self {
    case .aboutYou: return "About you"
    case .connected: return "Connected"
    case .privacy: return "Privacy and permissions"
    case .routines: return "Routines"
    case .voice: return "Voice"
    case .model: return "Model and effort"
    case .appearance: return "Appearance"
    case .about: return "About"
    }
  }
  var symbol: String {
    switch self {
    case .aboutYou: return "person.crop.circle"
    case .connected: return "link"
    case .privacy: return "lock"
    case .routines: return "repeat"
    case .voice: return "waveform"
    case .model: return "cpu"
    case .appearance: return "paintpalette"
    case .about: return "info.circle"
    }
  }
}

extension View {
  /// Every Settings pane: a grouped `Form` on the theme's ground (S7).
  func settingsForm() -> some View { return formStyle(.grouped).scrollContentBackground(.hidden) }
}

struct SettingsView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  /// The pane used last, so Settings (and ⌘,) opens where you left it (#147).
  @AppStorage("settingsPane") private var item: SettingsItem = .voice

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: Space.m) {
        ForEach(SettingsItem.groups, id: \.title) { g in
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: g.title).sectionLabelStyle(t).accessibilityAddTraits(.isHeader)
              .padding(.leading, Space.s).padding(.bottom, Space.xs)
            ForEach(g.items) { i in
              SidebarRow(i.title, symbol: i.symbol, selected: item == i, width: 190) { item = i }
            }
          }
        }
        Spacer(minLength: 0)
      }
      .padding(Space.l)
      .frame(width: 230)
      Rectangle().fill(t.line).frame(width: 1)
      pane
        .frame(maxWidth: 640, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear {
      model.refreshSettings()
      model.refreshAccounts()
      model.refreshPersonal()  // About you, the permission table and Routines
    }
  }

  @ViewBuilder
  private var pane: some View {
    switch item {
    case .aboutYou: AboutYouSettingsPane(model: model)
    case .connected: ConnectedSettingsPane(model: model, control: control)
    case .privacy: PrivacySettingsPane(model: model)
    case .routines: RoutinesSettingsPane(model: model)
    case .voice: VoiceSettingsPane(model: model)
    case .model: ModelSettingsPane(model: model)
    case .appearance: AppearanceSettings()
    case .about: AboutSettingsPane(model: model, nav: nav, control: control)
    }
  }
}

/// One Form row: title, optional detail line under it, optional trailing control. Text is verbatim (account and
/// routine names come from config.json).
struct FormRow<Trailing: View>: View {
  @Environment(\.stephenTheme) var t
  let title: String
  var detail: String? = nil
  let trailing: Trailing
  init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title; self.detail = detail; self.trailing = trailing()
  }
  var body: some View {
    HStack(spacing: Space.m) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: title).font(TypeScale.body).foregroundColor(t.ink)
        if let d = detail { Text(verbatim: d).font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true) }
      }
      Spacer(minLength: Space.m)
      trailing
    }
    .accessibilityElement(children: .contain)
  }
}

extension FormRow where Trailing == EmptyView {
  init(_ title: String, detail: String? = nil) { self.init(title, detail: detail) { EmptyView() } }
}

private struct Note: View {
  @Environment(\.stephenTheme) var t
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View { Text(verbatim: text).font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true) }
}

/** A section header in the pane's own words. */
private func header(_ s: String) -> some View { return Text(verbatim: s) }

/** voice.<key> from the settings.get config, as text; nil when absent. */
private func voiceValue(_ config: AppJSON?, _ key: String) -> String? {
  guard case .object(let c)? = config, case .object(let v)? = c["voice"], let x = v[key] else { return nil }
  return x.isScalar ? x.scalarText : x.renderLines().joined(separator: ", ")
}

private extension Binding {
  /// Run `change` whenever the value is set (to clear "Saved").
  func onSet(_ change: @escaping () -> Void) -> Binding<Value> {
    return Binding(get: { wrappedValue }, set: { wrappedValue = $0; change() })
  }
}

// MARK: Stephen: Voice (How Stephen talks, then voices and the wake word in accordions)

private struct VoiceSettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @State private var draft = TalkSettings.blank
  @State private var loaded = false
  @State private var saved = false
  @State private var problem: String? = nil
  @State private var voiceNote: String? = nil

  private static let synth = NSSpeechSynthesizer()
  private static let voices: [(id: String, name: String, source: String)] = [
    ("elevenlabs", "Noah Yang", "ElevenLabs"),
    ("kokoro", "Kokoro", "on this Mac"),
    ("say", "macOS voice", "on this Mac"),
  ]

  var body: some View {
    Form {
      if model.talk == nil {
        Section { Note(model.settingsNotice ?? "Stephen's settings are not available yet. Start Stephen and open this page again.") }
      } else {
        Section {
          Segmented("Length", options: [("brief", "Brief"), ("balanced", "Balanced"), ("detailed", "Detailed")], selection: bind(\.length), caption: true)
          Segmented("Tone", options: [("casual", "Casual"), ("friendly", "Friendly"), ("formal", "Formal")], selection: bind(\.tone), caption: true)
          FormRow("Speak replies out loud") { switchView("Speak replies out loud", bind(\.speak)) }
          FormRow("Explain steps as you go") { switchView("Explain steps as you go", bind(\.explain)) }
        }
        Section {
          Text(verbatim: draft.preview).font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
        } header: { header("Preview") }
        Section {
          HStack(spacing: Space.m) {
            PrimaryButton("Save") { save() }
            if saved { Text(verbatim: "Saved").font(TypeScale.secondary).foregroundColor(t.ok) }
            if let p = problem { Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.bad) }
          }
        } footer: {
          Note("Applies from your next command. A conversation that is already running keeps its way of talking until it ends.")
        }
        Section {
          Accordion("Voices and fallback order", key: "acc.settings.voice.voices") {
            VStack(alignment: .leading, spacing: Space.s) {
              ForEach(Self.voices, id: \.id) { v in
                VoiceRow(name: v.name, source: v.source, current: draft.voice == v.id, onPlay: { play(v.id) }, onSelect: { draft.voice = v.id; saved = false })
              }
              Note("Stephen uses the checked voice first and falls back down the list when one isn't available. Save to keep your choice.")
              if let n = voiceNote { Note(n) }
            }
          }
          Accordion("Wake word and F5", key: "acc.settings.voice.wake") {
            VStack(alignment: .leading, spacing: Space.s) {
              FormRow("Wake word", detail: (voiceValue(model.configJSON, "wakeWord") ?? "true") == "true" ? "On" : "Off")
              FormRow("Wake phrases", detail: voiceValue(model.configJSON, "wakePhrases") ?? "hey stephen")
              FormRow("Push to talk", detail: "Hold F5 (Fn and Option work too)")
              Note("Read only for now. Change the wake word in voice.wakeWord and voice.wakePhrases in config.json, then restart Stephen.")
            }
          }
        }
      }
    }
    .settingsForm()
    .onAppear(perform: adopt)
    .onChange(of: model.talk) { _ in adopt() }
  }

  /** Take the saved values the first time they arrive, so later refreshes don't undo unsaved choices. */
  private func adopt() {
    guard !loaded, let s = model.talk else { return }
    draft = s
    loaded = true
  }

  private func bind<V>(_ path: WritableKeyPath<TalkSettings, V>) -> Binding<V> {
    return Binding(get: { draft[keyPath: path] }, set: { draft[keyPath: path] = $0; saved = false })
  }

  private func switchView(_ label: String, _ on: Binding<Bool>) -> some View {
    return Toggle(label, isOn: on).labelsHidden().toggleStyle(StephenSwitch())
  }

  private func save() {
    guard let old = model.talk else { return }
    problem = nil
    model.saveTalk(draft.changes(from: old)) { err in
      problem = err
      saved = err == nil
    }
  }

  /// macOS voice: a real sample through the system voice. ElevenLabs and Kokoro have no sample request yet.
  private func play(_ id: String) {
    if id == "say" {
      voiceNote = nil
      Self.synth.stopSpeaking()
      _ = Self.synth.startSpeaking(draft.preview)
    } else {
      voiceNote = "Samples play for the macOS voice only. Choose this voice and Save to hear it in the next reply."
    }
  }
}

// MARK: Stephen: Model and effort

/// Which Claude model and effort Stephen's commands use. Quick to switch (Haiku for small tests). Saved to config.json;
/// applies from the next command (the listener ends the running conversation so that is the next one).
private struct ModelSettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @State private var choice = "sonnet"
  @State private var custom = ""
  @State private var effort = "default"
  @State private var loaded = false
  @State private var saved = false
  @State private var problem: String? = nil

  private static let aliases = ["haiku", "sonnet", "opus"]

  var body: some View {
    Form {
      Section {
        Segmented("Model", options: Self.aliases.map { ($0, $0.capitalized) } + [("default", "Default"), ("other", "Other")], selection: $choice.onSet { saved = false }, caption: true)
        if choice == "other" {
          TextField("Model name, for example claude-haiku-5-5", text: $custom).textFieldStyle(.roundedBorder).font(TypeScale.body)
            .accessibilityLabel("Model name").onChange(of: custom) { _ in saved = false }
        }
        Segmented("Effort", options: [("default", "Default"), ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra"), ("max", "Max")], selection: $effort.onSet { saved = false }, caption: true)
      }
      Section {
        HStack(spacing: Space.m) {
          PrimaryButton("Save") { save() }
          if saved { Text(verbatim: "Saved").font(TypeScale.secondary).foregroundColor(t.ok) }
          if let p = problem { Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.bad) }
        }
      } footer: {
        Note("Applies from your next command. Stephen starts a fresh conversation for it.")
      }
      Section {
        Accordion("What the models cost and do", key: "acc.settings.model.about") {
          Note("Haiku is fastest and cheapest, good for small tests. Opus with a high effort is slowest and best for hard requests. Default means Claude Code's own choice.")
        }
      }
    }
    .settingsForm()
    .onAppear(perform: adopt)
    .onChange(of: model.configJSON) { _ in adopt() }
  }

  /** Take the saved values the first time they arrive, so later refreshes don't undo unsaved choices. */
  private func adopt() {
    guard !loaded, let m = voiceValue(model.configJSON, "model") else { return }
    if Self.aliases.contains(m) || m == "default" { choice = m } else { choice = "other"; custom = m }
    effort = voiceValue(model.configJSON, "effort") ?? "default"
    loaded = true
  }

  private func save() {
    problem = nil
    let name = choice == "other" ? custom.trimmingCharacters(in: .whitespaces) : choice
    if name.isEmpty { problem = "Type a model name."; return }
    model.saveModel(model: name, effort: effort) { err in
      problem = err
      saved = err == nil
    }
  }
}

// MARK: You: Connected (accounts, Zen and Chrome, phone link: one list)

/// Each row has its state and its one button. Accounts are signed in from Terminal (the accordion says how).
private struct ConnectedSettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  let control: StephenControl
  @State private var zen: String? = nil  // nil: not checked; "" ready; else why not
  @State private var zenWorking = false
  @State private var phoneOn = false
  @State private var phoneResult = ""

  var body: some View {
    Form {
      Section {
        if model.accounts.isEmpty { FormRow(model.accountsNotice ?? "No accounts listed yet") }
        ForEach(model.accounts, id: \.id) { a in
          let w = accountStateWord(a)
          FormRow(a.name, detail: a.state == "connected" ? a.detail : a.hint) { StatusPill(w.word, kind: w.kind) }
        }
        FormRow("Zen and Chrome", detail: "Stephen works in Zen (the one you have open) and Chrome. Zen needs to be opened with the Zen for Stephen app. A normal Zen window can't connect to Stephen.") {
          if zenWorking { StatusPill("Opening", kind: .warn) } else if let z = zen { StatusPill(z.isEmpty ? "Ready" : "Not ready", kind: z.isEmpty ? .ok : .warn) }
          QuietButton("Open Zen for Stephen") {
            zenWorking = true
            control.openZen { m in zenWorking = false; zen = zenProblem(m) ?? "" }
          }
        }
        FormRow("Phone link", detail: "Lets your phone send Stephen requests through Claude Remote Control, locked to Stephen's phone tools.") {
          StatusPill(phoneOn ? "On" : "Off", kind: phoneOn ? .ok : .idle)
          QuietButton(phoneOn ? "Turn off" : "Turn on") {
            phoneResult = "Working..."
            let done: (AppMessage) -> Void = { m in phoneResult = phoneText(m); phoneOn = control.phoneLinkOn() }
            if phoneOn { control.phoneOff(done) } else { control.phoneOn(done) }
          }
        }
      }
      if let z = zen, !z.isEmpty { Section { Text(verbatim: z).font(TypeScale.secondary).foregroundColor(t.ink2).textSelection(.enabled) } }
      if !phoneResult.isEmpty { Section { Text(verbatim: phoneResult).font(TypeScale.mono).textSelection(.enabled) } }
      Section {
        Accordion("How to connect (Terminal)", key: "acc.settings.connected.terminal") {
          Note("Sign in and out with `stephen connect` and `stephen disconnect` in Terminal. Keys and tokens stay in the Keychain.")
        }
      }
    }
    .settingsForm()
    .onAppear { phoneOn = control.phoneLinkOn() }
  }
}

// MARK: You: Privacy and permissions

/**
 * The permission table (read only), then the replay recorder switch (issue #48 PR 2, [DEV REVIEW]: words and behaviour
 * unchanged, only the pane moved). Off by default; only this click turns it on (app.sock replay.set, which nothing else
 * sends). Off stops saving at once and asks whether to delete what was saved (replay.delete).
 */
private struct PrivacySettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @State private var askDelete = false
  @State private var problem: String? = nil
  @State private var done: String? = nil

  private static let label = "Save my F5 commands to measure mistakes"

  var body: some View {
    Form {
      PermissionsSection(model: model)
      Section {
        FormRow(Self.label) {
          Toggle(Self.label, isOn: Binding(get: { model.recordingOn }, set: { change($0) }))
            .toggleStyle(StephenSwitch()).disabled(model.connection != .online)
        }
        if let d = done { Text(verbatim: d).font(TypeScale.secondary).foregroundColor(t.ok) }
        if let p = problem { Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.bad) }
      } footer: {
        VStack(alignment: .leading, spacing: Space.xs) {
          Note("Saves the audio and the words of commands you start with F5 (or the Ask box mic) on this Mac for 30 days. Never sent anywhere. The wake word never records.")
          if model.connection != .online { Note("Start Stephen to change this.") }
        }
      }
      RulesSourceSection(model: model)
    }
    .settingsForm()
    .alert("Delete the saved recordings too?", isPresented: $askDelete) {
      Button("Delete", role: .destructive) { delete() }
      Button("Keep", role: .cancel) { done = "Kept. They are deleted after 30 days." }
    } message: {
      Text(verbatim: "Recording is off. Keep leaves the saved recordings on this Mac until they are 30 days old.")
    }
  }

  private func change(_ on: Bool) {
    problem = nil
    done = nil
    model.saveReplay(on) { err in
      problem = err.map { "Could not change it: \($0)" }
      if err == nil && !on { askDelete = true }
    }
  }

  private func delete() {
    model.deleteRecordings { err in
      if let e = err { problem = "Could not delete them: \(e)" } else { done = "Deleted." }
    }
  }
}

// MARK: App: About (config file; Speed and Doctor in accordions)

private struct AboutSettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  /// The doctor result is in WindowNav, so the palette's "Run doctor" shows it here too.
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  private static let doctorKey = "acc.settings.about.doctor"

  var body: some View {
    Form {
      Section {
        FormRow("Config file", detail: model.configPath ?? "unknown") {
          QuietButton("Open") { openConfigFile(model.configPath) }
        }
      }
      Section {
        Accordion("Speed, last 7 days", key: "acc.settings.about.speed") { SpeedSection(control: control) }
        Accordion("Doctor", key: Self.doctorKey) {
          VStack(alignment: .leading, spacing: Space.s) {
            QuietButton("Run doctor") { nav.doctor = "Checking..."; control.runDoctor { nav.doctor = doctorText($0) } }
            if !nav.doctor.isEmpty { Text(verbatim: nav.doctor).font(TypeScale.mono).foregroundColor(t.ink).textSelection(.enabled) }
          }
        }
      }
    }
    .settingsForm()
    // The palette's "Run doctor" lands here: open the Doctor accordion so its result shows.
    .onAppear { openDoctor(nav.doctor) }
    .onChange(of: nav.doctor) { openDoctor($0) }
  }

  private func openDoctor(_ result: String) {
    if !result.isEmpty { UserDefaults.standard.set(true, forKey: Self.doctorKey) }
  }
}

/** Read only: the latency log of the last 7 days as `stephen latency` prints it (ids, code words and numbers). Loads
 *  when its accordion opens. */
private struct SpeedSection: View {
  @Environment(\.stephenTheme) var t
  let control: StephenControl
  @State private var report = ""

  var body: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      Note("How long commands took in the last 7 days, from end of speech. Kept on this Mac only.")
      QuietButton("Refresh") { load() }
      if !report.isEmpty { Text(verbatim: report).font(TypeScale.mono).foregroundColor(t.ink).textSelection(.enabled) }
    }
    .onAppear { load() }
  }

  private func load() {
    report = "Loading..."
    control.latency { report = latencyText($0) }
  }
}

/** Opens the config file in its default app (Settings > About, and the palette). Only a .json path is opened; if it
 *  doesn't exist yet, its folder. */
func openConfigFile(_ configPath: String?) {
  guard let path = configPath, path.hasPrefix("/") else { return }
  let url = URL(fileURLWithPath: path)
  guard url.pathExtension.lowercased() == "json" else { return }
  var isDir: ObjCBool = false
  if FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue {
    _ = NSWorkspace.shared.open(url)
  } else {
    _ = NSWorkspace.shared.open(url.deletingLastPathComponent())
  }
}

// MARK: From Personal (view only: personal.summary; About you, the permission table and Routines)

/** About you: what Stephen reads from voice.aboutMe in config.json. Read only. */
private struct AboutYouSettingsPane: View {
  @ObservedObject var model: AppModel
  var body: some View {
    let a = model.personal?.about
    let fields: [(String, String)] =
      [("Name", a?.name), ("School", a?.school), ("Work", a?.work)].compactMap { k, v in v.map { (k, $0) } }
      + (a?.notes ?? []).map { ("Note", $0) }
    Form {
      if let n = model.personalNotice { Section { Note(n) } }
      Section {
        if fields.isEmpty { FormRow("Nothing here yet", detail: "Stephen reads this from voice.aboutMe in config.json.") }
        ForEach(Array(fields.enumerated()), id: \.offset) { _, f in FormRow(f.1, detail: f.0) }
        if let tz = a?.timeZone, !tz.isEmpty { FormRow(tz, detail: "Time zone") }
      } footer: { Note("Read only.") }
      Section {
        Accordion("Where this comes from", key: "acc.settings.aboutYou.source") {
          Note("Stephen reads it from voice.aboutMe in config.json. Change it there.")
        }
      }
    }
    .settingsForm()
  }
}

/** What Stephen may do, by how a command was started (personal.summary). Read only; the table sits straight in the
 *  section (no box inside a box). */
private struct PermissionsSection: View {
  @ObservedObject var model: AppModel
  var body: some View {
    if let p = model.personal?.permissions {
      Section {
        PermissionTable(
          columns: p.columns,
          rows: p.rows.map { r in PermissionRowData(action: r.action, levels: r.cells.map { permissionLevel($0.level) }) })
      } header: {
        header("What Stephen may do").accessibilityAddTraits(.isHeader)
      } footer: {
        Note("Read only. These come from Stephen's safety rules.")
      }
    } else if let n = model.personalNotice {
      Section { Note(n) }
    }
    // Always shown, even with no permissions data: it is a promise, not part of the table.
    Section { Note("Stephen never saves memory, sets timers or starts jobs on its own: it proposes, you keep.") }
  }
}

/** The rule behind each cell of the permission table, in a closed accordion. Read only. */
private struct RulesSourceSection: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  var body: some View {
    if let p = model.personal?.permissions {
      Section {
        Accordion("Where these rules come from", key: "acc.settings.privacy.rules") {
          VStack(alignment: .leading, spacing: Space.s) {
            ForEach(p.rows, id: \.action) { r in
              ForEach(Array(zip(p.columns, r.cells).enumerated()), id: \.offset) { _, pair in
                Text(verbatim: "\(r.action), \(pair.0): \(pair.1.rule)").font(TypeScale.secondary).foregroundColor(t.ink2)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
        }
      }
    }
  }
}

private struct RoutinesSettingsPane: View {
  @ObservedObject var model: AppModel
  var body: some View {
    let list = model.personal?.routines ?? []
    Form {
      if let n = model.personalNotice { Section { Note(n) } }
      Section {
        if list.isEmpty { FormRow("No routines listed yet") }
        ForEach(list, id: \.id) { r in
          FormRow(r.name, detail: "Uses \(r.uses). Say \"\(r.say)\"") {
            StatusPill(routineWord(r).word, kind: routineWord(r).kind)
          }
        }
      }
    }
    .settingsForm()
  }
}

func permissionLevel(_ wire: String) -> PermissionLevel {
  switch wire {
  case "allowed": return .allowed
  case "asks": return .asks
  default: return .never  // unknown reads as the strictest
  }
}

func routineWord(_ r: PersonalSummary.Routine) -> (word: String, kind: StatusKind) {
  switch r.state {
  case "ready": return ("Ready", .ok)
  case "off": return ("Turned off", .idle)
  default: return ("Needs " + (r.missing ?? []).joined(separator: ", "), .warn)
  }
}
