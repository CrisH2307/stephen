import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_TOOLS,
  ClaudeRunner,
  DISALLOWED_TOOLS,
  LOCKDOWN_ARGS,
  buildClaudeArgs,
  mcpConfig,
  parseClaudeOutput,
  stephenCliPath,
  writeMcpConfig,
  type ServeInstance,
  type SpawnFn,
} from '../../src/voice/claude.js';
import { claimServeInstance, newServeInstance, serveLockPath } from '../../src/server/instance.js';
import { fakeClaudePath, isAlive, readFakeLog, waitFor } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-claude-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const settings = { claudePath: 'claude', maxTurns: 15, model: null, mcpConfigPath: '/h/voice/mcp-config.json' };
const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('claude argv', () => {
  it('runs headless with ONLY Stephen’s MCP server and tools', () => {
    const a = buildClaudeArgs('open youtube', settings);
    expect(a.slice(0, 2)).toEqual(['-p', 'open youtube']); // prompt right after -p, never after a variadic flag
    expect(flagValue(a, '--output-format')).toBe('json');
    expect(flagValue(a, '--mcp-config')).toBe('/h/voice/mcp-config.json');
    expect(a).toContain('--strict-mcp-config');
    // No built-in tools at all, never a permission prompt, and none of the user's/project's settings files.
    expect(flagValue(a, '--tools')).toBe('');
    expect(flagValue(a, '--permission-mode')).toBe('dontAsk');
    expect(flagValue(a, '--setting-sources')).toBe('');
    expect(flagValue(a, '--allowedTools')).toBe('mcp__stephen');
    expect(ALLOWED_TOOLS).toEqual(['mcp__stephen']);
    const denied = flagValue(a, '--disallowedTools')!.split(',');
    for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Read', 'Glob', 'Grep']) expect(denied).toContain(t);
    expect(denied).toEqual([...DISALLOWED_TOOLS]);
    expect(flagValue(a, '--max-turns')).toBe('15');
    const persona = flagValue(a, '--append-system-prompt')!;
    expect(persona).toMatch(/You are Stephen/);
    expect(persona).toMatch(/only through the Stephen tools/);
    expect(persona).toMatch(/prefer open_url/);
    expect(persona).toMatch(/never try to work around a refusal/);
    expect(persona).toMatch(/one or two short spoken sentences that cover every part/);
    // Speak first, then act (the announce tool exists because the server is started with `serve --voice`).
    expect(persona).toContain(
      "Before doing anything that will play sound (music, a video, a podcast), first call the announce tool with a short line saying what you're about to play (≤ 12 words), then do it.",
    );
    expect(persona).toContain('After starting playback, your final reply should be very short.');
    expect(persona).toContain(
      "The user may refer to earlier commands in this conversation ('follow up', 'what about by car?', 'play the next one'); use the conversation. If there's no earlier context, make your best guess.",
    );
    expect(a).not.toContain('--resume');
    expect(a).not.toContain('--model');
    expect(a).not.toContain('--dangerously-skip-permissions');
    // every element is a plain string argv entry: nothing is shell-quoted
    expect(a.every((x) => typeof x === 'string')).toBe(true);
  });

  it('pins the exact argv (checked against Claude Code 2.1.314; see docs/VOICE.md)', () => {
    expect(buildClaudeArgs('open youtube', { ...settings, model: 'sonnet' })).toEqual([
      '-p',
      'open youtube',
      '--output-format',
      'json',
      '--mcp-config',
      '/h/voice/mcp-config.json',
      '--strict-mcp-config',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--no-chrome',
      '--no-session-persistence',
      '--allowedTools',
      'mcp__stephen',
      '--disallowedTools',
      DISALLOWED_TOOLS.join(','),
      '--append-system-prompt',
      expect.stringMatching(/^You are Stephen/),
      '--max-turns',
      '15',
      '--model',
      'sonnet',
    ]);
    expect([...LOCKDOWN_ARGS]).toEqual(['--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', '', '--no-chrome']);
  });

  it('follow-ups on: no --no-session-persistence (a resumed session must be saved); --resume <id> only when given', () => {
    const on = { ...settings, model: 'sonnet', followUps: true };
    const fresh = buildClaudeArgs('open youtube', on);
    const off = buildClaudeArgs('open youtube', { ...settings, model: 'sonnet' });
    expect(fresh).not.toContain('--no-session-persistence');
    expect(fresh).not.toContain('--resume');
    expect(off.filter((x) => x !== '--no-session-persistence')).toEqual(fresh); // the only difference
    const resumed = buildClaudeArgs('what about by car', on, { resume: '3f2a9c1e-0b7d-4e8a-9f00-1234567890ab' });
    expect(resumed.slice(0, 6)).toEqual(['-p', 'what about by car', '--output-format', 'json', '--resume', '3f2a9c1e-0b7d-4e8a-9f00-1234567890ab']);
    expect(resumed.filter((x, i) => !(x === '--resume' || resumed[i - 1] === '--resume'))).toEqual(buildClaudeArgs('what about by car', on));
    expect(buildClaudeArgs('x', on, { resume: null })).not.toContain('--resume');
    // the --no-session-persistence probe still drops it when this claude lacks it
    expect(buildClaudeArgs('x', { ...settings, unsupportedOptionalFlags: new Set(['--no-session-persistence']) })).not.toContain('--no-session-persistence');
  });

  it('--resume: refused without follow-ups, and only for a plain session id (never option-looking)', () => {
    expect(() => buildClaudeArgs('x', settings, { resume: 'sess-1' })).toThrow(/needs follow-ups/);
    const on = { ...settings, followUps: true };
    for (const bad of ['-p', '--dangerously-skip-permissions', '', 'a b', 'a/b', '../x', 'x'.repeat(129), 'sess\n1']) {
      expect(() => buildClaudeArgs('x', on, { resume: bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it('every variadic flag is followed by another option, so nothing swallows a value it shouldn’t', () => {
    // --mcp-config, --tools, --allowedTools and --disallowedTools take <values...> in Claude Code.
    const a = buildClaudeArgs('open youtube', { ...settings, model: 'sonnet' });
    for (const flag of ['--mcp-config', '--tools', '--allowedTools', '--disallowedTools']) {
      const i = a.indexOf(flag);
      expect(a.indexOf(flag, i + 1), `${flag} appears once`).toBe(-1);
      expect(a[i + 2], `the element after ${flag}'s value`).toMatch(/^--/);
    }
    // the empty values are real empty argv elements (execFile/spawn pass them through as "")
    expect(a.filter((x) => x === '')).toHaveLength(2);
  });

  it('adds --model when given, never --resume; an option-looking prompt stays a prompt', () => {
    const a = buildClaudeArgs('--help me', { ...settings, model: 'sonnet', maxTurns: 6 });
    expect(a[1]).toBe(' --help me');
    expect(flagValue(a, '--model')).toBe('sonnet');
    expect(a).not.toContain('--resume');
    expect(a).not.toContain('--continue');
    expect(a).not.toContain('-c');
    expect(flagValue(a, '--max-turns')).toBe('6');
    expect(() => buildClaudeArgs('  ', settings)).toThrow(/empty prompt/);
  });

  it('the announce tool is covered by --allowedTools mcp__stephen (no extra allow rule needed)', () => {
    // Claude Code rule `mcp__<server>` allows every tool of that server, mcp__stephen__announce included.
    const allowed = flagValue(buildClaudeArgs('play lo-fi', settings), '--allowedTools')!.split(',');
    expect(allowed).toEqual(['mcp__stephen']);
    expect(allowed.some((rule) => 'mcp__stephen__announce' === rule || 'mcp__stephen__announce'.startsWith(`${rule}__`))).toBe(true);
    expect(DISALLOWED_TOOLS.some((t) => /announce/i.test(t))).toBe(false);
  });

  it('MCP config holds exactly one server: stephen = this node + dist/cli.js serve --confirm dialog --voice', async () => {
    expect(mcpConfig('/usr/local/bin/node', '/opt/stephen/dist/cli.js')).toEqual({
      mcpServers: { stephen: { command: '/usr/local/bin/node', args: ['/opt/stephen/dist/cli.js', 'serve', '--confirm', 'dialog', '--voice'] } },
    });
    expect(stephenCliPath()).toMatch(/[/\\]dist[/\\]cli\.js$/);
    const file = await writeMcpConfig(join(tmp, 'voice'), '/n', '/c.js');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { stephen: { command: '/n', args: ['/c.js', 'serve', '--confirm', 'dialog', '--voice'] } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, 'voice')).mode & 0o777).toBe(0o700);
  });

  it('writeMcpConfig tightens a loose folder and file, and leaves no temp files', async () => {
    const dir = join(tmp, 'loose');
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, 'mcp-config.json'), '{"mcpServers":{"evil":{}}}', { mode: 0o666 });
    chmodSync(join(dir, 'mcp-config.json'), 0o666);
    const file = await writeMcpConfig(dir, '/n', '/c.js');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers).toEqual({ stephen: { command: '/n', args: ['/c.js', 'serve', '--confirm', 'dialog', '--voice'] } });
    expect(readdirSync(dir)).toEqual(['mcp-config.json']);
  });

  it('writeMcpConfig never writes through a symlink at the destination (it replaces the link)', async () => {
    const dir = join(tmp, 'linked');
    mkdirSync(dir, { mode: 0o700 });
    const victim = join(tmp, 'victim.txt');
    writeFileSync(victim, 'precious\n');
    symlinkSync(victim, join(dir, 'mcp-config.json'));
    const file = await writeMcpConfig(dir, '/n', '/c.js');
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.stephen.command).toBe('/n');
    // a dangling link is replaced too, and its target is never created
    const dir2 = join(tmp, 'dangling');
    mkdirSync(dir2, { mode: 0o700 });
    symlinkSync(join(tmp, 'created-by-link'), join(dir2, 'mcp-config.json'));
    await writeMcpConfig(dir2, '/n', '/c.js');
    expect(() => readlinkSync(join(dir2, 'mcp-config.json'))).toThrow();
    expect(() => statSync(join(tmp, 'created-by-link'))).toThrow();
  });

  it('writeMcpConfig refuses a folder that is a symlink or a destination that is a folder', async () => {
    const real = join(tmp, 'realdir');
    mkdirSync(real, { mode: 0o755 });
    symlinkSync(real, join(tmp, 'dirlink'));
    await expect(writeMcpConfig(join(tmp, 'dirlink'), '/n', '/c.js')).rejects.toThrow(/must be a real folder \(not a file or a symlink\)/);
    expect(statSync(real).mode & 0o777).toBe(0o755); // not chmodded through the link
    const d = join(tmp, 'destdir');
    mkdirSync(join(d, 'mcp-config.json'), { recursive: true });
    await expect(writeMcpConfig(d, '/n', '/c.js')).rejects.toThrow(/is a folder/);
    expect(readdirSync(d)).toEqual(['mcp-config.json']);
  });
});

describe('parseClaudeOutput', () => {
  it('reads result and session id', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Opened YouTube.', session_id: 'abc-123', total_cost_usd: 0.02, num_turns: 3 });
    expect(parseClaudeOutput(out, 0)).toEqual({ kind: 'ok', text: 'Opened YouTube.', sessionId: 'abc-123', costUsd: 0.02, turns: 3, durationMs: null, apiMs: null });
    expect(parseClaudeOutput(`warning line\n${out}\n`, 0)).toMatchObject({ kind: 'ok', text: 'Opened YouTube.' });
  });
  it('maps errors', () => {
    expect(parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' }), 1)).toEqual({
      kind: 'error',
      message: 'I ran out of steps before finishing.',
      sessionId: 's',
    });
    expect(parseClaudeOutput('nope', 1, 'Error: not logged in\n')).toEqual({ kind: 'error', message: "Claude Code didn't return a result (Error: not logged in).", sessionId: null });
    expect(parseClaudeOutput(JSON.stringify({ type: 'result', result: 'x', session_id: '../../etc' }), 0)).toMatchObject({ sessionId: null });
  });
});

describe('ClaudeRunner with a fake claude', () => {
  const fake = fakeClaudePath();
  const mk = (name: string, extra: Record<string, string> = {}, spawnFn?: SpawnFn) => {
    const log = join(tmp, `${name}.log`);
    const runner = new ClaudeRunner({
      ...settings,
      claudePath: fake,
      cwd: tmp,
      env: { ...process.env, FAKE_CLAUDE_LOG: log, ...extra },
      spawn: spawnFn,
      killGraceMs: 300,
    });
    return { runner, log };
  };

  it('serveInstance (R7-1): every run gets a fresh `serve --instance` config, and its lock is deleted after the run', async () => {
    const home = join(tmp, 'inst-home');
    mkdirSync(join(home, 'voice'), { recursive: true, mode: 0o700 });
    const made: ServeInstance[] = [];
    const log = join(tmp, 'inst.log');
    const runner = new ClaudeRunner({
      ...settings,
      claudePath: fake,
      cwd: tmp,
      env: { ...process.env, FAKE_CLAUDE_LOG: log },
      serveInstance: async () => {
        const id = newServeInstance();
        const inst = { id, lockPath: serveLockPath(home, id), mcpConfigPath: await writeMcpConfig(join(home, 'voice'), '/usr/bin/node', '/x/cli.js', null, null, id) };
        claimServeInstance(home, id, 1); // stands in for the serve the fake claude doesn't start
        made.push(inst);
        return inst;
      },
    });
    expect((await runner.run('open youtube')).kind).toBe('ok');
    expect((await runner.run('open gmail')).kind).toBe('ok');
    expect(made).toHaveLength(2);
    expect(made[0]!.id).not.toBe(made[1]!.id);
    expect(readFakeLog(log).map((r) => flagValue(r.argv, '--mcp-config'))).toEqual(made.map((m) => m.mcpConfigPath));
    for (const m of made) expect(existsSync(m.lockPath)).toBe(false);
    const args = JSON.parse(readFileSync(made[1]!.mcpConfigPath, 'utf8')).mcpServers.stephen.args as string[];
    expect(flagValue(args, '--instance')).toBe(made[1]!.id);
  });

  it('serveInstance gets the run\'s trust (R7-2): a wake-word run\'s serve has --trust wake, a trusted one none', async () => {
    const home = join(tmp, 'trust-home');
    mkdirSync(join(home, 'voice'), { recursive: true, mode: 0o700 });
    const seen: { trust: string; args: string[] }[] = [];
    const runner = new ClaudeRunner({
      ...settings,
      claudePath: fake,
      cwd: tmp,
      env: { ...process.env, FAKE_CLAUDE_LOG: join(tmp, 'trust.log') },
      serveInstance: async (trust) => {
        const id = newServeInstance();
        const inst = { id, lockPath: serveLockPath(home, id), mcpConfigPath: await writeMcpConfig(join(home, 'voice'), '/usr/bin/node', '/x/cli.js', null, null, id, trust) };
        claimServeInstance(home, id, 1);
        seen.push({ trust, args: JSON.parse(readFileSync(inst.mcpConfigPath, 'utf8')).mcpServers.stephen.args as string[] });
        return inst;
      },
    });
    await runner.run('any new emails', { trust: 'wake' });
    await runner.run('open youtube'); // no trust given: the cautious one
    await runner.run('read me that email', { trust: 'trusted' });
    expect(seen.map((s) => s.trust)).toEqual(['wake', 'wake', 'trusted']);
    expect(flagValue(seen[0]!.args, '--trust')).toBe('wake');
    expect(seen[2]!.args).not.toContain('--trust');
    expect(mcpConfig('/n', '/c', null, null, null, 'wake').mcpServers.stephen!.args).toEqual(['/c', 'serve', '--confirm', 'dialog', '--voice', '--trust', 'wake']);
    expect(mcpConfig('/n', '/c').mcpServers.stephen!.args).toEqual(['/c', 'serve', '--confirm', 'dialog', '--voice']);
  });

  it('spawns argv directly (no shell), detached, in the private cwd; every command is a fresh session', async () => {
    const calls: Parameters<SpawnFn>[] = [];
    const { runner, log } = mk('fresh', {}, (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return spawn(cmd, args as string[], opts);
    });
    // Back to back, as fast as possible: still never --resume (finding 1 of docs/REVIEW-3.md).
    const r1 = await runner.run('open youtube');
    expect(r1).toMatchObject({ kind: 'ok', sessionId: 'sess-1' });
    expect((r1 as { text: string }).text).toMatch(/I opened \[YouTube\]/);
    const r2 = await runner.run('now search for lo-fi');
    expect(r2).toMatchObject({ kind: 'ok', sessionId: 'sess-2' });
    await runner.run('open mail');

    const runs = readFakeLog(log);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.argv).toEqual(buildClaudeArgs('open youtube', { ...settings, claudePath: fake }));
    expect(runs[1]!.argv).toEqual(buildClaudeArgs('now search for lo-fi', { ...settings, claudePath: fake }));
    for (const r of runs) {
      expect(r.argv).not.toContain('--resume');
      expect(r.argv).not.toContain('--continue');
      expect(r.argv.some((x) => /sess-/.test(x))).toBe(false);
    }
    expect(runs[0]!.cwd).toBe(tmp);
    expect(calls[0]![2]).toMatchObject({ detached: true, shell: false, cwd: tmp });
  });

  it('errors and cancels do not change the next run (still fresh)', async () => {
    const { runner, log } = mk('err', { FAKE_CLAUDE_MODE: 'error' });
    expect(await runner.run('x')).toEqual({ kind: 'error', message: 'I ran out of steps before finishing.', sessionId: 'sess-1' });
    await runner.run('y');
    expect(readFakeLog(log).map((r) => r.argv.includes('--resume'))).toEqual([false, false]);
    const g = mk('garbage', { FAKE_CLAUDE_MODE: 'garbage' });
    expect(await g.runner.run('x')).toEqual({ kind: 'error', message: "Claude Code didn't return a result (Error: something broke).", sessionId: null });
  });

  it('reports a missing claude binary clearly', async () => {
    const runner = new ClaudeRunner({ ...settings, claudePath: join(tmp, 'no-such-claude'), cwd: tmp });
    const r = await runner.run('x');
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/Claude Code was not found/);
  });

  it.each(['hang', 'hang-stubborn'])('cancel kills the whole process group (%s)', async (mode) => {
    const pids = join(tmp, `${mode}.pids`);
    const { runner } = mk(mode, { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_PIDS: pids });
    const p = runner.run('play something long');
    await waitFor(() => {
      try {
        return !!JSON.parse(readFileSync(pids, 'utf8')).child;
      } catch {
        return false;
      }
    }, 10_000, 'fake claude to start');
    const { claude, child } = JSON.parse(readFileSync(pids, 'utf8')) as { claude: number; child: number };
    expect(isAlive(claude)).toBe(true);
    expect(isAlive(child)).toBe(true);
    expect(runner.running).toBe(true);
    expect(runner.cancel()).toBe(true);
    expect(await p).toEqual({ kind: 'cancelled' });
    await waitFor(() => !isAlive(claude) && !isAlive(child), 5000, 'claude and its child to die');
    expect(runner.running).toBe(false);
    expect(runner.cancel()).toBe(false);
  });

  it('never uses a shell even for hostile prompts', async () => {
    const spawnSpy = vi.fn<SpawnFn>((cmd, args, opts) => {
      expect(opts.shell).toBe(false);
      throw new Error(`blocked ${cmd} ${args.length}`);
    });
    const runner = new ClaudeRunner({ ...settings, cwd: tmp, spawn: spawnSpy });
    const r = await runner.run('open youtube; rm -rf ~ && $(reboot)');
    expect(r).toMatchObject({ kind: 'error' });
    expect(spawnSpy.mock.calls[0]![1][1]).toBe('open youtube; rm -rf ~ && $(reboot)');
  });
});
