/**
 * `stephen app`: open the Stephen window (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13), trying in order:
 *  1. the running `stephen listen`: `{id, type:"window.open"}` on app.sock, which forwards `{type:"open_window"}`
 *     over its own helper connection (helper.sock serves one client at a time, so we must not take it from the
 *     listener);
 *  2. Stephen Helper alone (no listener): connect to helper.sock, wait for its hello, send `open_window`, disconnect;
 *  3. neither: `open -a "<Stephen Helper.app>" --args --home <home> --open-window` (argv, no shell).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { loadConfig } from '../config.js';
import { openHelperArgv } from '../helper/client.js';
import { LineFramer, encodeCommand, parseHelperLine } from '../helper/framing.js';
import { HELPER_APP_NAME, helperAppPath, helperSocketPath } from '../helper/paths.js';
import { APP_MAX_LINE_BYTES } from './protocol.js';
import { appSocketPath } from './server.js';

export const APP_HELP = `stephen app: open the Stephen window (chat, memory, history, settings, audit)

Asks the running \`stephen listen\` to show it, else ${HELPER_APP_NAME}, else starts ${HELPER_APP_NAME}.
Chat needs \`stephen listen\` running; build the helper once with \`stephen install-helper\`.`;

export type Attempt = { ok: true } | { ok: false; reason: string };

export interface AppCliDeps {
  home: () => string;
  platform: NodeJS.Platform;
  appPath: string;
  exists: (p: string) => boolean;
  /** Send window.open to app.sock and wait for the answer. */
  askListener: (socketPath: string) => Promise<Attempt>;
  /** Send open_window to helper.sock (after its hello). */
  askHelper: (socketPath: string) => Promise<Attempt>;
  /** Run /usr/bin/open with this argv. */
  open: (argv: string[]) => Promise<Attempt>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const TIMEOUT_MS = 2_000;

/** argv for /usr/bin/open: the helper's usual start-up arguments plus --open-window. */
export function openWindowArgv(appPath: string, home: string): string[] {
  return [...openHelperArgv(appPath, home), '--open-window'];
}

/** One request on app.sock: `{id:"cli-open", type:"window.open"}` → ok, or the server's error message. */
export function askListener(socketPath: string, timeoutMs = TIMEOUT_MS): Promise<Attempt> {
  return new Promise((resolve) => {
    const id = 'cli-open';
    const s = createConnection(socketPath);
    const framer = new LineFramer(APP_MAX_LINE_BYTES);
    const done = (r: Attempt) => {
      clearTimeout(timer);
      s.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'no answer from stephen listen' }), timeoutMs);
    s.once('error', (e) => done({ ok: false, reason: e.message }));
    s.once('close', () => done({ ok: false, reason: 'stephen listen closed the connection' }));
    s.once('connect', () => s.write(`${JSON.stringify({ id, type: 'window.open' })}\n`));
    s.on('data', (data: Buffer) => {
      for (const line of framer.push(data)) {
        let m: { id?: unknown; type?: unknown; message?: unknown };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          continue;
        }
        if (m.id !== id) continue; // pushes (state …)
        done(m.type === 'ok' ? { ok: true } : { ok: false, reason: typeof m.message === 'string' ? m.message : 'refused' });
      }
    });
  });
}

/**
 * helper.sock: wait for hello, send open_window, disconnect. Only used when no listener answers (the helper serves
 * one client at a time; this briefly takes that slot, like `stephen doctor`'s probe).
 */
export function askHelper(socketPath: string, timeoutMs = TIMEOUT_MS): Promise<Attempt> {
  return new Promise((resolve) => {
    const s = createConnection(socketPath);
    const framer = new LineFramer();
    let sent = false;
    const done = (r: Attempt) => {
      clearTimeout(timer);
      s.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: `no hello from ${HELPER_APP_NAME}` }), timeoutMs);
    s.once('error', (e) => done({ ok: false, reason: e.message }));
    s.once('close', () => done(sent ? { ok: true } : { ok: false, reason: `${HELPER_APP_NAME} closed the connection` }));
    s.on('data', (data: Buffer) => {
      if (sent) return;
      for (const line of framer.push(data)) {
        const p = parseHelperLine(line);
        if (p.kind !== 'event' || p.event.type !== 'hello') continue;
        sent = true;
        s.end(encodeCommand({ type: 'open_window' }), () => done({ ok: true }));
        return;
      }
    });
  });
}

function runOpen(argv: string[]): Promise<Attempt> {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', argv, { timeout: 15_000 }, (e, _stdout, stderr) => {
      if (!e) resolve({ ok: true });
      else resolve({ ok: false, reason: String(stderr || e.message).trim().split('\n')[0] ?? 'open failed' });
    });
  });
}

export function defaultAppCliDeps(): AppCliDeps {
  return {
    home: () => loadConfig().home,
    platform: process.platform,
    appPath: helperAppPath(),
    exists: existsSync,
    askListener: (p) => askListener(p),
    askHelper: (p) => askHelper(p),
    open: runOpen,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

export async function runAppCli(argv: string[], deps: AppCliDeps = defaultAppCliDeps()): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.out(APP_HELP);
    return 0;
  }
  if (argv.length) {
    deps.err(`Unknown option "${argv[0]}". Usage: stephen app`);
    return 2;
  }
  const home = deps.home();
  const notes: string[] = [];

  const appSock = appSocketPath(home);
  if (deps.exists(appSock)) {
    const r = await deps.askListener(appSock);
    if (r.ok) {
      deps.out('Opened the Stephen window (asked the running `stephen listen`).');
      return 0;
    }
    notes.push(`stephen listen: ${r.reason}`);
  }

  const helperSock = helperSocketPath(home);
  if (deps.exists(helperSock)) {
    const r = await deps.askHelper(helperSock);
    if (r.ok) {
      deps.out(`Opened the Stephen window (${HELPER_APP_NAME}). Chat needs \`stephen listen\` running.`);
      return 0;
    }
    notes.push(`${HELPER_APP_NAME}: ${r.reason}`);
  }

  for (const n of notes) deps.out(`Note: ${n}`);
  if (deps.platform !== 'darwin') {
    deps.err('The Stephen window is part of Stephen Helper, which is macOS only.');
    return 1;
  }
  if (!deps.exists(deps.appPath)) {
    deps.err(`${HELPER_APP_NAME} is not installed at ${deps.appPath}. Run \`stephen install-helper\` first.`);
    return 1;
  }
  const r = await deps.open(openWindowArgv(deps.appPath, home));
  if (!r.ok) {
    deps.err(`Could not start ${HELPER_APP_NAME}: ${r.reason}`);
    return 1;
  }
  deps.out(`Started ${HELPER_APP_NAME} with its window open. Chat needs \`stephen listen\` running.`);
  return 0;
}
