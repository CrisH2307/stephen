// Stephen Helper: Settings (UI-PLAN v3.1 section 8). A left sub-list and one pane. "How Stephen talks" and
// "Appearance" are real; the others show what Stephen already tells us (read only) or say plainly where the setting
// lives today. The temporary P2 controls (phone link, Zen, doctor) sit in their panes, so the menu items could go later.

import AppKit
import SwiftUI

enum SettingsItem: String, CaseIterable, Identifiable {
  case talk, model, appearance, wake, phone, accounts, browsers, privacy, speed, about
  var id: String { return rawValue }
  var title: String {
    switch self {
    case .talk: return "How Stephen talks"
    case .model: return "Model and effort"
    case .appearance: return "Appearance"
    case .wake: return "Wake word and F5"
    case .phone: return "Phone link"
    case .accounts: return "Accounts"
    case .browsers: return "Browsers"
    case .privacy: return "Privacy and safety"
    case .speed: return "Speed"
    case .about: return "About"
    }
  }
  var symbol: String {
    switch self {
    case .talk: return "waveform"
    case .model: return "cpu"
    case .appearance: return "paintpalette"
    case .wake: return "mic"
    case .phone: return "iphone"
    case .accounts: return "person.crop.circle"
    case .browsers: return "globe"
    case .privacy: return "lock"
    case .speed: return "speedometer"
    case .about: return "info.circle"
    }
  }
}

struct SettingsView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  let control: StephenControl
  /// The pane used last, so Settings (and ⌘,) opens where you left it (#147).
  @AppStorage("settingsPane") private var item: SettingsItem = .talk

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 2) {
        // Small: the pane's title is the one large title on the page (#147).
        Text(verbatim: "Settings").sectionLabelStyle(t).accessibilityAddTraits(.isHeader)
          .padding(.leading, Space.s).padding(.bottom, Space.s)
        ForEach(SettingsItem.allCases) { i in
          SidebarRow(i.title, symbol: i.symbol, selected: item == i, width: 190) { item = i }
        }
        Spacer(minLength: 0)
      }
      .padding(Space.l)
      .frame(width: 230)
      Rectangle().fill(t.line).frame(width: 1)
      ScrollView {
        pane
          .padding(Space.xxl)
          .frame(maxWidth: 640, alignment: .leading)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .onAppear {
      model.refreshSettings()
      model.refreshAccounts()
    }
  }

  @ViewBuilder
  private var pane: some View {
    switch item {
    case .talk: TalkSettingsPane(model: model)
    case .model: ModelSettingsPane(model: model)
    case .appearance: AppearanceSettings()
    case .wake: WakeSettingsPane(model: model)
    case .phone: PhoneSettingsPane(control: control)
    case .accounts: AccountsSettingsPane(model: model)
    case .browsers: BrowsersSettingsPane(control: control)
    case .privacy: PrivacySettingsPane()
    case .speed: SpeedSettingsPane(control: control)
    case .about: AboutSettingsPane(model: model, control: control)
    }
  }
}

// MARK: How Stephen talks

private struct TalkSettingsPane: View {
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
    VStack(alignment: .leading, spacing: Space.l) {
      Text(verbatim: "How Stephen talks").font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
      if model.talk == nil {
        Text(verbatim: model.settingsNotice ?? "Stephen's settings are not available yet. Start Stephen and open this page again.")
          .font(TypeScale.secondary).foregroundColor(t.ink2)
      } else {
        Segmented("Length", options: [("brief", "Brief"), ("balanced", "Balanced"), ("detailed", "Detailed")], selection: bind(\.length), caption: true)
        Segmented("Tone", options: [("casual", "Casual"), ("friendly", "Friendly"), ("formal", "Formal")], selection: bind(\.tone), caption: true)
        GroupedList {
          GroupedRow("Speak replies out loud", first: true) { switchView("Speak replies out loud", bind(\.speak)) }
          GroupedRow("Explain steps as you go") { switchView("Explain steps as you go", bind(\.explain)) }
        }
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(verbatim: "Preview").sectionLabelStyle(t)
          Text(verbatim: draft.preview).font(TypeScale.body).foregroundColor(t.ink)
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.line, lineWidth: 1))
        }
        GroupedList("Voice") {
          ForEach(Array(Self.voices.enumerated()), id: \.element.id) { i, v in
            VoiceRow(name: v.name, source: v.source, current: draft.voice == v.id, first: i == 0, onPlay: { play(v.id) }, onSelect: { draft.voice = v.id; saved = false })
          }
        }
        Text(verbatim: "Stephen uses the checked voice first and falls back down the list when one isn't available.")
          .font(TypeScale.secondary).foregroundColor(t.ink2)
        if let n = voiceNote { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
        HStack(spacing: Space.m) {
          PrimaryButton("Save") { save() }
          if saved { Text(verbatim: "Saved").font(TypeScale.secondary).foregroundColor(t.ok) }
          if let p = problem { Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.bad) }
        }
        Text(verbatim: "Applies from your next command. A conversation that is already running keeps its way of talking until it ends.")
          .font(TypeScale.secondary).foregroundColor(t.ink2)
      }
    }
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
    return Toggle(label, isOn: on).labelsHidden().toggleStyle(.switch)
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

// MARK: Model and effort

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
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Model and effort")
      Segmented("Model", options: Self.aliases.map { ($0, $0.capitalized) } + [("default", "Default"), ("other", "Other")], selection: $choice.onSet { saved = false }, caption: true)
      if choice == "other" {
        TextField("Model name, for example claude-haiku-5-5", text: $custom).textFieldStyle(.roundedBorder).font(TypeScale.body)
          .accessibilityLabel("Model name").onChange(of: custom) { _ in saved = false }
      }
      Segmented("Effort", options: [("default", "Default"), ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "Extra"), ("max", "Max")], selection: $effort.onSet { saved = false }, caption: true)
      Note("Haiku is fastest and cheapest, good for small tests. Opus with a high effort is slowest and best for hard requests. Default means Claude Code's own choice.")
      HStack(spacing: Space.m) {
        PrimaryButton("Save") { save() }
        if saved { Text(verbatim: "Saved").font(TypeScale.secondary).foregroundColor(t.ok) }
        if let p = problem { Text(verbatim: p).font(TypeScale.secondary).foregroundColor(t.bad) }
      }
      Note("Applies from your next command. Stephen starts a fresh conversation for it.")
    }
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

private extension Binding {
  /// Run `change` whenever the value is set (to clear "Saved").
  func onSet(_ change: @escaping () -> Void) -> Binding<Value> {
    return Binding(get: { wrappedValue }, set: { wrappedValue = $0; change() })
  }
}

// MARK: Other panes

private struct PaneTitle: View {
  @Environment(\.stephenTheme) var t
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View { Text(verbatim: text).font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader) }
}

private struct Note: View {
  @Environment(\.stephenTheme) var t
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View { Text(verbatim: text).font(TypeScale.secondary).foregroundColor(t.ink2) }
}

/** voice.<key> from the settings.get config, as text; nil when absent. */
private func voiceValue(_ config: AppJSON?, _ key: String) -> String? {
  guard case .object(let c)? = config, case .object(let v)? = c["voice"], let x = v[key] else { return nil }
  return x.isScalar ? x.scalarText : x.renderLines().joined(separator: ", ")
}

private struct WakeSettingsPane: View {
  @ObservedObject var model: AppModel
  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Wake word and F5")
      GroupedList {
        GroupedRow("Wake word", detail: (voiceValue(model.configJSON, "wakeWord") ?? "true") == "true" ? "On" : "Off", first: true)
        GroupedRow("Wake phrases", detail: voiceValue(model.configJSON, "wakePhrases") ?? "hey stephen")
        GroupedRow("Push to talk", detail: "Hold F5 (Fn and Option work too)")
      }
      Note("Read only for now. Change the wake word in voice.wakeWord and voice.wakePhrases in config.json, then restart Stephen.")
    }
  }
}

private struct PhoneSettingsPane: View {
  let control: StephenControl
  @State private var result = ""
  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Phone link")
      Note("Lets your phone send Stephen requests through Claude Remote Control, locked to Stephen's phone tools.")
      HStack(spacing: Space.m) {
        PrimaryButton("Turn on") { result = "Working..."; control.phoneOn { result = phoneText($0) } }
        QuietButton("Turn off") { result = "Working..."; control.phoneOff { result = phoneText($0) } }
      }
      if !result.isEmpty { Text(verbatim: result).font(TypeScale.mono).textSelection(.enabled) }
    }
  }
}

private struct AccountsSettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Accounts")
      GroupedList {
        if model.accounts.isEmpty { GroupedRow(model.accountsNotice ?? "No accounts listed yet", first: true) }
        ForEach(Array(model.accounts.enumerated()), id: \.element.id) { i, a in
          let w = accountStateWord(a)
          GroupedRow(a.name, detail: a.state == "connected" ? a.detail : a.hint, first: i == 0) { StatusPill(w.word, kind: w.kind) }
        }
      }
      Note("Sign in and out with `stephen connect` and `stephen disconnect` in Terminal. Keys and tokens stay in the Keychain.")
    }
  }
}

private struct BrowsersSettingsPane: View {
  let control: StephenControl
  @State private var result = ""
  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Browsers")
      Note("Stephen works in Zen (the one you have open) and Chrome. Zen needs to be opened with the Zen for Stephen app. A normal Zen window can't connect to Stephen.")
      QuietButton("Open Zen for Stephen") { result = "Opening..."; control.openZen { result = zenProblem($0) ?? "Zen is ready for Stephen." } }
      if !result.isEmpty { Text(verbatim: result).font(TypeScale.secondary).textSelection(.enabled) }
    }
  }
}

private struct PrivacySettingsPane: View {
  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Privacy and safety")
      Note("What Stephen may do, and what it asks you about first, is listed under Personal. Stephen never saves memory, sets timers or starts jobs on its own: it proposes, you keep. Changing these rules is not possible from the app yet.")
    }
  }
}

/** Read only: the latency log of the last 7 days as `stephen latency` prints it (ids, code words and numbers). */
private struct SpeedSettingsPane: View {
  @Environment(\.stephenTheme) var t
  let control: StephenControl
  @State private var report = ""

  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("Speed")
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

private struct AboutSettingsPane: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  let control: StephenControl
  @State private var doctor = ""

  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      PaneTitle("About")
      GroupedList {
        GroupedRow("Config file", detail: model.configPath ?? "unknown", first: true) {
          QuietButton("Open") { openConfig() }
        }
      }
      QuietButton("Run doctor") { doctor = "Checking..."; control.runDoctor { doctor = doctorText($0) } }
      if !doctor.isEmpty { Text(verbatim: doctor).font(TypeScale.mono).foregroundColor(t.ink).textSelection(.enabled) }
    }
  }

  /** Opens the config file in its default app. Only a .json path is opened; if it doesn't exist yet, its folder. */
  private func openConfig() {
    guard let path = model.configPath, path.hasPrefix("/") else { return }
    let url = URL(fileURLWithPath: path)
    guard url.pathExtension.lowercased() == "json" else { return }
    var isDir: ObjCBool = false
    if FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue {
      _ = NSWorkspace.shared.open(url)
    } else {
      _ = NSWorkspace.shared.open(url.deletingLastPathComponent())
    }
  }
}
