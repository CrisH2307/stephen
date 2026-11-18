/**
 * media_control's last fallback (issue #205): press a Mac media key through `stephen listen`'s app.sock, which
 * forwards it to Stephen Helper (the only Stephen process that may post keys). The app that plays sound reacts: the
 * normal Zen, YouTube in any browser, Spotify, Apple Music. Wire format: `media.key` in src/app/protocol.ts. This file
 * must not import src/app (Claude-reachable code; test/memory/boundary.test.ts), so the request is written out here.
 */
import { createConnection } from 'node:net';
import type { MediaKeyAction } from '../helper/protocol.js';
import { clean } from '../safety/text.js';

export type MediaKeyResult = { ok: true } | { ok: false; reason: string };
export type MediaKeyFn = (action: MediaKeyAction) => Promise<MediaKeyResult>;

/** The listener waits up to ~2 s for the helper (audio query + key answer); an older listener never answers. */
export const MEDIA_KEY_TIMEOUT_MS = 4000;
const MAX_REPLY_BYTES = 4096;

export function appMediaKey(socketPath: string, timeoutMs = MEDIA_KEY_TIMEOUT_MS): MediaKeyFn {
  return (action) =>
    new Promise((resolve) => {
      let buf = '';
      let settled = false;
      const sock = createConnection(socketPath);
      const finish = (r: MediaKeyResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'stephen listen did not answer (it may be older than this Stephen)' }), timeoutMs);
      sock.setEncoding('utf8');
      sock.on('error', () => finish({ ok: false, reason: 'stephen listen is not running' }));
      sock.on('close', () => finish({ ok: false, reason: 'stephen listen closed the connection' }));
      sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'm1', type: 'media.key', action })}\n`));
      sock.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: { id?: unknown; type?: unknown; message?: unknown };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue;
          }
          if (msg.id !== 'm1') continue;
          if (msg.type === 'ok') return finish({ ok: true });
          return finish({ ok: false, reason: typeof msg.message === 'string' ? clean(msg.message, 200) : 'error' });
        }
        if (buf.length > MAX_REPLY_BYTES) finish({ ok: false, reason: 'reply too long' });
      });
    });
}
