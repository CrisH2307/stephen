// Buttons, Tag, Segmented, AskField (UI-PLAN v3.1 sections 5 and 9).

import SwiftUI

/// Navy (Light) / pale (Dark) filled button: Send, Run, Save, Allow.
struct PrimaryButton: View {
  @Environment(\.stephenTheme) var t
  let title: String
  var symbol: String? = nil
  let action: () -> Void
  init(_ title: String, symbol: String? = nil, action: @escaping () -> Void) { self.title = title; self.symbol = symbol; self.action = action }
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if let s = symbol { Image(systemName: s).font(.system(size: 14)) }
        Text(verbatim: title).font(TypeScale.body.weight(.medium))
      }
      .foregroundColor(t.primaryText).padding(.horizontal, Space.l).padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: Corner.button).fill(t.primary))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain).accessibilityLabel(title)
  }
}

/// Outlined, low-emphasis button: Don't send, Forget, Fix, Cancel.
struct QuietButton: View {
  @Environment(\.stephenTheme) var t
  let title: String
  var symbol: String? = nil
  var destructive: Bool = false
  let action: () -> Void
  init(_ title: String, symbol: String? = nil, destructive: Bool = false, action: @escaping () -> Void) {
    self.title = title; self.symbol = symbol; self.destructive = destructive; self.action = action
  }
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if let s = symbol { Image(systemName: s).font(.system(size: 14)) }
        Text(verbatim: title).font(TypeScale.body)
      }
      .foregroundColor(destructive ? t.bad : t.ink).padding(.horizontal, Space.l).padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: Corner.button).stroke(t.lineStrong, lineWidth: 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain).accessibilityLabel(title)
  }
}

/// Small chip: filter chips (selectable) and suggestion chips.
struct Tag: View {
  @Environment(\.stephenTheme) var t
  let title: String
  var selected: Bool = false
  var action: (() -> Void)? = nil
  init(_ title: String, selected: Bool = false, action: (() -> Void)? = nil) { self.title = title; self.selected = selected; self.action = action }
  var body: some View {
    let label = Text(verbatim: title).font(TypeScale.secondary).foregroundColor(selected ? t.accent : t.ink)
      .padding(.horizontal, Space.m).padding(.vertical, 5)
      .background(Capsule().fill(selected ? t.surface2 : Color.clear))
      // Only a chip you can click gets the strong outline; a plain label keeps the calm one.
      .overlay(Capsule().stroke(selected ? t.accent : (action == nil ? t.line : t.lineStrong), lineWidth: 1))
    if let action = action {
      Button(action: action) { label }.buttonStyle(.plain)
        .accessibilityLabel(title).accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    } else {
      label.accessibilityLabel(title)
    }
  }
}

/// Segmented control (Show memory as). Settings uses the system Picker now (#189). Track is surface-2, the chosen segment is surface with a strong outline (3:1 on
/// the track, #146). `caption: true` writes the label above it (#147); VoiceOver reads the label either way.
struct Segmented<Value: Hashable>: View {
  @Environment(\.stephenTheme) var t
  let label: String
  let options: [(value: Value, title: String)]
  @Binding var selection: Value
  var caption = false
  init(_ label: String, options: [(value: Value, title: String)], selection: Binding<Value>, caption: Bool = false) {
    self.label = label; self.options = options; self._selection = selection; self.caption = caption
  }
  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      if caption {
        Text(verbatim: label).font(TypeScale.secondary.weight(.medium)).foregroundColor(t.ink2).accessibilityHidden(true)
      }
      control
    }
  }
  private var control: some View {
    HStack(spacing: 2) {
      ForEach(options.indices, id: \.self) { i in
        let on = options[i].value == selection
        Button { selection = options[i].value } label: {
          Text(verbatim: options[i].title).font(TypeScale.secondary.weight(on ? .semibold : .regular)).foregroundColor(t.ink)
            .padding(.vertical, 6).frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: Corner.row - 2).fill(on ? t.surface : Color.clear)
              .overlay(RoundedRectangle(cornerRadius: Corner.row - 2).stroke(on ? t.lineStrong : Color.clear, lineWidth: 1)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(options[i].title)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
      }
    }
    .padding(2)
    .background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface2))
    .stephenAnimation(value: selection)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(label)
  }
}

/// The ask input: text, optional mic and trailing hint ("⌘K"). The caller owns the text and what Return does.
/// Return sends (onSubmit); Shift+Return adds a new line; the field grows to 5 lines, then scrolls (#88).
/// Return only ever calls onSubmit: it never answers a waiting question (Allow is a click, AskBox.swift ConfirmButtons).
struct AskField: View {
  @Environment(\.stephenTheme) var t
  var placeholder: String = "Ask Stephen"
  @Binding var text: String
  var hint: String? = nil
  var onMic: (() -> Void)? = nil
  /// Home's centred composer: bigger text and more room.
  var large: Bool = false
  let onSubmit: () -> Void
  init(_ placeholder: String = "Ask Stephen", text: Binding<String>, hint: String? = nil, onMic: (() -> Void)? = nil, large: Bool = false, onSubmit: @escaping () -> Void) {
    self.placeholder = placeholder; self._text = text; self.hint = hint; self.onMic = onMic; self.large = large; self.onSubmit = onSubmit
  }
  var body: some View {
    HStack(alignment: .bottom, spacing: Space.s) {
      TextField(placeholder, text: $text, axis: .vertical).lineLimit(1...5).textFieldStyle(.plain)
        .font(large ? Font.system(size: 17) : TypeScale.body).foregroundColor(t.ink)
        .onSubmit(onSubmit)
        .onKeyPress(keys: [.return], phases: .down) { press in
          guard press.modifiers.contains(.shift) else { return .ignored }  // plain Return: onSubmit
          // The field editor's own "new line here", at the cursor, without sending.
          NSApp.sendAction(#selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)), to: nil, from: nil)
          return .handled
        }
        // A held Return sends once, not again on each key repeat (for example after Return on the palette's Ask row).
        .onKeyPress(keys: [.return], phases: .repeat) { press in
          press.modifiers.contains(.shift) ? .ignored : .handled
        }
        .accessibilityLabel(placeholder)
      if let hint = hint, text.isEmpty { Text(verbatim: hint).font(TypeScale.secondary).foregroundColor(t.ink2).accessibilityHidden(true) }
      if let onMic = onMic {
        Button(action: onMic) {
          Image(systemName: "mic").font(.system(size: 16)).foregroundColor(t.ink2)
            .frame(width: 24, height: 24).contentShape(Rectangle())  // a 24 pt target (#145)
        }
          .buttonStyle(.plain).help("Talk").accessibilityLabel("Talk to Stephen")
      }
    }
    .padding(.horizontal, large ? Space.l : Space.m).padding(.vertical, large ? Space.l : 10)
    .background(RoundedRectangle(cornerRadius: large ? Corner.askBox : Corner.list).fill(t.surface))
    .overlay(RoundedRectangle(cornerRadius: large ? Corner.askBox : Corner.list).stroke(t.lineStrong, lineWidth: 1))
  }
}

/// A place for rare things (UI-V4-IA-PLAN section 6): closed by default, the open state remembered per page and
/// section under `key` (for example "acc.settings.privacy.rules"). Never put safety content in it: a waiting question,
/// a refusal, a failed step or job, or the Recording on sign.
struct Accordion<Content: View>: View {
  @Environment(\.stephenTheme) var t
  let title: String
  @AppStorage private var open: Bool
  let content: Content
  init(_ title: String, key: String, @ViewBuilder content: () -> Content) {
    self.title = title; self._open = AppStorage(wrappedValue: false, key); self.content = content()
  }
  var body: some View {
    DisclosureGroup(isExpanded: $open) {
      content.padding(.top, Space.s)
    } label: {
      Text(verbatim: title).font(TypeScale.secondary).foregroundColor(t.ink2)
    }
  }
}
