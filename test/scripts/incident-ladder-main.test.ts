/**
 * #368: the incident ladder's main loop (scripts/incident-ladder.mjs) with gh, git, claude and fetch faked through its
 * `io` seam. No real network, no real gh, no real model. Needs `npm run build` (the script reads its rules from dist/).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_AUTHOR_IDS } from '../../src/telemetry/incident-ladder.js';
import { parseIncidentRecord } from '../../src/telemetry/incidents.js';
import { formatReport } from '../../src/telemetry/report.js';
// @ts-expect-error: a plain .mjs script, no types
import { io, main } from '../../scripts/incident-ladder.mjs';

const CRIS = ALLOWED_AUTHOR_IDS[0]!;
const NOW = new Date('2026-11-26T12:00:00.000Z');
const rec = parseIncidentRecord({ v: 1, id: 'cmd-1', ts: '2026-11-20T10:00:00.000Z', stephen: '0.9.1', part: 'serve', code: 'ECONNRESET', stage: 'replyReady', node: '24.20.0', darwin: '25.1.0' })!;
const BODY = formatReport([rec]).body;

interface Comment {
  body: string;
  created_at: string;
  user: { id: number };
}

let events: string[];
let comments: Map<number, Comment[]>;
let labelExists: boolean;
let issues: { number: number; body: string; user: { id: number }; created_at: string }[];
let claudePrompts: string[];
let opencodeCalls: { args: string[]; opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } }[];
let opencodeOut: () => Promise<string>;
const saved = { ...io };
const DRAFT = { cause: 'socket_closed_early', confidence: 'medium', files: [], test: '', summary: 'free draft' };
const textEvent = (text: string) => JSON.stringify({ type: 'text', part: { type: 'text', text } });

function fakeRun(file: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {}): Promise<string> {
  const ok = (v: unknown) => Promise.resolve(typeof v === 'string' ? v : JSON.stringify(v));
  if (file === 'gh' && args[0] === 'api') {
    if (args[1] === 'graphql') return ok({ data: { repository: { issue: { lastEditedAt: null, createdAt: '2026-11-20T10:00:00Z' } } } });
    const path = args[1]!;
    if (path.endsWith('/labels/needs-cris')) return labelExists ? ok({ name: 'needs-cris' }) : Promise.reject(new Error('HTTP 404'));
    const m = /issues\/(\d+)\/comments/.exec(path);
    if (m) return ok(comments.get(Number(m[1])) ?? []);
    if (path.includes('state=open')) {
      events.push('list open');
      return ok(issues);
    }
    if (path.includes('state=all')) return ok([]);
  }
  if (file === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
    const n = Number(args[2]);
    const body = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf8');
    events.push(`comment #${n}`);
    comments.set(n, [...(comments.get(n) ?? []), { body, created_at: NOW.toISOString(), user: { id: CRIS } }]);
    return ok('');
  }
  if (file === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
    events.push(`label #${args[2]} ${args[args.indexOf('--add-label') + 1]}`);
    return ok('');
  }
  if (file === 'opencode') {
    events.push('opencode');
    opencodeCalls.push({ args, opts });
    return opencodeOut();
  }
  if (file === 'claude') {
    events.push(`claude ${args[args.indexOf('--model') + 1]}`);
    claudePrompts.push(args.join(' '));
    return ok({ structured_output: null }); // fails the check: the ladder climbs to L5
  }
  if (file === 'git' || file === 'tar') return ok('');
  return Promise.reject(new Error(`unexpected ${file} ${args.join(' ')}`));
}

beforeEach(() => {
  events = [];
  comments = new Map();
  labelExists = true;
  // Filed six days ago: an old open incident must still be listed (no `since` on the open list).
  issues = [{ number: 41, body: BODY, user: { id: CRIS }, created_at: '2026-11-20T10:00:00Z' }];
  Object.assign(io, { run: fakeRun, fetch: () => Promise.reject(new Error('no network in tests')), log: () => {}, now: () => NOW, dry: false });
  claudePrompts = [];
  opencodeCalls = [];
  opencodeOut = () => Promise.resolve(`${textEvent(JSON.stringify(DRAFT))}\n`);
  for (const k of ['INCIDENT_L1_MODEL', 'FREELLM_API_KEY', 'INCIDENT_L1B_MODEL']) delete process.env[k];
});
afterEach(() => {
  Object.assign(io, saved);
  for (const k of ['INCIDENT_L1_MODEL', 'FREELLM_API_KEY', 'INCIDENT_L1B_MODEL']) delete process.env[k];
});

describe('incident ladder main loop', () => {
  it('lists an old open incident, climbs to L5, and posts the comment before the label', async () => {
    await main();
    expect(events).toEqual(['list open', 'claude haiku', 'claude sonnet', 'claude opus', 'comment #41', 'label #41 needs-cris', 'comment #274']);
    const posted = comments.get(41)![0]!.body;
    expect(posted.split('\n')[0]).toBe('from: incident-bot');
    expect(posted).toMatch(/^Trail: L1a none, L1b none, L2 failed, L3 failed, L4 failed, L5$/m);
  });

  it('a missing needs-cris label stops before any level', async () => {
    labelExists = false;
    await expect(main()).rejects.toThrow(/Create the needs-cris label first/);
    expect(events.filter((e) => e.startsWith('claude') || e.startsWith('comment') || e.startsWith('label'))).toEqual([]);
  });

  it('the same body never gets two comments', async () => {
    await main();
    events = [];
    await main();
    expect(events).toEqual(['list open']);
    expect(comments.get(41)!.filter((c) => c.body.includes('<!-- ladder:'))).toHaveLength(1);
  });

  it('skips an issue from another author without reading it', async () => {
    issues = [{ ...issues[0]!, user: { id: 1 } }];
    await main();
    expect(events).toEqual(['list open']);
  });

  it('a dry run posts and labels nothing', async () => {
    io.dry = true;
    await main();
    expect(events.some((e) => e.startsWith('comment') || e.startsWith('label'))).toBe(false);
  });
});

describe('free levels first (docs/design/INCIDENT-LADDER-FREE-FIRST.md)', () => {
  const freellmOk = () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ ...DRAFT, summary: 'freellm draft' }) } }] }) });
  const optIn = () => {
    process.env.INCIDENT_L1_MODEL = 'gpt-oss-120b';
    process.env.FREELLM_API_KEY = 'test-key';
    process.env.INCIDENT_L1B_MODEL = 'opencode/deepseek-v4.1-flash-free';
  };
  const trail = () => /^Trail: (.*)$/m.exec(comments.get(41)![0]!.body)![1];

  it('L1a gives a draft: opencode never runs, and L2 gets the L1a draft', async () => {
    optIn();
    io.fetch = freellmOk;
    await main();
    expect(events).not.toContain('opencode');
    expect(claudePrompts[0]).toContain('freellm draft');
    expect(trail()).toBe('L1a draft, L2 failed, L3 failed, L4 failed, L5');
  });

  for (const [name, fetch] of [
    ['unreachable', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['bad JSON', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'not json' } }] }) })],
  ] as const) {
    it(`L1a ${name}: L1b runs, and L2 gets the L1b draft`, async () => {
      optIn();
      io.fetch = fetch;
      await main();
      expect(events.slice(0, 3)).toEqual(['list open', 'opencode', 'claude haiku']);
      expect(claudePrompts[0]).toContain('free draft');
      expect(trail()).toBe('L1a none, L1b draft, L2 failed, L3 failed, L4 failed, L5');
    });
  }

  it('both free levels fail: L2 runs with no draft', async () => {
    optIn();
    opencodeOut = () => Promise.reject(new Error('timeout'));
    await main();
    expect(claudePrompts[0]).toContain('No earlier pass.');
    expect(trail()).toBe('L1a none, L1b none, L2 failed, L3 failed, L4 failed, L5');
  });

  for (const model of [undefined, 'opencode/big-pickle', 'auto']) {
    it(`INCIDENT_L1B_MODEL=${model}: no opencode call`, async () => {
      if (model) process.env.INCIDENT_L1B_MODEL = model;
      await main();
      expect(events).not.toContain('opencode');
    });
  }

  it('the opencode call: pinned model, no --auto, no secret, an empty cwd, an isolated config', async () => {
    optIn();
    process.env.GH_TOKEN = 'secret-gh';
    try {
      await main();
    } finally {
      delete process.env.GH_TOKEN;
    }
    const { args, opts } = opencodeCalls[0]!;
    expect(args.slice(0, 7)).toEqual(['run', '--standalone', '--archived', '--format', 'json', '-m', 'opencode/deepseek-v4.1-flash-free']);
    expect(args).not.toContain('--auto');
    expect(opts.timeout).toBe(45_000);
    expect(opts.env!.FREELLM_API_KEY).toBeUndefined();
    expect(opts.env!.GH_TOKEN).toBeUndefined();
    expect(opts.env!.OPENCODE_CONFIG!.startsWith(opts.env!.XDG_CONFIG_HOME!)).toBe(true);
    expect(opts.cwd).toMatch(/l1b-[^/]+\/cwd$/);
  });
});
