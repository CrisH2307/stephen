/**
 * Ask box confirmations (UI-PLAN v3.1 section 5, "Needs your OK"): the gate's question goes to the Ask box in
 * Stephen Helper through `stephen listen`'s app.sock, and the owner answers with a click there.
 *
 *   gate (this process) ──confirm.ask──▶ app.sock (stephen listen) ──confirm push──▶ Ask box
 *   gate ◀──confirm.result── app.sock ◀──confirm.answer {confirmId, approve}── Ask box click
 *
 * 'unavailable' (so the chain falls back to the macOS dialog) when nothing listens on app.sock, when the listener is
 * older and doesn't relay confirmations (its hello answer has no `confirms: true`), when no Ask box is connected, or
 * when the connection drops before an answer. An unanswered question is 'declined' after the same
 * timeout as the dialog. Wire format: src/app/protocol.ts. This file must not import src/app (Claude-reachable code;
 * test/memory/boundary.test.ts), so the few lines of protocol it speaks are written out here.
 */
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { ConfirmOutcome, ConfirmPrompt, Confirmer } from '../types.js';
import { truncate } from './text.js';

/** `<home>/run/app.sock` (same as appSocketPath in src/app/server.ts; a test checks they match). */
export function appSocketFor(home: string): string {
  return join(home, 'run', 'app.sock');
}

/** Same caps as the dialog (DialogConfirmer). */
export const APP_CONFIRM_TITLE_MAX = 200;
export const APP_CONFIRM_BODY_MAX = 4000;
const CONNECT_TIMEOUT_MS = 1000;
const MAX_REPLY_BYTES = 4096;

export class AppConfirmer implements Confirmer {
  readonly kind = 'app';
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
  ) {}

  confirm(prompt: ConfirmPrompt): Promise<ConfirmOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let buf = '';
      const sock = createConnection(this.socketPath);
      const finish = (out: ConfirmOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(answerTimer);
        sock.destroy();
        resolve(out);
      };
      const connectTimer = setTimeout(() => finish('unavailable'), CONNECT_TIMEOUT_MS);
      // The listener declines on its own timeout; this is only a backstop for a listener that hangs.
      const answerTimer = setTimeout(() => finish('declined'), this.timeoutMs + 5000);
      answerTimer.unref?.();
      sock.setEncoding('utf8');
      sock.on('error', () => finish('unavailable'));
      sock.on('close', () => finish('unavailable'));
      sock.on('connect', () => {
        clearTimeout(connectTimer);
        // Both lines at once: an older listener answers hello without `confirms` and ignores confirm.ask.
        sock.write(`${JSON.stringify({ id: 'g0', type: 'hello', version: '1' })}\n`);
        sock.write(
          `${JSON.stringify({
            id: 'g1',
            type: 'confirm.ask',
            title: truncate(prompt.title, APP_CONFIRM_TITLE_MAX),
            body: truncate(prompt.body, APP_CONFIRM_BODY_MAX),
            timeoutMs: this.timeoutMs,
          })}\n`,
        );
      });
      sock.on('data', (d: string) => {
        buf += d;
        if (buf.length > MAX_REPLY_BYTES) return finish('unavailable');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: { id?: unknown; type?: unknown; outcome?: unknown; confirms?: unknown };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue;
          }
          if (msg.id === 'g0') {
            if (msg.type !== 'hello' || msg.confirms !== true) return finish('unavailable');
            continue;
          }
          if (msg.id !== 'g1') continue;
          if (msg.type === 'confirm.result' && (msg.outcome === 'approved' || msg.outcome === 'declined')) return finish(msg.outcome);
          return finish('unavailable'); // error, 'unavailable', or an older listener's answer
        }
      });
    });
  }
}
