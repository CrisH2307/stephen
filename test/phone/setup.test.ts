import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { formatLockdown, runPhoneCli, type PhoneCliEnv } from '../../src/phone/cli.js';
import { checkPhoneLockdown, compareTools, isPhoneOn, PHONE_AGENT, PHONE_TOOLS, phoneDir, phoneFiles, phoneOnPath, writePhoneFolder } from '../../src/phone/setup.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude-init.mjs');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-phone-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const bridge = { command: '/usr/bin/node', args: ['/repo/dist/cli.js', 'phone-bridge'] };

describe('phone folder files (ADR-005: the agent setting is the allow-list)', () => {
  it('the agent lists exactly the bridge tools; settings select it; start_job is never pre-allowed', () => {
    const f = phoneFiles(bridge);
    const settings = JSON.parse(f['.claude/settings.json']!);
    expect(settings).toEqual({
      agent: PHONE_AGENT,
      enableAllProjectMcpServers: true,
      permissions: { allow: ['mcp__stephen_phone__ask', 'mcp__stephen_phone__job_status'] },
    });
    const agent = f[`.claude/agents/${PHONE_AGENT}.md`]!;
    expect(agent).toMatch(new RegExp(`^---\\nname: ${PHONE_AGENT}\\n`));
    expect(agent).toContain(`\ntools: ${PHONE_TOOLS.join(', ')}\n---\n`);
    expect(JSON.parse(f['.mcp.json']!)).toEqual({ mcpServers: { stephen_phone: bridge } });
  });

  it('writes the folder 0700 and every file 0600', async () => {
    const home = join(tmp, 'h1');
    const dir = await writePhoneFolder(home, bridge);
    expect(dir).toBe(phoneDir(home));
    for (const d of [dir, join(dir, '.claude'), join(dir, '.claude/agents')]) expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const rel of Object.keys(phoneFiles(bridge))) {
      expect(statSync(join(dir, rel)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, rel), 'utf8')).toBe(phoneFiles(bridge)[rel]);
    }
  });
});

describe('lock-down check', () => {
  it('compareTools: extra tools mean not locked; missing bridge tools only mean incomplete', () => {
    expect(compareTools(PHONE_TOOLS)).toEqual({ locked: true, complete: true, extra: [], missing: [] });
    expect(compareTools([])).toMatchObject({ locked: true, complete: false, missing: PHONE_TOOLS });
    expect(compareTools([...PHONE_TOOLS, 'Bash', 'mcp__stephen__click'])).toMatchObject({ locked: false, extra: ['Bash', 'mcp__stephen__click'] });
  });

  const run = (env: Record<string, string>) => {
    Object.assign(process.env, env);
    return checkPhoneLockdown(tmp, { claudePath: FAKE, timeoutMs: 10_000 }).finally(() => {
      for (const k of Object.keys(env)) delete process.env[k];
    });
  };

  it('reads the init line (after hook lines) and stops claude before any model call', async () => {
    const t0 = Date.now();
    expect(await run({ FAKE_TOOLS: PHONE_TOOLS.join(',') })).toEqual({ locked: true, complete: true, extra: [], missing: [], error: '' });
    expect(Date.now() - t0).toBeLessThan(8_000); // killed at init, not left waiting
  });

  it('a widened session is reported as not locked', async () => {
    expect(await run({ FAKE_TOOLS: `${PHONE_TOOLS.join(',')},Bash,Edit` })).toMatchObject({ locked: false, extra: ['Bash', 'Edit'], error: '' });
  });

  it('fails closed: no init line, or claude missing, is not locked', async () => {
    expect(await run({ FAKE_MODE: 'exit' })).toMatchObject({ locked: false, error: 'claude exited before its init line' });
    expect(await checkPhoneLockdown(tmp, { claudePath: join(tmp, 'no-such-claude') })).toMatchObject({ locked: false, error: expect.stringMatching(/could not start claude/) });
  });
});

describe('stephen phone', () => {
  const cli = async (argv: string[], check?: PhoneCliEnv['check']) => {
    const out: string[] = [];
    const code = await runPhoneCli(argv, { home: join(tmp, 'h2'), out: (l) => out.push(l), err: (l) => out.push(l), ...(check ? { check } : {}) });
    return { code, text: out.join('\n') };
  };

  it('setup writes the folder; check exits 0 only when locked', async () => {
    expect((await cli(['setup'])).text).toContain(`Wrote the phone folder: ${phoneDir(join(tmp, 'h2'))}`);
    const ok = await cli(['check'], async () => ({ ...compareTools([]), error: '' }));
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.text).toMatch(/✓ Locked[\s\S]*Missing \(the bridge isn't running yet\)/);
    const bad = await cli(['check'], async () => ({ ...compareTools(['Bash']), error: '' }));
    expect(bad).toMatchObject({ code: 1 });
    expect(bad.text).toMatch(/✗ NOT locked.*Bash.*stays off/);
  });

  it('unknown commands exit 2; help exits 0', async () => {
    expect((await cli(['launch'])).code).toBe(2);
    expect((await cli(['on', 'now'])).code).toBe(2);
    expect((await cli([])).code).toBe(0);
  });

  it('formatLockdown: a probe error is never shown as locked', () => {
    expect(formatLockdown({ ...compareTools(PHONE_TOOLS), error: 'no init line from claude in time' })[0]).toMatch(/^✗ Not proven locked/);
  });
});

describe('stephen phone on | off | status', () => {
  const locked = async () => ({ ...compareTools(PHONE_TOOLS), error: '' });
  const run = async (argv: string[], home: string, o: Partial<PhoneCliEnv> = {}) => {
    const out: string[] = [];
    const code = await runPhoneCli(argv, { home, check: locked, listening: async () => true, out: (l) => out.push(l), err: (l) => out.push(l), ...o });
    return { code, text: out.join('\n') };
  };

  it('on: checks the lock, runs Remote Control in the phone folder with the marker set, clears it when it ends', async () => {
    const home = join(tmp, 'on1');
    const seen: { args: string[]; cwd: unknown; onDuring: boolean }[] = [];
    const r = await run(['on'], home, {
      spawn: (_cmd, args, opts) => {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
        setTimeout(() => seen.push({ args, cwd: opts.cwd, onDuring: isPhoneOn(home) }), 100);
        return child;
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ args: ['remote-control', '--spawn', 'session', '--no-chrome', '--permission-mode', 'default', '--name', 'Stephen'], cwd: phoneDir(home), onDuring: true }]);
    expect(isPhoneOn(home)).toBe(false);
    expect(r.text).toMatch(/Phone link on[\s\S]*Phone link off\./);
  });

  it('on refuses unless locked AND complete; nothing is started', async () => {
    let spawned = 0;
    const spawnFn: PhoneCliEnv['spawn'] = () => (spawned++, spawn(process.execPath, ['-e', '']));
    for (const check of [async () => ({ ...compareTools([]), error: '' }), async () => ({ ...compareTools([...PHONE_TOOLS, 'Bash']), error: '' })]) {
      const r = await run(['on'], join(tmp, 'on2'), { check, spawn: spawnFn });
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/stays off/);
    }
    expect(spawned).toBe(0);
    expect(isPhoneOn(join(tmp, 'on2'))).toBe(false);
  });

  it('off: removes the marker and stops only a Remote Control process', async () => {
    const home = join(tmp, 'off1');
    const killed: number[] = [];
    const mark = () => {
      mkdirSync(phoneDir(home), { recursive: true });
      writeFileSync(phoneOnPath(home), JSON.stringify({ pid: 1, rc: 4242 }));
    };
    mark();
    expect((await run(['off'], home, { commandOf: () => 'claude remote-control --spawn session', kill: (p) => killed.push(p) })).text).toMatch(/Phone link off/);
    expect(killed).toEqual([4242]);
    expect(existsSync(phoneOnPath(home))).toBe(false);
    mark();
    await run(['off'], home, { commandOf: () => '/usr/bin/vim notes.txt', kill: (p) => killed.push(p) });
    expect(killed).toEqual([4242]); // a reused pid that isn't Remote Control is left alone
    expect((await run(['off'], home)).text).toMatch(/already off/);
  });

  it('status', async () => {
    const home = join(tmp, 'st1');
    expect((await run(['status'], home, { listening: async () => false })).text).toBe('Phone link: off.\n• stephen listen is not running: phone requests fail until you start it.');
    mkdirSync(phoneDir(home), { recursive: true });
    writeFileSync(phoneOnPath(home), JSON.stringify({ pid: 1, rc: 77 }));
    expect((await run(['status'], home, { commandOf: () => 'claude remote-control' })).text).toBe('Phone link: on (Remote Control pid 77).\n✓ stephen listen answers phone requests.');
  });
});
