/**
 * Structural guarantees for memory (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 4.6): nothing Claude can reach has a
 * path to the memory store. The MCP server, the safety gate, desktop actions, drivers, the page engine and the eval
 * dry-run server must not import src/memory (directly, or at runtime through other modules), and no MCP tool is
 * named like a memory tool. Later boundaries (src/app) are added to BOUNDARIES.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { buildServer, type ServerDeps } from '../../src/server/index.js';
import type { ServerDepsWithVoice } from '../../src/voice/announce.js';
import { CLAUDE_REACHABLE, directViolations, importsOf, scanSrc, staticReach, transitiveViolations, SRC_ROOT, type Boundary } from '../helpers/import-scan.js';
import { FakeAudit, FakeGate, FakeManager, makeEngine, setup } from '../server/fakes.js';
import { join } from 'node:path';

vi.mock('../../src/safety/index.js', () => import('../server/safety-mock.js'));

const BOUNDARIES: readonly Boundary[] = [
  { target: 'src/memory/', importers: CLAUDE_REACHABLE },
  // The Stephen window's socket (app.sock) can change memory and history: nothing Claude reaches may import it.
  { target: 'src/app/', importers: CLAUDE_REACHABLE },
  // History holds every command and reply and is "never sent to Claude" (review 5, R5-7).
  { target: 'src/history/', importers: CLAUDE_REACHABLE },
];

const MEMORY_TOOL_RE = /remember|memor|forget/i;

describe('import boundaries', () => {
  const refs = scanSrc();

  it('the scanner sees static, multi-line, type-only and dynamic imports', () => {
    const tools = importsOf(join(SRC_ROOT, 'server', 'tools.ts'));
    expect(tools).toContainEqual(expect.objectContaining({ resolved: 'src/voice/announce.ts', typeOnly: false }));
    const dry = importsOf(join(SRC_ROOT, 'eval', 'dry-server.ts'));
    expect(dry).toContainEqual(expect.objectContaining({ resolved: 'src/voice/announce.ts', typeOnly: true }));
    expect(refs).toContainEqual(expect.objectContaining({ from: 'src/cli.ts', resolved: 'src/memory/cli.ts', typeOnly: false }));
    expect(refs).toContainEqual(expect.objectContaining({ from: 'src/memory/store.ts', resolved: 'src/safety/session-state.ts' }));
    // The rule itself fires: memory → safety would be a violation if the roles were swapped.
    expect(directViolations({ target: 'src/safety/', importers: ['src/memory/'] }, refs).length).toBeGreaterThan(0);
    expect(transitiveViolations({ target: 'src/server/util.ts', importers: ['src/server/tools.ts'] }, refs)[0]?.at(-1)).toBe('src/server/util.ts');
  });

  for (const b of BOUNDARIES) {
    it(`no direct import of ${b.target} from ${b.importers.join(', ')}`, () => {
      expect(directViolations(b, refs).map((r) => `${r.from} imports ${r.spec}`)).toEqual([]);
    });

    it(`no runtime import chain reaches ${b.target} from ${b.importers.join(', ')}`, () => {
      expect(transitiveViolations(b, refs).map((c) => c.join(' -> '))).toEqual([]);
    });
  }
});

describe('the stephen serve process (review 5, R5-7)', () => {
  it('src/cli.ts loads no memory, app or history code at start-up (listen/memory/history/app load it on demand)', () => {
    const loaded = [...staticReach('src/cli.ts')];
    expect(loaded).toContain('src/server/index.ts'); // the scan works
    expect(loaded.filter((f) => /^src\/(memory|app|history)\//.test(f))).toEqual([]);
  });
});

describe('MCP tool surface', () => {
  it('no tool is named like a memory tool (every optional tool on, voice server included)', async () => {
    const h = await setup({ overrides: { safety: { allowEvaluate: true } } });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(20);

    const voice = buildServer({
      cfg: h.cfg,
      manager: new FakeManager(),
      engine: makeEngine(),
      safetyFactory: vi.fn(() => ({ gate: new FakeGate(), audit: new FakeAudit() })) as unknown as ServerDeps['safetyFactory'],
      voice: {},
    } as ServerDepsWithVoice);
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([voice.connect(b), client.connect(a)]);
    const voiceNames = (await client.listTools()).tools.map((t) => t.name);
    expect(voiceNames).toContain('announce');

    for (const n of [...names, ...voiceNames]) expect(n, n).not.toMatch(MEMORY_TOOL_RE);
  });
});
