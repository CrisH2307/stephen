// Stephen Helper: Settings (UI-PLAN v3.1 section 8). A left sub-list and one pane. "How Stephen talks" and
// "Appearance" are real; the others show what Stephen already tells us (read only) or say plainly where the setting
// lives today. The temporary P2 controls (phone link, Zen, doctor) sit in their panes, so the menu items could go later.

import AppKit
import SwiftUI

enum SettingsItem: String, CaseIterable, Identifiable {
  case talk, appearance, wake, phone, accounts, browsers, privacy, about
  var id: String { return rawValue }
  var title: String {
    switch self {
    case .talk: return "How Stephen talks"
    case .appearance: return "Appearance"
    case .wake: return "Wake word and F5"
    case .phone: return "Phone link"
    case .accounts: return "Accounts"
    case .browsers: return "Browsers"
    case .privacy: return "Privacy and safety"
    case .about: return "About"
    }
  }
  var symbol: String {
    switch self {
    case .talk: return "waveform"
    case .appearance: return "paintpalette"
    case .wake: return "mic"
    case .phone: return "iphone"
    case .accounts: return "person.crop.circle"
    case .browsers: return "globe"
    case .privacy: return "lock"
    case .about: return "info.circle"
    }
  }
}

struct SettingsView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  let control: StephenControl
  @State private var item: SettingsItem = .talk

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: "Settings").font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
          .padding(.bottom, Space.m)
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
    case .appearance: AppearanceSettings()
    case .wake: WakeSettingsPane(model: model)
    case .phone: PhoneSettingsPane(control: control)
    case .accounts: AccountsSettingsPane(model: model)
    case .browsers: BrowsersSettingsPane(control: control)
    case .privacy: PrivacySettingsPane()
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
        Segmented("Length", options: [("brief", "Brief"), ("balanced", "Balanced"), ("detailed", "Detailed")], selection: bind(\.length))
        Segmented("Tone", options: [("casual", "Casual"), ("friendly", "Friendly"), ("formal", "Formal")], selection: bind(\.tone))
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
      Note("Stephen works in Zen (the one you have open) and Chrome. Zen needs to be opened with Stephen access.")
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
