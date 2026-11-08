// Stephen Helper: Personal (UI-PLAN v3.1 section 7). One scrolling page of grouped lists: About you, What Stephen
// may do (the permission table from personal.summary, each cell's rule listed under it), Memory (2 newest with
// Forget, then "See all"), Connected (accounts.status) and Routines. View only, except Forget (owner default 3).

import SwiftUI

struct PersonalView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        Text(verbatim: "Personal").font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
        if let n = model.personalNotice { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
        about
        permissions
        memory
        connected
        routines
      }
      .padding(Space.xxl)
      .frame(maxWidth: 720, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear {
      model.refreshPersonal()
      model.refreshMemory()
      model.refreshAccounts()
    }
  }

  // MARK: About you

  private var about: some View {
    let a = model.personal?.about
    let fields: [(String, String)] =
      [("Name", a?.name), ("School", a?.school), ("Work", a?.work)].compactMap { k, v in v.map { (k, $0) } }
      + (a?.notes ?? []).map { ("Note", $0) }
    return GroupedList("About you") {
      if fields.isEmpty {
        GroupedRow("Nothing here yet", detail: "Stephen reads this from voice.aboutMe in config.json.", first: true)
      }
      ForEach(Array(fields.enumerated()), id: \.offset) { i, f in
        GroupedRow(f.1, detail: f.0, first: i == 0)
      }
      if let tz = a?.timeZone, !tz.isEmpty { GroupedRow(tz, detail: "Time zone", first: fields.isEmpty) }
      GroupedRow("How Stephen talks", first: false) { QuietButton("Settings") { nav.page = .settings } }
    }
  }

  // MARK: What Stephen may do

  @ViewBuilder
  private var permissions: some View {
    if let p = model.personal?.permissions {
      VStack(alignment: .leading, spacing: Space.s) {
        Text(verbatim: "What Stephen may do").sectionLabelStyle(t).accessibilityAddTraits(.isHeader)
        PermissionTable(
          columns: p.columns,
          rows: p.rows.map { r in PermissionRowData(action: r.action, levels: r.cells.map { permissionLevel($0.level) }) })
        DisclosureGroup {
          VStack(alignment: .leading, spacing: Space.s) {
            ForEach(p.rows, id: \.action) { r in
              ForEach(Array(zip(p.columns, r.cells).enumerated()), id: \.offset) { _, pair in
                Text(verbatim: "\(r.action), \(pair.0): \(pair.1.rule)").font(TypeScale.secondary).foregroundColor(t.ink2)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          .padding(.top, Space.s)
        } label: {
          Text(verbatim: "Where these come from").font(TypeScale.secondary).foregroundColor(t.ink2)
        }
        Text(verbatim: "Read from Stephen's safety rules. Change them in Settings, Privacy and safety.")
          .font(TypeScale.secondary).foregroundColor(t.ink2)
      }
    }
  }

  // MARK: Memory

  private var memory: some View {
    let newest = Array(model.memory.sorted { $0.createdAt > $1.createdAt }.prefix(2))
    return GroupedList("Memory") {
      if let n = model.memoryNotice, model.memory.isEmpty {
        GroupedRow(n, first: true)
      } else if newest.isEmpty {
        GroupedRow("Nothing saved yet", detail: "Say \"remember …\" and Stephen keeps it here.", first: true)
      }
      ForEach(Array(newest.enumerated()), id: \.element.id) { i, item in
        GroupedRow(item.text, detail: model.memoryCaption(item), first: i == 0) {
          QuietButton("Forget", destructive: true) { model.forgetMemory(item.id) }
        }
      }
      if !model.memory.isEmpty {
        // Placeholder target until the Memory page PR (section 7a): the current memory list.
        GroupedRow("See all \(model.memory.count) ›") { QuietButton("Open") { nav.page = .memory } }
      }
    }
  }

  // MARK: Connected

  private var connected: some View {
    GroupedList("Connected") {
      if model.accounts.isEmpty {
        GroupedRow(model.accountsNotice ?? "No accounts listed yet", first: true)
      }
      ForEach(Array(model.accounts.enumerated()), id: \.element.id) { i, account in
        let w = accountStateWord(account)
        GroupedRow(
          account.name, detail: account.state == "connected" ? account.detail : account.hint, first: i == 0
        ) { StatusPill(w.word, kind: w.kind) }
      }
    }
  }

  // MARK: Routines

  private var routines: some View {
    let list = model.personal?.routines ?? []
    return GroupedList("Routines") {
      if list.isEmpty { GroupedRow("No routines listed yet", first: true) }
      ForEach(Array(list.enumerated()), id: \.element.id) { i, r in
        GroupedRow(r.name, detail: "Uses \(r.uses). Say \"\(r.say)\"", first: i == 0) {
          StatusPill(routineWord(r).word, kind: routineWord(r).kind)
        }
      }
    }
  }
}

func permissionLevel(_ wire: String) -> PermissionLevel {
  switch wire {
  case "allowed": return .allowed
  case "asks": return .asks
  default: return .never  // unknown reads as the strictest
  }
}

func routineWord(_ r: PersonalSummary.Routine) -> (word: String, kind: StatusKind) {
  switch r.state {
  case "ready": return ("Ready", .ok)
  case "off": return ("Turned off", .idle)
  default: return ("Needs " + (r.missing ?? []).joined(separator: ", "), .warn)
  }
}
