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
 * WebDriver BiDi as far as browser-hub is concerned (Chromium allows several sessions, unlike Gecko).
 * It prints the listening line on stderr exactly like Gecko, and exits when Chromium exits.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPT = (chromium: string) => `#!${process.execPath}
// fake zen for browser-hub tests (generated)
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const net = require('node:net');
const { join } = require('node:path');

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
  '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...extras, 'about:blank',
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
  const path = join(dir, 'zen');
  await writeFile(path, SCRIPT(chromium), 'utf8');
  await chmod(path, 0o755);
  return path;
}
