/**
 * The window's control actions (src/app/control.ts): phone on/off through runPhoneCli (fake here; the real one is
 * tested in test/phone), zen-launch and doctor --json as CLI children, and launch.json for Stephen Helper.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appControl, cliRunner, launchInfoPath, PHONE_UNTRUSTED, writeLaunchInfo, type RunCli } from '../../src/app/control.js';
import { urlHost } from '../../src/cli.js';
import type { PhoneCliEnv } from '../../src/phone/cli.js';
import { phoneConfigDir, phoneDir, phoneOnPath } from '../../src/phone/setup.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-control-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const newHome = () => {
  const h = mkdtempSync(join(tmp, 'h-'));
  mkdirSync(join(h, 'phone'), { recursive: true });
  return h;
};
const noRun: RunCli = async () => ({ code: 0, stdout: '', stderr: '' });

describe('phone on / off', () => {
  it('answers on:true once its own `phone on` wrote the kill switch marker, while Remote Control keeps running', async () => {
    const home = newHome();
    let endRc: (code: number) => void = () => undefined;
    const calls: string[][] = [];
    const phone = (argv: string[], e: PhoneCliEnv) => {
      calls.push(argv);
      e.out!('✓ Locked: the phone session can use only Stephen phone tools.');
      writeFileSync(phoneOnPath(home), JSON.stringify({ pid: 777, rc: 778 }));
      e.out!('Phone link on.');
      return new Promise<number>((r) => (endRc = r));
    };
    const c = appControl({ home, cliPath: 'x', run: noRun, phone, pid: 777 });
    const r = await c.phoneOn();
    expect(r).toEqual({ on: true, lines: ['✓ Locked: the phone session can use only Stephen phone tools.', 'Phone link on.'] });
    expect(calls).toEqual([['on']]);
    endRc(0);
  });

  it('a refusal (lock not proven, not signed in, already on elsewhere) answers on:false with what it printed', async () => {
    const home = newHome();
    // Another process's marker is not ours: still on:false.
    writeFileSync(phoneOnPath(home), JSON.stringify({ pid: 1, rc: 2 }));
    const phone = async (_argv: string[], e: PhoneCliEnv) => {
      e.out!('✗ NOT locked: the phone session could also use 2 other tool(s): Bash, Write. The phone channel stays off.');
      e.err!('The phone link stays off.');
      return 1;
    };
    const r = await appControl({ home, cliPath: 'x', run: noRun, phone, pid: 777 }).phoneOn();
    expect(r.on).toBe(false);
    expect(r.lines).toEqual(['✗ NOT locked: the phone session could also use 2 other tool(s): Bash, Write. The phone channel stays off.', 'The phone link stays off.']);
  });

  it('a second phone.on while the first is still checking is refused; a throw becomes a line', async () => {
    const home = newHome();
    let finish: (n: number) => void = () => undefined;
    const c = appControl({ home, cliPath: 'x', run: noRun, phone: () => new Promise<number>((r) => (finish = r)), pid: 777 });
    const first = c.phoneOn();
    await expect(c.phoneOn()).rejects.toThrow(/already turning on/);
    finish(1);
    expect((await first).on).toBe(false);
    const boom = appControl({ home, cliPath: 'x', run: noRun, phone: async () => Promise.reject(new Error('no claude')) });
    expect((await boom.phoneOn()).lines).toEqual(["Couldn't turn the phone link on: no claude"]);
  });

  it('R9-13: an untrusted phone folder is refused before Remote Control starts (no terminal to answer the prompt)', async () => {
    const home = newHome();
    mkdirSync(phoneConfigDir(home), { recursive: true });
    writeFileSync(join(phoneConfigDir(home), '.claude.json'), JSON.stringify({ projects: { '/other': { hasTrustDialogAccepted: true } } }));
    const calls: string[][] = [];
    const phone = async (argv: string[]) => (calls.push(argv), 0);
    expect(await appControl({ home, cliPath: 'x', run: noRun, phone, pid: 777 }).phoneOn()).toEqual({ on: false, lines: [PHONE_UNTRUSTED] });
    expect(calls).toEqual([]);
    writeFileSync(join(phoneConfigDir(home), '.claude.json'), JSON.stringify({ projects: { [phoneDir(home)]: { hasTrustDialogAccepted: true } } }));
    await appControl({ home, cliPath: 'x', run: noRun, phone, pid: 777 }).phoneOn();
    expect(calls).toEqual([['on']]);
  });

  it('phone.off runs `phone off` and returns its lines; lines are cleaned and capped', async () => {
    const calls: string[][] = [];
    const phone = async (argv: string[], e: PhoneCliEnv) => {
      calls.push(argv);
      for (let i = 0; i < 50; i++) e.out!(`line ${i}\u0007`);
      return 0;
    };
    const r = await appControl({ home: newHome(), cliPath: 'x', run: noRun, phone }).phoneOff();
    expect(calls).toEqual([['off']]);
    expect(r.on).toBe(false);
    expect(r.lines).toHaveLength(40);
    expect(r.lines[39]).toBe('line 49');
  });
});

describe('zen.open and doctor.run', () => {
  it('zen-launch: ok from the exit code, message from its output', async () => {
    const seen: string[][] = [];
    const run: RunCli = async (args) => (seen.push(args), { code: 1, stdout: '', stderr: 'Zen is open without Stephen access. Quit it first.\n' });
    const r = await appControl({ home: newHome(), cliPath: 'x', run }).openZen();
    expect(seen).toEqual([['zen-launch']]);
    expect(r).toEqual({ ok: false, message: 'Zen is open without Stephen access. Quit it first.' });
  });

  it('doctor --json: checks and counts; output that is not JSON is an error', async () => {
    const checks = [{ ok: false, label: 'Chrome installed', fix: 'Install Google Chrome.' }];
    const ok: RunCli = async (args) => ({ code: 0, stdout: args.join(' ') === 'doctor --json' ? JSON.stringify({ checks, problems: 1, blocking: 0 }) : '', stderr: '' });
    expect(await appControl({ home: newHome(), cliPath: 'x', run: ok }).doctor()).toEqual({ checks, problems: 1, blocking: 0 });
    const bad: RunCli = async () => ({ code: 1, stdout: '', stderr: 'stephen: boom' });
    await expect(appControl({ home: newHome(), cliPath: 'x', run: bad }).doctor()).rejects.toThrow('doctor failed: stephen: boom');
  });

  it('R9-12: doctor shows Zen as host:port, never the WebSocket path with its session id', () => {
    expect(urlHost('ws://127.0.0.1:9222/session/1f2e3d4c-aaaa-bbbb')).toBe('127.0.0.1:9222');
    expect(urlHost('not a url')).toBe('connected');
  });

  it('cliRunner runs `node <cli> <args>` and reports the exit code', async () => {
    const cli = join(tmp, 'fake-cli.mjs');
    writeFileSync(cli, "console.log(process.argv.slice(2).join(' ')); process.exitCode = process.argv[2] === 'fail' ? 3 : 0;\n");
    expect(await cliRunner(cli)(['doctor', '--json'])).toMatchObject({ code: 0, stdout: 'doctor --json\n' });
    expect((await cliRunner(cli)(['fail'])).code).toBe(3);
  });
});

describe('launch.json', () => {
  it('records node, cli.js and PATH, 0600, creating run/ 0700', () => {
    const home = mkdtempSync(join(tmp, 'l-'));
    writeLaunchInfo(home, '/repo/dist/cli.js', { PATH: '/opt/homebrew/bin:/usr/bin' });
    expect(JSON.parse(readFileSync(launchInfoPath(home), 'utf8'))).toEqual({ node: process.execPath, cli: '/repo/dist/cli.js', path: '/opt/homebrew/bin:/usr/bin' });
    expect(statSync(launchInfoPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
  });
});
