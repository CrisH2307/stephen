// Stephen Helper: the safety gate's questions in the window: PendingConfirm, Allow / Deny (answerConfirm) and
// Esc = Deny (denyFirstConfirm). Moved here unchanged from AppClient.swift so the Allow / Deny code sits in one
// small file. The `confirms` list itself, and the confirm / confirm.end pushes, are in AppModel (AppClient.swift).

import Foundation

/** A question from the safety gate waiting for the owner's click (`confirm` push). Title and body are shown verbatim. */
struct PendingConfirm: Identifiable, Equatable {
  let id: String
  let title: String
  let body: String
}

extension AppModel {
  /** Allow / Deny for one question. It leaves the box at once; confirm.end (or an error: already gone) follows. */
  func answerConfirm(_ confirmId: String, approve: Bool) {
    confirms.removeAll { $0.id == confirmId }
    request(AppRequest.confirmAnswer(newId(), confirmId: confirmId, approve: approve)) { [weak self] msg in
      if msg.type == "error" { self?.log("app.sock: confirm answer refused: \(msg.message ?? "error")") }
    }
  }

  /** Esc while a question waits: Deny the first one, only that one. Esc never allows. false when none waits. */
  @discardableResult
  func denyFirstConfirm() -> Bool {
    guard let q = confirms.first else { return false }
    answerConfirm(q.id, approve: false)
    return true
  }
}
