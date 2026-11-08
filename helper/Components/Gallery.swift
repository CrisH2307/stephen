// Debug preview gallery: every component in the chosen theme. #Preview needs Xcode's macro plugin, which this
// build (plain swiftc) does not have, so screens show this view from a debug menu item instead.

import SwiftUI

struct ComponentGallery: View {
  @State var choice = ThemeChoice()
  @State var text = ""
  @State var length = "Brief"
  @State var voice = "Kokoro"

  var body: some View {
    GalleryBody(choice: $choice, text: $text, length: $length, voice: $voice).stephenThemed(choice)
  }
}

private struct GalleryBody: View {
  @Environment(\.stephenTheme) var t
  @Binding var choice: ThemeChoice
  @Binding var text: String
  @Binding var length: String
  @Binding var voice: String

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        HStack {
          ForEach(ThemeName.allCases) { n in Tag(n.title, selected: !choice.followMac && choice.name == n) { choice = ThemeChoice(name: n, followMac: false) } }
          Tag("Follow the Mac", selected: choice.followMac) { choice.followMac.toggle() }
        }
        Text(verbatim: "Page title").font(TypeScale.pageTitle).foregroundColor(t.ink)
        SidebarSection("Stephen") {
          SidebarRow("Home", symbol: "house", selected: true, shortcut: "⌘1") {}
          SidebarRow("Jobs", symbol: "clock", selected: false) {}
        }.frame(width: 200)
        HStack(spacing: Space.l) { StatusPill("Listening", kind: .ok); StatusPill("Needs approval", kind: .warn); StatusPill("Offline", kind: .bad); StatusPill("Stopped", kind: .idle) }
        HStack { PrimaryButton("Send") {}; QuietButton("Don't send") {}; QuietButton("Forget", destructive: true) {} }
        AskField(text: $text, hint: "⌘K", onMic: {}) {}.frame(width: 300)
        Segmented("Length", options: [("Brief", "Brief"), ("Balanced", "Balanced"), ("Detailed", "Detailed")], selection: $length).frame(width: 300)
        GroupedList("Connected") {
          GroupedRow("Canvas", detail: "Read-only · connected", first: true) { StatusPill("Connected", kind: .ok) }
          GroupedRow("Notion", detail: "Not set up") { QuietButton("Connect") {} }
        }
        PermissionTable(columns: ["F5", "Hey Stephen", "Phone"], rows: [
          PermissionRowData(action: "Read", levels: [.allowed, .allowed, .allowed]),
          PermissionRowData(action: "Send or submit", levels: [.asks, .never, .never]),
        ])
        GroupedList("Voice") {
          VoiceRow(name: "Kokoro", source: "on this Mac", current: voice == "Kokoro", first: true, onPlay: {}, onSelect: { voice = "Kokoro" })
          VoiceRow(name: "macOS voice", source: "built in", current: voice == "macOS", onPlay: {}, onSelect: { voice = "macOS" })
        }
      }.padding(Space.xl)
    }
    .frame(minWidth: 480, minHeight: 600).background(t.ground)
  }
}
