// F9 first-run setup in the Stephen window (docs/ARCHITECTURE-PLAN.md F9). F9a: Claude Code present and signed in.
// Every line here is Stephen's own fixed text, chosen by a code word from `stephen setup --status`; nothing from Claude
// Code, a page or the network is shown (#382, #390). The install command is shown with Copy and is never run.

import AppKit
import SwiftUI

/** The official install command, shown for the person to paste into Terminal. Stephen never runs it. */
let CLAUDE_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code"
let CLAUDE_CODE_PAGE = "https://claude.com/claude-code"

/** The fixed line for each code word. Pure (tested from the TypeScript side by reading this file). */
func claudeSetupLine(_ word: String) -> String {
  switch word {
  case "checking": return "Checking Claude Code..."
  case "missing": return "Claude Code is not on this Mac yet. Open Terminal, paste the command below, press Return, then press Check again."
  case "signed_out": return "Claude Code is installed but not signed in. Open Terminal, type claude, press Return and sign in. Then press Check again."
  case "ok": return "Claude Code is ready and signed in."
  case "no_launch_info": return "Stephen Helper doesn't know where Stephen is yet. Run stephen install-helper once in Terminal, then press Check again."
  default: return "Stephen couldn't check Claude Code. Press Check again."
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
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.m) {
      Text(verbatim: "Set up Stephen").font(TypeScale.homeTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
      Text(verbatim: "A few checks before your first command. Nothing here runs a script for you.")
        .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      step
      Spacer(minLength: 0)
      HStack(spacing: Space.s) {
        QuietButton("Check again") { check() }
        Spacer()
        QuietButton("Later") { later() }
        PrimaryButton("Continue") { finish() }.disabled(claude != "ok").opacity(claude == "ok" ? 1 : 0.5)
      }
    }
    .padding(Space.xl)
    .frame(width: 560, height: 420, alignment: .topLeading)
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
      if claude == "missing" { command(CLAUDE_INSTALL_COMMAND) }
      if claude == "signed_out" { command("claude") }
      if claude == "missing" {
        QuietButton("Read about Claude Code") { if let u = URL(string: CLAUDE_CODE_PAGE) { _ = NSWorkspace.shared.open(u) } }
      }
    }
    .padding(Space.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.surface))
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
    claude = "checking"
    copied = false
    control.setupStatus { claude = $0 }
  }
}
