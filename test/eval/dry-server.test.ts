/** `serve --dry-run --record`: same tools as the real server, every call recorded, nothing acts. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildDryRunServer, fakeResult, readDryCalls, type DryCall } from '../../src/eval/dry-server.js';
import { buildServer, type ServerDeps } from '../../src/server/index.js';
import { parseServeArgs } from '../../src/serve-args.js';
import { FakeManager, makeEngine, textOf } from '../server/fakes.js';

function deps(): ServerDeps & { voice: object } {
  const tmp = mkdtempSync(join(tmpdir(), 'dry-'));
  const cfg = loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'hub') });
  const safetyFactory = vi.fn(() => {
    throw new Error('the dry-run server must never create the safety layer');
  });
  return { cfg, manager: new FakeManager(), engine: makeEngine(), safetyFactory: safetyFactory as unknown as ServerDeps['safetyFactory'], voice: {} };
}

async function connect(server: McpServer) {
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe('dry-run server', () => {
  it('lists exactly the real server\'s tools (with --voice), same schemas and descriptions', async () => {
    const d = deps();
    const real = await connect(buildServer(d));
    const dry = await connect(buildDryRunServer(d, '0', () => undefined).server);
    const a = (await real.listTools()).tools;
    const b = (await dry.listTools()).tools;
    expect(b.map((t) => t.name)).toEqual(a.map((t) => t.name));
    expect(b.map((t) => t.name)).toEqual(expect.arrayContaining(['announce', 'open_url', 'play_media', 'click', 'type']));
    expect(b).toEqual(a);
  });

  it('records every call in order and returns a fake result; nothing reaches the browser, engine or gate', async () => {
    const d = deps();
    const calls: DryCall[] = [];
    const client = await connect(buildDryRunServer(d, '0', (c) => calls.push(c)).server);
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
    const r1 = await call('announce', { text: 'Bet, playing lofi' });
    const r2 = await call('open_url', { url: 'https://www.google.com/maps/dir/?api=1&destination=Union', new_tab: true, intent: 'routes' });
    const r3 = await call('click', { tab: 'z2', target: 'e1', intent: 'x' });
    expect(calls.map((c) => [c.n, c.tool])).toEqual([
      [1, 'announce'],
      [2, 'open_url'],
      [3, 'click'],
    ]);
    expect(calls[1]!.args).toMatchObject({ new_tab: true });
    expect(textOf(r1)).toBe('Said: "Bet, playing lofi". Go ahead.');
    expect(textOf(r2)).toMatch(/^Opened a new Zen tab and loaded https:\/\/www\.google\.com\/maps\/dir\//);
    expect(textOf(r3)).toBe('Done.');
    expect((d.manager as FakeManager).opened.size).toBe(0);
    expect((d.manager as FakeManager).connectCalls).toEqual([]);
    expect(d.safetyFactory).not.toHaveBeenCalled();
    for (const fn of Object.values(d.engine)) expect(fn).not.toHaveBeenCalled();
  });

  it('invalid arguments are still rejected by the real schemas', async () => {
    const calls: DryCall[] = [];
    const client = await connect(buildDryRunServer(deps(), '0', (c) => calls.push(c)).server);
    const r = (await client.callTool({ name: 'open_url', arguments: { intent: 'x' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('fake results never say "dry run" (that would change the behaviour we measure)', () => {
    for (const t of ['announce', 'open_url', 'open_app', 'play_media', 'desktop_status', 'snapshot', 'click', 'anything']) {
      expect(textOf(fakeResult(t, { url: 'https://x', app: 'Notes', query: 'q' }, 1))).not.toMatch(/dry|fake|simulat|pretend/i);
    }
  });

  it('readDryCalls parses the JSONL record file', () => {
    expect(readDryCalls('')).toEqual([]);
    expect(readDryCalls('{"tool":"a","args":{},"n":1}\n\n{"tool":"b","args":{"x":1},"n":2}\n')).toEqual([
      { tool: 'a', args: {}, n: 1 },
      { tool: 'b', args: { x: 1 }, n: 2 },
    ]);
  });
});

describe('serve --dry-run --record', () => {
  it('parses only as a pair, absolute path, nothing else combined', () => {
    expect(parseServeArgs(['--dry-run', '--record', '/tmp/x.jsonl'])).toEqual({ dryRun: { record: '/tmp/x.jsonl' } });
    expect(parseServeArgs(['--record=/tmp/x.jsonl', '--dry-run'])).toEqual({ dryRun: { record: '/tmp/x.jsonl' } });
    expect(parseServeArgs(['--dry-run'])).toEqual({ error: '--dry-run and --record <file> go together' });
    expect(parseServeArgs(['--record', '/tmp/x'])).toEqual({ error: '--dry-run and --record <file> go together' });
    expect(parseServeArgs(['--dry-run', '--record', 'rel.jsonl'])).toEqual({ error: '--record needs an absolute file path' });
    expect(parseServeArgs(['--dry-run', '--record'])).toEqual({ error: '--record needs an absolute file path' });
    expect(parseServeArgs(['--dry-run', '--record', '/x', '--voice'])).toEqual({ error: '--dry-run cannot be combined with other serve options' });
    expect(parseServeArgs(['--dry-run', '--record', '/x', '--confirm', 'dialog'])).toEqual({ error: '--dry-run cannot be combined with other serve options' });
    expect(parseServeArgs(['--confirm', 'dialog', '--voice'])).toEqual({ confirm: 'dialog', voice: true }); // unchanged
  });

  it('end to end over stdio (dist/cli.js): tools listed, call recorded to the file, process exits on close', async () => {
    const cli = resolve('dist/cli.js');
    const tmp = mkdtempSync(join(tmpdir(), 'dry-e2e-'));
    const rec = join(tmp, 'calls.jsonl');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', '--dry-run', '--record', rec],
      env: { ...process.env, HOME: tmp, STEPHEN_HOME: join(tmp, 'hub') } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('announce');
    expect(tools).toContain('play_media');
    const r = (await client.callTool({ name: 'play_media', arguments: { query: 'One Call Away Charlie Puth', intent: 'play' } })) as CallToolResult;
    expect(textOf(r)).toMatch(/^Playing "One Call Away Charlie Puth"/);
    await client.close();
    expect(readDryCalls(readFileSync(rec, 'utf8'))).toEqual([{ tool: 'play_media', args: { query: 'One Call Away Charlie Puth', intent: 'play' }, n: 1 }]);
  }, 30_000);
});
