/** src/lib/http-body.ts: the one capped body read (account clients, media search). */
import { describe, expect, it } from 'vitest';
import { readCappedBody } from '../../src/lib/http-body.js';

const tooLarge = () => new Error('too large');

function res(chunks: string[], headers: Record<string, string> = {}) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks.shift();
      if (next === undefined) c.close();
      else c.enqueue(new TextEncoder().encode(next));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { r: { headers: new Headers(headers), body }, cancelled: () => cancelled };
}

describe('readCappedBody', () => {
  it('reads a body under the cap as UTF-8 (multi-chunk, multi-byte)', async () => {
    expect(await readCappedBody(res(['hé', 'llo']).r, 100, tooLarge)).toBe('héllo');
    expect(await readCappedBody({ headers: new Headers(), body: null }, 100, tooLarge)).toBe('');
  });

  it('a declared Content-Length over the cap throws before reading, and cancels the stream', async () => {
    const x = res(['abc'], { 'content-length': '101' });
    await expect(readCappedBody(x.r, 100, tooLarge)).rejects.toThrow('too large');
    expect(x.cancelled()).toBe(true);
  });

  it('a stream that grows past the cap is cancelled and throws', async () => {
    const x = res(['12345', '67890', 'more']);
    await expect(readCappedBody(x.r, 8, tooLarge)).rejects.toThrow('too large');
    expect(x.cancelled()).toBe(true);
  });
});
