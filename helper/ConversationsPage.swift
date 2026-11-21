// Stephen Helper: Conversations (UI-PLAN v3.1 section 4). One list of what you asked, grouped by day, each with what
// Stephen did (browser actions from the audit log that happened during the command, plus the other tools it used)
// and refusals named in words. Replaces the old History / Audit switch. No new protocol: history.list + audit.recent
// joined here by time.

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

/** The outcome in words, nil for a normal one. */
func conversationOutcomeWord(_ outcome: String) -> (word: String, kind: StatusKind)? {
  switch outcome {
  case "error": return ("Failed", .bad)
  case "cancelled": return ("Stopped", .idle)
  case "memory": return ("Memory", .idle)
  default: return nil
  }
}

/** Search: case-insensitive match on what was said, the reply and the action lines. */
func conversationMatches(_ entry: HistoryEntry, lines: [DoneLine], query: String) -> Bool {
  let q = query.trimmingCharacters(in: .whitespaces).lowercased()
  if q.isEmpty { return true }
  let hay = ([entry.said, entry.reply] + lines.map { $0.text }).joined(separator: "\n").lowercased()
  return hay.contains(q)
}

struct ConversationsPage: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  /// The toolbar's ⋯ menu sets nav.confirmClearAll; the alert is here, next to the list it deletes.
  @ObservedObject var nav: WindowNav
  @State private var search = ""

  /// Entries with their lines, grouped by day, after the search filter.
  private var days: [(day: HistoryDay, rows: [(entry: HistoryEntry, lines: [DoneLine])])] {
    model.historyDays.compactMap { day in
      let rows = day.entries.map { (entry: $0, lines: conversationLines(entry: $0, audit: model.audit, parse: model.parseDate)) }
        .filter { conversationMatches($0.entry, lines: $0.lines, query: search) }
      return rows.isEmpty ? nil : (day: day, rows: rows)
    }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        if let n = model.historyNotice ?? model.auditNotice { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
        if model.history.isEmpty {
          Text(verbatim: "Nothing yet. What you ask Stephen, and what it does, is listed here.")
            .font(TypeScale.body).foregroundColor(t.ink2)
        } else {
          searchField
          let shown = days
          if shown.isEmpty {
            Text(verbatim: "Nothing matches \"\(search)\".").font(TypeScale.body).foregroundColor(t.ink2)
          }
          ForEach(shown, id: \.day.id) { group in
            GroupedList(group.day.title) {
              ForEach(Array(group.rows.enumerated()), id: \.element.entry.id) { i, row in
                ConversationRow(entry: row.entry, lines: row.lines, time: model.timeText(row.entry.ts),
                                source: model.sourceLabel(row.entry.source), first: i == 0)
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
      TextField("Search conversations", text: $search).textFieldStyle(.plain).font(TypeScale.body).foregroundColor(t.ink)
        .accessibilityLabel("Search conversations")
    }
    .padding(.horizontal, Space.m).padding(.vertical, 8)
    .background(RoundedRectangle(cornerRadius: Corner.row).fill(t.surface))
    .overlay(RoundedRectangle(cornerRadius: Corner.row).stroke(t.lineStrong, lineWidth: 1))
  }
}

private struct ConversationRow: View {
  @Environment(\.stephenTheme) var t
  let entry: HistoryEntry
  let lines: [DoneLine]
  let time: String
  let source: String
  let first: Bool

  var body: some View {
    VStack(spacing: 0) {
      if !first { Rectangle().fill(t.line).frame(height: 1) }
      VStack(alignment: .leading, spacing: Space.s) {
        HStack(spacing: Space.s) {
          Text(verbatim: time).font(TypeScale.mono).foregroundColor(t.ink2)
          Text(verbatim: source + (entry.followUp ? ", follow-up" : "")).font(TypeScale.secondary).foregroundColor(t.ink2)
          Spacer(minLength: 0)
          if let o = conversationOutcomeWord(entry.outcome) { StatusPill(o.word, kind: o.kind) }
        }
        Text(verbatim: entry.said).font(TypeScale.body).foregroundColor(t.ink).textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        if !entry.reply.isEmpty {
          Text(verbatim: entry.reply).font(TypeScale.body).foregroundColor(t.ink2).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
          HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            StepMark(status: l.status)
            Text(verbatim: l.text).font(TypeScale.secondary).foregroundColor(l.status == .ok ? t.ink2 : t.ink)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(.horizontal, Space.l).padding(.vertical, Space.m)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(label)
  }

  private var label: String {
    var s = "\(time), \(source). You said: \(entry.said)."
    if !entry.reply.isEmpty { s += " Stephen replied: \(entry.reply)." }
    if let o = conversationOutcomeWord(entry.outcome) { s += " \(o.word)." }
    for l in lines { s += " \(l.text)." }
    return s
  }
}
