/**
 * Errors that carry page-supplied text (review #2 finding 8).
 *
 * The `message` of every error the page engine throws is written by browser-hub and never contains
 * page text (element names, option labels, ids…): it refers to elements by ref and to a fixed set of
 * roles only. When page text is useful to the model (the options of a <select>, what covers a click
 * target) it travels in `pageText`, which the server must show ONLY inside its untrusted-content
 * wrapper — never in the error line itself.
 */
import { HubError, type HubErrorCode } from '../errors.js';
import { cleanText } from './format.js';

export class PageTextError extends HubError {
  /** Page-supplied, untrusted text (already passed through cleanText: one line, ≤ 2000 chars). */
  readonly pageText: string;
  constructor(code: HubErrorCode, message: string, pageText: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.pageText = cleanText(pageText, 2000);
  }
}

/** The untrusted page text attached to an error thrown by the page engine, or null. */
export function pageTextOf(e: unknown): string | null {
  return e instanceof PageTextError && e.pageText ? e.pageText : null;
}
