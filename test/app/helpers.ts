/** A tiny app.sock client for tests: collects every line, answers requests by id. */
import { createConnection, type Socket } from 'node:net';

export type Msg = Record<string, unknown> & { type: string; id?: string };

export class TestClient {
  readonly messages: Msg[] = [];
  closed = false;
  private buf = '';
  private waiters: (() => void)[] = [];

  private constructor(private readonly sock: Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line) this.messages.push(JSON.parse(line) as Msg);
      }
      this.wake();
    });
    sock.on('close', () => {
      this.closed = true;
      this.wake();
    });
    sock.on('error', () => undefined);
  }

  static connect(path: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      s.once('connect', () => resolve(new TestClient(s)));
      s.once('error', reject);
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Write a raw line (a newline is added) or an object. */
  send(msg: unknown): void {
    this.sock.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  }

  /** The first received message matching `pred` (already received or arriving within `ms`). */
  async waitFor(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = this.messages.find(pred);
      if (m) return m;
      if (this.closed) throw new Error('connection closed while waiting');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async request(msg: Msg): Promise<Msg> {
    this.send(msg);
    return this.waitFor((m) => m.id === msg.id);
  }

  close(): void {
    this.sock.destroy();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
