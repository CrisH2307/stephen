// Stephen Helper: Conversations (UI-V4-IA-PLAN section 6.2). Intro line, search and the All, Refused, Failed chips,
// then day groups of rows: what you asked (verbatim), a facts line and the status word. A row opens to show the reply
// and every step; refused and failed lines always show, open or closed. No new protocol: history.list +
// audit.recent joined here by time.

import SwiftUI

/** One line under a reply: what Stephen did, refused or tried and failed. */
struct DoneLine: Equatable {
  var text: String
  var status: StepStatus
}

/** Audit entry in words: `click button "Send"`. Only fields the audit already redacts. */
func auditActionText(_ a: AuditEntry) -> String {
  var parts = [a.kind.isEmpty ? a.tool : a.kind]
  if !a.element.isEmpty { parts.append(a.element) }
  return parts.joined(separator: " ")
}

/**
 * What Stephen did for one command. Audit entries whose time falls inside the command (it finished at `ts` and took
 * `ms`, plus 2 s of slack) are listed; a denied one reads "Refused: ...". Other tools from the history entry follow
 * as one line. ponytail: matching is by time only, the audit has no command id; two commands at once could swap lines.
 */
func conversationLines(entry: HistoryEntry, audit: [AuditEntry], parse: (String) -> Date?) -> [DoneLine] {
  var lines: [DoneLine] = []
  var auditTools = Set<String>()
  if let end = parse(entry.ts) {
    let start = end.addingTimeInterval(-entry.ms / 1000.0 - 2)
    let stop = end.addingTimeInterval(2)
    for a in audit.reversed() {  // audit arrives newest first; show oldest first
      guard let d = parse(a.ts), d >= start, d <= stop else { continue }
      auditTools.insert(a.tool)
      if a.outcome == "denied" {
        let why = !a.error.isEmpty ? a.error : (a.verdict == "confirm" ? "you did not allow it" : "Stephen's safety rules")
        lines.append(DoneLine(text: "Refused: \(auditActionText(a)). \(why)", status: .refused))
      } else if a.outcome == "error" {
        lines.append(DoneLine(text: "Tried \(auditActionText(a)), it failed", status: .failed))
      } else {
        lines.append(DoneLine(text: auditActionText(a), status: .ok))
      }
    }
  }
  // Same words as the chat's steps (src/app/steps.ts): one line per other tool.
  for c in entry.tools where !auditTools.contains(c.tool) {
    lines.append(c.isError ? DoneLine(text: "Tried \(c.tool), it failed", status: .failed)
                           : DoneLine(text: "Used \(c.tool)", status: .ok))
  }
  return lines
}

/** Search: case-insensitive match on what was said, the reply and the action lines. */
func conversationMatches(_ entry: HistoryEntry, lines: [DoneLine], query: String) -> Bool {
  let q = query.trimmingCharacters(in: .whitespaces).lowercased()
  if q.isEmpty { return true }
  let hay = ([entry.said, entry.reply] + lines.map { $0.text }).joined(separator: "\n").lowercased()
  return hay.contains(q)
}

/** Filter chips (plan 6.2). Refused and Failed keep a row with that kind of line; a row can be in both. */
let CONVERSATION_FILTERS = [
  MemoryFilter(id: "all", title: "All"), MemoryFilter(id: "refused", title: "Refused"), MemoryFilter(id: "failed", title: "Failed"),
]

/** One conversation row's data: the entry and its step lines. The page and the palette both use it. */
struct ConversationRecord {
  let entry: HistoryEntry
  let lines: [DoneLine]
}

/**
 * Rows that pass the search (conversationMatches) and the chip: a pure filter on top of it. `keep` is the row a
 * palette result opened: it stays even when the chip would hide it, so "that row open" always holds.
 */
func conversationRows(_ entries: [HistoryEntry], audit: [AuditEntry], parse: (String) -> Date?, query: String,
                      filter: String = "all", keep: String? = nil) -> [ConversationRecord] {
  return entries.map { ConversationRecord(entry: $0, lines: conversationLines(entry: $0, audit: audit, parse: parse)) }
    .filter { r in
      guard conversationMatches(r.entry, lines: r.lines, query: query) else { return false }
      if r.entry.id == keep { return true }
      switch filter {
      case "refused": return r.lines.contains { $0.status == .refused }
      case "failed": return r.entry.outcome == "error" || r.lines.contains { $0.status == .failed }
      default: return true
      }
    }
}

/** "Stephen app · 2:10 PM · 3 steps · 1 refused": the chat's format, never just "done". */
func conversationFacts(_ entry: HistoryEntry, lines: [DoneLine], source: String, time: String) -> String {
  var parts = [source + (entry.followUp ? ", follow-up" : ""), time]
  if !lines.isEmpty { parts.append(lines.count == 1 ? "1 step" : "\(lines.count) steps") }
  let refused = lines.filter { $0.status == .refused }.count, failed = lines.filter { $0.status == .failed }.count
  if refused > 0 { parts.append("\(refused) refused") }
  if failed > 0 { parts.append("\(failed) failed") }
  return parts.joined(separator: " · ")
}

struct ConversationsPage: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  /// The search text and the open row live in nav, so a palette result can set both. The toolbar's ⋯ menu sets
  /// nav.confirmClearAll; the alert is here, next to the list it deletes.
  @ObservedObject var nav: WindowNav
  @State private var filter = "all"

  /// Rows grouped by day, after the search and the chip.
  private var days: [(day: HistoryDay, rows: [ConversationRecord])] {
    model.historyDays.compactMap { day in
      let rows = conversationRows(day.entries, audit: model.audit, parse: model.parseDate, query: nav.conversationQuery,
                                  filter: filter, keep: nav.conversationOpen)
      return rows.isEmpty ? nil : (day: day, rows: rows)
    }
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: Space.xl) {
          // S4: one honest sentence.
          Text(verbatim: "What you asked, what Stephen did, and what it refused. The list is saved on this Mac.")
            .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
          if let n = model.historyNotice ?? model.auditNotice { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
          if model.history.isEmpty {
            Text(verbatim: "Nothing yet. What you ask Stephen, and what it does, is listed here.")
              .font(TypeScale.body).foregroundColor(t.ink2)
          } else {
            VStack(alignment: .leading, spacing: Space.m) {
              searchField
              chips
            }
            let shown = days
            if shown.isEmpty {
              Text(verbatim: nav.conversationQuery.isEmpty ? "Nothing here." : "Nothing matches \"\(nav.conversationQuery)\".")
                .font(TypeScale.body).foregroundColor(t.ink2)
            }
            ForEach(shown, id: \.day.id) { group in
              GroupedList(group.day.title) {
                ForEach(Array(group.rows.enumerated()), id: \.element.entry.id) { i, row in
                  ConversationItem(entry: row.entry, lines: row.lines, time: model.timeText(row.entry.ts),
                                   source: model.sourceLabel(row.entry.source), first: i == 0,
                                   expanded: nav.conversationOpen == row.entry.id,
                                   toggle: { nav.conversationOpen = nav.conversationOpen == row.entry.id ? nil : row.entry.id })
                    .id(row.entry.id)
                }
              }
            }
            if model.historyMayHaveMore {
              QuietButton("Load older") { model.loadOlderHistory() }
            }
          }
        }
        .padding(Space.xxl)
        .frame(maxWidth: 720, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      // A palette result opened this page on a row: bring it into view.
      .onAppear { if let id = nav.conversationOpen { proxy.scrollTo(id, anchor: .top) } }
    }
    .onAppear { model.refreshHistory(); model.refreshAudit() }
    .alert("Clear all conversations?", isPresented: $nav.confirmClearAll) {
      Button("Clear", role: .destructive) { model.clearHistory() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(verbatim: "Every saved command and reply is deleted. Memory is not affected.")
    }
  }

  private var searchField: some View {
    HStack(spacing: Space.s) {
      Image(systemName: "magnifyingglass").foregroundColor(t.ink2).accessibilityHidden(true)
      TextField("Search conversations", text: $nav.conversationQuery).textFieldStyle(.plain).font(TypeScale.body)
        .foregroundColor(t.ink).accessibilityLabel("Search conversations")
    }
    .padding(.horizontal, Space.m).padding(.vertical, 8)
    .background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface))
    .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.lineStrong, lineWidth: 1))
  }

  /// The same chips as Memory.
  private var chips: some View {
    HStack(spacing: Space.s) {
      ForEach(CONVERSATION_FILTERS) { f in Tag(f.title, selected: filter == f.id) { filter = f.id }.fixedSize() }
    }
    .accessibilityElement(children: .contain).accessibilityLabel("Filter")
  }
}

/** One S5 row: title (what you asked, verbatim), facts line, status word. A click opens the reply and every step. */
private struct ConversationItem: View {
  @Environment(\.stephenTheme) var t
  let entry: HistoryEntry
  let lines: [DoneLine]
  let time: String
  let source: String
  let first: Bool
  let expanded: Bool
  let toggle: () -> Void

  var body: some View {
    let word = recentChatWord(entry, lines: lines)
    let facts = conversationFacts(entry, lines: lines, source: source, time: time)
    // A String, not a literal: a literal picks the LocalizedStringKey overload for third-party text.
    let spoken: String = "You said: \(entry.said). \(word.word). \(facts)"
    VStack(spacing: 0) {
      if !first { Rectangle().fill(t.line).frame(height: 1) }
      VStack(alignment: .leading, spacing: Space.s) {
        // A real button (#145), like a job row: Tab reaches it and Space opens it.
        Button(action: toggle) {
          HStack(alignment: .top, spacing: Space.m) {
            VStack(alignment: .leading, spacing: 2) {
              Text(verbatim: entry.said).font(TypeScale.body).foregroundColor(t.ink).lineLimit(expanded ? 1 : 2)
                .fixedSize(horizontal: false, vertical: true)
              Text(verbatim: facts).font(TypeScale.secondary).foregroundColor(t.ink2)
            }
            Spacer(minLength: Space.m)
            StatusPill(word.word, kind: word.kind)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundColor(t.ink2)
              .rotationEffect(.degrees(expanded ? 90 : 0)).frame(width: 24, height: 24).accessibilityHidden(true)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityHint(expanded ? "Hides the reply and the steps" : "Shows the reply and the steps")
        .accessibilityAddTraits(.isButton)
        // Open: what you said in full, copyable (a Button label can't be selected).
        if expanded {
          Text(verbatim: entry.said).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        if expanded && !entry.reply.isEmpty {
          Text(verbatim: entry.reply).font(TypeScale.body).foregroundColor(t.ink2).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        // [DEV REVIEW] Safety: steps and refusals are a truthful record. A refused or failed line shows open or
        // closed (only ok lines wait for the open row), in order, in its own words.
        ForEach(Array(lines.filter { expanded || $0.status != .ok }.enumerated()), id: \.offset) { _, l in
          HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            StepMark(status: l.status)
            Text(verbatim: l.text).font(TypeScale.secondary).foregroundColor(l.status == .ok ? t.ink2 : t.ink)
              .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(.horizontal, Space.l).padding(.vertical, Space.m)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .contain)
  }
}
