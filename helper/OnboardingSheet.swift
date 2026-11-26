// F9 first-run setup in the Stephen window (docs/ARCHITECTURE-PLAN.md F9). F9a: Claude Code present and signed in.
// F9b: the voice models, downloaded with progress and Retry (`stephen voice-setup --json-progress`).
// F9c: the three Mac permissions, read live from macOS, with Open Settings; then the first command to try.
// Every line here is Stephen's own fixed text, chosen by a code word from `stephen setup --status`; nothing from Claude
// Code, a page or the network is shown (#382, #390). Installing is the person's: the sheet only opens the official page
// (the same link as `stephen setup` and docs/guide/GETTING-STARTED.md), it never shows or runs an install command.

import AppKit
import AVFoundation
import SwiftUI

let CLAUDE_CODE_PAGE = "https://claude.com/claude-code"

/** The fixed line for each code word. Pure (tested from the TypeScript side by reading this file). */
func claudeSetupLine(_ word: String) -> String {
  switch word {
  case "checking": return "Checking Claude Code..."
  case "missing": return "Claude Code is not on this Mac yet. Open its page, follow the install steps there, then press Check again."
  case "signed_out": return "Claude Code is installed but not signed in. Open Terminal, type claude, press Return and sign in. Then press Check again."
  case "ok": return "Claude Code is ready and signed in."
  case "no_launch_info": return "Stephen Helper doesn't know where Stephen is yet. Run stephen install-helper once in Terminal, then press Check again."
  default: return "Stephen couldn't check Claude Code. Press Check again."
  }
}

/** The fixed line for the voice-model step. Pure. */
func modelSetupLine(_ word: String, _ p: ModelProgress?) -> String {
  if let p = p {
    switch p.event {
    case "downloading": return "Downloading voice model \(p.index) of \(p.total) (about \(p.mb) MB)..."
    case "extracting": return "Unpacking voice model \(p.index) of \(p.total)..."
    case "installed": return "Voice model \(p.index) of \(p.total) is ready."
    case "failed":
      switch p.reason {
      case "keywords": return "The voice models are in place, but Stephen can't use your wake phrase with them. Change it in Settings, Voice, then press Check again."
      case "busy": return "Another download of the voice models is running. Wait for it to finish, then press Check again."
      case "config": return "Stephen's settings file has a problem. Run stephen doctor in Terminal, then press Check again."
      default: return "The download stopped. Check the internet, then press Retry. What was already downloaded is kept."
      }
    default: break
    }
  }
  switch word {
  case "checking": return "Checking the voice models..."
  case "missing": return "Stephen needs its voice models on this Mac (wake word and speech to text). They stay on this Mac."
  case "ok": return "The voice models are ready."
  default: return "Stephen couldn't check the voice models. Press Check again."
  }
}

struct OnboardingSheet: View {
  @Environment(\.stephenTheme) var t
  let control: StephenControl
  /// Setup is finished: don't show this again.
  let finish: () -> Void
  /// Not now: close for this time only.
  let later: () -> Void
  @State private var claude = "checking"
  @State private var models = "checking"
  @State private var progress: ModelProgress? = nil
  @State private var downloading = false
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.m) {
      Text(verbatim: "Set up Stephen").font(TypeScale.homeTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
      Text(verbatim: "A few checks before your first command. Nothing here runs a script for you.")
        .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      ScrollView {
        VStack(alignment: .leading, spacing: Space.m) {
          step
          modelsStep
          PermissionsStep()
          if ready { doneStep }
        }
      }
      HStack(spacing: Space.s) {
        QuietButton("Check again") { check() }
        Spacer()
        QuietButton("Later") { later() }
        PrimaryButton("Continue") { finish() }.disabled(!ready).opacity(ready ? 1 : 0.5)
      }
    }
    .padding(Space.xl)
    .frame(width: 560, height: 560, alignment: .topLeading)
    .background(t.ground)
    .onAppear { check() }
  }

  private var step: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      HStack(spacing: Space.s) {
        Image(systemName: claude == "ok" ? "checkmark.circle.fill" : "1.circle").foregroundColor(claude == "ok" ? t.accent : t.ink2)
          .accessibilityHidden(true)
        Text(verbatim: "Claude Code").font(TypeScale.section).foregroundColor(t.ink)
      }
      Text(verbatim: claudeSetupLine(claude)).font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
      if claude == "signed_out" { command("claude") }
      if claude == "missing" {
        PrimaryButton("Open the Claude Code page") { if let u = URL(string: CLAUDE_CODE_PAGE) { _ = NSWorkspace.shared.open(u) } }
      }
    }
    .padding(Space.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.surface))
  }

  private var ready: Bool { claude == "ok" && models == "ok" }

  private var modelsStep: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      HStack(spacing: Space.s) {
        Image(systemName: models == "ok" ? "checkmark.circle.fill" : "2.circle").foregroundColor(models == "ok" ? t.accent : t.ink2)
          .accessibilityHidden(true)
        Text(verbatim: "Voice models").font(TypeScale.section).foregroundColor(t.ink)
      }
      Text(verbatim: modelSetupLine(models, progress)).font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
      if downloading, let p = progress, p.total > 0 {
        ProgressView(value: Double(p.event == "installed" ? p.index : p.index - 1), total: Double(p.total)).tint(t.accent)
      }
      if models == "missing" && !downloading && (progress?.event != "failed" || progress?.reason == "download" || progress?.reason == "") {
        PrimaryButton(progress?.event == "failed" ? "Retry" : "Download") { download() }
      }
    }
    .padding(Space.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.surface))
  }

  private var doneStep: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      Text(verbatim: "You're set").font(TypeScale.section).foregroundColor(t.ink)
      Text(verbatim: "Press Continue, start Stephen from the menu bar, then try your first command: hold F5 and say \"what time is it\".")
        .font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
    }
    .padding(Space.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.surface))
  }

  private func download() {
    downloading = true
    progress = nil
    control.voiceSetup(progress: { progress = $0 }) { ok in
      downloading = false
      if ok { progress = nil; models = "ok" } else if progress?.event != "failed" { progress = ModelProgress(event: "failed", index: 0, total: 0, mb: 0) }
    }
  }

  private func command(_ text: String) -> some View {
    HStack(spacing: Space.s) {
      Text(verbatim: text).font(TypeScale.mono).foregroundColor(t.ink).textSelection(.enabled)
      Spacer()
      QuietButton(copied ? "Copied" : "Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
      }
    }
    .padding(Space.s)
    .background(RoundedRectangle(cornerRadius: Corner.button).stroke(t.line))
  }

  private func check() {
    if downloading { return }
    claude = "checking"
    models = "checking"
    progress = nil
    copied = false
    control.setupStatus { c, m in claude = c; models = m }
  }
}

/** One Mac permission: what it is for, whether macOS says it is on, and where to turn it on. */
struct PermissionRow: Identifiable {
  let id: String
  let title: String
  let why: String
  let settingsURL: String
}

let SETUP_PERMISSIONS: [PermissionRow] = [
  PermissionRow(id: "microphone", title: "Microphone", why: "To hear you after F5 or \"Hey Stephen\".",
                settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
  PermissionRow(id: "input", title: "Input Monitoring", why: "To notice F5 and Esc anywhere on the Mac.",
                settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"),
  PermissionRow(id: "accessibility", title: "Accessibility", why: "To press media keys for you (play, pause, next).",
                settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
]

/** What macOS says now. Microphone: only "on" once allowed; not asked yet counts as off. */
func permissionOn(_ id: String) -> Bool {
  switch id {
  case "microphone": return AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
  case "input": return CGPreflightListenEventAccess()
  case "accessibility": return CGPreflightPostEventAccess()
  default: return false
  }
}

private struct PermissionsStep: View {
  @Environment(\.stephenTheme) var t
  @State private var on: [String: Bool] = [:]

  var body: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      HStack(spacing: Space.s) {
        Image(systemName: allOn ? "checkmark.circle.fill" : "3.circle").foregroundColor(allOn ? t.accent : t.ink2).accessibilityHidden(true)
        Text(verbatim: "Mac permissions").font(TypeScale.section).foregroundColor(t.ink)
      }
      Text(verbatim: "Turn on \"Stephen Helper\" in each list. Microphone: press Ask now (macOS adds apps to that list only when they ask). Input Monitoring and Accessibility: if it is not there, click + and choose it from Applications in your home folder. If you start Stephen from Terminal instead, macOS asks for Terminal.")
        .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      ForEach(SETUP_PERMISSIONS) { p in
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
          Image(systemName: on[p.id] == true ? "checkmark" : "circle").foregroundColor(on[p.id] == true ? t.accent : t.ink2).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "\(p.title): \(on[p.id] == true ? "on" : "off")").font(TypeScale.body).foregroundColor(t.ink)
            Text(verbatim: p.why).font(TypeScale.secondary).foregroundColor(t.ink2)
          }
          Spacer()
          if on[p.id] != true {
            if p.id == "microphone" && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
              QuietButton("Ask now") { AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { refresh() } } }
            } else {
              QuietButton("Open Settings") { if let u = URL(string: p.settingsURL) { _ = NSWorkspace.shared.open(u) } }
            }
          }
        }
      }
      QuietButton("Check again") { refresh() }
    }
    .padding(Space.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.surface))
    .onAppear { refresh() }
  }

  private var allOn: Bool { SETUP_PERMISSIONS.allSatisfy { on[$0.id] == true } }

  private func refresh() {
    var m: [String: Bool] = [:]
    for p in SETUP_PERMISSIONS { m[p.id] = permissionOn(p.id) }
    on = m
  }
}
