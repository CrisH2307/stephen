// Stephen Helper: the ⌘K palette (docs/research/UI-V4-IA-PLAN.md section 7, step a: Waiting, Ask, Go to, Actions).
// It only goes to a page, opens the Ask box, fills Home's composer (never sends), or runs an app action from the allow
// list in plan 7.3. It never answers a question. Typed text never leaves the Mac.
//
// Keys: Up and Down move, Return runs the selected row, Esc closes the palette (only the palette). While it is open,
// the question card's buttons and its Esc are off (\.paletteOpen, read by ConfirmButtons and ChatThreadView).
// Glass: the `surface` tint over the regular material (plan 8.1). No animation when it opens.

import SwiftUI

private struct PaletteOpenKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// True while the main window's palette is open. The Ask box never sets it, so its card keys are never affected.
  var paletteOpen: Bool {
    get { return self[PaletteOpenKey.self] }
    set { self[PaletteOpenKey.self] = newValue }
  }
}

/** One palette row: a section, words, an icon, and what Return or a click does. */
struct PaletteItem: Identifiable {
  let id: String
  let section: String
  let title: String
  let symbol: String
  let run: () -> Void
}

struct CommandPalette: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  let control: StephenControl
  let actions: WindowActions
  @Binding var sidebarCollapsed: Bool
  @AppStorage("settingsPane") private var pane: SettingsItem = .voice
  @State private var query = ""
  @State private var selected = 0
  @FocusState private var focused: Bool

  var body: some View {
    let items = shown
    ZStack(alignment: .top) {
      // A click outside the panel closes it.
      Color.clear.contentShape(Rectangle()).onTapGesture { close() }.accessibilityHidden(true)
      VStack(spacing: 0) {
        HStack(spacing: Space.s) {
          Image(systemName: "magnifyingglass").foregroundColor(t.ink2).accessibilityHidden(true)
          TextField("Search pages and actions", text: $query).textFieldStyle(.plain).font(TypeScale.body).foregroundColor(t.ink)
            .focused($focused)
            .onSubmit { run(items) }
            .onKeyPress(.upArrow) { move(-1, items.count); return .handled }
            .onKeyPress(.downArrow) { move(1, items.count); return .handled }
            .onKeyPress(.escape) { close(); return .handled }
            .accessibilityLabel("Search pages and actions")
        }
        .padding(.horizontal, Space.m).padding(.vertical, 12)
        Rectangle().fill(t.line).frame(height: 1)
        ScrollViewReader { proxy in
          ScrollView {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i == 0 || items[i - 1].section != item.section {
                  Text(verbatim: item.section).sectionLabelStyle(t).accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, 12).padding(.top, i == 0 ? Space.xs : Space.s).padding(.bottom, Space.xs)
                }
                row(item, selected: i == selected) { selected = i; run(items) }.id(item.id)
              }
              if items.isEmpty {
                Text(verbatim: "No match.").font(TypeScale.secondary).foregroundColor(t.ink2).padding(12)
              }
            }
            .padding(Space.s)
          }
          .frame(maxHeight: 380)
          .fixedSize(horizontal: false, vertical: true)
          .onChange(of: selected) { i in if items.indices.contains(i) { proxy.scrollTo(items[i].id) } }
        }
      }
      .frame(width: 560)
      .glassBackground(.palette)
      .clipShape(RoundedRectangle(cornerRadius: Corner.list))
      .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.lineStrong, lineWidth: 1))
      .padding(.top, Space.l)
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Search and actions")
      .accessibilityAddTraits(.isModal)
    }
    .onAppear { focused = true }
    .onExitCommand { close() }
    .onChange(of: query) { _ in selected = 0 }
    .onChange(of: nav.page) { _ in close() }
  }

  private func row(_ item: PaletteItem, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: Space.s) {
        Image(systemName: item.symbol).font(.system(size: 15)).foregroundColor(selected ? t.accent : t.ink2).frame(width: 20)
        // Verbatim: the Ask row repeats what you typed.
        Text(verbatim: item.title).font(TypeScale.body).foregroundColor(t.ink).lineLimit(1).truncationMode(.tail)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .background(
        ZStack(alignment: .leading) {
          RoundedRectangle(cornerRadius: Corner.row).fill(selected ? t.selection : Color.clear)
          Capsule().fill(t.accent).frame(width: 3, height: 18).padding(.leading, 2).opacity(selected ? 1 : 0)
        }
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(item.title)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }

  // MARK: rows

  /// Waiting and Ask always show; Go to and Actions are filtered by the typed words.
  private var shown: [PaletteItem] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    var list: [PaletteItem] = []
    if !model.confirms.isEmpty {
      // Like the banner: it only opens the Ask box, where the card is. It never answers.
      list.append(PaletteItem(id: "waiting", section: "Waiting", title: "Stephen is waiting for your OK", symbol: "questionmark.circle") {
        actions.ask()
      })
    }
    // Fills Home's composer. Not sent: only Home's Send sends.
    list.append(PaletteItem(id: "ask", section: "Ask", title: q.isEmpty ? "Ask Stephen" : "Ask Stephen: \(q)", symbol: "text.bubble") {
      if !q.isEmpty { nav.draft = q }
      nav.page = .home
    })
    let rest = goTo + appActions
    return list + (q.isEmpty ? rest : rest.filter { $0.title.localizedCaseInsensitiveContains(q) })
  }

  private var goTo: [PaletteItem] {
    let pages = (Page.talk + Page.control).map { p in
      PaletteItem(id: "page.\(p.rawValue)", section: "Go to", title: p.title, symbol: p.symbol) { nav.page = p }
    }
    let panes = SettingsItem.allCases.map { i in
      PaletteItem(id: "pane.\(i.rawValue)", section: "Go to", title: "Settings: \(i.title)", symbol: i.symbol) {
        pane = i
        nav.page = .settings
      }
    }
    return pages + panes
  }

  private var appActions: [PaletteItem] {
    var list = [
      PaletteItem(id: "newchat", section: "Actions", title: "New chat", symbol: "plus") {
        nav.draft = ""
        model.newChat()
        nav.page = .home
      },
      PaletteItem(id: "askbox", section: "Actions", title: "Open the Ask box", symbol: "rectangle.and.pencil.and.ellipsis") { actions.ask() },
    ]
    list += ThemeName.allCases.map { n in
      PaletteItem(id: "theme.\(n.rawValue)", section: "Actions", title: "Theme: \(n.title)", symbol: "paintpalette") { ThemeStore.shared.pick(n) }
    }
    list += [
      PaletteItem(id: "theme.mac", section: "Actions", title: "Theme: Follow the Mac", symbol: "paintpalette") { ThemeStore.shared.setFollowMac(true) },
      PaletteItem(id: "sidebar", section: "Actions", title: sidebarCollapsed ? "Show sidebar" : "Hide sidebar", symbol: "sidebar.left") {
        sidebarCollapsed.toggle()
      },
      PaletteItem(id: "refresh.conversations", section: "Actions", title: "Refresh conversations", symbol: "arrow.clockwise") { model.refreshHistory() },
      PaletteItem(id: "refresh.jobs", section: "Actions", title: "Refresh jobs", symbol: "arrow.clockwise") { model.refreshJobs() },
      PaletteItem(id: "refresh.memory", section: "Actions", title: "Refresh memory", symbol: "arrow.clockwise") { model.refreshMemoryPage() },
      PaletteItem(id: "config", section: "Actions", title: "Open config file", symbol: "doc.text") { openConfigFile(model.configPath) },
      // Read only. The result shows in Settings > About.
      PaletteItem(id: "doctor", section: "Actions", title: "Run doctor", symbol: "stethoscope") {
        pane = .about
        nav.page = .settings
        nav.doctor = "Checking..."
        control.runDoctor { nav.doctor = doctorText($0) }
      },
    ]
    return list
  }

  // MARK: keys

  private func move(_ by: Int, _ count: Int) {
    guard count > 0 else { return }
    selected = (selected + by + count) % count
  }

  /// Close first, then run, so the question card's keys are back before anything else happens.
  private func run(_ items: [PaletteItem]) {
    guard items.indices.contains(selected) else { return }
    let item = items[selected]
    close()
    item.run()
  }

  private func close() { nav.paletteOpen = false }
}
