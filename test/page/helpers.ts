/**
 * Test helpers for the page engine: two local fixture servers (two origins) on loopback.
 * Fixture HTML may contain {{ORIGIN_A}} / {{ORIGIN_B}} placeholders.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'puppeteer-core';
import { launchTestBrowser, type TestProtocol } from '../helpers/chromium.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export interface Fixtures {
  /** Origin A: http://127.0.0.1:<port> */
  a: string;
  /** Origin B (different origin AND site): http://localhost:<port> */
  b: string;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

export async function startFixtures(): Promise<Fixtures> {
  const origins = { a: '', b: '' };
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')).replace(/^([/\\])+/, '');
    if (path.includes('..')) {
      res.writeHead(400).end();
      return;
    }
    readFile(join(FIXTURES, path || 'index.html'), 'utf8')
      .then((body) => {
        const out = body.replaceAll('{{ORIGIN_A}}', origins.a).replaceAll('{{ORIGIN_B}}', origins.b);
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
        if (path.startsWith('csp')) {
          // Gmail-style lockdown: no eval, no inline script, Trusted Types enforced.
          headers['content-security-policy'] =
            "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types 'none'";
        }
        res.writeHead(200, headers).end(out);
      })
      .catch(() => res.writeHead(404).end('not found'));
  };
  const sa = createServer(handler);
  const sb = createServer(handler);
  const [pa, pb] = await Promise.all([listen(sa), listen(sb)]);
  origins.a = `http://127.0.0.1:${pa}`;
  origins.b = `http://localhost:${pb}`;
  return {
    a: origins.a,
    b: origins.b,
    close: async () => {
      await Promise.all([
        new Promise((r) => sa.close(() => r(undefined))),
        new Promise((r) => sb.close(() => r(undefined))),
      ]);
    },
  };
}

export interface Env {
  browser: Browser;
  fx: Fixtures;
  /** A fresh page per call (closed by closeEnv via browser.close). */
  open(path: string): Promise<Page>;
}

export async function setupEnv(protocol: TestProtocol): Promise<Env> {
  const [browser, fx] = await Promise.all([launchTestBrowser(protocol), startFixtures()]);
  return {
    browser,
    fx,
    open: async (path: string) => {
      const page = await browser.newPage();
      await page.goto(`${fx.a}/${path}`, { waitUntil: 'load' });
      return page;
    },
  };
}

export async function closeEnv(env: Env | undefined): Promise<void> {
  if (!env) return;
  await env.browser.close().catch(() => undefined);
  await env.fx.close().catch(() => undefined);
}

/** Pull the ref out of the first snapshot line matching `re`. */
export function refIn(text: string, re: RegExp): string {
  const line = text.split('\n').find((l) => re.test(l));
  if (!line) throw new Error(`No line matching ${re} in:\n${text}`);
  const m = /\[ref=([^\]]+)\]/.exec(line);
  if (!m) throw new Error(`Line has no ref: ${line}`);
  return m[1] as string;
}

/** PNG width/height from IHDR bytes 16–23. */
export function pngDims(buf: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(buf);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
