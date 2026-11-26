/**
 * Stand-ins for src/safety/index.ts's pure helpers (the real ones are built in wt-safety).
 * Used via: vi.mock('../../src/safety/index.js', () => import('./safety-mock.js'))
 * No imports here, so the mock factory cannot become circular.
 */
export function wrapUntrusted(source: string, url: string, text: string): string {
  const safe = text.replaceAll('</untrusted_web_content', '&lt;/untrusted_web_content');
  // Like the real one: only the origin of the URL goes in the attribute, never its path or hash.
  let origin = 'unknown';
  try {
    origin = new URL(url).origin;
  } catch {
    /* unknown */
  }
  return `<untrusted_web_content source="${source}" origin="${origin}">${safe}</untrusted_web_content>`;
}

export function redactValue(value: string, secret: boolean): string {
  if (secret) return `[redacted, ${value.length} chars]`;
  return `[${value.length} chars] "${value.slice(0, 10)}${value.length > 10 ? '…' : ''}"`;
}

export function createSafety(): never {
  throw new Error('tests must inject safetyFactory');
}
