// Sidebar pieces and the status pill (UI-PLAN v3.1 sections 4 and 2: states are always named in words).

import SwiftUI

/// "STEPHEN" / "YOU" label above a group of rows.
struct SidebarSection<Content: View>: View {
  @Environment(\.stephenTheme) var t
  let title: String
  let content: Content
  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }
  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      Text(verbatim: title).sectionLabelStyle(t).padding(.horizontal, Space.s).accessibilityAddTraits(.isHeader)
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
  let action: () -> Void
  init(_ title: String, symbol: String, selected: Bool, collapsed: Bool = false, shortcut: String? = nil, action: @escaping () -> Void) {
    self.title = title; self.symbol = symbol; self.selected = selected; self.collapsed = collapsed; self.shortcut = shortcut; self.action = action
  }
  var body: some View {
    Button(action: action) {
      HStack(spacing: Space.s) {
        Image(systemName: symbol).font(.system(size: 16)).foregroundColor(selected ? t.accent : t.ink2).frame(width: 20)
        if !collapsed {
          Text(verbatim: title).font(TypeScale.body).foregroundColor(t.ink)
          Spacer(minLength: 0)
          if let shortcut = shortcut { Text(verbatim: shortcut).font(TypeScale.secondary).foregroundColor(t.ink2) }
        }
      }
      .padding(.horizontal, Space.s).padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: collapsed ? .center : .leading)
      .background(RoundedRectangle(cornerRadius: Corner.row).fill(selected ? t.surface2 : Color.clear))
      .contentShape(Rectangle())
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
  init(_ word: String, kind: StatusKind) { self.word = word; self.kind = kind }
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(kind.color(t)).frame(width: 8, height: 8).accessibilityHidden(true)
      Text(verbatim: word).font(TypeScale.secondary).foregroundColor(t.ink)
    }
    .stephenAnimation(value: word)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(word)
  }
}
