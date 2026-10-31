/**
 * Fakes for the voice-output tests: a local ElevenLabs HTTP server, fake `afplay` / `say` executables (Node
 * scripts that log what they were given), and an in-memory `security` (macOS Keychain) for ExecFn.
 * All keys here are fake.
 */
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn, ExecResult } from '../../../src/voice/tts/keys.js';

export const FAKE_KEY = 'sk_fake0000000000000000000000000000000000000000beef';
export const OTHER_FAKE_KEY = 'sk_fake1111111111111111111111111111111111111111cafe';
/** Bytes that start like an mp3 (ID3 tag). */
export const FAKE_MP3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00'), Buffer.alloc(2000, 7)]);

export interface FakeRequest {
  method: string;
  url: string;
  key: string | undefined;
  contentType: string | undefined;
  body: string;
}

export type Reply =
  | { kind: 'audio' }
  | { kind: 'error'; status: number; detail?: unknown }
  | { kind: 'hang' }
  | { kind: 'json'; body: unknown };

export class FakeElevenLabs {
  requests: FakeRequest[] = [];
  /** What the next requests get (by path prefix, first match wins); default audio. */
  routes: { prefix: string; reply: Reply }[] = [];
  private server: Server | null = null;
  private hanging: (() => void)[] = [];
  baseUrl = '';

  reply(prefix: string, reply: Reply): this {
    this.routes.unshift({ prefix, reply });
    return this;
  }

  async start(): Promise<this> {
    this.server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d: string) => (body += d));
      req.on('end', () => {
        const url = req.url ?? '';
        this.requests.push({ method: req.method ?? '', url, key: req.headers['xi-api-key'] as string | undefined, contentType: req.headers['content-type'], body });
        const reply = this.routes.find((r) => url.startsWith(r.prefix))?.reply ?? { kind: 'audio' };
        if (reply.kind === 'hang') {
          this.hanging.push(() => res.destroy());
          return;
        }
        if (reply.kind === 'audio') {
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': FAKE_MP3.length });
          res.end(FAKE_MP3);
        } else if (reply.kind === 'json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        } else {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: reply.detail ?? { status: 'error', message: 'error' } }));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const h of this.hanging) h();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export interface PlayLog {
  argv: string[];
  mode: number | null;
  head: string;
  bytes: number;
}

/**
 * A fake executable (Node script): logs {argv, file mode, first bytes, stdin} as a JSON line to `<dir>/log`,
 * waits `ms`, exits `code`. Used as `afplay` and `say`.
 */
export function fakeBin(name: string, opts: { ms?: number; code?: number } = {}): { path: string; log: () => (PlayLog & { stdin: string })[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `stephen-fake-${name}-`));
  const log = join(dir, 'log');
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const f = argv[argv.length - 1];
let mode = null, head = '', bytes = 0;
try { const st = fs.statSync(f); mode = st.mode & 0o777; const b = fs.readFileSync(f); bytes = b.length; head = b.subarray(0, 4).toString('latin1'); } catch {}
let stdin = '';
try { if (${JSON.stringify(name)} === 'say') stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, mode, head, bytes, stdin }) + '\\n');
setTimeout(() => process.exit(${opts.code ?? 0}), ${opts.ms ?? 30});
`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    dir,
    log: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/**
 * In-memory macOS `security`: find/add/delete generic passwords, including `security -i` reading
 * commands from stdin. Records every call (argv + stdin) so tests can check the key never hits argv.
 */
export class FakeSecurity {
  items = new Map<string, string>();
  calls: { file: string; args: string[]; input?: string }[] = [];
  /** Make `-i` silently ignore the add (like a failing command inside interactive mode). */
  dropInteractiveAdds = false;

  exec: ExecFn = async (file, args, opts) => {
    this.calls.push({ file, args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    if (file !== 'security') return { code: -1, stdout: '', stderr: `${file} not found` };
    if (args[0] === '-i') {
      for (const line of (opts.input ?? '').split('\n').filter(Boolean)) {
        const r = this.run(tokenize(line));
        if (r.code !== 0) return { code: 0, stdout: '', stderr: '' }; // security -i keeps going and exits 0
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return this.run(args);
  };

  private run(args: string[]): ExecResult {
    const opt = (f: string) => {
      const i = args.indexOf(f);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const id = `${opt('-s')}|${opt('-a')}`;
    switch (args[0]) {
      case 'find-generic-password': {
        const v = this.items.get(id);
        return v === undefined ? { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' } : { code: 0, stdout: `${v}\n`, stderr: '' };
      }
      case 'add-generic-password': {
        if (this.dropInteractiveAdds) return { code: 1, stdout: '', stderr: '' };
        if (this.items.has(id) && !args.includes('-U')) return { code: 45, stdout: '', stderr: 'already exists' };
        this.items.set(id, opt('-w') ?? '');
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'delete-generic-password':
        if (!this.items.delete(id)) return { code: 44, stdout: '', stderr: 'could not be found' };
        return { code: 0, stdout: 'password has been deleted.', stderr: '' };
      default:
        return { code: 2, stdout: '', stderr: 'usage' };
    }
  }
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[1] ?? m[2]!);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
