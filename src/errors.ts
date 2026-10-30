/** Error with a stable code and a message written for the model/user (actionable, no stack noise). */
export type HubErrorCode =
  | 'NOT_CONNECTED' // browser not reachable / setup step missing
  | 'NEEDS_USER' // user must do something (quit Zen, toggle chrome://inspect, click Allow)
  | 'TAB_NOT_FOUND'
  | 'BAD_REF' // malformed ref
  | 'STALE_REF' // ref no longer resolves — re-snapshot
  | 'WRONG_TAB' // ref belongs to another tab than the one given
  | 'NOT_EDITABLE'
  | 'OBSCURED' // another element covers the click target (overlay, cookie banner) — nothing was clicked
  | 'FOCUS_MOVED' // focus left the target while typing — typing stopped
  | 'TIMEOUT'
  | 'DENIED' // blocked by the safety gate
  | 'NO_DIALOG'
  | 'INVALID_ARG'
  | 'INTERNAL';

export class HubError extends Error {
  readonly code: HubErrorCode;
  constructor(code: HubErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HubError';
    this.code = code;
  }
}

export function isHubError(e: unknown): e is HubError {
  return e instanceof HubError;
}

/** Turn anything thrown into a one-line, model-facing message. */
export function errorMessage(e: unknown): string {
  if (e instanceof HubError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message.split('\n')[0] ?? String(e);
  return String(e);
}
