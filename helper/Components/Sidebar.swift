// Sidebar pieces and the status pill (UI-PLAN v3.1 sections 4 and 2: states are always named in words).

import SwiftUI

/// "STEPHEN" / "YOU" label above a group of rows.
struct SidebarSection<Content: View>: View {
  @Environment(\.stephenTheme) var t
  let title: String
  var collapsed: Bool = false
  let content: Content
  init(_ title: String, collapsed: Bool = false, @ViewBuilder content: () -> Content) {
    self.title = title
    self.collapsed = collapsed
    self.content = content()
  }
  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      Text(verbatim: title).sectionLabelStyle(t).padding(.horizontal, Space.s).opacity(collapsed ? 0 : 1)
        .fixedSize().frame(width: SidebarMetrics.content(collapsed), alignment: .leading).clipped().accessibilityAddTraits(.isHeader)
      content
    }
  }
}

/// One sidebar row. `collapsed` shows the icon only (60 pt rail) with a tooltip.
struct SidebarRow: View {
  @Environment(\.stephenTheme) var t
  let title: String
  let symbol: String
  let selected: Bool
  var collapsed: Bool = false
  var shortcut: String? = nil
  /// nil = the sidebar's content width (it animates between rail and full); a list elsewhere passes its own width.
  var width: CGFloat? = nil
  let action: () -> Void
  init(_ title: String, symbol: String, selected: Bool, collapsed: Bool = false, shortcut: String? = nil, width: CGFloat? = nil, action: @escaping () -> Void) {
    self.title = title; self.symbol = symbol; self.selected = selected; self.collapsed = collapsed; self.shortcut = shortcut; self.width = width; self.action = action
  }
  var body: some View {
    Button(action: action) {
      // The icon sits at the same x in both states; the label and shortcut fade while the width animates (clipped).
      HStack(spacing: Space.s) {
        Image(systemName: symbol).font(.system(size: 16, weight: selected ? .semibold : .regular))
          .foregroundColor(selected ? t.accent : t.ink2).frame(width: 20)
        Text(verbatim: title).font(TypeScale.body.weight(selected ? .semibold : .regular)).foregroundColor(t.ink)
          .lineLimit(1).fixedSize().opacity(collapsed ? 0 : 1)
        Spacer(minLength: 0)
        if let shortcut = shortcut { Text(verbatim: shortcut).font(TypeScale.secondary).foregroundColor(t.ink2).opacity(collapsed ? 0 : 1) }
      }
      .padding(.horizontal, Space.s).padding(.vertical, 8)
      .frame(width: width ?? SidebarMetrics.content(collapsed), alignment: .leading)
      .background(
        ZStack(alignment: .leading) {
          RoundedRectangle(cornerRadius: Corner.row).fill(t.accent.opacity(selected ? 0.12 : 0))
          // The mark for "you are here": a small accent bar on the leading edge.
          Capsule().fill(t.accent).frame(width: 3, height: 18).padding(.leading, 2).opacity(selected ? 1 : 0)
        }
      )
      .clipShape(RoundedRectangle(cornerRadius: Corner.row))
      .contentShape(Rectangle())
      .stephenAnimation(value: selected)
    }
    .buttonStyle(.plain)
    .help(title)
    .accessibilityLabel(title)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}

enum StatusKind {
  case ok, warn, bad, idle
  func color(_ t: Theme) -> Color {
    switch self {
    case .ok: return t.ok
    case .warn: return t.warn
    case .bad: return t.bad
    case .idle: return t.ink2
    }
  }
}

/// Dot plus word. Never color alone: the word is required.
struct StatusPill: View {
  @Environment(\.stephenTheme) var t
  let word: String
  let kind: StatusKind
  var showWord: Bool = true
  init(_ word: String, kind: StatusKind, showWord: Bool = true) { self.word = word; self.kind = kind; self.showWord = showWord }
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(kind.color(t)).frame(width: 8, height: 8).accessibilityHidden(true)
      Text(verbatim: word).font(TypeScale.secondary).foregroundColor(t.ink).lineLimit(1).fixedSize().opacity(showWord ? 1 : 0)
    }
    .stephenAnimation(value: word)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(word)
  }
}
