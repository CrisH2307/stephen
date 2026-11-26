// Stephen Helper: visual tokens (UI-PLAN v3.1 section 9, UI v4 changes from docs/research/UI-V4-DIRECTION.md section 5).
// Five themes, one environment value. Glass (UI-V4-IA-PLAN section 8) is at the end of this file.
// Screens read `@Environment(\.stephenTheme) var t` and use t.ink, t.surface, ... never raw colors.
// Install once at the root of a window or popover: `.stephenThemed(choice)`.

import AppKit
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
  /// Window background. One flat color in every theme (v4: the Light wash is gone).
  let ground: Color
  let surface: Color
  let surface2: Color
  /// Calm borders of lists and cards (1.1 to 1.2:1). With Increase Contrast it becomes `lineHigh ?? lineStrong`.
  var line: Color
  /// Outlines of things you click or type in: 3:1 or more on ground (top and bottom), surface and surface-2 (#146).
  let lineStrong: Color
  let ink: Color
  let ink2: Color
  let primary: Color
  let primaryText: Color
  let accent: Color
  let ok: Color
  let warn: Color
  let bad: Color
  /// The sidebar's tint (v4). Under the glass, or solid with Reduce Transparency.
  let sidebar: Color
  /// A selected row: accent at 12% over surface, as one solid color (v4). Always with a second cue (the accent bar).
  let selection: Color
  /// Increase Contrast `line` where `lineStrong` would leave ink under 4.5:1 on the "You" bubble (Dark, Navy).
  var lineHigh: Color? = nil

  var colorScheme: ColorScheme { return isDark ? .dark : .light }

  private static let okLight = Color(hex: 0x1E7A4F), warnLight = Color(hex: 0x8A5A00), badLight = Color(hex: 0xB42318)
  private static let okDark = Color(hex: 0x5CC28B), warnDark = Color(hex: 0xE0B04A), badDark = Color(hex: 0xF07167)

  static func of(_ n: ThemeName) -> Theme {
    switch n {
    case .light:
      return Theme(name: n, isDark: false, ground: Color(hex: 0xF5F6F8), surface: Color(hex: 0xFFFFFF),
                   surface2: Color(hex: 0xF2F3F6), line: Color(hex: 0xE3E5EA), lineStrong: Color(hex: 0x7E8793), ink: Color(hex: 0x0E1525), ink2: Color(hex: 0x556070),
                   primary: Color(hex: 0x13244A), primaryText: Color(hex: 0xFFFFFF), accent: Color(hex: 0x2456C9),
                   ok: okLight, warn: warnLight, bad: badLight, sidebar: Color(hex: 0xECEEF1), selection: Color(hex: 0xE5EBF9))
    case .dark:
      return Theme(name: n, isDark: true, ground: Color(hex: 0x12151B), surface: Color(hex: 0x171A21),
                   surface2: Color(hex: 0x1F232C), line: Color(hex: 0x2A2F3A), lineStrong: Color(hex: 0x696F7B), ink: Color(hex: 0xEEF0F4), ink2: Color(hex: 0xA3AAB7),
                   primary: Color(hex: 0xDCE6FF), primaryText: Color(hex: 0x0E1525), accent: Color(hex: 0x7FA6FF),
                   ok: okDark, warn: warnDark, bad: badDark, sidebar: Color(hex: 0x1B1E25), selection: Color(hex: 0x232B3C), lineHigh: Color(hex: 0x666C78))
    case .navy:
      // surface-2 is not in the plan table: derived one step lighter than surface (#16264A -> #1E3260).
      // v4: bad #FF8A80 (was #F07167, 4.3:1 on surface-2).
      return Theme(name: n, isDark: true, ground: Color(hex: 0x0F1B33), surface: Color(hex: 0x16264A),
                   surface2: Color(hex: 0x1E3260), line: Color(hex: 0x26385F), lineStrong: Color(hex: 0x71809F), ink: Color(hex: 0xEEF2FA), ink2: Color(hex: 0xA9B6CF),
                   primary: Color(hex: 0xDCE6FF), primaryText: Color(hex: 0x0E1525), accent: Color(hex: 0x8FB0FF),
                   ok: okDark, warn: warnDark, bad: Color(hex: 0xFF8A80), sidebar: Color(hex: 0x16264A), selection: Color(hex: 0x253760), lineHigh: Color(hex: 0x5E6D8E))
    case .rose:
      // surface-2 derived: a pink tint between ground and line (#FBE9EE).
      return Theme(name: n, isDark: false, ground: Color(hex: 0xFFF5F7), surface: Color(hex: 0xFFFFFF),
                   surface2: Color(hex: 0xFBE9EE), line: Color(hex: 0xF1DCE2), lineStrong: Color(hex: 0x9E7E87), ink: Color(hex: 0x2A1219), ink2: Color(hex: 0x7A5560),
                   primary: Color(hex: 0x7A1F3D), primaryText: Color(hex: 0xFFFFFF), accent: Color(hex: 0xB4235A),
                   ok: okLight, warn: warnLight, bad: badLight, sidebar: Color(hex: 0xFBEFF2), selection: Color(hex: 0xF6E5EB))
    case .sun:
      // surface-2 derived: a cream tint between ground and line (#F7F0D4). Accent #7A5E00: 5.4:1 on surface-2 (#146).
      return Theme(name: n, isDark: false, ground: Color(hex: 0xFFFBEA), surface: Color(hex: 0xFFFFFF),
                   surface2: Color(hex: 0xF7F0D4), line: Color(hex: 0xEFE6C4), lineStrong: Color(hex: 0x91865E), ink: Color(hex: 0x221C08), ink2: Color(hex: 0x6B5F35),
                   primary: Color(hex: 0x3D3200), primaryText: Color(hex: 0xFFFFFF), accent: Color(hex: 0x7A5E00),
                   ok: okLight, warn: warnLight, bad: badLight, sidebar: Color(hex: 0xFBF5DC), selection: Color(hex: 0xEFECE0))
    }
  }
}

// MARK: scale (plan section 9)

enum Corner {
  static let askBox: CGFloat = 14, list: CGFloat = 12, button: CGFloat = 10, row: CGFloat = 8
}

/// v3.2: roomier than v3.1 (was 4, 8, 12, 16, 24, 32). Still a 2 pt grid; page padding is xxl, section gaps xl.
enum Space {
  static let xs: CGFloat = 4, s: CGFloat = 10, m: CGFloat = 16, l: CGFloat = 20, xl: CGFloat = 32, xxl: CGFloat = 40
}

/// Sidebar sizes. The icon column is the same in both states, so collapsing only clips and fades, nothing jumps.
/// The expanded width is the owner's: dragged on the divider, clamped to minWidth...maxWidth, kept as "sidebarWidth".
enum SidebarMetrics {
  static let pad = Space.s            // 10 pt each side
  static let expanded: CGFloat = 220  // default content width; the column is 240 with padding
  static let minWidth: CGFloat = 180  // drag range (content width)
  static let maxWidth: CGFloat = 320
  static let rail: CGFloat = 40       // content width; the rail is 60 with padding (icon centre at 30)
  static func clamp(_ width: CGFloat) -> CGFloat { return width.isNaN ? expanded : min(max(width, minWidth), maxWidth) }
  static func content(_ collapsed: Bool, _ width: CGFloat = expanded) -> CGFloat { return collapsed ? rail : clamp(width) }
  static func column(_ collapsed: Bool, _ width: CGFloat = expanded) -> CGFloat { return content(collapsed, width) + 2 * pad }
}

private struct SidebarWidthKey: EnvironmentKey { static let defaultValue = SidebarMetrics.expanded }

extension EnvironmentValues {
  /// The sidebar's expanded content width (the main window sets it from "sidebarWidth").
  var sidebarWidth: CGFloat {
    get { return self[SidebarWidthKey.self] }
    set { self[SidebarWidthKey.self] = newValue }
  }
}

/// Smallest window content (#154). Measured: Memory needs 853 x 606 with the full sidebar, Settings about 826 wide.
/// The window and the root view both use it, so the window can never be smaller than its pages.
enum WindowMetrics {
  static let minContent = NSSize(width: 860, height: 640)
}

/// SF Pro only, SF Mono for numbers and ids. v4 roles: calmer titles, sentence-case section labels.
enum TypeScale {
  static let homeTitle = Font.system(size: 26, weight: .semibold, design: .default)
  static let section = Font.system(size: 15, weight: .semibold)
  static let body = Font.system(size: 15)
  static let secondary = Font.system(size: 13)
  static let sectionLabel = Font.system(size: 12, weight: .semibold)
  static let eyebrow = Font.system(size: 12)
  static let mono = Font.system(size: 13, design: .monospaced)
}

enum Motion {
  static let state: Double = 0.15
  static let bar: Double = 0.22
}

extension View {
  /// Section label look (v4): 12 pt semibold, sentence case as written, no tracking, ink-2.
  func sectionLabelStyle(_ t: Theme) -> some View {
    return self.font(TypeScale.sectionLabel).foregroundColor(t.ink2)
  }

  /// Eyebrow look (v4): the small "kind" word above a list title, 12 pt regular, ink-2.
  func eyebrowStyle(_ t: Theme) -> some View {
    return self.font(TypeScale.eyebrow).foregroundColor(t.ink2)
  }

  /// The pre-v4 label look (11 pt medium, upper case, tracked). Pinned on the two safety labels, the question card's
  /// "Needs your OK" and the refusal / failure label, until a dev-lane review changes them (review of #246).
  func safetyLabelStyle(_ t: Theme) -> some View {
    return self.font(Font.system(size: 11, weight: .medium)).tracking(0.88).textCase(.uppercase).foregroundColor(t.ink2)
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
  @Environment(\.colorSchemeContrast) var contrast
  let choice: ThemeChoice
  func body(content: Content) -> some View {
    var t = choice.resolved(scheme)
    // Increase Contrast (System Settings > Accessibility > Display): every border gets stronger (#146).
    if contrast == .increased { t.line = t.lineHigh ?? t.lineStrong }
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

// MARK: glass (UI-V4-IA-PLAN section 8)

/// The only three glass surfaces. Everything else (pages, the question card, the banner, steps, refusals, the
/// "Recording on" sign) stays solid. Tint alphas must match scripts/glass-contrast.mjs (ALPHA), which
/// checks 4.5:1 for every text color over pure black and pure white.
enum Glass {
  case sidebar, toolbar, palette

  /// (light themes, dark themes)
  var alpha: (light: Double, dark: Double) {
    switch self {
    case .sidebar: return (0.95, 0.88)
    case .toolbar: return (0.92, 0.85)
    case .palette: return (0.90, 0.88)
    }
  }

  func tint(_ t: Theme) -> Color {
    switch self {
    case .sidebar: return t.sidebar
    case .toolbar: return t.ground
    case .palette: return t.surface
    }
  }
}

extension View {
  /// A glass background: the system material under the theme tint. Solid tint with Reduce Transparency or Increase
  /// Contrast (plan 8.3).
  func glassBackground(_ kind: Glass) -> some View { return background(GlassBackground(kind: kind)) }
}

private struct GlassBackground: View {
  @Environment(\.stephenTheme) var t
  @Environment(\.accessibilityReduceTransparency) var reduceTransparency
  @Environment(\.colorSchemeContrast) var contrast
  let kind: Glass

  var body: some View {
    let tint = kind.tint(t)
    if reduceTransparency || contrast == .increased {
      tint
    } else {
      ZStack {
        switch kind {
        case .sidebar: SidebarMaterial()
        case .toolbar: Rectangle().fill(.bar)
        case .palette: Rectangle().fill(.regularMaterial)
        }
        tint.opacity(t.isDark ? kind.alpha.dark : kind.alpha.light)
      }
    }
  }
}

/// The sidebar material macOS draws behind a window's sidebar (it shows the desktop softly).
private struct SidebarMaterial: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .sidebar
    v.blendingMode = .behindWindow
    v.state = .followsWindowActiveState
    return v
  }
  func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
