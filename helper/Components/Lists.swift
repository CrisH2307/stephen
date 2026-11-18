// Grouped (System Settings style) lists, the permission table and the voice row (UI-PLAN v3.1 sections 7 and 8).

import SwiftUI

/// Inset group: optional header label above a rounded surface; rows are separated by lines.
struct GroupedList<Content: View>: View {
  @Environment(\.stephenTheme) var t
  var header: String? = nil
  let content: Content
  init(_ header: String? = nil, @ViewBuilder content: () -> Content) { self.header = header; self.content = content() }
  var body: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      if let header = header { Text(verbatim: header).sectionLabelStyle(t).accessibilityAddTraits(.isHeader) }
      VStack(spacing: 0) { content }
        .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Corner.list))
    }
  }
}

/// One row: title, optional detail line, optional trailing view (button, pill, toggle). Draws a divider above unless first.
struct GroupedRow<Trailing: View>: View {
  @Environment(\.stephenTheme) var t
  let title: String
  var detail: String? = nil
  var first: Bool = false
  let trailing: Trailing
  init(_ title: String, detail: String? = nil, first: Bool = false, @ViewBuilder trailing: () -> Trailing) {
    self.title = title; self.detail = detail; self.first = first; self.trailing = trailing()
  }
  var body: some View {
    VStack(spacing: 0) {
      if !first { Rectangle().fill(t.line).frame(height: 1) }
      HStack(spacing: Space.m) {
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: title).font(TypeScale.body).foregroundColor(t.ink)
          if let d = detail { Text(verbatim: d).font(TypeScale.secondary).foregroundColor(t.ink2) }
        }
        Spacer(minLength: Space.m)
        trailing
      }
      .padding(.horizontal, Space.l).padding(.vertical, Space.m)
    }
    .accessibilityElement(children: .contain)
  }
}

extension GroupedRow where Trailing == EmptyView {
  init(_ title: String, detail: String? = nil, first: Bool = false) {
    self.init(title, detail: detail, first: first) { EmptyView() }
  }
}

/// What Stephen may do, by how it was started. Cells say the word (Allowed / Asks you / Never); color is secondary.
enum PermissionLevel: String {
  case allowed = "Allowed", asks = "Asks you", never = "Never"
  func color(_ t: Theme) -> Color {
    switch self {
    case .allowed: return t.ok
    case .asks: return t.warn
    case .never: return t.bad
    }
  }
}

struct PermissionRowData: Identifiable {
  let id = UUID()
  let action: String
  let levels: [PermissionLevel]  // one per column
}

struct PermissionTable: View {
  @Environment(\.stephenTheme) var t
  let columns: [String]  // e.g. ["F5", "Hey Stephen", "Phone"]
  let rows: [PermissionRowData]
  init(columns: [String], rows: [PermissionRowData]) { self.columns = columns; self.rows = rows }
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: Space.s) {
        Text(verbatim: "").frame(maxWidth: .infinity, alignment: .leading)
        ForEach(columns, id: \.self) { c in Text(verbatim: c).sectionLabelStyle(t).frame(width: 78, alignment: .leading) }
      }
      .padding(.horizontal, Space.l).padding(.vertical, Space.s).accessibilityHidden(true)
      ForEach(rows) { r in
        Rectangle().fill(t.line).frame(height: 1)
        HStack(spacing: Space.s) {
          Text(verbatim: r.action).font(TypeScale.body).foregroundColor(t.ink).frame(maxWidth: .infinity, alignment: .leading)
          ForEach(r.levels.indices, id: \.self) { i in
            HStack(spacing: 5) {
              Circle().fill(r.levels[i].color(t)).frame(width: 7, height: 7)
              Text(verbatim: r.levels[i].rawValue).font(TypeScale.secondary).foregroundColor(t.ink)
            }
            .frame(width: 78, alignment: .leading)
          }
        }
        .padding(.horizontal, Space.l).padding(.vertical, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(r.action). " + zip(columns, r.levels).map { "\($0): \($1.rawValue)" }.joined(separator: ". "))
      }
    }
    .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface))
    .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.line, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: Corner.list))
  }
}

/// A voice in the fallback list: name, where it runs, play button, check when current.
struct VoiceRow: View {
  @Environment(\.stephenTheme) var t
  let name: String
  let source: String  // "ElevenLabs", "on this Mac"
  let current: Bool
  var first: Bool = false
  let onPlay: () -> Void
  let onSelect: () -> Void
  init(name: String, source: String, current: Bool, first: Bool = false, onPlay: @escaping () -> Void, onSelect: @escaping () -> Void) {
    self.name = name; self.source = source; self.current = current; self.first = first; self.onPlay = onPlay; self.onSelect = onSelect
  }
  /// GroupedRow's look, with the name side as a real button (#145) so Tab reaches it; Play stays its own button.
  var body: some View {
    VStack(spacing: 0) {
      if !first { Rectangle().fill(t.line).frame(height: 1) }
      HStack(spacing: Space.m) {
        Button(action: onSelect) {
          HStack(spacing: Space.m) {
            VStack(alignment: .leading, spacing: 2) {
              Text(verbatim: name).font(TypeScale.body).foregroundColor(t.ink)
              Text(verbatim: source).font(TypeScale.secondary).foregroundColor(t.ink2)
            }
            Spacer(minLength: Space.m)
            if current { Image(systemName: "checkmark").foregroundColor(t.accent).accessibilityHidden(true) }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name), \(source)\(current ? ", current voice" : "")")
        .accessibilityHint("Use this voice")
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
        Button(action: onPlay) {
          Image(systemName: "play.circle").font(.system(size: 18)).foregroundColor(t.accent)
            .frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .buttonStyle(.plain).help("Play a sample").accessibilityLabel("Play \(name)")
      }
      .padding(.horizontal, Space.l).padding(.vertical, Space.m)
    }
    .accessibilityElement(children: .contain)
  }
}
