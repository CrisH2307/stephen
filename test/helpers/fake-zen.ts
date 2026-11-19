/**
 * A stand-in "zen" executable for Linux CI, so the REAL ZenDriver launch path can be exercised
 * without Firefox: binary check → spawn with `--profile <dir> --new-instance --remote-debugging-port 0
 * …extraArgs` → poll the log for "WebDriver BiDi listening on ws://…" → connect to `<url>/session`
 * with protocol 'webDriverBiDi'.
 *
 * The script launches Chromium on the given profile, then listens on a loopback port of its own and
 * forwards each WebSocket connection to Chromium's DevTools endpoint, rewriting the request path
 * `/session` → `/devtools/browser/<id>`. Puppeteer's `connect({protocol: 'webDriverBiDi'})` first tries
 * pure BiDi (`session.status`) and falls back to BiDi-over-CDP on that socket, so the session is real
 * WebDriver BiDi as far as Stephen is concerned (Chromium allows several sessions, unlike Gecko).
 * It prints the listening line on stderr exactly like Gecko, and exits when Chromium exits.
 */
import { chmod, copyFile, link, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPT = (interpreter: string, chromium: string) => `#!${interpreter}
// fake zen for Stephen tests (generated)
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const net = require('node:net');
const { join } = require('node:path');

// zen-launch finds Zen with \`pgrep -x zen\`, which matches the process name. On macOS that is the interpreter's
// file name (writeFakeZen runs this script with a node named "zen"). On Linux, Node renames its main thread to
// "MainThread", so set it back. The command line stays as it is.
try { require('node:fs').writeFileSync('/proc/self/comm', 'zen'); } catch {}

const args = process.argv.slice(2);
let profile = null;
const extras = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--profile') profile = args[++i];
  else if (a === '--remote-debugging-port') i++;
  else if (a === '--new-instance') continue;
  else extras.push(a);
}
if (!profile) { console.error('fake zen: --profile is required'); process.exit(2); }

const chrome = spawn(${JSON.stringify(chromium)}, [
  '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  // Like src/drivers/chrome.ts: without these, Chrome's first-run screen hides the tab on a fresh profile and drops
  // the press aimed at a cross-site iframe (selftest check 12 on macOS, where tests use the real Chrome).
  '--no-first-run', '--no-default-browser-check', ...extras, 'about:blank',
], { stdio: 'ignore' });
chrome.on('exit', (code) => process.exit(code ?? 0));
const stop = () => { try { chrome.kill('SIGTERM'); } catch {} };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

function readPort() {
  try {
    const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\\r?\\n/);
    return port && path ? { port: Number(port), path: path.trim() } : null;
  } catch { return null; }
}

const timer = setInterval(() => {
  const target = readPort();
  if (!target) return;
  clearInterval(timer);
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\\r\\n\\r\\n');
      if (end < 0) return;
      client.off('data', onData);
      const text = head.toString('latin1').replace(/^GET \\/session(?=[ ?])/, 'GET ' + target.path);
      const upstream = net.connect(target.port, '127.0.0.1', () => {
        upstream.write(Buffer.from(text, 'latin1'));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  server.listen(0, '127.0.0.1', () => {
    console.error('WebDriver BiDi listening on ws://127.0.0.1:' + server.address().port);
  });
}, 50);
`;

/** Writes an executable fake `zen` into `dir` that runs `chromium`; returns its path. */
export async function writeFakeZen(dir: string, chromium: string): Promise<string> {
  // macOS names a script's process after its interpreter, and a symlink resolves to "node". So run the script with a
  // hard link to node named "zen" (a copy when the link fails, e.g. another volume). Without this, \`pgrep -x zen\`
  // finds the fake zen only when a real Zen happens to be running.
  const binDir = join(dir, 'fake-zen-bin');
  const interpreter = join(binDir, 'zen');
  await mkdir(binDir, { recursive: true });
  const node = await realpath(process.execPath);
  await link(node, interpreter).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : copyFile(node, interpreter)));
  const path = join(dir, 'zen');
  await writeFile(path, SCRIPT(interpreter, chromium), 'utf8');
  await chmod(path, 0o755);
  return path;
}
