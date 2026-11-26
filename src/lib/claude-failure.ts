/**
 * Why a Claude Code run failed, in plain words (R5), shared by the voice runners and background jobs. It lives in
 * src/lib (imports nothing) because src/jobs must not load src/voice (test/memory/boundary.test.ts).
 * The CLI text only picks a code word and a fixed line; it is never copied, except a short clock-like reset time.
 */

// Wording seen in Claude Code 2.1.319 ("Usage limit reached · limit resets 3pm") and earlier builds ("You've hit your limit · resets 3pm").
const PLAN_LIMIT_RE = /\b(?:usage|plan|session|weekly|5-hour) limit reached\b|\bhit your (?:[a-z0-9-]+ )?limit\b/i;
const LIMIT_RESET_RE = /\bresets?\s+(?:at\s+)?([^·|(\n]+)/i;

/** The plain message for "plan limit reached" CLI text (with the reset time when the text carries one), else null. Pure. */
export function planLimitMessage(text: string): string | null {
  if (!PLAN_LIMIT_RE.test(text)) return null;
  // The reset time is CLI text: keep only a short clock-like value.
  const raw = LIMIT_RESET_RE.exec(text)?.[1]?.trim();
  const at = raw && /^[0-9apm: .]{1,12}$/i.test(raw) ? raw : undefined;
  return at ? `You've reached your Claude plan limit. It resets at ${at}.` : "You've reached your Claude plan limit.";
}

/** Why a model run failed (R5), as an incident code word. claude_other: anything not matched below. */
export const CLAUDE_FAILURES = ['claude_missing', 'claude_signed_out', 'claude_usage_limit', 'claude_busy', 'claude_offline', 'claude_other'] as const;
export type ClaudeFailure = (typeof CLAUDE_FAILURES)[number];

// Fixed markers only, first match wins. The text is never copied anywhere: it only picks one of these words.
// ponytail: markers seen in Claude Code 2.1.316 to 2.1.319 and Node's network errors; a new wording falls to claude_other.
const FAILURE_MARKERS: readonly [ClaudeFailure, RegExp][] = [
  ['claude_missing', /\bClaude Code was not found\b/],
  ['claude_usage_limit', new RegExp(`${PLAN_LIMIT_RE.source}|\\breached your Claude plan limit\\b`, 'i')],
  ['claude_signed_out', /\bnot logged in\b|\bplease run \/login\b|\binvalid api key\b|\bauthentication_error\b|\boauth token has expired\b|\bAPI Error: 401\b/i],
  ['claude_busy', /\boverloaded(?:_error)?\b|\brate_limit_error\b|\brate limited\b|\bAPI Error: (?:429|529)\b/i],
  ['claude_offline', /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)\b|\bgetaddrinfo\b|\bfetch failed\b|\bunable to connect to api\b|\bconnection error\b/i],
];

/** One failed run's message (a ClaudeOutcome error) → a failure code word, by fixed markers. Pure. */
export function claudeFailure(message: string): ClaudeFailure {
  return FAILURE_MARKERS.find(([, re]) => re.test(message))?.[0] ?? 'claude_other';
}

/**
 * R5: the plain line for a failed model run Stephen recognizes. claude_usage_limit keeps the plan limit message (it may
 * hold the reset time); claude_other keeps the run's own message.
 */
export const FAILURE_LINES: Partial<Record<ClaudeFailure, string>> = {
  claude_missing: "I can't find Claude Code on this Mac. Run stephen doctor to see how to fix it.",
  claude_signed_out: 'Claude Code is signed out. Open Terminal, run claude, and sign in again.',
  claude_busy: 'Claude is busy right now. Try again in a minute.',
  claude_offline: "I can't reach Claude right now. Check the internet.",
};

/** The plain line for a run's CLI text (result text, errors or stderr), or null when no fixed marker matches. Pure. */
export function plainFailureLine(text: string): string | null {
  const f = claudeFailure(text);
  if (f === 'claude_usage_limit') return planLimitMessage(text) ?? "You've reached your Claude plan limit.";
  return FAILURE_LINES[f] ?? null;
}
