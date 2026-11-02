/**
 * The warm process (src/voice/warm-claude.ts) against the fake claude's stream-json mode (fake-claude-stream.mjs):
 * argv, the one-line JSON messages, persona deletion after initialize, MCP readiness, errors (error result,
 * exit mid-turn, malformed output, MCP not connected), per-command differences of the cumulative cost / api time,
 * and kill() taking the whole process group.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, LOCKDOWN_ARGS, NO_SESSION_PERSISTENCE, buildClaudeArgs, buildWarmArgs, mcpConfig, type ClaudeSettings } from '../../src/voice/claude.js';
import { WarmClaude, probeWarmProtocol, userMessageLine, type WarmClaudeOptions } from '../../src/voice/warm-claude.js';
import { fakeClaudePath, isAlive, readFakeLog, waitFor } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-warm-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let k = 0;

interface Turn {
  pid: number;
  n: number;
  prompt: string;
  line: string;
  personaExists: boolean | null;
}

function setup(env: Record<string, string> = {}, over: Partial<WarmClaudeOptions> = {}) {
  const dir = join(tmp, `w${++k}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, 'claude.log');
  const turnsLog = join(dir, 'turns.log');
  const pids = join(dir, 'pids.json');
  const toolLog = join(dir, 'tool-log.jsonl');
  const mcpConfigPath = join(dir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig('/usr/bin/node', '/x/cli.js', null, toolLog)));
  const o: WarmClaudeOptions = {
    claudePath: fakeClaudePath(),
    maxTurns: 25,
    model: 'sonnet',
    mcpConfigPath,
    followUps: true,
    personaFile: join(dir, 'persona.txt'),
    cwd: dir,
    env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_TURNS: turnsLog, FAKE_CLAUDE_PIDS: pids, ...env },
    killGraceMs: 300,
    readyTimeoutMs: 3000,
    mcpPollMs: 20,
    ...over,
  };
  const turns = (): Turn[] => (existsSync(turnsLog) ? readFileSync(turnsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Turn) : []);
  const procs = (): { claude: number; child: number } => JSON.parse(readFileSync(pids, 'utf8'));
  return { dir, o, log, toolLog, turns, procs };
}

const SETTINGS: ClaudeSettings = { claudePath: 'claude', maxTurns: 25, model: 'sonnet', mcpConfigPath: '/h/voice/mcp-config.json', followUps: true, personaFile: '/h/voice/persona.txt' };

describe('buildWarmArgs', () => {
  it('stream-json in and out, the same lock-down as the one-shot argv, no prompt, no --resume', () => {
    const a = buildWarmArgs(SETTINGS);
    expect(a.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    // Everything after the output format is identical to the one-shot run's (review-style: nothing changes).
    expect(a.slice(6)).toEqual(buildClaudeArgs('open youtube', SETTINGS).slice(4));
    expect(a.slice(6)).toEqual([
      '--mcp-config',
      '/h/voice/mcp-config.json',
      ...LOCKDOWN_ARGS,
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      '--disallowedTools',
      DISALLOWED_TOOLS.join(','),
      '--append-system-prompt-file',
      '/h/voice/persona.txt',
      '--max-turns',
      '25',
      '--model',
      'sonnet',
    ]);
    expect(a).not.toContain('--resume');
    expect(a).not.toContain('--include-partial-messages');
    expect(a).not.toContain(NO_SESSION_PERSISTENCE); // follow-ups on: same rule as one-shot
    expect(buildWarmArgs({ ...SETTINGS, followUps: false })).toContain(NO_SESSION_PERSISTENCE);
  });

  it('argv-persona mode puts the memory in --append-system-prompt like the one-shot runner', () => {
    const a = buildWarmArgs({ ...SETTINGS, personaFile: null }, ['my gym is goodlife']);
    expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('my gym is goodlife');
  });

  it('userMessageLine: one JSON line, whatever the prompt holds', () => {
    const prompt = 'say "hi"\nthen {"type":"user"} \\ and   done';
    const line = userMessageLine(prompt);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
  });
});

describe('WarmClaude against the fake stream-json claude', () => {
  it('two commands on one process: one valid line each, same session, per-command api time and cost', async () => {
    const t = setup({ FAKE_CLAUDE_DURATION_MS: '30', FAKE_CLAUDE_API_MS: '250' });
    const p = new WarmClaude(t.o, 'key-1', ['my gym is goodlife']);
    await p.ready();
    const prompt = 'play "one call away"\nby charlie puth';
    const a = await p.turn(prompt);
    const b = await p.turn('now pause it');
    expect(a).toMatchObject({ kind: 'ok', turns: 2, durationMs: 30, apiMs: 250 });
    expect(b).toMatchObject({ kind: 'ok', turns: 2, durationMs: 30, apiMs: 250 }); // cumulative 500 → 250 for this one
    expect(a.kind === 'ok' && a.costUsd).toBeCloseTo(0.01);
    expect(b.kind === 'ok' && b.costUsd).toBeCloseTo(0.01);
    expect(a.kind === 'ok' && a.sessionId).toBe(b.kind === 'ok' && b.sessionId);
    const turns = t.turns();
    expect(turns.map((x) => x.prompt)).toEqual([prompt, 'now pause it']);
    expect(turns.every((x) => x.pid === turns[0]!.pid)).toBe(true);
    expect(JSON.parse(turns[0]!.line)).toEqual({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
    // One process for both, with the warm argv and the persona (memory included) at start-up.
    const runs = readFakeLog(t.log);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv).toEqual(buildWarmArgs(t.o));
    expect(runs[0]!.persona?.text).toContain('my gym is goodlife');
    expect(runs[0]!.persona?.mode).toBe(0o600);
    await p.kill();
  });

  it('the persona file is deleted after initialize answers, not before', async () => {
    const t = setup({ FAKE_CLAUDE_INIT_MS: '300' });
    const p = new WarmClaude(t.o, undefined, []);
    await waitFor(() => readFakeLog(t.log).length === 1, 5000, 'spawn');
    expect(existsSync(t.o.personaFile!)).toBe(true); // still there while initialize is pending
    await p.initialized;
    expect(existsSync(t.o.personaFile!)).toBe(false);
    await p.ready();
    await p.turn('hi');
    expect(t.turns()[0]!.personaExists).toBe(false);
    expect(readFakeLog(t.log)[0]!.persona?.text).toContain('You are Stephen');
    await p.kill();
  });

  it('waits while stephen is pending, then is ready', async () => {
    const t = setup({ FAKE_CLAUDE_MCP: 'slow' });
    const p = new WarmClaude(t.o, undefined);
    await p.ready();
    expect((await p.turn('hi')).kind).toBe('ok');
    await p.kill();
  });

  it.each([
    ['MCP failed', { FAKE_CLAUDE_MCP: 'failed' }, /MCP status: failed/],
    ['MCP never connects', { FAKE_CLAUDE_MCP: 'pending' }, /didn't connect in time/],
    ['initialize refused', { FAKE_CLAUDE_MODE: 'init-error' }, /refused the request \(initialize refused\)/],
    ['initialize never answered', { FAKE_CLAUDE_MODE: 'no-init' }, /didn't answer initialize/],
  ])('%s: not ready, fails closed (process group killed, persona deleted)', async (_what, env, why) => {
    const t = setup(env, { readyTimeoutMs: 400 });
    const p = new WarmClaude(t.o, undefined);
    await expect(p.ready()).rejects.toThrow(why);
    const turn = await p.turn('hi');
    expect(turn.kind).not.toBe('ok');
    await p.kill();
    const { claude, child } = t.procs();
    expect(isAlive(claude)).toBe(false);
    expect(isAlive(child)).toBe(false);
    expect(existsSync(t.o.personaFile!)).toBe(false);
    expect(t.turns()).toEqual([]); // nothing was sent
  });

  it('an error result is an error outcome', async () => {
    const t = setup({ FAKE_CLAUDE_MODE: 'error' });
    const p = new WarmClaude(t.o, undefined);
    await p.ready();
    expect(await p.turn('do a lot')).toMatchObject({ kind: 'error', message: 'I ran out of steps before finishing.' });
    await p.kill();
  });

  it('an exit mid-turn is an error (with the reason)', async () => {
    const t = setup({ FAKE_CLAUDE_MODE: 'exit-mid-turn' });
    const p = new WarmClaude(t.o, undefined);
    const exits: number[] = [];
    p.onExit(() => exits.push(1));
    await p.ready();
    expect(await p.turn('hi')).toMatchObject({ kind: 'error', message: expect.stringMatching(/stopped before it answered \(Error: exited mid-turn\)/) });
    expect(p.exited).toBe(true);
    expect(exits).toEqual([1]);
    await p.kill();
  });

  it('a line that is not JSON is an error and the process is killed', async () => {
    const t = setup({ FAKE_CLAUDE_MODE: 'garbage' });
    const p = new WarmClaude(t.o, undefined);
    await p.ready();
    expect(await p.turn('hi')).toMatchObject({ kind: 'error', message: expect.stringMatching(/isn't stream-json/) });
    await waitFor(() => p.exited, 5000, 'exit');
    expect(isAlive(t.procs().child)).toBe(false);
  });

  it('MCP gone before a later command: that command errors, nothing is sent', async () => {
    const t = setup({ FAKE_CLAUDE_MCP: 'drop' });
    const p = new WarmClaude(t.o, undefined);
    await p.ready();
    expect((await p.turn('one')).kind).toBe('ok');
    expect(await p.turn('two')).toMatchObject({ kind: 'error', message: expect.stringMatching(/not connected \(MCP status: failed\)/) });
    expect(t.turns().map((x) => x.prompt)).toEqual(['one']);
    await p.kill();
  });

  it('kill() during a turn: the turn is cancelled and claude AND its serve child are gone when kill resolves', async () => {
    const t = setup({ FAKE_CLAUDE_MODE: 'hang' });
    const p = new WarmClaude(t.o, undefined);
    await p.ready();
    const turn = p.turn('play a long podcast');
    await waitFor(() => t.turns().length === 1, 5000, 'turn sent');
    await p.kill();
    expect(await turn).toEqual({ kind: 'cancelled' });
    const { claude, child } = t.procs();
    expect(isAlive(claude)).toBe(false);
    expect(isAlive(child)).toBe(false);
  });

  it('a claude that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const t = setup({ FAKE_CLAUDE_MODE: 'hang-stubborn' });
    const p = new WarmClaude(t.o, undefined);
    await p.ready();
    const turn = p.turn('x');
    await waitFor(() => t.turns().length === 1, 5000, 'turn sent');
    const t0 = Date.now();
    await p.kill();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(await turn).toEqual({ kind: 'cancelled' });
    expect(isAlive(t.procs().claude)).toBe(false);
  });

  it('a missing claude binary: not ready, with the install hint', async () => {
    const t = setup({}, { claudePath: join(tmp, 'no-such-claude') });
    const p = new WarmClaude(t.o, undefined);
    await expect(p.ready()).rejects.toThrow(/stopped \(Claude Code was not found/);
    expect(p.exited).toBe(true);
  });

  it('probeWarmProtocol: null when initialize answers, else the reason; the probe process is killed', async () => {
    const ok = setup();
    expect(await probeWarmProtocol(ok.o)).toBeNull();
    expect(isAlive(ok.procs().claude)).toBe(false);
    const bad = setup({ FAKE_CLAUDE_MODE: 'init-error' });
    expect(await probeWarmProtocol(bad.o)).toMatch(/initialize refused/);
  });
});
