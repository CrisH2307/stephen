/**
 * `stephen zen-launch` and `install-zen-launcher` against fakes: exit codes, never killing Zen
 * (quit only via AppleScript), the state written for `serve`, and the launcher AppleScript with
 * paths containing spaces and quotes.
 */
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appleScriptString, osascriptQuitArgv } from '../../src/drivers/macos.js';
import type { Clock, SpawnedProcess } from '../../src/drivers/util.js';
import { ZEN_NOT_CLAUDE_READY_MESSAGE, ZEN_NOT_RUNNING_MESSAGE, ZenDriver, type ZenReadiness } from '../../src/drivers/zen.js';
import { HubError } from '../../src/errors.js';
import {
  type InstallLauncherDeps,
  type RunFn,
  ZEN_RUNNING_NORMALLY_LEAD,
  ZEN_RUNNING_NORMALLY_MESSAGE,
  type ZenLaunchDeps,
  buildLauncherAppleScript,
  findLegacyZenLauncher,
  formatZenLaunch,
  installZenLauncher,
  legacyZenLauncherAppPath,
  parseZenLaunchArgs,
  planZenLauncher,
  runZenLaunch,
  quitFailedMessage,
  ZEN_LAUNCH_FAILED,
  shellQuote,
  zenLauncherAppPath,
} from '../../src/zen-launcher.js';
import { FakeBrowser, type TestConfig, makeTestConfig } from './helpers.js';

let tc: TestConfig;
afterEach(() => {
  tc?.cleanup();
  vi.restoreAllMocks();
});

class FakeChild extends EventEmitter {
  readonly stderr = null;
  killed = false;
  constructor(readonly pid: number) {
    super();
  }
  unref(): void {}
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** A fake Zen.app with an XML Info.plist and an icon, so bundle id / icon lookup run for real. */
function fakeZenApp(root: string, bundleId = 'app.zen-browser.zen'): string {
  const app = join(root, 'Apps', 'Zen.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIconFile</key>\n<string>firefox.icns</string>\n<key>CFBundleIdentifier</key>\n<string>${bundleId}</string>\n</dict></plist>\n`,
  );
  writeFileSync(join(app, 'Contents', 'Resources', 'firefox.icns'), 'ICNS');
  writeFileSync(join(app, 'Contents', 'MacOS', 'zen'), '#!/bin/sh\n', { mode: 0o755 });
  return app;
}

/** Fake clock: sleep advances time immediately. */
function fakeClock(): Clock {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

interface LaunchHarness {
  deps: ZenLaunchDeps;
  runs: { cmd: string; args: string[] }[];
  launches: number;
  driver: ZenDriver | null;
  spawns: { cmd: string; args: readonly string[]; opts: SpawnOptions }[];
  children: FakeChild[];
  connects: number;
}

function launchHarness(o: {
  readiness?: ZenReadiness['kind'];
  /** Successive answers of isProcessRunning('zen'); the last one repeats. */
  running?: boolean[];
  platform?: NodeJS.Platform;
  runResult?: { code: number; stdout?: string; stderr?: string };
  launchError?: Error;
  /** Use a real ZenDriver (fake spawn/connect) instead of a stub. */
  realDriver?: boolean;
  /** Other user accounts (B5); default a single-user Mac. */
  others?: number | null;
}): LaunchHarness {
  const h: LaunchHarness = { deps: undefined as unknown as ZenLaunchDeps, runs: [], launches: 0, driver: null, spawns: [], children: [], connects: 0 };
  const running = [...(o.running ?? [false])];
  const run: RunFn = async (cmd, args) => {
    h.runs.push({ cmd, args });
    return { code: o.runResult?.code ?? 0, stdout: o.runResult?.stdout ?? '', stderr: o.runResult?.stderr ?? '' };
  };
  const profile = join(tc.home, 'real-profile');
  mkdirSync(profile, { recursive: true });
  let driver: ZenLaunchDeps['driver'];
  if (o.realDriver) {
    h.driver = new ZenDriver(tc.cfg, {
      resolveRealProfile: async () => profile,
      otherUserCount: async () => 0, // B5: a single-user Mac unless a test says otherwise
      isExecutable: async () => true,
      isProcessRunning: async () => false,
      isPidAlive: () => false,
      listenTimeoutMs: 300,
      pollIntervalMs: 10,
      spawn: (cmd, args, opts) => {
        h.spawns.push({ cmd, args, opts });
        const child = new FakeChild(7000 + h.spawns.length);
        h.children.push(child);
        writeSync((opts.stdio as number[])[2]!, 'WebDriver BiDi listening on ws://127.0.0.1:4545\n');
        return child as unknown as SpawnedProcess;
      },
      connect: async () => {
        h.connects += 1;
        return new FakeBrowser().asBrowser();
      },
    });
    driver = h.driver;
  } else {
    const state = { pid: 4242, wsUrl: 'ws://127.0.0.1:7777/session', profileDir: profile, mode: 'real' as const };
    driver = {
      inspect: async () => ({ kind: o.readiness ?? 'none', state: o.readiness && o.readiness !== 'none' ? state : null, profileDir: profile }),
      launchForClaude: async () => {
        h.launches += 1;
        if (o.launchError) throw o.launchError;
        return { pid: 5555, wsUrl: 'ws://127.0.0.1:4545/session', profileDir: profile, logPath: join(tc.cfg.stateDir, 'zen-real.log'), resumed: false };
      },
    };
  }
  h.deps = {
    cfg: tc.cfg,
    driver,
    isProcessRunning: async () => (running.length > 1 ? running.shift()! : running[0]!),
    run,
    otherUserCount: async () => (o.others === undefined ? 0 : o.others),
    platform: o.platform ?? 'darwin',
    clock: fakeClock(),
    quitTimeoutMs: 20_000,
    pollIntervalMs: 250,
  };
  return h;
}

describe('zen-launch', () => {
  it.each([[2], [null]])('B5 (#385 review): --quit-running on a shared Mac (%s) refuses before it asks Zen to quit', async (others) => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const h = launchHarness({ running: [true], others });
    const r = await runZenLaunch({ quitRunning: true }, h.deps);
    expect(r).toMatchObject({ exitCode: 2, status: 'needs-user', message: expect.stringMatching(/Chrome/) });
    expect(h.runs).toEqual([]); // no osascript quit: the person's Zen stays open
    expect(h.launches).toBe(0);
  });

  it('nothing running: launches, writes the state for serve (no owner, no session) and exits 0 — kills nothing', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const killSpy = vi.spyOn(process, 'kill');
    const h = launchHarness({ realDriver: true });
    const r = await runZenLaunch({}, h.deps);
    expect(r).toMatchObject({ exitCode: 0, status: 'launched', pid: 7001, wsUrl: 'ws://127.0.0.1:4545/session' });
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.args).toContain('--remote-debugging-port');
    expect(h.spawns[0]!.opts.detached).toBe(true);
    expect(h.connects).toBe(0); // never opened a BiDi session
    expect(JSON.parse(readFileSync(join(tc.cfg.stateDir, 'zen.json'), 'utf8'))).toEqual({
      pid: 7001,
      wsUrl: 'ws://127.0.0.1:4545/session',
      profileDir: join(tc.home, 'real-profile'),
      mode: 'real',
    });
    expect(h.children[0]!.killed).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(h.runs).toEqual([]); // no osascript, no open
    expect(formatZenLaunch(r)).toMatch(/^✓ Started Zen with Stephen access \(pid 7001\)\./);
    // R7: success never shows the profile or log paths (they stay in --json)
    const shown = formatZenLaunch({ ...r, logPath: '/x/zen.log' });
    expect(shown).not.toContain(join(tc.home, 'real-profile'));
    expect(shown).not.toContain('/x/zen.log');
    expect(shown).not.toMatch(/Profile:|Zen log:/);
    expect(r.profileDir).toBe(join(tc.home, 'real-profile'));
  });

  it('a Stephen-ready Zen is already running: brings it to the front (open -a Zen.app) and exits 0 without launching', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const app = fakeZenApp(tc.home);
    tc.cfg.zen.executablePath = join(app, 'Contents', 'MacOS', 'zen');
    const h = launchHarness({ readiness: 'ready', running: [true] });
    const r = await runZenLaunch({ quitRunning: true }, h.deps);
    expect(r).toMatchObject({ exitCode: 0, status: 'already-running', pid: 4242 });
    expect(r.notes).toEqual([]);
    expect(r.detail).toBeUndefined();
    expect(h.launches).toBe(0);
    expect(h.runs).toEqual([{ cmd: '/usr/bin/open', args: ['-a', app] }]);
    // not on macOS: nothing to bring to the front
    const linux = launchHarness({ readiness: 'ready', platform: 'linux' });
    expect((await runZenLaunch({}, linux.deps)).exitCode).toBe(0);
    expect(linux.runs).toEqual([]);
  });

  it('R7: open -a fails on a ready Zen: a plain note, the raw words only in detail', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const h = launchHarness({ readiness: 'ready', running: [true], runResult: { code: 1, stderr: 'LSOpenURLsWithRole() failed with error -600\n' } });
    const r = await runZenLaunch({}, h.deps);
    expect(r).toMatchObject({ exitCode: 0, status: 'already-running', detail: 'LSOpenURLsWithRole() failed with error -600' });
    expect(r.notes).toEqual(['Could not bring Zen to the front. Click Zen in the Dock.']);
    expect(formatZenLaunch(r)).not.toContain('LSOpen');
  });

  it('Zen open normally, no --quit-running: exit 2 with a clear message; nothing quit, nothing launched', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const h = launchHarness({ running: [true] });
    const r = await runZenLaunch({}, h.deps);
    expect(r).toMatchObject({ exitCode: 2, status: 'zen-running' });
    expect(r.message.startsWith(ZEN_RUNNING_NORMALLY_LEAD)).toBe(true);
    expect(r.message).toMatch(/--quit-running/);
    expect(h.runs).toEqual([]);
    expect(h.launches).toBe(0);
    expect(formatZenLaunch(r)).toMatch(/^! Zen is open without Stephen access\./);
  });

  it('--quit-running: asks Zen to quit with osascript (bundle id from Info.plist), waits for it to exit, then launches — never kill', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const app = fakeZenApp(tc.home, 'app.zen-browser.zen.custom');
    tc.cfg.zen.executablePath = join(app, 'Contents', 'MacOS', 'zen');
    const killSpy = vi.spyOn(process, 'kill');
    const h = launchHarness({ running: [true, true, true, false] });
    const r = await runZenLaunch({ quitRunning: true }, h.deps);
    expect(r).toMatchObject({ exitCode: 0, status: 'launched', pid: 5555 });
    expect(h.runs).toEqual([{ cmd: '/usr/bin/osascript', args: ['-e', 'tell application id "app.zen-browser.zen.custom" to quit'] }]);
    expect(h.runs.some((x) => /kill/.test(x.cmd) || x.args.some((a) => /kill|SIGKILL|-9/.test(a)))).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(h.launches).toBe(1);
    expect(r.notes.join(' ')).toMatch(/Asked Zen to quit/);
  });

  it('--quit-running: Zen does not exit within ~20 s → exit 2, not launched, never forced', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const h = launchHarness({ running: [true] });
    const r = await runZenLaunch({ quitRunning: true }, h.deps);
    expect(r).toMatchObject({ exitCode: 2, status: 'quit-failed' });
    expect(r.message).toMatch(/did not quit within 20 s\. It may be asking.*never force-quits/);
    expect(r.message).not.toMatch(/[\u2013\u2014]/);
    expect(h.runs.map((x) => x.cmd)).toEqual(['/usr/bin/osascript']);
    expect(h.runs[0]!.args).toEqual(osascriptQuitArgv('app.zen-browser.zen')); // no Info.plist → default bundle id
    expect(h.launches).toBe(0);
  });

  it('--quit-running: osascript refused (no Automation permission) → exit 2, a plain line, the raw reason only in detail', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const raw = 'execution error: Not authorized to send Apple events to Zen. (-1743)';
    const h = launchHarness({ running: [true], runResult: { code: 1, stderr: `${raw}\n` } });
    const r = await runZenLaunch({ quitRunning: true }, h.deps);
    expect(r).toMatchObject({ exitCode: 2, status: 'quit-failed', detail: raw });
    expect(r.message).toMatch(/^This Mac did not let Stephen ask Zen to quit\..*Automation\.$/);
    expect(formatZenLaunch(r)).not.toContain('-1743');
    expect(h.launches).toBe(0);
  });

  it('R7: quitFailedMessage maps "not allowed" and keeps every other reason generic', () => {
    expect(quitFailedMessage('(-1743)')).toMatch(/did not let Stephen/);
    expect(quitFailedMessage('Not authorised to send Apple events')).toMatch(/did not let Stephen/);
    for (const why of ['osascript exit code 1', 'execution error: Zen got an error: User canceled. (-128)', '']) {
      const m = quitFailedMessage(why);
      expect(m).toBe('Could not ask Zen to quit. Quit Zen yourself (⌘Q), then try again. Stephen never force-quits Zen.');
    }
  });

  it('--quit-running off macOS: exit 2, nothing run', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const h = launchHarness({ running: [true], platform: 'linux' });
    expect(await runZenLaunch({ quitRunning: true }, h.deps)).toMatchObject({ exitCode: 2, status: 'quit-failed' });
    expect(h.runs).toEqual([]);
  });

  it('a launch still starting is resumed even though a zen process exists', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const h = launchHarness({ readiness: 'starting', running: [true] });
    expect(await runZenLaunch({}, h.deps)).toMatchObject({ exitCode: 0, status: 'launched' });
    expect(h.launches).toBe(1);
  });

  it('exit codes: NEEDS_USER from the launch → 2, anything else → 1', async () => {
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'never' } });
    const needs = launchHarness({ launchError: new HubError('NEEDS_USER', 'Could not find your Zen profile') });
    expect(await runZenLaunch({}, needs.deps)).toMatchObject({ exitCode: 2, status: 'needs-user', message: 'Could not find your Zen profile' });
    const broken = launchHarness({ launchError: new HubError('NOT_CONNECTED', 'Zen was not found at /x') });
    expect(await runZenLaunch({}, broken.deps)).toMatchObject({ exitCode: 1, status: 'error' });
    const weird = launchHarness({ launchError: new Error('EACCES boom') });
    const r = await runZenLaunch({}, weird.deps);
    expect(r).toMatchObject({ exitCode: 1, status: 'error', message: ZEN_LAUNCH_FAILED, detail: 'EACCES boom' });
    expect(formatZenLaunch(r)).toBe(`✗ ${ZEN_LAUNCH_FAILED}`);
    // a HubError keeps its own message (written for people) and has no detail
    expect((await runZenLaunch({}, broken.deps)).detail).toBeUndefined();
  });

  it('notes when the config would not use this Zen (agent mode) or may launch it (launch: auto)', async () => {
    tc = makeTestConfig({ zen: { mode: 'agent', launch: 'auto' } });
    expect((await runZenLaunch({}, launchHarness({}).deps)).notes.join(' ')).toMatch(/"mode": "agent".*will not use this one/);
    tc.cleanup();
    tc = makeTestConfig({ zen: { mode: 'real', launch: 'auto' } });
    expect((await runZenLaunch({}, launchHarness({}).deps)).notes.join(' ')).toMatch(/"zen\.launch" is "auto"/);
  });

  it('parses its options', () => {
    expect(parseZenLaunchArgs([])).toEqual({ quitRunning: false, json: false });
    expect(parseZenLaunchArgs(['--quit-running', '--json'])).toEqual({ quitRunning: true, json: true });
    expect(parseZenLaunchArgs(['--force'])).toEqual({ error: 'Unknown option "--force".' });
  });

  it('the driver error text and zen-launch agree on how to recover', () => {
    expect(ZEN_NOT_CLAUDE_READY_MESSAGE).toMatch(/Zen for Stephen.*stephen zen-launch/);
  });

  it('#89 the messages say Stephen needs "Zen for Stephen" and why a normal Zen window does not connect', () => {
    const why = /can only connect to a Zen that was started with its remote-control port open\. A normal Zen window does not open that port\. The 'Zen for Stephen' app opens Zen with it\./;
    expect(ZEN_NOT_CLAUDE_READY_MESSAGE).toMatch(/Stephen needs "Zen for Stephen"/);
    expect(ZEN_NOT_CLAUDE_READY_MESSAGE).toMatch(why);
    expect(ZEN_NOT_RUNNING_MESSAGE).toMatch(why);
    expect(ZEN_RUNNING_NORMALLY_MESSAGE).toMatch(why);
  });
});

// ───────────────────────────── launcher app ─────────────────────────────

/** Decode the AppleScript string literal assigned to `name` in `script`. */
function literal(script: string, name: string): string {
  const m = new RegExp(`set ${name} to "((?:[^"\\\\]|\\\\.)*)"`).exec(script);
  if (!m) throw new Error(`no ${name} in script`);
  return m[1]!.replace(/\\(.)/g, '$1');
}

describe('install-zen-launcher', () => {
  const NODE = `/Users/Jo "JJ" O'Neil/.nvm/versions/node/v22 $HOME/bin/node`;
  const CLI = '/Users/Jo "JJ" O\'Neil/My Projects/browser hub\\x/dist/cli.js';

  it('builds an AppleScript whose paths survive spaces, quotes, $ and backslashes and reach the shell via quoted form', () => {
    const script = buildLauncherAppleScript(NODE, CLI);
    expect(literal(script, 'nodePath')).toBe(NODE);
    expect(literal(script, 'cliPath')).toBe(CLI);
    expect(script).toContain('do shell script (quoted form of nodePath) & " " & (quoted form of cliPath) & " zen-launch" & extraArgs');
    // the only other text reaching the shell is fixed
    expect(script).toContain('my zenLaunch("")');
    expect(script).toContain('my zenLaunch(" --quit-running")');
    // exit 2 + "open normally" → the Reopen dialog; other failures show zen-launch's message
    expect(script).toContain(`if errNum is 2 and errMsg contains ${appleScriptString(ZEN_RUNNING_NORMALLY_LEAD)} then`);
    expect(script).toContain(
      'display dialog "Zen is open without Stephen access. A normal Zen window does not open the remote-control port Stephen needs. Quit and reopen it for Stephen? Your tabs come back if Zen restores your previous session." with title "Zen for Stephen" buttons {"Cancel", "Reopen"} default button "Reopen" cancel button "Cancel"',
    );
    expect(script).toContain('my showError(errMsg)');
    expect(script).not.toMatch(/\bproperty\b/); // applets would write properties back into themselves
    expect(() => buildLauncherAppleScript('/a\nb', CLI)).toThrow(/control character/);
  });

  it('--dry-run prints the app path, the exact command and the AppleScript, and creates nothing', async () => {
    tc = makeTestConfig();
    const app = fakeZenApp(tc.home);
    tc.cfg.zen.executablePath = join(app, 'Contents', 'MacOS', 'zen');
    const appPath = join(tc.home, 'Applications', 'Zen for Stephen.app');
    const plan = await planZenLauncher(tc.cfg, { nodePath: NODE, cliPath: CLI, appPath });
    expect(plan.iconPath).toBe(join(app, 'Contents', 'Resources', 'firefox.icns'));
    const lines: string[] = [];
    const runs: string[] = [];
    const deps: InstallLauncherDeps = { run: async (c) => (runs.push(c), { code: 0, stdout: '', stderr: '' }), platform: 'linux', exists: async () => false, log: (l) => lines.push(l) };
    expect(await installZenLauncher(plan, { dryRun: true }, deps)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain(`App:     ${appPath}`);
    expect(out).toContain(`Runs:    ${shellQuote(NODE)} ${shellQuote(CLI)} zen-launch`);
    expect(out).toContain(plan.script);
    expect(out).toMatch(/only works on macOS/);
    expect(runs).toEqual([]);
    expect(existsSync(join(tc.home, 'Applications'))).toBe(false);
    // shellQuote really round-trips through sh
    const { execFileSync } = await import('node:child_process');
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(NODE)}`]).toString()).toBe(NODE);
  });

  it('off macOS without --dry-run: says it is macOS-only and exits 1', async () => {
    tc = makeTestConfig();
    const plan = await planZenLauncher(tc.cfg, { nodePath: NODE, cliPath: CLI, appPath: join(tc.home, 'A.app') });
    const lines: string[] = [];
    expect(await installZenLauncher(plan, {}, { run: async () => ({ code: 0, stdout: '', stderr: '' }), platform: 'linux', exists: async () => true, log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toMatch(/macOS-only/);
  });

  it('on macOS: osacompile -o <app>, Zen icon over applet.icns, marker, ad-hoc re-sign; replaces only its own app', async () => {
    tc = makeTestConfig();
    const zenApp = fakeZenApp(tc.home);
    tc.cfg.zen.executablePath = join(zenApp, 'Contents', 'MacOS', 'zen');
    const cli = join(tc.home, 'dist dir', 'cli.js');
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, '');
    const appPath = join(tc.home, 'Applications', 'Zen for Stephen.app');
    const plan = await planZenLauncher(tc.cfg, { nodePath: NODE, cliPath: cli, appPath });
    const runs: { cmd: string; args: string[] }[] = [];
    let compiled = '';
    const deps: InstallLauncherDeps = {
      platform: 'darwin',
      exists: async (p) => existsSync(p),
      log: () => undefined,
      run: async (cmd, args) => {
        runs.push({ cmd, args });
        if (cmd === '/usr/bin/osacompile') {
          compiled = readFileSync(args[2]!, 'utf8');
          mkdirSync(join(args[1]!, 'Contents', 'Resources', 'Scripts'), { recursive: true });
          writeFileSync(join(args[1]!, 'Contents', 'Resources', 'applet.icns'), 'APPLET');
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    expect(await installZenLauncher(plan, {}, deps)).toBe(0);
    expect(runs[0]).toMatchObject({ cmd: '/usr/bin/osacompile', args: ['-o', appPath, expect.stringMatching(/launcher\.applescript$/)] });
    expect(compiled).toBe(plan.script);
    expect(readFileSync(join(appPath, 'Contents', 'Resources', 'applet.icns'), 'utf8')).toBe('ICNS');
    expect(runs.map((r) => r.cmd)).toEqual(['/usr/bin/osacompile', '/usr/bin/codesign', '/usr/bin/touch']);
    expect(runs[1]!.args).toEqual(['--force', '--sign', '-', appPath]);
    // re-install replaces it
    expect(await installZenLauncher(plan, {}, deps)).toBe(0);
    // an app with that name that Stephen did not make is left alone
    const foreign = join(tc.home, 'Applications', 'Other.app');
    mkdirSync(foreign, { recursive: true });
    const lines: string[] = [];
    expect(await installZenLauncher({ ...plan, appPath: foreign }, {}, { ...deps, log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toMatch(/not made by Stephen/);
    expect(existsSync(foreign)).toBe(true);
  });

  it('on macOS: refuses when dist/cli.js is missing (the app would not work)', async () => {
    tc = makeTestConfig();
    const plan = await planZenLauncher(tc.cfg, { nodePath: NODE, cliPath: join(tc.home, 'nope.js'), appPath: join(tc.home, 'A.app') });
    const lines: string[] = [];
    expect(await installZenLauncher(plan, {}, { run: async () => ({ code: 0, stdout: '', stderr: '' }), platform: 'darwin', exists: async (p) => existsSync(p), log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toMatch(/npm run build/);
  });
});

describe('launcher rename: "Zen for Stephen", old "Zen for Claude"', () => {
  it('the launcher is ~/Applications/Zen for Stephen.app; the old one was ~/Applications/Zen for Claude.app', () => {
    expect(zenLauncherAppPath('/Users/jo')).toBe('/Users/jo/Applications/Zen for Stephen.app');
    expect(legacyZenLauncherAppPath('/Users/jo')).toBe('/Users/jo/Applications/Zen for Claude.app');
  });

  it('doctor finds the old app only when browser-hub made it (its marker is inside)', () => {
    tc = makeTestConfig();
    expect(findLegacyZenLauncher(tc.home)).toBeNull();
    const old = join(tc.home, 'Applications', 'Zen for Claude.app');
    mkdirSync(join(old, 'Contents', 'Resources'), { recursive: true });
    expect(findLegacyZenLauncher(tc.home)).toBeNull(); // same name, not ours: never suggest deleting it
    writeFileSync(join(old, 'Contents', 'Resources', 'browser-hub-zen-launcher'), 'Created by browser-hub install-zen-launcher.\n');
    expect(findLegacyZenLauncher(tc.home)).toBe(old);
  });

  it('install-zen-launcher builds the new app and leaves the old one alone (the user deletes it)', async () => {
    tc = makeTestConfig();
    const old = join(tc.home, 'Applications', 'Zen for Claude.app');
    mkdirSync(join(old, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(old, 'Contents', 'Resources', 'browser-hub-zen-launcher'), '');
    const cli = join(tc.home, 'cli.js');
    writeFileSync(cli, '');
    const appPath = zenLauncherAppPath(tc.home);
    const plan = await planZenLauncher(tc.cfg, { nodePath: '/usr/bin/node', cliPath: cli, appPath });
    const lines: string[] = [];
    const deps: InstallLauncherDeps = {
      platform: 'darwin',
      exists: async (p) => existsSync(p),
      log: (l) => lines.push(l),
      run: async (cmd, args) => {
        if (cmd === '/usr/bin/osacompile') mkdirSync(join(args[1]!, 'Contents', 'Resources'), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    expect(await installZenLauncher(plan, {}, deps)).toBe(0);
    expect(existsSync(join(appPath, 'Contents', 'Resources', 'stephen-zen-launcher'))).toBe(true);
    expect(existsSync(old)).toBe(true);
    expect(lines.join('\n')).toContain('drag "Zen for Stephen" to your Dock');
    expect(plan.script).toContain('-- Zen for Stephen: opens Zen with Stephen access.');
    expect(plan.script).toContain('with title "Zen for Stephen"');
    expect(plan.script).not.toMatch(/Claude|browser-hub/);
  });
});
