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
import { CLAUDE_REACHABLE, REPO_ROOT, directViolations, importsOf, listTsFiles, scanSrc, staticReach, transitiveViolations, SRC_ROOT, type Boundary } from '../helpers/import-scan.js';
import { FakeAudit, FakeGate, FakeManager, makeEngine, setup } from '../server/fakes.js';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

vi.mock('../../src/safety/index.js', () => import('../server/safety-mock.js'));

const BOUNDARIES: readonly Boundary[] = [
  { target: 'src/memory/', importers: CLAUDE_REACHABLE },
  // The Stephen window's socket (app.sock) can change memory and history: nothing Claude reaches may import it.
  { target: 'src/app/', importers: CLAUDE_REACHABLE },
  // History holds every command and reply and is "never sent to Claude" (review 5, R5-7).
  { target: 'src/history/', importers: CLAUDE_REACHABLE },
  // Timers/reminders are spoken later: Claude-reachable code must not be able to create them.
  { target: 'src/timers/', importers: CLAUDE_REACHABLE },
  // `stephen connect gmail` (OAuth sign-in, Keychain write, config change) is owner-only: no tool may reach it.
  { target: 'src/connect/', importers: CLAUDE_REACHABLE },
  // Background jobs (docs/ADR-004 rule 1): the model never starts one, so nothing it can reach may load src/jobs.
  { target: 'src/jobs/', importers: CLAUDE_REACHABLE },
  // Resume (ADR-007 v2) sends stored turns back to the model: only the owner's click may start it (covered by
  // src/history/ above too; named so a move out of src/history keeps the rule).
  { target: 'src/history/resume.ts', importers: CLAUDE_REACHABLE },
];

/**
 * A job gets no memory, no history, no account data and none of Stephen's tools (ADR-004 rule 3): src/jobs may not
 * load those. One file of src/accounts is allowed: result.ts, the pure text cleaner (reduceLinks) for job output.
 */
const JOB_FORBIDDEN = ['src/memory/', 'src/history/', 'src/app/', 'src/server/', 'src/connect/', 'src/timers/', 'src/desktop/', 'src/drivers/', 'src/page/', 'src/voice/'];
const JOB_ACCOUNTS_OK = 'src/accounts/result.ts';

const MEMORY_TOOL_RE = /remember|memor|forget/i;

/**
 * Account and sign-in code reads secrets through src/lib/keychain.ts, not through the voice code. One exception:
 * src/connect/voice-key.ts is `stephen voice-key`, the ElevenLabs key CLI, so it uses the voice key lookup.
 */
const NO_VOICE_IMPORT: Boundary = { target: 'src/voice/', importers: ['src/accounts/', 'src/connect/'] };
const VOICE_KEY_CLI = 'src/connect/voice-key.ts';

describe('import boundaries', () => {
  const refs = scanSrc();

  it('the scanner sees static, multi-line, type-only and dynamic imports', () => {
    const tools = importsOf(join(SRC_ROOT, 'server', 'tools.ts'));
    expect(tools).toContainEqual(expect.objectContaining({ resolved: 'src/voice/announce.ts', typeOnly: false }));
    const dry = importsOf(join(SRC_ROOT, 'eval', 'dry-server.ts'));
    expect(dry).toContainEqual(expect.objectContaining({ resolved: 'src/voice/announce.ts', typeOnly: true }));
    expect(refs).toContainEqual(expect.objectContaining({ from: 'src/cli.ts', resolved: 'src/memory/cli.ts', typeOnly: false }));
    expect(refs).toContainEqual(expect.objectContaining({ from: 'src/memory/store.ts', resolved: 'src/safety/text.ts' }));
    // The rule itself fires: memory → safety would be a violation if the roles were swapped.
    expect(directViolations({ target: 'src/safety/', importers: ['src/memory/'] }, refs).length).toBeGreaterThan(0);
    expect(transitiveViolations({ target: 'src/server/util.ts', importers: ['src/server/tools.ts'] }, refs)[0]?.at(-1)).toBe('src/server/util.ts');
  });

  it('src/lib/ imports nothing outside src/lib/ (node built-ins and packages only)', () => {
    const fromLib = refs.filter((r) => r.from.startsWith('src/lib/'));
    expect(fromLib.length).toBeGreaterThan(5); // the scan sees src/lib
    expect(fromLib.filter((r) => r.resolved && !r.resolved.startsWith('src/lib/')).map((r) => `${r.from} imports ${r.spec}`)).toEqual([]);
  });

  it('src/lib/ (loaded by serve) holds no Keychain write or config writer; memory is out of reach (CLAUDE_REACHABLE)', () => {
    for (const abs of listTsFiles(join(SRC_ROOT, 'lib'))) {
      const src = readFileSync(abs, 'utf8');
      expect(src, abs).not.toMatch(/add-generic-password|delete-generic-password|\['-i'\]|keychainStore|keychainDelete|updateAccountsConfig|updateConfigSection/);
    }
    expect(CLAUDE_REACHABLE).toContain('src/lib/');
  });

  it('src/accounts/ and src/connect/ do not import src/voice/ (only the voice-key CLI does)', () => {
    expect(directViolations(NO_VOICE_IMPORT, refs).filter((r) => r.from !== VOICE_KEY_CLI).map((r) => `${r.from} imports ${r.spec}`)).toEqual([]);
    const chains = transitiveViolations(NO_VOICE_IMPORT, refs).filter((c) => !c.includes(VOICE_KEY_CLI));
    expect(chains.map((c) => c.join(' -> '))).toEqual([]);
    // The rule fires: the voice-key CLI is the one known importer.
    expect(directViolations(NO_VOICE_IMPORT, refs).map((r) => r.from)).toContain(VOICE_KEY_CLI);
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

describe('src/jobs (docs/ADR-004)', () => {
  const refs = scanSrc();

  it('is loaded only by the listener (src/voice/index.ts, job-rows.ts) and, on demand, by src/cli.ts', () => {
    const from = [...new Set(refs.filter((r) => r.resolved?.startsWith('src/jobs/') && !r.from.startsWith('src/jobs/')).map((r) => `${r.from}${r.dynamic ? ' (dynamic)' : ''}`))].sort();
    expect(from).toEqual(['src/cli.ts (dynamic)', 'src/voice/index.ts', 'src/voice/job-rows.ts']);
    expect([...staticReach('src/cli.ts')].filter((f) => f.startsWith('src/jobs/'))).toEqual([]);
  });

  it('no job tool exists: no MCP tool is registered from src/jobs, and no tool name says "job"', () => {
    for (const abs of listTsFiles(join(SRC_ROOT, 'jobs'))) expect(readFileSync(abs, 'utf8'), abs).not.toMatch(/registerTool|McpServer|server\.tool\(/);
    for (const abs of listTsFiles(join(SRC_ROOT, 'server'))) expect(readFileSync(abs, 'utf8'), abs).not.toMatch(/['"`][a-z_]*job[a-z_]*['"`]\s*,\s*\{/i);
  });

  it('loads no memory, history, app, server, timer, voice or account-service code (rule 3)', () => {
    for (const target of JOB_FORBIDDEN) {
      const b: Boundary = { target, importers: ['src/jobs/'] };
      expect(directViolations(b, refs).map((r) => `${r.from} imports ${r.spec}`), target).toEqual([]);
      expect(transitiveViolations(b, refs).map((c) => c.join(' -> ')), target).toEqual([]);
    }
    const accounts = transitiveViolations({ target: 'src/accounts/', importers: ['src/jobs/'] }, refs).filter((c) => c.at(-1) !== JOB_ACCOUNTS_OK);
    expect(accounts.map((c) => c.join(' -> '))).toEqual([]);
  });
});

describe('the stephen serve process (review 5, R5-7)', () => {
  it('src/cli.ts loads no memory, app or history code at start-up (listen/memory/history/app load it on demand)', () => {
    const loaded = [...staticReach('src/cli.ts')];
    expect(loaded).toContain('src/server/index.ts'); // the scan works
    expect(loaded.filter((f) => /^src\/(memory|app|history|timers|connect|jobs)\//.test(f))).toEqual([]);
    // The owner-only CLIs (connect, accounts, voice-key) are reached only through dynamic imports from src/cli.ts.
    const fromOutside = scanSrc().filter((r) => r.resolved?.startsWith('src/connect/') && !r.from.startsWith('src/connect/'));
    expect(fromOutside.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(fromOutside.map((r) => `${r.from}${r.dynamic ? ' (dynamic)' : ''}`))]).toEqual(['src/cli.ts (dynamic)']);
  });

  it('R7-8: no Keychain write/delete or config writer is in serve\'s start-up graph or anywhere Claude can reach', () => {
    const WRITERS = /export\s+(?:async\s+)?function\s+(keychainStore|keychainDelete|updateAccountsConfig|updateConfigSection|runVoiceKey)\b/;
    const definedIn = listTsFiles()
      .map((abs) => ({ file: relative(REPO_ROOT, abs).split(sep).join('/'), src: readFileSync(abs, 'utf8') }))
      .filter((f) => WRITERS.test(f.src))
      .map((f) => f.file)
      .sort();
    expect(definedIn).toEqual(['src/config-write.ts', 'src/connect/accounts-cli.ts', 'src/connect/keychain-write.ts', 'src/connect/voice-key.ts']);
    const loaded = staticReach('src/cli.ts');
    expect(definedIn.filter((f) => loaded.has(f))).toEqual([]);
    // Nothing Claude-reachable gets to them at runtime, through any chain (src/connect/ is a boundary target above).
    for (const f of definedIn) expect(transitiveViolations({ target: f, importers: CLAUDE_REACHABLE }, scanSrc()).map((c) => c.join(' -> '))).toEqual([]);
    // The read-only helpers serve does load have no write path left.
    for (const f of ['src/voice/tts/keys.ts', 'src/accounts/secrets.ts', 'src/lib/keychain.ts']) {
      expect(loaded.has(f), f).toBe(true);
      expect(readFileSync(join(REPO_ROOT, f), 'utf8')).not.toMatch(/add-generic-password|delete-generic-password|writeFileSync|renameSync/);
    }
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
    // ADR-007 v2: no model tool can resume or continue a stored chat.
    for (const n of [...names, ...voiceNames]) expect(n, n).not.toMatch(/resume|continue|conversation/i);
  });
});

/**
 * ADR-007 v2 (resume, [DEV REVIEW]): one entry point, the owner's "Open in chat" click in the window. The helper side
 * is checked in test/helper/app-protocol.test.ts; this is the Node side, by source.
 */
describe('resume has one entry point: an owner click in the window', () => {
  const refs = scanSrc();
  const src = (f: string) => readFileSync(join(REPO_ROOT, f), 'utf8');
  const files = listTsFiles().map((abs) => relative(REPO_ROOT, abs).split(sep).join('/'));

  it('src/history/resume.ts is loaded only by the listener (src/voice/index.ts), and nothing model-reachable imports it', () => {
    const from = [...new Set(refs.filter((r) => r.resolved === 'src/history/resume.ts').map((r) => `${r.from}${r.dynamic ? ' (dynamic)' : ''}`))];
    expect(from).toEqual(['src/voice/index.ts']);
    const b: Boundary = { target: 'src/history/resume.ts', importers: CLAUDE_REACHABLE };
    expect(transitiveViolations(b, refs).map((c) => c.join(' -> '))).toEqual([]);
    expect([...staticReach('src/cli.ts')]).not.toContain('src/history/resume.ts');
  });

  it('chat.resume is an app.sock request only: no serve, gate, tool or other code names it', () => {
    expect(files.filter((f) => /['"]chat\.resume/.test(src(f))).sort()).toEqual(['src/app/protocol.ts', 'src/app/server.ts']);
    // The gate's own app.sock client (the only serve code that talks to app.sock) sends confirm.ask and nothing else.
    expect(src('src/safety/app-confirm.ts')).not.toMatch(/resume/i);
    for (const f of files.filter((f) => CLAUDE_REACHABLE.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)))) {
      expect(src(f), f).not.toMatch(/chat\.resume|ResumeArm|resumePrompt|ResumeRequest/);
    }
  });

  it('only a window command can carry a resume: no voice phrase, phone command or --text path reaches it', () => {
    // HandleOptions.resume is set in one place: listenerQueue (app chat.send), from the arm the click set.
    expect(files.filter((f) => /\bResumeRequest\b/.test(src(f))).sort()).toEqual(['src/app/server.ts', 'src/voice/assistant.ts']);
    const server = src('src/app/server.ts');
    expect(server).toMatch(/const resume = o\.window \? \(takeResume\?\.\(\) \?\? null\) : null;\s*return assistant\.command\(text, \{ source: 'app',[^}]*\.\.\.\(resume \? \{ resume \} : \{\}\) \}\);/);
    // The listener: the arm is taken only in the app queue; every command start clears it unless it came from the window.
    const index = src('src/voice/index.ts');
    expect(index.match(/resumeArm\.take\(\)/g)).toHaveLength(1);
    expect(index).toMatch(/queue: listenerQueue\(l, a, \(\) => \{\s*const conv = resumeArm\.take\(\);/);
    expect(index).toMatch(/const onStart = \(c: [^)]*\) => \{\s*resumeArm\.commandStarted\(c\.source\);/);
    expect(index.match(/resumeArm\.arm\(/g)).toHaveLength(1); // inside the app server's resume.arm (chat.resume)
    // The phone and --text paths call the Assistant without a resume.
    expect(index).toMatch(/a\.command\(text, \{ source: 'phone', raw: text, speak: false \}\)/);
    expect(index).toMatch(/assistant\.handle\(text, \{ source: 'cli', raw: text \}\)/);
    // No voice router or phone code knows about resume.
    for (const f of files.filter((f) => (f.startsWith('src/voice/') || f.startsWith('src/phone/')) && !['src/voice/index.ts', 'src/voice/assistant.ts', 'src/voice/conversation.ts', 'src/voice/claude.ts', 'src/voice/warm-claude.ts', 'src/voice/command-log.ts'].includes(f))) {
      expect(src(f), f).not.toMatch(/ResumeArm|ResumeRequest|resumePrompt|chat\.resume|assumePrivateRead|history\/resume/);
    }
  });
});
