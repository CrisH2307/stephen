/**
 * What Stephen did for one command, as short lines for the chat's action chain (UI-PLAN v3.2, "3 steps · 9.8 s"):
 * browser actions from the audit log that happened while the command ran, oldest first, refusals named in words, then
 * the other tools from the tool log ("Used gmail_search").
 *
 * Only fields the audit already redacts are used (kind, element, error), never arguments, URLs or typed text. An
 * element label can still be page text, so the helper shows every line with Text(verbatim:) and nothing here goes back
 * to the model.
 *
 * ponytail: audit entries are matched by time (the audit has no command id). The listener runs one command at a time,
 * so its own commands never mix; a phone job acting in the same seconds could add a line. Add a command id to the
 * audit if that shows up.
 */
import { truncate } from '../safety/text.js';
import type { ToolCallRecord } from '../server/tool-log.js';
import type { AuditEntry } from '../types.js';

export interface ChatStep {
  text: string;
  status: 'ok' | 'refused' | 'failed';
}

/** At most this many steps per command (maxTurns bounds a command; this keeps one push small). */
export const MAX_CHAT_STEPS = 40;
/** Each step's text is cut to this many characters. */
export const MAX_STEP_CHARS = 160;
/** Audit lines up to this long before the command's start or after its end still count (clock and write slack). */
const SLACK_MS = 1000;

function actionText(a: AuditEntry): string {
  return [a.kind ?? a.tool, a.element].filter((s) => !!s).join(' ');
}

/** The steps of a command that ran from `startMs` to `endMs` (epoch ms). `audit` may be in any order. */
export function commandSteps(audit: AuditEntry[], calls: ToolCallRecord[], startMs: number, endMs: number): ChatStep[] {
  const steps: ChatStep[] = [];
  const auditTools = new Set<string>();
  const inside = audit
    .map((a) => ({ a, t: Date.parse(a.ts) }))
    .filter(({ t }) => Number.isFinite(t) && t >= startMs - SLACK_MS && t <= endMs + SLACK_MS)
    .sort((x, y) => x.t - y.t);
  for (const { a } of inside) {
    auditTools.add(a.tool);
    if (a.outcome === 'denied') {
      const why = a.error || (a.verdict === 'confirm' ? 'you did not allow it' : "Stephen's safety rules");
      steps.push({ text: `Refused: ${actionText(a)}. ${why}`, status: 'refused' });
    } else if (a.outcome === 'error') {
      steps.push({ text: `Tried ${actionText(a)}, it failed`, status: 'failed' });
    } else {
      steps.push({ text: actionText(a), status: 'ok' });
    }
  }
  for (const c of calls) {
    if (auditTools.has(c.tool)) continue;
    steps.push({ text: `Used ${c.tool}`, status: c.isError ? 'failed' : 'ok' });
  }
  return steps.slice(0, MAX_CHAT_STEPS).map((s) => ({ ...s, text: truncate(s.text, MAX_STEP_CHARS) }));
}
