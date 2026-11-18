/**
 * Newline-delimited JSON framing and validation for the helper protocol (mirrors `LineFramer` / `parseCommand`
 * in helper/Core.swift; both sides drop over-long and malformed lines).
 */
import { z } from 'zod';
import { MEDIA_KEYS, type HelperCommand, type HelperEvent } from './protocol.js';

/** protocol.ts: "≤ 4 KiB each". A line longer than this (bytes, without its newline) is dropped. */
export const MAX_LINE_BYTES = 4096;

/** Splits a byte stream into lines; over-long lines are dropped up to their newline. */
export class LineFramer {
  private chunks: Buffer[] = [];
  private size = 0;
  private discarding = false;
  dropped = 0;

  constructor(readonly maxBytes: number = MAX_LINE_BYTES) {}

  push(data: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    while (start <= data.length) {
      const nl = data.indexOf(0x0a, start);
      const end = nl === -1 ? data.length : nl;
      const piece = data.subarray(start, end);
      if (!this.discarding) {
        if (this.size + piece.length > this.maxBytes) {
          this.discarding = true;
          this.dropped++;
          this.chunks = [];
          this.size = 0;
        } else if (piece.length) {
          this.chunks.push(piece);
          this.size += piece.length;
        }
      }
      if (nl === -1) break;
      if (!this.discarding) {
        let line = Buffer.concat(this.chunks, this.size).toString('utf8');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length) lines.push(line);
      }
      this.discarding = false;
      this.chunks = [];
      this.size = 0;
      start = nl + 1;
    }
    return lines;
  }
}

const at = z.number().finite();

const helperEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string().max(64), inputMonitoring: z.boolean() }),
  z.object({ type: z.literal('ptt_down'), at }),
  z.object({ type: z.literal('ptt_up'), at, heldMs: z.number().finite().nonnegative() }),
  z.object({ type: z.literal('esc'), at }),
  z.object({ type: z.literal('audio'), playing: z.boolean(), at }),
  z.object({ type: z.literal('media_key_done'), key: z.enum(MEDIA_KEYS), ok: z.boolean(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal('error'), message: z.string().max(MAX_LINE_BYTES) }),
]);

export const HELPER_EVENT_TYPES: ReadonlySet<HelperEvent['type']> = new Set(['hello', 'ptt_down', 'ptt_up', 'esc', 'audio', 'media_key_done', 'error']);

export type ParsedLine =
  | { kind: 'event'; event: HelperEvent }
  /** Valid JSON object with a `type` this client does not know (ignored per the protocol). */
  | { kind: 'unknown'; type: string }
  | { kind: 'invalid'; reason: string };

/** Parse and validate one line from the helper. Unknown extra fields are stripped. */
export function parseHelperLine(line: string): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'not a JSON object' };
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string') return { kind: 'invalid', reason: 'missing "type"' };
  if (!HELPER_EVENT_TYPES.has(type as HelperEvent['type'])) return { kind: 'unknown', type };
  const r = helperEventSchema.safeParse(raw);
  if (!r.success) return { kind: 'invalid', reason: `bad "${type}" event` };
  return { kind: 'event', event: r.data as HelperEvent };
}

/** One command as a protocol line (JSON + "\n"). */
export function encodeCommand(cmd: HelperCommand): string {
  return `${JSON.stringify(cmd)}\n`;
}
