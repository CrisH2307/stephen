// T6 step 4: the Activity row text rules, run against the real helper sources (every HELPER_SOURCES file except
// helper/main.swift). Prints "ok", or each failed check and exits 1. Driven by test/helper/swift.int.test.ts.

import Foundation

var failed = 0
func check(_ ok: Bool, _ what: String) {
  if !ok { failed += 1; print("FAIL: \(what)") }
}

func audit(_ json: String) -> AuditEntry { return try! JSONDecoder().decode(AuditEntry.self, from: Data(json.utf8)) }
let parse: (String) -> Date? = { ISO8601DateFormatter().date(from: $0) }
let now = ISO8601DateFormatter().date(from: "2026-11-26T15:00:00Z")!

// Host only, never the path or query. Never args, never error text.
let click = audit(#"{"ts":"2026-11-26T14:14:00Z","tool":"click","kind":"click","element":"button \"Play\"","urlBefore":"https://www.youtube.com/watch?v=abc&token=s3cret","urlAfter":"https://www.youtube.com/watch?v=abc","outcome":"ok","args":{"text":"[9 chars] \"my secret\""},"cmd":"h_0123456789abcdef"}"#)
check(activityText(click) == #"Clicked button "Play" on www.youtube.com"#, "click text: \(activityText(click))")
let failedType = audit(#"{"ts":"2026-11-26T14:31:00Z","tool":"type","kind":"type","urlBefore":"https://docs.google.com/document/d/1/edit","outcome":"error","error":"Page said: your code is 771204"}"#)
check(activityText(failedType) == "Typed into a field on docs.google.com", "type text: \(activityText(failedType))")
check(activityResult(failedType).word == "failed", "error is just failed")

// Results in words.
check(activityResult(audit(#"{"outcome":"ok","confirmation":"approved"}"#)).word == "you allowed", "approved")
check(activityResult(audit(#"{"outcome":"denied","confirmation":"declined"}"#)).word == "you said no", "declined")
check(activityResult(audit(#"{"outcome":"denied","verdict":"deny"}"#)).word == "refused", "refused")
check(activityJobResult("stopped").word == "stopped by you", "job stopped")

// Page text is quoted, one line, cut at 60, and can't close the quotes early.
let long = String(repeating: "x", count: 80)
let q = activityQuoted("button \"\(long)\"")
check(q == "button \"" + String(repeating: "x", count: 59) + "…\"", "60 character cut: \(q)")
check(activityQuoted("link \"a\nb\u{202E}c \" on evil.com\"") == #"link "a b c ' on evil.com""#, "one line, inner quote: \(activityQuoted("link \"a\nb\u{202E}c \" on evil.com\""))")
check(activityQuoted("plain label") == #""plain label""#, "quoted whole")

// A page that opened names where it landed; without one, where it was asked from. about:blank has no host.
check(activityText(audit(#"{"kind":"tab_open","urlBefore":"about:blank","urlAfter":"https://mail.google.com/mail/u/0/#inbox"}"#)) == "Opened a tab on mail.google.com", "tab_open")
check(activityText(audit(#"{"kind":"navigate","urlBefore":"https://a.example/x","outcome":"denied"}"#)) == "Opened a page from a.example", "denied navigate")

// Rows: newest first, last 24 h only, the gate's decision line folded into its result, job audit lines left out,
// joined by cmd (or by time for older lines).
let history = try! JSONDecoder().decode([HistoryEntry].self, from: Data(#"[{"id":"h_0123456789abcdef","ts":"2026-11-26T14:14:05Z","ms":10000},{"id":"h_old","ts":"2026-11-26T14:31:02Z","ms":5000}]"#.utf8))
let gate = audit(#"{"ts":"2026-11-26T14:13:59Z","tool":"click","kind":"click","element":"button \"Play\"","urlBefore":"https://www.youtube.com/watch?v=abc","outcome":"ok"}"#)
let jobAudit = audit(#"{"ts":"2026-11-26T14:20:00Z","tool":"job_stop","outcome":"ok"}"#)
let old = audit(#"{"ts":"2026-11-25T14:00:00Z","tool":"click","kind":"click","outcome":"ok"}"#)
let job = try! JSONDecoder().decode(JobRow.self, from: Data(#"{"id":"2026-11-26-sort","task":"Sort my\ndownloads","status":"stopped","createdAt":1795701600000,"endedAt":1795702800000}"#.utf8))
let rows = activityRows(audit: [failedType, jobAudit, click, gate, old], jobs: [job], history: history, now: now, parse: parse)
check(rows.map { $0.text } == ["Typed into a field on docs.google.com", "Job \"Sort my downloads\"", #"Clicked button "Play" on www.youtube.com"#], "rows: \(rows.map { $0.text })")
check(rows.map { $0.historyId } == ["h_old", nil, "h_0123456789abcdef"], "joins: \(rows.map { $0.historyId })")
// Two tabs on the same host at once, lines interleaved (result A, result B, decision B, decision A): each decision
// folds into its own tab's result, so each click shows once. A new tab's decision line ("new") folds into its result.
func tabLine(_ ts: String, _ tab: String, after: Bool) -> AuditEntry {
  return audit(#"{"ts":"\#(ts)","tool":"click","kind":"click","urlBefore":"https://www.youtube.com/","outcome":"ok","tab":"\#(tab)""# + (after ? #","urlAfter":"https://www.youtube.com/x"}"# : "}"))
}
let two = activityRows(audit: [tabLine("2026-11-26T14:40:04Z", "z1", after: true), tabLine("2026-11-26T14:40:03Z", "z2", after: true),
                               tabLine("2026-11-26T14:40:02Z", "z2", after: false), tabLine("2026-11-26T14:40:01Z", "z1", after: false)],
                       jobs: [], history: [], now: now, parse: parse)
check(two.count == 2, "two tabs: \(two.count) rows")
let opened = activityRows(audit: [audit(#"{"ts":"2026-11-26T14:50:01Z","tool":"tab_open","kind":"tab_open","urlBefore":"about:blank","urlAfter":"https://a.example/","outcome":"ok","tab":"z3"}"#),
                                  audit(#"{"ts":"2026-11-26T14:50:00Z","tool":"tab_open","kind":"tab_open","urlBefore":"about:blank","outcome":"ok","tab":"new"}"#)],
                          jobs: [], history: [], now: now, parse: parse)
check(opened.count == 1, "new tab folds: \(opened.count) rows")

// Nothing secret reaches any row.
for r in rows { for s in ["s3cret", "771204", "my secret", "watch", "token"] { check(!r.text.contains(s), "leak \(s) in \(r.text)") } }

if failed > 0 { exit(1) }
print("ok")
