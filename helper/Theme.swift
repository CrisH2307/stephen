// Stephen Helper: visual tokens (UI-PLAN v3.1 section 9). Five themes, one environment value.
// Screens read `@Environment(\.stephenTheme) var t` and use t.ink, t.surface, ... never raw colors.
// Install once at the root of a window or popover: `.stephenThemed(choice)`.

import SwiftUI

enum ThemeName: String, CaseIterable, Identifiable {
  case light, dark, navy, rose, sun
  var id: String { return rawValue }
  var title: String { return rawValue.capitalized }
}

/// What the user picked in Settings > Appearance. followMac = Light by day, Dark at night (system appearance).
struct ThemeChoice: Equatable {
  var name: ThemeName = .light
  var followMac: Bool = false

  func resolved(_ scheme: ColorScheme) -> Theme {
    if followMac { return Theme.of(scheme == .dark ? .dark : .light) }
    return Theme.of(name)
  }
}

extension Color {
  /// 0xRRGGBB
  init(hex: UInt32) {
    self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
  }
}

struct Theme: Equatable {
  let name: ThemeName
  let isDark: Bool
  /// Window background, top to bottom (Light is the only wash; the others repeat one color).
  let groundTop: Color
  let groundBottom: Color
  let surface: Color
  let surface2: Color
  let line: Color
  let ink: Color
  let ink2: Color
  let primary: Color
  let primaryText: Color
  let accent: Color
  let ok: Color
  let warn: Color
  let bad: Color

  var ground: LinearGradient { return LinearGradient(colors: [groundTop, groundBottom], startPoint: .top, endPoint: .bottom) }
  var colorScheme: ColorScheme { return isDark ? .dark : .light }

  private static let okLight = Color(hex: 0x1E7A4F), warnLight = Color(hex: 0x8A5A00), badLight = Color(hex: 0xB42318)
  private static let okDark = Color(hex: 0x5CC28B), warnDark = Color(hex: 0xE0B04A), badDark = Color(hex: 0xF07167)

  static func of(_ n: ThemeName) -> Theme {
    switch n {
    case .light:
      return Theme(name: n, isDark: false, groundTop: Color(hex: 0xFFFFFF), groundBottom: Color(hex: 0xECEEF2), surface: Color(hex: 0xFFFFFF),
                   surface2: Color(hex: 0xF2F3F6), line: Color(hex: 0xE3E5EA), ink: Color(hex: 0x0E1525), ink2: Color(hex: 0x556070),
                   primary: Color(hex: 0x13244A), primaryText: Color(hex: 0xFFFFFF), accent: Color(hex: 0x2456C9),
                   ok: okLight, warn: warnLight, bad: badLight)
    case .dark:
      return Theme(name: n, isDark: true, groundTop: Color(hex: 0x12151B), groundBottom: Color(hex: 0x12151B), surface: Color(hex: 0x171A21),
                   surface2: Color(hex: 0x1F232C), line: Color(hex: 0x2A2F3A), ink: Color(hex: 0xEEF0F4), ink2: Color(hex: 0xA3AAB7),
                   primary: Color(hex: 0xDCE6FF), primaryText: Color(hex: 0x0E1525), accent: Color(hex: 0x7FA6FF),
                   ok: okDark, warn: warnDark, bad: badDark)
    case .navy:
      // surface-2 is not in the plan table: derived one step lighter than surface (#16264A -> #1E3260).
      return Theme(name: n, isDark: true, groundTop: Color(hex: 0x0F1B33), groundBottom: Color(hex: 0x0F1B33), surface: Color(hex: 0x16264A),
                   surface2: Color(hex: 0x1E3260), line: Color(hex: 0x26385F), ink: Color(hex: 0xEEF2FA), ink2: Color(hex: 0xA9B6CF),
                   primary: Color(hex: 0xDCE6FF), primaryText: Color(hex: 0x0E1525), accent: Color(hex: 0x8FB0FF),
                   ok: okDark, warn: warnDark, bad: badDark)
    case .rose:
      // surface-2 derived: a pink tint between ground and line (#FBE9EE).
      return Theme(name: n, isDark: false, groundTop: Color(hex: 0xFFF5F7), groundBottom: Color(hex: 0xFFF5F7), surface: Color(hex: 0xFFFFFF),
                   surface2: Color(hex: 0xFBE9EE), line: Color(hex: 0xF1DCE2), ink: Color(hex: 0x2A1219), ink2: Color(hex: 0x7A5560),
                   primary: Color(hex: 0x7A1F3D), primaryText: Color(hex: 0xFFFFFF), accent: Color(hex: 0xB4235A),
                   ok: okLight, warn: warnLight, bad: badLight)
    case .sun:
      // surface-2 derived: a cream tint between ground and line (#F7F0D4).
      return Theme(name: n, isDark: false, groundTop: Color(hex: 0xFFFBEA), groundBottom: Color(hex: 0xFFFBEA), surface: Color(hex: 0xFFFFFF),
                   surface2: Color(hex: 0xF7F0D4), line: Color(hex: 0xEFE6C4), ink: Color(hex: 0x221C08), ink2: Color(hex: 0x6B5F35),
                   primary: Color(hex: 0x3D3200), primaryText: Color(hex: 0xFFFFFF), accent: Color(hex: 0x8A6A00),
                   ok: okLight, warn: warnLight, bad: badLight)
    }
  }
}

// MARK: scale (plan section 9)

enum Corner {
  static let window: CGFloat = 12, askBox: CGFloat = 14, list: CGFloat = 12, button: CGFloat = 10, row: CGFloat = 8
}

enum Space {
  static let xs: CGFloat = 4, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16, xl: CGFloat = 24, xxl: CGFloat = 32
}

/// SF Pro only. Display design for big titles, SF Mono for numbers and ids.
enum TypeScale {
  static let pageTitle = Font.system(size: 28, weight: .semibold, design: .default)
  static let homeTitle = Font.system(size: 34, weight: .semibold, design: .default)
  static let section = Font.system(size: 17, weight: .semibold)
  static let body = Font.system(size: 15)
  /** Stephen's reply in the chat: the main text, a step up from body (owner, 2026-11-09: bolder, easier to read). */
  static let reply = Font.system(size: 16, weight: .medium)
  static let secondary = Font.system(size: 13)
  static let sectionLabel = Font.system(size: 11, weight: .medium)
  static let mono = Font.system(size: 13, design: .monospaced)
}

enum Motion {
  static let state: Double = 0.15
  static let bar: Double = 0.2
}

extension View {
  /// Section label look: 11 pt, uppercase, +8% tracking, ink-2.
  func sectionLabelStyle(_ t: Theme) -> some View {
    return self.font(TypeScale.sectionLabel).tracking(0.88).textCase(.uppercase).foregroundColor(t.ink2)
  }

  /// Animate `value` changes in `seconds`, or not at all with Reduce Motion.
  func stephenAnimation<V: Equatable>(_ seconds: Double = Motion.state, value: V) -> some View {
    return modifier(StephenAnimation(seconds: seconds, value: value))
  }

  /// Install the theme (resolved from the choice and, for "Follow the Mac", the system appearance) for this subtree.
  func stephenThemed(_ choice: ThemeChoice) -> some View {
    return modifier(ThemeRoot(choice: choice))
  }
}

private struct StephenAnimation<V: Equatable>: ViewModifier {
  @Environment(\.accessibilityReduceMotion) var reduce
  let seconds: Double
  let value: V
  func body(content: Content) -> some View {
    return content.animation(reduce ? nil : .easeInOut(duration: seconds), value: value)
  }
}

private struct ThemeRoot: ViewModifier {
  @Environment(\.colorScheme) var scheme
  let choice: ThemeChoice
  func body(content: Content) -> some View {
    let t = choice.resolved(scheme)
    // Fixed themes pin the color scheme so system controls (text fields, scrollbars) match; Follow the Mac does not.
    let pinned: ColorScheme? = choice.followMac ? nil : t.colorScheme
    return content.environment(\.stephenTheme, t).preferredColorScheme(pinned).tint(t.accent)
  }
}

private struct ThemeKey: EnvironmentKey {
  static let defaultValue = Theme.of(.light)
}

extension EnvironmentValues {
  var stephenTheme: Theme {
    get { return self[ThemeKey.self] }
    set { self[ThemeKey.self] = newValue }
  }
}
