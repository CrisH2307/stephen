// Stephen Helper: Activity (T6, docs/design/STOP-AND-ACTIVITY.md). One flat list, newest first, of what Stephen did in
// the last 24 hours: browser actions from audit.recent and jobs from jobs.list. A row opens the Conversations entry it
// belongs to. Never shown: args, error text, full URLs (host only), page text, a job's log. On private sites the
// listener already drops the label, intent and error (T6 step 3); this page never shows intent or error anywhere.

import SwiftUI

/** One Activity line. `text` is plain words; any page text in it is cleaned, quoted and cut (activityQuoted). */
struct ActivityRow: Identifiable, Equatable {
  let id: String
  let date: Date
  let text: String
  let result: String
  let kind: StatusKind
  /** The Conversations entry (history id) the row opens; nil when none is known. */
  var historyId: String? = nil
}

/** Untrusted text on one line: controls, line breaks and bidi marks become spaces, then it is cut at `max` characters. */
func activityClean(_ s: String, max: Int = 60) -> String {
  let flat = String(String.UnicodeScalarView(s.unicodeScalars.map { u in
    switch u.properties.generalCategory {
    case .control, .format, .lineSeparator, .paragraphSeparator: return " "
    default: return u
    }
  }))
  let one = flat.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  return one.count > max ? String(one.prefix(max - 1)) + "…" : one
}

/**
 * The element as `button "Play"`: the role, then the page's own label in quotes. The audit writes `role "name"`; a
 * quote inside the name becomes ' so the label can't close the quotes early. Anything else is quoted whole.
 */
func activityQuoted(_ element: String) -> String {
  if element.hasSuffix("\""), let q = element.firstIndex(of: "\""), q < element.index(before: element.endIndex) {
    let role = activityClean(String(element[..<q]), max: 20)
    let name = String(element[element.index(after: q)..<element.index(before: element.endIndex)])
    let quoted = "\"" + activityClean(name.replacingOccurrences(of: "\"", with: "'")) + "\""
    return role.isEmpty ? quoted : role + " " + quoted
  }
  return "\"" + activityClean(element.replacingOccurrences(of: "\"", with: "'")) + "\""
}

/** Host only: never the path or query, which can hold tokens or search words. "" for about:blank and junk. */
func activityHost(_ url: String) -> String {
  guard let h = URL(string: url)?.host, !h.isEmpty else { return "" }
  return activityClean(h, max: 80)
}

/** "Clicked button "Play" on youtube.com": the action in words, from kind and tool, with the host. */
func activityText(_ a: AuditEntry) -> String {
  let el = a.element.isEmpty ? "" : " " + activityQuoted(a.element)
  let before = activityHost(a.urlBefore), after = activityHost(a.urlAfter)
  // Where the action happened. A page or tab that opened names where it landed, or where it was asked from.
  func on(_ h: String) -> String { return h.isEmpty ? "" : " on " + h }
  switch a.kind {
  case "navigate", "tab_open":
    let what = a.kind == "navigate" ? "Opened a page" : "Opened a tab"
    return what + (!after.isEmpty ? " on " + after : before.isEmpty ? "" : " from " + before)
  case "tab_close": return "Closed a tab" + on(before)
  case "click": return "Clicked" + el + on(before)
  case "hover": return "Pointed at" + (el.isEmpty ? " something" : el) + on(before)
  case "type": return "Typed into" + (el.isEmpty ? " a field" : el) + on(before)
  case "select": return "Chose an option in" + (el.isEmpty ? " a list" : el) + on(before)
  case "press": return "Pressed a key" + on(before)
  case "scroll": return "Scrolled" + on(before)
  case "upload": return "Uploaded a file" + on(before)
  case "dialog": return "Answered a dialog" + on(before)
  case "evaluate": return "Ran a script" + on(before)
  case "read": return "Read a page" + on(before)
  default: return "Used " + activityClean(a.tool, max: 40) + on(before.isEmpty ? after : before)
  }
}

/** The result in words, never color alone. */
func activityResult(_ a: AuditEntry) -> (word: String, kind: StatusKind) {
  switch a.outcome {
  case "ok": return a.confirmation == "approved" ? ("you allowed", .ok) : ("done", .ok)
  case "denied": return a.confirmation == "declined" ? ("you said no", .idle) : ("refused", .warn)
  default: return ("failed", .bad)
  }
}

/** A job's result. Stops come only from the owner (jobs.stop is a click in the app), so "stopped by you" is true. */
func activityJobResult(_ status: String) -> (word: String, kind: StatusKind) {
  switch status {
  case "queued": return ("waiting", .warn)
  case "running": return ("running", .ok)
  case "done": return ("done", .ok)
  case "stopped": return ("stopped by you", .idle)
  case "timeout": return ("failed, timed out", .bad)
  default: return ("failed", .bad)
  }
}

/**
 * The page's rows: audit and jobs of the last 24 h before `now`, newest first. Job audit lines are left out (the job
 * row says it). An allowed action writes two lines, the gate's decision and then the result (src/safety/gate.ts,
 * src/server/hub.ts). A decision line (ok, no urlAfter) is dropped when the newer line kept just before it is the same
 * action and has not taken a decision yet. "Before it" is in the same tab: two tabs can interleave their lines. "Same
 * action" is tool, kind and host (the two lines write the label and URL in different forms). A new tab's decision line
 * says tab "new", and older lines have none: those use the line kept just before, in any tab. ponytail: two of the
 * same action in the same tab at the same moment could still pair the wrong way round.
 */
func activityRows(audit: [AuditEntry], jobs: [JobRow], history: [HistoryEntry], now: Date,
                  parse: (String) -> Date?) -> [ActivityRow] {
  let since = now.addingTimeInterval(-24 * 3600)
  var rows: [ActivityRow] = []
  let ids = Set(history.map { $0.id })
  var kept: [Int: AuditEntry] = [:]
  var paired = Set<Int>()
  var last: Int? = nil
  var lastInTab: [String: Int] = [:]
  for (i, a) in audit.enumerated() {  // audit arrives newest first
    guard let d = parse(a.ts), d >= since, !a.tool.hasPrefix("job_") else { continue }
    let inTab = !a.tab.isEmpty && a.tab != "new"
    if a.outcome == "ok", a.urlAfter.isEmpty, let j = inTab ? lastInTab[a.tab] : last, !paired.contains(j), let n = kept[j],
       n.tool == a.tool, n.kind == a.kind, activityHost(n.urlBefore) == activityHost(a.urlBefore) {
      paired.insert(j)
      continue
    }
    kept[i] = a
    last = i
    if !a.tab.isEmpty { lastInTab[a.tab] = i }
    let r = activityResult(a)
    rows.append(ActivityRow(id: "a\(i)", date: d, text: activityText(a), result: r.word, kind: r.kind,
                            historyId: activityHistoryId(a, at: d, history: history, ids: ids, parse: parse)))
  }
  for j in jobs {
    let d = Date(timeIntervalSince1970: (j.endedAt ?? j.startedAt ?? j.createdAt) / 1000.0)
    guard d >= since else { continue }
    let r = activityJobResult(j.status)
    // The task is the owner's own words: quoted, one line.
    rows.append(ActivityRow(id: "j" + j.id, date: d, text: "Job \"" + activityClean(j.task) + "\"", result: r.word, kind: r.kind))
  }
  return rows.sorted { $0.date > $1.date }
}

/** The history id of the command an entry belongs to: its `cmd`, or for older lines the command running at that time. */
func activityHistoryId(_ a: AuditEntry, at d: Date, history: [HistoryEntry], ids: Set<String>, parse: (String) -> Date?) -> String? {
  if !a.cmd.isEmpty { return ids.contains(a.cmd) ? a.cmd : nil }
  return history.first { e in
    guard let end = parse(e.ts) else { return false }
    return d >= end.addingTimeInterval(-e.ms / 1000.0 - 2) && d <= end.addingTimeInterval(2)
  }?.id
}

struct ActivityPage: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @ObservedObject var nav: WindowNav

  var body: some View {
    let rows = activityRows(audit: model.audit, jobs: model.jobs, history: model.history, now: Date(), parse: model.parseDate)
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        Text(verbatim: "What Stephen did in the last 24 hours, newest first. Built from the logs on this Mac.")
          .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
        if let n = model.auditNotice ?? model.jobsNotice ?? (model.jobsListOk == false ? JOBS_LIST_FAILED : nil) { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
        if model.audit.count >= AppModel.auditLimit {
          Text(verbatim: "Showing the last \(AppModel.auditLimit) actions.").font(TypeScale.secondary).foregroundColor(t.ink2)
        }
        if rows.isEmpty {
          Text(verbatim: "Nothing in the last 24 hours.").font(TypeScale.body).foregroundColor(t.ink2)
        } else {
          GroupedList {
            ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
              ActivityItem(row: r, first: i == 0, open: r.historyId.map { id in { open(id) } })
            }
          }
        }
      }
      .padding(Space.xxl)
      .frame(maxWidth: 720, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear { model.refreshAudit(); model.refreshJobs(); model.refreshHistory() }
  }

  /** Conversations with that entry open. Only navigates. */
  private func open(_ id: String) {
    nav.conversationQuery = ""
    nav.conversationOpen = id
    nav.page = .conversations
    model.loadVersions(id)
  }
}

/** One line: time, the action in words, the result. A row with a conversation is a button that opens it. */
private struct ActivityItem: View {
  @Environment(\.stephenTheme) var t
  let row: ActivityRow
  let first: Bool
  let open: (() -> Void)?

  var body: some View {
    let time = row.date.formatted(date: .omitted, time: .shortened)
    let line = HStack(alignment: .firstTextBaseline, spacing: Space.m) {
      Text(verbatim: time).font(TypeScale.secondary).foregroundColor(t.ink2).frame(width: 72, alignment: .leading)
      Text(verbatim: row.text).font(TypeScale.body).foregroundColor(t.ink).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: Space.m)
      StatusPill(row.result, kind: row.kind)
      if open != nil {
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundColor(t.ink2)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, Space.l).padding(.vertical, Space.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    // A String, not a literal: a literal would treat page text as a localization key.
    let spoken: String = "\(time). \(row.text). \(row.result)"
    VStack(spacing: 0) {
      if !first { Rectangle().fill(t.line).frame(height: 1) }
      if let open = open {
        Button(action: open) { line }.buttonStyle(.plain)
          .accessibilityElement(children: .ignore).accessibilityLabel(spoken)
          .accessibilityHint("Opens this in Conversations").accessibilityAddTraits(.isButton)
      } else {
        line.accessibilityElement(children: .ignore).accessibilityLabel(spoken)
      }
    }
  }
}
