// Stephen Helper: the Memory page (UI-PLAN v3.1 section 7a), opened from Personal ("See all") and the Ask box.
// Header (back to Personal, title, "86% full" chip only over 80%, search, ⋯), filter chips, the graph (you in the
// center, items grouped by kind, links between related items, the selected node accent, a New proposal dashed amber)
// or the same items as a list, the inspector (facts, sources, Edit, Forget), New from your chats (Skip / Keep) and
// the Tell Stephen box.
// Safety: the model never writes memory. A proposal is saved only by the owner's Keep here (memory.keep); Tell
// Stephen only proposes. Text from the listener is shown verbatim.

import SwiftUI

struct MemoryFilter: Identifiable {
  let id: String
  let title: String
}
/** Filter chips, in order. "new" shows proposals only. */
let MEMORY_FILTERS = [
  MemoryFilter(id: "all", title: "All"), MemoryFilter(id: "people", title: "People"), MemoryFilter(id: "school", title: "School"),
  MemoryFilter(id: "places", title: "Places"), MemoryFilter(id: "habits", title: "Habits"),
  MemoryFilter(id: "projects", title: "Projects"), MemoryFilter(id: "new", title: "New"),
]
/** Group order around "You"; kinds without a chip ("other") are shown under All only. */
let MEMORY_KIND_ORDER = ["people", "school", "places", "habits", "projects", "other"]

func memoryKindTitle(_ kind: String) -> String {
  return MEMORY_FILTERS.first { $0.id == kind }?.title ?? "Other"
}

/** Nodes that pass a chip and a search. */
func memoryFilter(_ nodes: [GraphNode], filter: String, search: String) -> [GraphNode] {
  let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return nodes.filter { n in
    let chip = filter == "all" || (filter == "new" ? n.new : n.kind == filter)
    return chip && (q.isEmpty || n.text.lowercased().contains(q))
  }
}

/** "what do you know about Lab 4?" → "Lab 4": a question in Tell Stephen searches instead of proposing. */
func tellStephenQuery(_ text: String) -> String? {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard t.hasSuffix("?") else { return nil }
  var q = String(t.dropLast())
  for p in ["what do you know about ", "what do you remember about ", "do you know ", "what about "]
  where q.lowercased().hasPrefix(p) {
    q = String(q.dropFirst(p.count))
    break
  }
  return q.trimmingCharacters(in: .whitespacesAndNewlines)
}

/**
 * Where each node sits: kinds present get equal slices around the center, a node's slot alternates between two
 * rings so labels don't collide. Pure, so the same memory always draws the same picture.
 */
struct GroupLabel: Identifiable {
  let kind: String
  let at: CGPoint
  var id: String { return kind }
}

func memoryLayout(_ nodes: [GraphNode], size: CGSize) -> (points: [String: CGPoint], labels: [GroupLabel]) {
  let center = CGPoint(x: size.width / 2, y: size.height / 2)
  let kinds = MEMORY_KIND_ORDER.filter { k in nodes.contains { $0.kind == k } }
  let radius = min(size.width, size.height) * 0.36
  var points: [String: CGPoint] = [:]
  var labels: [GroupLabel] = []
  for (i, kind) in kinds.enumerated() {
    let slice = 2 * Double.pi / Double(kinds.count)
    let angle = slice * Double(i) - Double.pi / 2
    let group = nodes.filter { $0.kind == kind }
    labels.append(GroupLabel(kind: kind, at: CGPoint(x: center.x + CGFloat(cos(angle)) * radius * 0.5, y: center.y + CGFloat(sin(angle)) * radius * 0.5)))
    let step = min(0.45, slice * 0.8 / Double(max(group.count, 1)))
    for (j, n) in group.enumerated() {
      let a = angle + (Double(j) - Double(group.count - 1) / 2) * step
      let r = radius * (j % 2 == 0 ? 0.9 : 1.15)
      points[n.id] = CGPoint(x: center.x + CGFloat(cos(a)) * r, y: center.y + CGFloat(sin(a)) * r)
    }
  }
  return (points, labels)
}

struct MemoryPage: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav
  @State private var filter = "all"
  @State private var search = ""
  @State private var asList = false
  @State private var selected: String? = nil
  @State private var tell = ""
  @State private var editing = false
  @State private var editText = ""
  @State private var confirmClear = false
  @FocusState private var searchFocused: Bool

  private var shown: [GraphNode] { return memoryFilter(model.graphNodes, filter: filter, search: search) }
  private var selectedNode: GraphNode? { return model.graphNodes.first { $0.id == selected } }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.l) {
      header
      chips
      if let n = model.memoryPageNotice ?? model.memoryNotice {
        Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2)
      }
      HStack(alignment: .top, spacing: Space.xl) {
        VStack(alignment: .leading, spacing: Space.m) {
          Segmented("Show memory as", options: [(value: false, title: "Graph"), (value: true, title: "List")], selection: $asList)
            .frame(width: 200)
          if asList { list } else { graph }
          tellBox
        }
        .frame(maxWidth: .infinity)
        ScrollView {
          VStack(alignment: .leading, spacing: Space.xl) {
            inspector
            proposals
          }
        }
        .frame(width: 300)
      }
    }
    .padding(Space.xxl)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .onAppear { model.refreshMemoryPage() }
    .onExitCommand { if editing { editing = false } else { nav.page = .personal } }
    .alert("Forget everything?", isPresented: $confirmClear) {
      Button("Forget all", role: .destructive) {
        model.clearMemory()
        model.refreshMemoryPage()
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(verbatim: "Stephen will forget all \(model.memory.count) saved items. This can't be undone.")
    }
  }

  // MARK: header

  private var header: some View {
    HStack(spacing: Space.m) {
      Button { nav.page = .personal } label: {
        Text(verbatim: "‹ Personal").font(TypeScale.body).foregroundColor(t.accent)
      }
      .buttonStyle(.plain).accessibilityLabel("Back to Personal").help("Back to Personal (Esc)")
      Text(verbatim: "Memory").font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
      if let u = model.memoryUsage, u.warn {
        StatusPill("\(u.percent)% full", kind: .warn).help("Memory Stephen loads into each chat, of the 8 KB budget")
      }
      Spacer(minLength: Space.m)
      HStack(spacing: Space.s) {
        Image(systemName: "magnifyingglass").foregroundColor(t.ink2).accessibilityHidden(true)
        TextField("Search memory", text: $search).textFieldStyle(.plain).font(TypeScale.body).foregroundColor(t.ink)
          .focused($searchFocused).accessibilityLabel("Search memory")
      }
      .padding(.horizontal, Space.m).padding(.vertical, 6).frame(width: 200)
      .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface))
      .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.lineStrong, lineWidth: 1))
      Button("") { searchFocused = true }.keyboardShortcut("f", modifiers: .command).frame(width: 0, height: 0).opacity(0)
        .accessibilityHidden(true)
      Menu {
        if let u = model.memoryUsage {
          Text(verbatim: "Memory: \(u.percent)% of 8 KB per chat")
        }
        Button("Refresh") { model.refreshMemoryPage() }
        Button("Forget all…") { confirmClear = true }.disabled(model.memory.isEmpty)
      } label: {
        Image(systemName: "ellipsis.circle").font(.system(size: 18)).foregroundColor(t.ink2)
      }
      .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("More")
    }
  }

  private var chips: some View {
    HStack(spacing: Space.s) {
      ForEach(MEMORY_FILTERS) { f in
        let count = f.id == "new" ? model.suggestions.count : 0
        Tag(count > 0 ? "\(f.title) \(count)" : f.title, selected: filter == f.id) { filter = f.id }
      }
    }
    .accessibilityElement(children: .contain).accessibilityLabel("Filter")
  }

  // MARK: graph and list

  private var graph: some View {
    GeometryReader { geo in
      let nodes = shown
      let layout = memoryLayout(nodes, size: geo.size)
      let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
      ZStack {
        Path { p in
          for l in layout.labels {
            p.move(to: center)
            p.addLine(to: l.at)
          }
        }
        .stroke(t.line, lineWidth: 1)
        Path { p in
          for l in model.graphLinks {
            guard let a = layout.points[l.a], let b = layout.points[l.b] else { continue }
            p.move(to: a)
            p.addLine(to: b)
          }
        }
        .stroke(t.ink2.opacity(0.5), lineWidth: 1)
        Text(verbatim: "You").font(TypeScale.body.weight(.semibold)).foregroundColor(t.primaryText)
          .padding(.horizontal, Space.m).padding(.vertical, 6)
          .background(Capsule().fill(t.primary)).position(center).accessibilityHidden(true)
        ForEach(layout.labels) { l in
          Text(verbatim: memoryKindTitle(l.kind)).sectionLabelStyle(t)
            .padding(.horizontal, 6).background(t.surface).position(l.at).accessibilityHidden(true)
        }
        ForEach(nodes) { n in
          if let at = layout.points[n.id] { node(n).position(at) }
        }
        if nodes.isEmpty {
          Text(verbatim: model.graphNodes.isEmpty ? "Nothing saved yet. Tell Stephen something below." : "Nothing matches.")
            .font(TypeScale.secondary).foregroundColor(t.ink2).position(x: center.x, y: center.y + 40)
        }
      }
    }
    .frame(minHeight: 340)
    .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface))
    .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.line, lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Memory graph, \(shown.count) items. Choose List for the same items as a list.")
  }

  private func node(_ n: GraphNode) -> some View {
    let isSel = selected == n.id
    return Button { select(n.id) } label: {
      VStack(spacing: 3) {
        ZStack {
          Circle().fill(isSel ? t.accent : t.surface2).frame(width: 14, height: 14)
          if n.new {
            Circle().stroke(t.warn, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])).frame(width: 16, height: 16)
          } else if !isSel {
            Circle().stroke(t.ink2, lineWidth: 1).frame(width: 14, height: 14)
          }
        }
        Text(verbatim: n.text).font(.system(size: 11)).foregroundColor(isSel ? t.accent : t.ink).lineLimit(1)
          .frame(maxWidth: 110)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(n.text)
    .accessibilityLabel(nodeLabel(n))
    .accessibilityAddTraits(isSel ? [.isButton, .isSelected] : .isButton)
  }

  private func nodeLabel(_ n: GraphNode) -> String {
    return "\(memoryKindTitle(n.kind)): \(n.text)\(n.new ? ", new, not kept yet" : "")"
  }

  /** The same items as the graph, grouped by kind: the keyboard and VoiceOver friendly view. */
  private var list: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.l) {
        if shown.isEmpty {
          Text(verbatim: model.graphNodes.isEmpty ? "Nothing saved yet." : "Nothing matches.")
            .font(TypeScale.secondary).foregroundColor(t.ink2)
        }
        ForEach(MEMORY_KIND_ORDER, id: \.self) { kind in
          let group = shown.filter { $0.kind == kind }
          if !group.isEmpty {
            GroupedList(memoryKindTitle(kind)) {
              ForEach(Array(group.enumerated()), id: \.element.id) { i, n in
                Button { select(n.id) } label: {
                  GroupedRow(n.text, detail: n.new ? "New, not kept yet" : nil, first: i == 0) {
                    if selected == n.id { Image(systemName: "checkmark").foregroundColor(t.accent).accessibilityHidden(true) }
                  }
                  .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(nodeLabel(n))
                .accessibilityAddTraits(selected == n.id ? [.isButton, .isSelected] : .isButton)
              }
            }
          }
        }
      }
    }
    .frame(minHeight: 340)
  }

  private var tellBox: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      AskField("Tell Stephen", text: $tell) { submitTell() }
      Text(verbatim: "\"I moved to Fit4Less\" shows as New. Nothing is saved until you press Keep. Ask with a ? to search.")
        .font(TypeScale.secondary).foregroundColor(t.ink2)
    }
  }

  private func submitTell() {
    let text = tell.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return }
    if let q = tellStephenQuery(text) {
      search = q
      filter = "all"
    } else {
      model.proposeMemory(text)
      filter = "all"
    }
    tell = ""
  }

  private func select(_ id: String) {
    selected = id
    editing = false
  }

  // MARK: inspector

  @ViewBuilder
  private var inspector: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      Text(verbatim: "Selected").sectionLabelStyle(t).accessibilityAddTraits(.isHeader)
      if let n = selectedNode {
        VStack(alignment: .leading, spacing: Space.m) {
          Text(verbatim: memoryKindTitle(n.kind)).font(TypeScale.secondary).foregroundColor(t.ink2)
          if editing {
            TextField("Memory text", text: $editText).textFieldStyle(.plain).font(TypeScale.body).foregroundColor(t.ink)
              .padding(Space.s)
              .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.accent, lineWidth: 1))
              .onSubmit { saveEdit(n) }
              .accessibilityLabel("Edit memory text")
          } else {
            Text(verbatim: n.text).font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
          Text(verbatim: sourceLine(n)).font(TypeScale.secondary).foregroundColor(t.ink2)
          let related = relatedTo(n)
          if !related.isEmpty {
            Text(verbatim: "Related").sectionLabelStyle(t)
            ForEach(related) { r in
              Button { select(r.id) } label: {
                Text(verbatim: r.text).font(TypeScale.secondary).foregroundColor(t.accent).multilineTextAlignment(.leading)
              }
              .buttonStyle(.plain).accessibilityLabel("Related: \(r.text)")
            }
          }
          HStack(spacing: Space.s) {
            if editing {
              PrimaryButton(n.new ? "Keep" : "Save") { saveEdit(n) }
              QuietButton("Cancel") { editing = false }
            } else if n.new {
              PrimaryButton("Keep") { model.keepProposal(n.id) }
              QuietButton("Edit") { startEdit(n) }
              QuietButton("Skip") { model.skipProposal(n.id); selected = nil }
            } else {
              QuietButton("Edit") { startEdit(n) }
              QuietButton("Forget", destructive: true) {
                model.forgetMemory(n.id)
                selected = nil
                model.refreshMemoryPage()
              }
            }
          }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Corner.list).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: Corner.list).stroke(t.line, lineWidth: 1))
      } else {
        Text(verbatim: "Choose an item in the graph to see where it came from.").font(TypeScale.secondary).foregroundColor(t.ink2)
      }
    }
  }

  /** "You said · 2026-11-03 9:12", "From Canvas · you kept it · …", or for a proposal where it came from. */
  private func sourceLine(_ n: GraphNode) -> String {
    if n.new, let p = model.suggestions.first(where: { $0.id == n.id }) {
      return model.originLabel(p.origin) + (p.untrusted ? " · third-party text, check it" : "") + " · not kept yet"
    }
    if let item = model.memory.first(where: { $0.id == n.id }) { return model.memoryCaption(item) }
    return ""
  }

  private func relatedTo(_ n: GraphNode) -> [GraphNode] {
    let ids = Set(model.graphLinks.flatMap { l -> [String] in l.a == n.id ? [l.b] : l.b == n.id ? [l.a] : [] })
    return model.graphNodes.filter { ids.contains($0.id) }
  }

  private func startEdit(_ n: GraphNode) {
    editText = n.text
    editing = true
  }

  private func saveEdit(_ n: GraphNode) {
    let text = editText.trimmingCharacters(in: .whitespacesAndNewlines)
    editing = false
    if text.isEmpty { return }
    if n.new {
      model.keepProposal(n.id, text: text == n.text ? nil : text)
    } else if text != n.text {
      model.updateMemory(n.id, text: text)
      model.refreshMemoryPage()
    }
  }

  // MARK: proposals

  private var proposals: some View {
    GroupedList("New from your chats") {
      if model.suggestions.isEmpty {
        GroupedRow("Nothing new", detail: "What you tell Stephen below shows here first.", first: true)
      }
      ForEach(Array(model.suggestions.enumerated()), id: \.element.id) { i, p in
        VStack(alignment: .leading, spacing: 0) {
          if i > 0 { Rectangle().fill(t.line).frame(height: 1) }
          VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: p.text).font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
            Text(verbatim: model.originLabel(p.origin) + (p.untrusted ? " · third-party text, check it" : ""))
              .font(TypeScale.secondary).foregroundColor(p.untrusted ? t.warn : t.ink2)
            HStack(spacing: Space.s) {
              QuietButton("Skip") { model.skipProposal(p.id) }
              PrimaryButton("Keep") { model.keepProposal(p.id) }
            }
          }
          .padding(Space.l)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestion: \(p.text). \(model.originLabel(p.origin))\(p.untrusted ? ", third-party text" : "")")
      }
    }
  }
}
