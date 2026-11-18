// Stephen Helper: Jobs (UI-PLAN v3.1 section 4). A grouped list: Running first, then the rest. Each job shows its
// status in words, how long it ran and what it cost so far (budget used), the job's own summary (shown as written,
// so check it), Stop for running jobs (the owner's own click, as before) and Reveal in Finder for the output folder.

import AppKit
import SwiftUI

/** Job status as a word and a kind. Never color alone. */
func jobStatusWord(_ status: String) -> (word: String, kind: StatusKind) {
  switch status {
  case "queued": return ("Waiting", .warn)
  case "running": return ("Running", .ok)
  case "done": return ("Finished", .idle)
  case "stopped": return ("Stopped", .idle)
  case "timeout": return ("Failed, timed out", .bad)
  default: return ("Failed", .bad)
  }
}

/** "3 min, $0.12": time and money used, whatever is known. */
func jobUsedText(_ job: JobRow, now: Double) -> String {
  var parts: [String] = []
  if let s = job.startedAt { parts.append(jobDurationText(from: s, to: job.endedAt ?? now)) }
  if let c = job.costUsd { parts.append(String(format: "$%.2f spent", c)) }
  return parts.joined(separator: ", ")
}

/** "3 min", "1 h 05 min": whole minutes between two epoch-millisecond times. */
func jobDurationText(from: Double, to: Double) -> String {
  let minutes = max(0, Int((to - from) / 60000.0))
  if minutes < 60 { return "\(minutes) min" }
  let rest = minutes % 60
  return "\(minutes / 60) h \(rest < 10 ? "0" : "")\(rest) min"
}

struct JobsView: View {
  @Environment(\.stephenTheme) var t
  @ObservedObject var model: AppModel
  @State private var openId: String? = nil

  var body: some View {
    let running = model.jobs.filter { $0.isRunning }
    let past = model.jobs.filter { !$0.isRunning }
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        Text(verbatim: "Jobs").font(TypeScale.pageTitle).foregroundColor(t.ink).accessibilityAddTraits(.isHeader)
        if let n = model.jobsNotice { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
        if model.jobs.isEmpty {
          Text(verbatim: "No jobs yet. Say \"start a job to ...\" and it shows up here.").font(TypeScale.body).foregroundColor(t.ink2)
        }
        if !running.isEmpty { group("Running", running) }
        if !past.isEmpty { group("Earlier", past) }
        if !model.jobs.isEmpty {
          Text(verbatim: "The summary is written by the job itself, so check it before you rely on it.")
            .font(TypeScale.secondary).foregroundColor(t.ink2)
        }
      }
      .padding(Space.xxl)
      .frame(maxWidth: 720, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear { model.refreshJobs() }
    // Poll every 5 s only while a job runs (#202): each answer reassigns model.jobs, which redraws every view
    // watching the model. SwiftUI cancels this loop when the page goes away or the running state flips.
    .task(id: !running.isEmpty) {
      while !Task.isCancelled && model.jobs.contains(where: { $0.isRunning }) {
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        if Task.isCancelled { break }
        model.refreshJobs()
      }
    }
    // A job started from the Ask box while this page is open: pick it up once the reply ends.
    .onReceive(model.$state.dropFirst().removeDuplicates()) { s in if s == "idle" { model.refreshJobs() } }
  }

  private func group(_ title: String, _ jobs: [JobRow]) -> some View {
    GroupedList(title) {
      ForEach(Array(jobs.enumerated()), id: \.element.id) { i, job in
        JobItem(job: job, first: i == 0, expanded: openId == job.id,
                toggle: { openId = openId == job.id ? nil : job.id }, stop: { model.stopJob(job.id) })
      }
    }
  }
}

private struct JobItem: View {
  @Environment(\.stephenTheme) var t
  let job: JobRow
  let first: Bool
  let expanded: Bool
  let toggle: () -> Void
  let stop: () -> Void

  var body: some View {
    let s = jobStatusWord(job.status)
    let used = jobUsedText(job, now: Date().timeIntervalSince1970 * 1000.0)
    VStack(spacing: 0) {
      if !first { Rectangle().fill(t.line).frame(height: 1) }
      VStack(alignment: .leading, spacing: Space.s) {
        HStack(alignment: .top, spacing: Space.m) {
          // A real button (#145): Tab reaches it with Full Keyboard Access and Space opens it. Stop and the folder
          // button stay outside it, so they are their own buttons.
          Button(action: toggle) {
            HStack(alignment: .top, spacing: Space.m) {
              VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: job.task).font(TypeScale.body).foregroundColor(t.ink).lineLimit(expanded ? nil : 2)
                  .fixedSize(horizontal: false, vertical: true)
                if !used.isEmpty { Text(verbatim: used).font(TypeScale.secondary).foregroundColor(t.ink2) }
              }
              Spacer(minLength: Space.m)
              StatusPill(s.word, kind: s.kind)
              Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundColor(t.ink2)
                .rotationEffect(.degrees(expanded ? 90 : 0)).frame(width: 24, height: 24).accessibilityHidden(true)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(job.task). \(s.word). \(used)")
          .accessibilityHint(expanded ? "Hides the summary" : "Shows the summary")
          .accessibilityAddTraits(.isButton)
          if job.isRunning { QuietButton("Stop", destructive: true, action: stop).accessibilityLabel("Stop job: \(job.task)") }
        }
        if expanded {
          Text(verbatim: bodyText).font(TypeScale.secondary).foregroundColor(t.ink).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          Text(verbatim: "\(job.turns) turns").font(TypeScale.secondary).foregroundColor(t.ink2)
          if !job.folder.isEmpty {
            QuietButton("Open output folder", symbol: "folder") {
              NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: job.folder)])
            }
          }
        }
      }
      .padding(.horizontal, Space.l).padding(.vertical, Space.m)
    }
    .accessibilityElement(children: .contain)
  }

  private var bodyText: String {
    if !job.summary.isEmpty { return job.summary }
    if !job.error.isEmpty { return job.error }
    return job.isRunning ? "Still working. The summary appears here when it finishes." : "No summary."
  }
}
