/** Reading an HTTP response body with a byte cap (account clients, the media search). */

/** The parts of a fetch Response a capped read needs (lets tests pass a fake). */
export interface BodyResponse {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Read a response body as UTF-8, at most `maxBytes`. A declared Content-Length above the cap, or a stream that
 * grows past it, cancels the stream and throws `onTooLarge()`.
 */
export async function readCappedBody(res: BodyResponse, maxBytes: number, onTooLarge: () => Error): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw onTooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw onTooLarge();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}
