/** `serve --tool-log <file>`: {tool,isError,ms} per call, never arguments or results (src/server/tool-log.ts). */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config.js';
import { buildServer, type ServerDeps } from '../../src/server/index.js';
import {
  appendToolLog,
  checkToolLogPath,
  fileToolLogger,
  readToolLog,
  resetToolLog,
  TOOL_LOG_FILE,
  toolLogPath,
  toolLogServeArgs,
  withToolLog,
  type ToolCallRecord,
} from '../../src/server/tool-log.js';
import { parseServeArgs } from '../../src/serve-args.js';
import { FakeAudit, FakeConfirmer, FakeGate, FakeManager, FakePage, makeEngine } from './fakes.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-tool-log-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function home(): { home: string; voice: string; log: string } {
  const h = join(tmp, `home-${++n}`);
  mkdirSync(join(h, 'voice'), { recursive: true, mode: 0o700 });
  return { home: h, voice: join(h, 'voice'), log: join(h, 'voice', TOOL_LOG_FILE) };
}

async function connect(server: McpServer) {
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe('serve --tool-log <path>', () => {
  it('accepts a .jsonl file directly inside <home>/voice/ and combines with the voice flags', () => {
    const h = home();
    expect(toolLogPath(h.home)).toBe(h.log);
    expect(toolLogServeArgs(h.log)).toEqual(['--tool-log', h.log]);
    expect(toolLogServeArgs(null)).toEqual([]);
    expect(parseServeArgs(['--confirm', 'dialog', '--voice', '--tool-log', h.log], { home: h.home })).toEqual({ confirm: 'dialog', voice: true, toolLog: h.log });
    expect(parseServeArgs([`--tool-log=${h.log}`], { home: h.home })).toEqual({ toolLog: h.log });
    const state = join(h.voice, 'conversation-state.json');
    expect(parseServeArgs(['--session-state', state, '--tool-log', h.log], { home: h.home })).toEqual({ sessionState: state, toolLog: h.log });
  });

  it('refuses everything else', () => {
    const h = home();
    const link = join(h.voice, 'link.jsonl');
    symlinkSync(join(tmp, 'target.jsonl'), link);
    const cases: [string[], RegExp][] = [
      [['--tool-log'], /needs a file path/],
      [['--tool-log', 'voice/tool-log.jsonl'], /absolute/],
      [['--tool-log', join(h.home, TOOL_LOG_FILE)], /directly inside/],
      [['--tool-log', `${h.voice}/../voice/tool-log.jsonl`], /normalized/],
      [['--tool-log', join(h.voice, 'tool-log.json')], /\.jsonl/],
      [['--tool-log', join(h.voice, '.x.jsonl')], /\.jsonl/],
      [['--tool-log', '/etc/passwd'], /directly inside/],
      [['--tool-log', link], /regular file/],
      [['--tool-log', h.log, '--tool-log', h.log], /twice/],
      [['--dry-run', '--record', '/tmp/x.jsonl', '--tool-log', h.log], /cannot be combined/],
    ];
    for (const [argv, re] of cases) {
      const r = parseServeArgs(argv, { home: h.home });
      expect('error' in r ? r.error : 'accepted', argv.join(' ')).toMatch(re);
      expect('error' in r ? r.error : '').toMatch(/^--tool-log|^--dry-run/);
    }
    expect(parseServeArgs(['--tool-log', h.log])).toEqual({ error: "--tool-log: Stephen's home folder is unknown" });
    expect(checkToolLogPath(h.log, h.home)).toEqual({ path: h.log });
  });
});

describe('withToolLog shim', () => {
  it('records name, isError and ms; passes arguments and results through untouched; rethrows', async () => {
    const mcp = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {} } });
    const recs: ToolCallRecord[] = [];
    let t = 1000;
    const shim = withToolLog(mcp, (r) => recs.push(r), () => (t += 7));
    const seen: unknown[] = [];
    shim.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => {
      seen.push(text);
      return { content: [{ type: 'text', text: `got ${text}` }] };
    });
    shim.registerTool('bad', { inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] }));
    shim.registerTool('boom', { inputSchema: {} }, async () => {
      throw new Error('kaboom');
    });
    const client = await connect(mcp);
    const r = (await client.callTool({ name: 'echo', arguments: { text: 'my password is hunter2' } })) as CallToolResult;
    expect(r.content).toEqual([{ type: 'text', text: 'got my password is hunter2' }]);
    expect(seen).toEqual(['my password is hunter2']);
    expect(((await client.callTool({ name: 'bad', arguments: {} })) as CallToolResult).isError).toBe(true);
    expect(((await client.callTool({ name: 'boom', arguments: {} })) as CallToolResult).isError).toBe(true);
    expect(recs).toEqual([
      { tool: 'echo', isError: false, ms: 7 },
      { tool: 'bad', isError: true, ms: 7 },
      { tool: 'boom', isError: true, ms: 7 },
    ]);
  });

  it('buildServer with toolLog: the real tools are logged by name only, 0600, never arguments or page text', async () => {
    const h = home();
    const cfg = loadConfig({}, { HOME: tmp, STEPHEN_HOME: h.home });
    const manager = new FakeManager();
    manager.addPage('z1', new FakePage('https://mail.example.com/inbox', 'SECRET-TITLE Inbox'));
    const gate = new FakeGate();
    const audit = new FakeAudit();
    const deps: ServerDeps = {
      cfg,
      manager,
      engine: makeEngine(),
      safetyFactory: vi.fn(() => ({ gate, audit })) as unknown as ServerDeps['safetyFactory'],
      confirmerFactory: () => new FakeConfirmer(),
      orphanWaitMs: 200,
      toolLog: h.log,
    };
    const client = await connect(buildServer(deps));
    const tools = (await client.listTools()).tools.map((x) => x.name);
    // Same tools as without the log.
    const plain = await connect(buildServer({ ...deps, toolLog: undefined }));
    expect(tools).toEqual((await plain.listTools()).tools.map((x) => x.name));
    await client.callTool({ name: 'tabs_list', arguments: {} });
    await client.callTool({ name: 'type', arguments: { tab: 'nope-tab', target: 'e1', text: 'hunter2-SECRET', intent: 'x' } });
    const raw = readFileSync(h.log, 'utf8');
    expect(raw).not.toMatch(/SECRET|hunter2|nope-tab|example\.com/);
    expect(statSync(h.log).mode & 0o777).toBe(0o600);
    const recs = readToolLog(h.log);
    expect(recs.map((r) => r.tool)).toEqual(['tabs_list', 'type']);
    expect(recs[1]!.isError).toBe(true);
    for (const line of raw.trim().split('\n')) expect(Object.keys(JSON.parse(line)).sort()).toEqual(['isError', 'ms', 'tool']);
  });
});

describe('stephen serve --tool-log (dist/cli.js over stdio)', () => {
  const cli = resolve('dist/cli.js');
  it.skipIf(!existsSync(cli))('logs the call names to the file', async () => {
    const h = home();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', '--confirm', 'deny', '--tool-log', h.log],
      env: { ...process.env, HOME: tmp, STEPHEN_HOME: h.home } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport);
    await client.callTool({ name: 'tabs_list', arguments: {} });
    await client.close();
    expect(readToolLog(h.log).map((r) => r.tool)).toEqual(['tabs_list']);
    expect(statSync(h.log).mode & 0o777).toBe(0o600);
  });
});

describe('tool log file', () => {
  it('append + read round trip; malformed lines skipped; reset empties it', () => {
    const h = home();
    expect(readToolLog(h.log)).toEqual([]); // missing
    appendToolLog(h.log, { tool: 'open_url', isError: false, ms: 12 });
    writeFileSync(h.log, 'not json\n{"tool":"x y","isError":false,"ms":1}\n{"tool":"a","isError":"no","ms":1}\n{"tool":"a","isError":false,"ms":-1}\n', { flag: 'a' });
    appendToolLog(h.log, { tool: 'click', isError: true, ms: 3.6 });
    expect(readToolLog(h.log)).toEqual([
      { tool: 'open_url', isError: false, ms: 12 },
      { tool: 'click', isError: true, ms: 4 },
    ]);
    resetToolLog(h.log);
    expect(readFileSync(h.log, 'utf8')).toBe('');
    expect(statSync(h.log).mode & 0o777).toBe(0o600);
  });

  it('never follows a symlink; a write failure does not throw from the logger', () => {
    const h = home();
    const target = join(tmp, `target-${n}.jsonl`);
    writeFileSync(target, '{"tool":"a","isError":false,"ms":1}\n');
    symlinkSync(target, h.log);
    expect(() => appendToolLog(h.log, { tool: 'a', isError: false, ms: 1 })).toThrow();
    expect(() => resetToolLog(h.log)).toThrow();
    expect(readToolLog(h.log)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('{"tool":"a","isError":false,"ms":1}\n');
    const errors: unknown[] = [];
    fileToolLogger(h.log, (e) => errors.push(e))({ tool: 'a', isError: false, ms: 1 });
    expect(errors).toHaveLength(1);
    expect(lstatSync(h.log).isSymbolicLink()).toBe(true);
  });
});
