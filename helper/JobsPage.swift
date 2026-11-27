// Stephen Helper: Jobs (UI-V4-IA-PLAN section 6.4). Intro line with the caution (R9), then Running (open), Failed
// (open, never an accordion: a failed job is never hidden, however old), then the closed accordion Earlier (N) for
// the rest. Each row: the task, a facts line ("Started 2:10 PM · 3 min · $0.12 spent"), the status in words, Stop on
// running rows only (the owner's own click, as before). An open row: the job's own summary (labelled as written by
// the job, so check it), turns, and Reveal in Finder for the output folder.

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

/** "Started 2:10 PM · 3 min · $0.12 spent": whatever is known. A start before today also names the day. */
func jobUsedText(_ job: JobRow, now: Double) -> String {
  var parts: [String] = []
  if let s = job.startedAt {
    let d = Date(timeIntervalSince1970: s / 1000.0)
    parts.append("Started " + d.formatted(date: Calendar.current.isDateInToday(d) ? .omitted : .abbreviated, time: .shortened))
    parts.append(jobDurationText(from: s, to: job.endedAt ?? now))
  }
  if let c = job.costUsd { parts.append(String(format: "$%.2f spent", c)) }
  return parts.joined(separator: " · ")
}

/** Failed or timed out (the red status words). */
func jobFailed(_ job: JobRow) -> Bool { return !job.isRunning && jobStatusWord(job.status).kind == .bad }

/** "Earlier (5)": finished and stopped jobs only. Failed jobs are never in it (Accordion rule in Controls.swift). */
func jobsEarlierTitle(_ jobs: [JobRow]) -> String { return "Earlier (\(jobs.count))" }

/** R7d: the Jobs page states, in plain words. */
let JOBS_LOADING = "Loading your jobs..."
let JOBS_LIST_FAILED = "Couldn't load your jobs right now."
let JOBS_EMPTY = "No jobs yet. Say \"start a job to find 5 internships\"."

/** ADR-010: off while a job is queued or running; the line said next to the button then. */
let JOB_EDIT_STOP_FIRST = "Stop the job first to change its request."
/** ADR-010: the longest edited request (src/jobs/spec.ts EDIT_REQUEST_MAX; a test keeps them equal), so it is never cut. */
let JOB_EDIT_MAX = 440

/** Characters as the listener counts them (code points), for the editor's counter. */
func jobEditCount(_ text: String) -> Int { return text.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count }

/** ADR-010: "Version 2 of 3" on the job card; nil for a job that was never edited and has no edits. */
func jobVersionText(_ job: JobRow) -> String? {
  return job.versions > 1 ? "Version \(job.version) of \(job.versions)" : nil
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
    let failed = model.jobs.filter(jobFailed)
    let earlier = model.jobs.filter { !$0.isRunning && !jobFailed($0) }
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xl) {
        // R9: the caution once, here.
        Text(verbatim: "Long tasks Stephen runs in the background. Each summary is written by the job: check it before you rely on it.")
          .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
        if let n = model.jobsNotice { Text(verbatim: n).font(TypeScale.secondary).foregroundColor(t.ink2) }
        if let s = model.jobStarted { Text(verbatim: s).font(TypeScale.secondary).foregroundColor(t.ink2) }
        // R7d: loading, error and empty in words. Empty only after a list that worked.
        switch model.jobsListOk {
        case nil:
          HStack(spacing: Space.s) {
            ProgressView().controlSize(.small)
            Text(verbatim: JOBS_LOADING).font(TypeScale.body).foregroundColor(t.ink2)
          }
        case false?:
          VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: JOBS_LIST_FAILED).font(TypeScale.body).foregroundColor(t.ink).fixedSize(horizontal: false, vertical: true)
            QuietButton("Try again", symbol: "arrow.clockwise") { model.refreshJobs() }
          }
        case true?:
          if model.jobs.isEmpty {
            Text(verbatim: JOBS_EMPTY).font(TypeScale.body).foregroundColor(t.ink2)
          }
        }
        if !running.isEmpty { GroupedList("Running") { rows(running) } }
        // [DEV REVIEW] Safety: failed jobs are never inside a closed accordion.
        if !failed.isEmpty { GroupedList("Failed") { rows(failed) } }
        if !earlier.isEmpty {
          Accordion(jobsEarlierTitle(earlier), key: "acc.jobs.earlier") { GroupedList { rows(earlier) } }
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

  private func rows(_ jobs: [JobRow]) -> some View {
    ForEach(Array(jobs.enumerated()), id: \.element.id) { i, job in
      JobItem(job: job, first: i == 0, expanded: openId == job.id,
              toggle: { openId = openId == job.id ? nil : job.id }, stop: { model.stopJob(job.id) },
              edit: { model.editJob(job.id, request: $0) })
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
  /** ADR-010 Edit request: the edited text goes to the listener, which shows the job dialog again. */
  let edit: (String) -> Void
  @State private var editing = false
  @State private var draft = ""

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
                if let v = jobVersionText(job) { Text(verbatim: v).font(TypeScale.secondary).foregroundColor(t.ink2) }
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
          // [DEV REVIEW] ADR-010: Edit request is off while the job is queued or running (Stop is next to it).
          QuietButton("Edit request", symbol: "pencil") { draft = job.request; editing = true }
            .disabled(job.isRunning)
            .accessibilityLabel("Edit the request of job: \(job.task)")
        }
        if job.isRunning { Text(verbatim: JOB_EDIT_STOP_FIRST).font(TypeScale.secondary).foregroundColor(t.ink2) }
        if editing && !job.isRunning { editor }
        if expanded {
          if !job.summary.isEmpty { Text(verbatim: "Summary, written by the job").sectionLabelStyle(t) }
          Text(verbatim: bodyText).font(TypeScale.secondary).foregroundColor(t.ink).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          Text(verbatim: "\(job.turns) turns").font(TypeScale.secondary).foregroundColor(t.ink2)
          // ADR-010: the job's real id (an edited job's -v<N>), shown once it exists; the dialog never names it.
          Text(verbatim: "Job \(job.id)").font(TypeScale.secondary).foregroundColor(t.ink2).textSelection(.enabled)
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

  /// The Edit request editor (ADR-010): the old request prefilled, Continue and Cancel. Continue only sends the text;
  /// the listener shows the same job dialog as any new job, with every field, and nothing starts until it is allowed.
  private var editor: some View {
    VStack(alignment: .leading, spacing: Space.s) {
      Text(verbatim: "This starts a new job. Stephen shows the job dialog again (folder, web, budgets), and nothing starts until you allow it. The old job stays as it is.")
        .font(TypeScale.secondary).foregroundColor(t.ink2).fixedSize(horizontal: false, vertical: true)
      TextField("Edit the request", text: $draft).textFieldStyle(.roundedBorder).font(TypeScale.body)
        .accessibilityLabel("Edit the request")
      Text(verbatim: "\(jobEditCount(draft)) of \(JOB_EDIT_MAX) characters")
        .font(TypeScale.secondary).foregroundColor(jobEditCount(draft) > JOB_EDIT_MAX ? t.bad : t.ink2)
      HStack(spacing: Space.s) {
        QuietButton("Continue", symbol: "arrow.right") { sendDraft() }
          .disabled(job.isRunning || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || jobEditCount(draft) > JOB_EDIT_MAX)
        QuietButton("Cancel") { editing = false }
      }
    }
  }

  private func sendDraft() {
    guard !job.isRunning, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, jobEditCount(draft) <= JOB_EDIT_MAX else { return }
    edit(draft)
    editing = false
  }

  private var bodyText: String {
    if !job.summary.isEmpty { return job.summary }
    if !job.error.isEmpty { return job.error }
    return job.isRunning ? "Still working. The summary appears here when it finishes." : "No summary."
  }
}
