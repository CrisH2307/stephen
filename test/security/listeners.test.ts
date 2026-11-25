/**
 * R4: no new network listener in src/ without review. A file that starts a server (`createServer(`, `.listen(`, or
 * `listenPrivateSocket(`) must be on the list below with its exact count of each call, so a second listener in an
 * allowed file fails too. A file that uses node:http must name 127.0.0.1 and never 0.0.0.0 (comments ignored).
 * Adding a listener means adding it here, in a PR a reviewer reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../src');
type Counts = { createServer: number; listen: number; listenPrivateSocket: number };

/** Counted on qa, 2026-11-25 (grep), per file relative to src/. */
const ALLOWED: Record<string, Counts> = {
  'lib/private-socket.ts': { createServer: 1, listen: 1, listenPrivateSocket: 1 },
  'app/server.ts': { createServer: 0, listen: 0, listenPrivateSocket: 1 },
  'phone/server.ts': { createServer: 0, listen: 0, listenPrivateSocket: 1 },
  'connect/gmail-oauth.ts': { createServer: 1, listen: 1, listenPrivateSocket: 0 },
  'selftest/fixtures.ts': { createServer: 2, listen: 1, listenPrivateSocket: 0 },
  'eval/clicks.ts': { createServer: 1, listen: 1, listenPrivateSocket: 0 },
};

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
function countListeners(text: string): Counts {
  return { createServer: count(text, /createServer\(/g), listen: count(text, /\.listen\(/g), listenPrivateSocket: count(text, /listenPrivateSocket\(/g) };
}
const any = (c: Counts) => c.createServer + c.listen + c.listenPrivateSocket > 0;
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Every problem with a set of files (path relative to src/ -> source text). Empty means all good. */
function listenerProblems(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const c = countListeners(text);
    if (!any(c)) continue;
    const want = ALLOWED[file];
    if (!want) out.push(`${file}: starts a listener and is not on the list`);
    else if (c.createServer !== want.createServer || c.listen !== want.listen || c.listenPrivateSocket !== want.listenPrivateSocket) {
      out.push(`${file}: listener calls changed (${JSON.stringify(c)}, expected ${JSON.stringify(want)})`);
    }
    if (/from ['"]node:http['"]/.test(text)) {
      if (!text.includes('127.0.0.1')) out.push(`${file}: uses node:http but never names 127.0.0.1`);
      if (stripComments(text).includes('0.0.0.0')) out.push(`${file}: names 0.0.0.0`);
    }
  }
  return out;
}

function readSrc(dir = SRC): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, readSrc(full));
    else if (e.name.endsWith('.ts')) out[relative(SRC, full)] = readFileSync(full, 'utf8');
  }
  return out;
}

describe('R4: network listeners in src/', () => {
  const src = readSrc();

  it('only the listed files start a listener, each with its exact count, and http binds to 127.0.0.1', () => {
    expect(listenerProblems(src)).toEqual([]);
  });

  it('every listed file still exists and still has its listener (the list does not go stale)', () => {
    for (const [file, want] of Object.entries(ALLOWED)) {
      expect(src[file], file).toBeDefined();
      expect(countListeners(src[file]!), file).toEqual(want);
    }
  });

  it('a planted new file with a server fails', () => {
    const planted = { ...src, 'fake/new-listener.ts': "import { createServer } from 'node:http';\ncreateServer(() => {}).listen(0, '127.0.0.1');\n" };
    expect(listenerProblems(planted)).toEqual(['fake/new-listener.ts: starts a listener and is not on the list']);
  });

  it('a second listener in an allowed file fails, and so does 0.0.0.0', () => {
    const more = { ...src, 'eval/clicks.ts': `${src['eval/clicks.ts']}\ncreateServer(() => {}).listen(0, '127.0.0.1');\n` };
    expect(listenerProblems(more)[0]).toMatch(/^eval\/clicks\.ts: listener calls changed/);
    const open = { ...src, 'connect/gmail-oauth.ts': `${src['connect/gmail-oauth.ts']}\nconst host = '0.0.0.0';\n` };
    expect(listenerProblems(open)).toEqual(['connect/gmail-oauth.ts: names 0.0.0.0']);
  });
});
