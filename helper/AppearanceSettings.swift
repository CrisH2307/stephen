// Stephen Helper: Settings > Appearance (UI-PLAN v3.1 section 8). The theme is stored in UserDefaults under the key
// "theme" (light, dark, navy, rose, sun, or "mac" for Follow the Mac), as the temporary reading of it was. ThemeStore
// is the one place that reads and writes it; the main window and the Ask box both observe it, so a change shows at once.

import SwiftUI

@MainActor
final class ThemeStore: ObservableObject {
  static let shared = ThemeStore()
  @Published private(set) var choice: ThemeChoice

  private static let key = "theme"
  /** The last fixed theme, so turning Follow the Mac off goes back to it. */
  private static let lastKey = "themeLast"

  init() {
    let raw = UserDefaults.standard.string(forKey: ThemeStore.key) ?? ""
    if raw == "mac" {
      let last = ThemeName(rawValue: UserDefaults.standard.string(forKey: ThemeStore.lastKey) ?? "") ?? .light
      choice = ThemeChoice(name: last, followMac: true)
    } else {
      choice = ThemeChoice(name: ThemeName(rawValue: raw) ?? .light, followMac: false)
    }
  }

  func pick(_ name: ThemeName) { set(ThemeChoice(name: name, followMac: false)) }
  func setFollowMac(_ on: Bool) { set(ThemeChoice(name: choice.name, followMac: on)) }

  private func set(_ c: ThemeChoice) {
    choice = c
    let d = UserDefaults.standard
    d.set(c.name.rawValue, forKey: ThemeStore.lastKey)
    d.set(c.followMac ? "mac" : c.name.rawValue, forKey: ThemeStore.key)
  }
}

extension View {
  /// The window or popover root: themed by what Settings > Appearance saved, live.
  func stephenThemedBySettings() -> some View { return modifier(SettingsThemed()) }
}

private struct SettingsThemed: ViewModifier {
  @ObservedObject private var store = ThemeStore.shared
  func body(content: Content) -> some View { return content.stephenThemed(store.choice) }
}

struct AppearanceSettings: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject private var store = ThemeStore.shared

  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      Text(verbatim: "Appearance").font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
      HStack(spacing: Space.m) {
        ForEach(ThemeName.allCases) { n in
          ThemeTile(name: n, selected: !store.choice.followMac && store.choice.name == n) { store.pick(n) }
        }
      }
      GroupedList {
        GroupedRow("Follow the Mac", detail: "Light by day, Dark at night. The window and the Ask box change together.", first: true) {
          Toggle("Follow the Mac", isOn: Binding(get: { store.choice.followMac }, set: { store.setFollowMac($0) }))
            .labelsHidden().toggleStyle(StephenSwitch())
        }
      }
    }
  }
}

/// A tiny Ask box in one theme's colors.
private struct ThemeTile: View {
  @Environment(\.stephenTheme) var t
  let name: ThemeName
  let selected: Bool
  let action: () -> Void

  var body: some View {
    let p = Theme.of(name)
    Button(action: action) {
      VStack(spacing: Space.s) {
        ZStack {
          RoundedRectangle(cornerRadius: Corner.row).fill(p.ground)
          HStack(spacing: Space.xs) {
            Text(verbatim: "Ask Stephen").font(.system(size: 9)).foregroundColor(p.ink2).lineLimit(1)
            Spacer(minLength: 0)
            Circle().fill(p.primary).frame(width: 10, height: 10)
          }
          .padding(.horizontal, 6).padding(.vertical, 5)
          .background(RoundedRectangle(cornerRadius: 6).fill(p.surface).overlay(RoundedRectangle(cornerRadius: 6).stroke(p.line, lineWidth: 1)))
          .padding(.horizontal, 6)
        }
        .frame(height: 52)
        .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(selected ? t.accent : t.line, lineWidth: selected ? 2 : 1))
        Text(verbatim: name.title).font(TypeScale.secondary.weight(selected ? .semibold : .regular)).foregroundColor(t.ink)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .frame(maxWidth: 110)
    .accessibilityLabel("\(name.title) theme")
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}
