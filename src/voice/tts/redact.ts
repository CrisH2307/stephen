/** API keys never appear in output: only `sk_…` plus the last 4 characters. */

export function redactKey(key: string): string {
  const k = key.trim();
  if (k.length < 12) return '…';
  return `${k.startsWith('sk_') ? 'sk_' : ''}…${k.slice(-4)}`;
}

/** Replace every occurrence of `key` in `text` with its redacted form (for error bodies, stderr…). */
export function scrubKey(text: string, key: string | null | undefined): string {
  if (!key || key.length < 8) return text;
  return text.split(key).join(redactKey(key));
}

/** What an ElevenLabs key looks like (sk_ + hex today); anything with spaces, quotes or newlines is refused. */
export const API_KEY_RE = /^[A-Za-z0-9_-]{20,256}$/;
