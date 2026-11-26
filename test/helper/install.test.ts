/**
 * `stephen install-helper` and the doctor lines, with every program faked (no swiftc, codesign or open runs):
 * compiler lookup and the actionable "xcode-select --install" error, the argv arrays, the app bundle layout,
 * refusing to replace an app Stephen did not make, --dry-run, and the doctor checks.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helperDoctorChecks, type HelperDoctorDeps } from '../../src/helper/doctor.js';
import {
  HELPER_FRAMEWORKS,
  HELPER_SOURCES,
  type InstallHelperDeps,
  codesignArgs,
  fallbackSdks,
  findSwiftCompiler,
  helperSourceDir,
  installHelper,
  planHelperInstall,
  renderInfoPlist,
  swiftcArgs,
} from '../../src/helper/install.js';
import { HELPER_BUNDLE_ID } from '../../src/helper/paths.js';
import type { RunFn, RunResult } from '../../src/zen-launcher.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sh-install-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });

type Responder = (cmd: string, args: string[]) => RunResult | Promise<RunResult>;

function fakeRun(respond: Responder): { run: RunFn; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      return respond(cmd, args);
    },
  };
}

/** xcrun finds swiftc + SDK; "swiftc" writes the output binary; codesign/open succeed. */
const happy: Responder = (cmd, args) => {
  if (cmd === '/usr/bin/xcrun' && args[0] === '--find') return ok('/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc\n');
  if (cmd === '/usr/bin/xcrun' && args.includes('--show-sdk-path')) return ok('/SDKs/MacOSX.sdk\n');
  if (cmd.endsWith('swiftc') && args[0] === '--version') return ok('Swift version 6.0\n');
  if (cmd.endsWith('swiftc') && args[0] === '-typecheck') return ok();
  if (cmd.endsWith('swiftc')) {
    const out = args[args.indexOf('-o') + 1]!;
    writeFileSync(out, '#!/bin/sh\n');
    return ok();
  }
  return ok();
};

function deps(run: RunFn, over: Partial<InstallHelperDeps> = {}): { deps: InstallHelperDeps; out: string[] } {
  const out: string[] = [];
  return {
    out,
    deps: { run, platform: 'darwin', exists: existsSync, log: (l) => out.push(l), quitRunning: async () => false, openAfter: true, ...over },
  };
}

function plan() {
  return planHelperInstall({ appPath: join(dir, 'Applications', 'Stephen Helper.app'), stephenHome: join(dir, '.stephen'), version: '0.1.0' });
}

describe('install-helper', () => {
  it('ships the Swift sources and the Info.plist template (LSUIElement, bundle id)', () => {
    const src = helperSourceDir();
    for (const f of ['Core.swift', 'AppClient.swift', 'AppWindow.swift', 'main.swift', 'Info.plist']) expect(existsSync(join(src, f)), f).toBe(true);
    const plist = renderInfoPlist(readFileSync(join(src, 'Info.plist'), 'utf8'), '1.2.3');
    expect(plist).toContain('<key>LSUIElement</key>\n\t<true/>');
    expect(plist).toContain(`<string>${HELPER_BUNDLE_ID}</string>`);
    expect(plist).toContain('<string>1.2.3</string>');
    expect(plist).not.toContain('__VERSION__');
    expect(renderInfoPlist('__VERSION__', '1<2')).toBe('0.0.0');
    // main.swift has no AppKit-free logic of its own to drift: the state machine lives in Core.swift.
    expect(readFileSync(join(src, 'Core.swift'), 'utf8')).not.toMatch(/^import (AppKit|CoreAudio|CoreGraphics|Foundation)/m);
  });

  it('builds the swiftc and codesign argv (no shell)', () => {
    expect(swiftcArgs('/src', '/tmp/x/Stephen Helper', '/SDK')).toEqual([
      '-O', '-swift-version', '5', '-sdk', '/SDK', '-o', '/tmp/x/Stephen Helper',
      '/src/Core.swift', '/src/Theme.swift',
      '/src/Components/Sidebar.swift', '/src/Components/Controls.swift', '/src/Components/Lists.swift', '/src/Components/ChatThread.swift',
      '/src/AppProtocol.swift', '/src/AppConnection.swift', '/src/AppClient.swift', '/src/AppConfirm.swift', '/src/StephenControl.swift', '/src/AppWindow.swift', '/src/AskBox.swift', '/src/MainWindow.swift', '/src/HomeView.swift', '/src/Palette.swift', '/src/MemoryPage.swift', '/src/ConversationsPage.swift', '/src/JobsPage.swift', '/src/AppearanceSettings.swift', '/src/SettingsPage.swift', '/src/main.swift',
      '-framework', 'AppKit', '-framework', 'CoreAudio', '-framework', 'CoreGraphics', '-framework', 'ServiceManagement', '-framework', 'SwiftUI',
    ]);
    expect(swiftcArgs('/src', '/o', null)).not.toContain('-sdk');
    expect(codesignArgs('/A/Stephen Helper.app')).toEqual(['--force', '--sign', '-', '--identifier', 'dev.stephen.helper', '/A/Stephen Helper.app']);
  });

  it('compiles every helper/*.swift file (the Stephen window included) and links SwiftUI', () => {
    const swift = (readdirSync(helperSourceDir(), { recursive: true }) as string[]).filter((f) => f.endsWith('.swift')).sort();
    expect([...HELPER_SOURCES].sort()).toEqual(swift);
    expect(HELPER_SOURCES.at(-1)).toBe('main.swift');
    expect(HELPER_FRAMEWORKS).toContain('SwiftUI');
    const args = swiftcArgs('/src', '/o', null);
    expect(args.indexOf('/src/AppWindow.swift')).toBeGreaterThan(args.indexOf('-o'));
    expect(args.slice(-2)).toEqual(['-framework', 'SwiftUI']);
  });

  it('finds swiftc with xcrun, falls back to PATH, else explains', async () => {
    expect(await findSwiftCompiler(fakeRun(happy).run)).toEqual({
      ok: true,
      compiler: { swiftc: '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc', sdkPath: '/SDKs/MacOSX.sdk', via: 'xcrun' },
    });
    const path = fakeRun((cmd) => (cmd === 'swiftc' ? ok('Swift version 6') : fail('xcrun: error: invalid active developer path')));
    expect(await findSwiftCompiler(path.run)).toEqual({ ok: true, compiler: { swiftc: 'swiftc', sdkPath: null, via: 'PATH' } });
    const none = fakeRun(() => fail('xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)', 1));
    const r = await findSwiftCompiler(none.run);
    expect(r.ok).toBe(false);
  });

  it('missing compiler → "run xcode-select --install", nothing written', async () => {
    const { run } = fakeRun((cmd) => (cmd === 'swiftc' ? fail('spawn swiftc ENOENT', 127) : fail('xcrun: error: invalid active developer path')));
    const d = deps(run);
    expect(await installHelper(plan(), {}, d.deps)).toBe(1);
    expect(d.out.join('\n')).toContain('xcode-select --install');
    expect(existsSync(plan().appPath)).toBe(false);
  });

  it('compiles, assembles Contents/{MacOS,Info.plist}, signs ad hoc, opens it and prints next steps', async () => {
    const f = fakeRun(happy);
    const quits: string[] = [];
    const d = deps(f.run, { quitRunning: async (h) => (quits.push(h), true) });
    const p = plan();
    expect(await installHelper(p, {}, d.deps)).toBe(0);

    const swiftc = f.calls.find((c) => c.cmd.endsWith('swiftc') && c.args[0] !== '--version')!;
    expect(swiftc.args.slice(0, 5)).toEqual(['-O', '-swift-version', '5', '-sdk', '/SDKs/MacOSX.sdk']);
    expect(swiftc.args).toContain(join(p.sourceDir, 'main.swift'));
    const sign = f.calls.find((c) => c.cmd === '/usr/bin/codesign')!;
    expect(sign.args.slice(0, 5)).toEqual(['--force', '--sign', '-', '--identifier', 'dev.stephen.helper']);
    const open = f.calls.find((c) => c.cmd === '/usr/bin/open')!;
    expect(open.args).toEqual(['-a', p.appPath, '--args', '--home', p.stephenHome]);
    expect(quits).toEqual([p.stephenHome]);

    const exe = join(p.appPath, 'Contents', 'MacOS', 'Stephen Helper');
    expect(statSync(exe).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(p.appPath, 'Contents', 'Info.plist'), 'utf8')).toContain('<string>dev.stephen.helper</string>');
    const text = d.out.join('\n');
    expect(text).toContain('Input Monitoring');
    expect(text).toContain('"Press 🌐 key to" → "Do Nothing"');
    expect(text).toMatch(/Rebuilding changes the app's signature/);

    // Rebuilding over our own app works.
    expect(await installHelper(p, {}, deps(fakeRun(happy).run).deps)).toBe(0);
    // No staging leftovers.
    expect(existsSync(join(dir, 'Applications', `.Stephen Helper.app.tmp-${process.pid}`))).toBe(false);
  });

  it('a swiftc error is shown with the command; nothing is installed', async () => {
    const { run } = fakeRun((cmd, args) => (cmd.endsWith('swiftc') ? fail('main.swift:10:5: error: cannot find X in scope') : happy(cmd, args)));
    const d = deps(run);
    expect(await installHelper(plan(), {}, d.deps)).toBe(1);
    expect(d.out.join('\n')).toMatch(/swiftc failed[\s\S]*cannot find X[\s\S]*Command: /);
    expect(existsSync(plan().appPath)).toBe(false);
  });

  it('refuses to replace an app it did not make', async () => {
    const p = plan();
    mkdirSync(join(p.appPath, 'Contents'), { recursive: true });
    writeFileSync(join(p.appPath, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.other</string></dict></plist>');
    const d = deps(fakeRun(happy).run);
    expect(await installHelper(p, {}, d.deps)).toBe(1);
    expect(d.out.join('\n')).toContain('was not made by Stephen');
  });

  it('--dry-run prints the commands and runs nothing but the compiler lookup; non-macOS refuses a real run', async () => {
    const f = fakeRun(happy);
    const d = deps(f.run);
    expect(await installHelper(plan(), { dryRun: true }, d.deps)).toBe(0);
    expect(f.calls.every((c) => c.cmd === '/usr/bin/xcrun')).toBe(true);
    const text = d.out.join('\n');
    expect(text).toContain('Dry run');
    expect(text).toMatch(/swiftc -O -swift-version 5 -sdk \/SDKs\/MacOSX.sdk -o '<tmp>\/Stephen Helper'/);
    expect(text).toContain('/usr/bin/codesign --force --sign - --identifier dev.stephen.helper');
    expect(existsSync(plan().appPath)).toBe(false);

    const linux = deps(fakeRun(happy).run, { platform: 'linux' });
    expect(await installHelper(plan(), { dryRun: true }, linux.deps)).toBe(0);
    expect(await installHelper(plan(), {}, linux.deps)).toBe(1);
    expect(linux.out.join('\n')).toContain('macOS-only');
  });

  it('refuses a home whose socket path would be too long for macOS', async () => {
    const p = planHelperInstall({ appPath: join(dir, 'A.app'), stephenHome: join(dir, 'x'.repeat(120)), version: '1' });
    const d = deps(fakeRun(happy).run);
    expect(await installHelper(p, {}, d.deps)).toBe(1);
    expect(d.out.join('\n')).toContain('too long');
  });
});

/** swiftc's error on Command Line Tools for macOS 27.2 (#248). */
const NO_MACROS = "ChatThread.swift:178:22: error: external macro implementation type 'SwiftUIMacros.StateMacro' could not be found for macro 'State()'; plugin for module 'SwiftUIMacros' not found";
const sdkOf = (args: string[]) => args[args.indexOf('-sdk') + 1];

describe('install-helper SDK fallback (#248)', () => {
  it('lists the other SDKs newest first by version number, each real folder once, without the default', () => {
    const links: Record<string, string> = { '/C/MacOSX.sdk': '/C/MacOSX27.2.sdk', '/C/MacOSX26.sdk': '/C/MacOSX26.5.sdk', '/C/MacOSX27.sdk': '/C/MacOSX27.2.sdk' };
    const names = ['MacOSX.sdk', 'MacOSX15.sdk', 'MacOSX26.5.sdk', 'MacOSX26.sdk', 'MacOSX26.10.sdk', 'MacOSX27.2.sdk', 'MacOSX27.sdk', 'notes.txt'];
    expect(fallbackSdks('/C', names, '/C/MacOSX.sdk', (p) => links[p] ?? p)).toEqual(['/C/MacOSX26.10.sdk', '/C/MacOSX26.5.sdk', '/C/MacOSX15.sdk']);
  });

  /** The default SDK fails with NO_MACROS; `broken` fails with another error; every other SDK builds. */
  const fallback = (broken: string[]): Responder => (cmd, args) =>
    cmd.endsWith('swiftc') && args[0] !== '--version' && (sdkOf(args) === '/SDKs/MacOSX.sdk' || broken.includes(sdkOf(args)!)) ? fail(sdkOf(args) === '/SDKs/MacOSX.sdk' ? NO_MACROS : 'error: other') : happy(cmd, args);
  const compiled = (calls: { cmd: string; args: string[] }[]) => calls.filter((c) => c.cmd.endsWith('swiftc') && c.args[0] === '-O').map((c) => sdkOf(c.args));

  it('the default SDK lacks SwiftUIMacros: tries the others newest first, uses the first that builds, prints it', async () => {
    const f = fakeRun(fallback(['/C/MacOSX27.1.sdk']));
    const d = deps(f.run, { fallbackSdks: () => ['/C/MacOSX27.1.sdk', '/C/MacOSX26.5.sdk', '/C/MacOSX15.sdk'] });
    expect(await installHelper(plan(), {}, d.deps)).toBe(0);
    expect(compiled(f.calls)).toEqual(['/SDKs/MacOSX.sdk', '/C/MacOSX27.1.sdk', '/C/MacOSX26.5.sdk']);
    const text = d.out.join('\n');
    expect(text).toContain('SDK: /C/MacOSX26.5.sdk');
    expect(text).toContain('The default SDK (/SDKs/MacOSX.sdk) cannot build');
    expect(existsSync(join(plan().appPath, 'Contents', 'MacOS', 'Stephen Helper'))).toBe(true);
  });

  it('no other SDK builds: exit 1 with what to install; another swiftc error never tries other SDKs', async () => {
    const none = fakeRun(fallback(['/C/MacOSX26.5.sdk']));
    const d = deps(none.run, { fallbackSdks: () => ['/C/MacOSX26.5.sdk'] });
    expect(await installHelper(plan(), {}, d.deps)).toBe(1);
    expect(d.out.join('\n')).toMatch(/SwiftUIMacros[\s\S]*tried \/C\/MacOSX26.5.sdk[\s\S]*Install an older macOS SDK/);
    expect(existsSync(plan().appPath)).toBe(false);

    const other = fakeRun((cmd, args) => (cmd.endsWith('swiftc') && args[0] === '-O' ? fail('main.swift:1:1: error: boom') : happy(cmd, args)));
    let asked = false;
    expect(await installHelper(plan(), {}, deps(other.run, { fallbackSdks: () => ((asked = true), ['/C/MacOSX26.5.sdk']) }).deps)).toBe(1);
    expect(compiled(other.calls)).toEqual(['/SDKs/MacOSX.sdk']);
    expect(asked).toBe(false);
  });
});

describe('install-helper skip unchanged', () => {
  /** A private copy of the Swift sources so a test can edit one. */
  function ownPlan() {
    const sourceDir = join(dir, 'helper');
    cpSync(helperSourceDir(), sourceDir, { recursive: true });
    return { ...plan(), sourceDir };
  }
  const count = (calls: { cmd: string; args: string[] }[], pick: (c: { cmd: string; args: string[] }) => boolean) => calls.filter(pick).length;
  const compiles = (c: { cmd: string; args: string[] }) => c.cmd.endsWith('swiftc') && c.args[0] !== '--version';
  const signs = (c: { cmd: string; args: string[] }) => c.cmd === '/usr/bin/codesign' && c.args[0] === '--force';
  const stampOf = (p: { appPath: string }) => join(dirname(p.appPath), `.${basename(p.appPath)}.stamp`);

  it('skip unchanged: a second run builds, signs and copies nothing', async () => {
    const p = ownPlan();
    expect(await installHelper(p, {}, deps(fakeRun(happy).run).deps)).toBe(0);
    const exe = join(p.appPath, 'Contents', 'MacOS', 'Stephen Helper');
    const before = statSync(exe).ino;
    const f = fakeRun(happy);
    const d = deps(f.run);
    expect(await installHelper(p, {}, d.deps)).toBe(0);
    expect(count(f.calls, compiles)).toBe(0);
    expect(count(f.calls, signs)).toBe(0);
    expect(f.calls.some((c) => c.cmd === '/usr/bin/open')).toBe(false);
    expect(statSync(exe).ino).toBe(before);
    expect(d.out.join('\n')).toContain('Nothing changed, so the build was skipped');
  });

  async function installThenChange(change: (p: ReturnType<typeof ownPlan>) => void, respond: Responder = happy) {
    const p = ownPlan();
    expect(await installHelper(p, {}, deps(fakeRun(happy).run).deps)).toBe(0);
    change(p);
    const f = fakeRun(respond);
    expect(await installHelper(p, {}, deps(f.run).deps)).toBe(0);
    return f;
  }

  it('skip unchanged: a changed Swift source rebuilds', async () => {
    const f = await installThenChange((p) => writeFileSync(join(p.sourceDir, 'Core.swift'), '// edited\n', { flag: 'a' }));
    expect(count(f.calls, compiles)).toBe(1);
  });

  it('skip unchanged: a changed compiler version rebuilds', async () => {
    const f = await installThenChange(() => undefined, (cmd, args) => (cmd.endsWith('swiftc') && args[0] === '--version' ? ok('Swift version 6.1\n') : happy(cmd, args)));
    expect(count(f.calls, compiles)).toBe(1);
  });

  it('skip unchanged: a missing installed app rebuilds', async () => {
    const f = await installThenChange((p) => rmSync(p.appPath, { recursive: true }));
    expect(count(f.calls, compiles)).toBe(1);
  });

  it('skip unchanged: a failed signature check rebuilds', async () => {
    const f = await installThenChange(() => undefined, (cmd, args) => (cmd === '/usr/bin/codesign' && args[0] === '--verify' ? fail('invalid signature') : happy(cmd, args)));
    expect(count(f.calls, compiles)).toBe(1);
    expect(count(f.calls, signs)).toBe(1);
  });

  it('skip unchanged: a missing stamp rebuilds', async () => {
    const f = await installThenChange((p) => rmSync(stampOf(p)));
    expect(count(f.calls, compiles)).toBe(1);
  });

  it('skip unchanged: --force rebuilds', async () => {
    const p = ownPlan();
    expect(await installHelper(p, {}, deps(fakeRun(happy).run).deps)).toBe(0);
    const f = fakeRun(happy);
    expect(await installHelper(p, { force: true }, deps(f.run).deps)).toBe(0);
    expect(count(f.calls, compiles)).toBe(1);
  });

  it('skip unchanged: a failed build writes no stamp', async () => {
    const p = ownPlan();
    const bad = (cmd: string, args: string[]) => (compiles({ cmd, args }) ? fail('error: boom') : happy(cmd, args));
    expect(await installHelper(p, {}, deps(fakeRun(bad).run).deps)).toBe(1);
    expect(existsSync(stampOf(p))).toBe(false);
    const badSign = (cmd: string, args: string[]) => (cmd === '/usr/bin/codesign' ? fail('no') : happy(cmd, args));
    expect(await installHelper(p, {}, deps(fakeRun(badSign).run).deps)).toBe(1);
    expect(existsSync(stampOf(p))).toBe(false);
  });
});

describe('doctor: helper lines', () => {
  function doctorDeps(over: Partial<HelperDoctorDeps> & { files?: string[] } = {}): HelperDoctorDeps {
    const files = new Set(over.files ?? []);
    return {
      platform: 'darwin',
      appPath: '/U/Applications/Stephen Helper.app',
      exists: (p) => files.has(p),
      run: fakeRun(happy).run,
      probe: async () => ({ running: false, reason: 'ECONNREFUSED' }),
      fallbackSdks: () => [],
      ...over,
    };
  }
  const exe = '/U/Applications/Stephen Helper.app/Contents/MacOS/Stephen Helper';
  const sock = '/h/run/helper.sock';

  it('not installed → ✗ with the install command; Xcode tools reported', async () => {
    const c = await helperDoctorChecks('/h', doctorDeps());
    expect(c.map((x) => [x.label.split(' (')[0], x.ok])).toEqual([
      ['Stephen Helper installed', false],
      ['Xcode command line tools', true],
      ['macOS SDK that can build the helper', true],
    ]);
    expect(c[0]!.fix).toContain('stephen install-helper');
  });

  it('installed + running + granted → ✓ lines from hello', async () => {
    const c = await helperDoctorChecks('/h', doctorDeps({ files: [exe, sock], probe: async () => ({ running: true, hello: { type: 'hello', version: '1', inputMonitoring: true } }) }));
    expect(c.map((x) => [x.label, x.ok])).toEqual([
      ['Stephen Helper installed (push-to-talk: hold F5 or Fn+Option)', true],
      ['Xcode command line tools (Swift compiler, to build the helper)', true],
      ['macOS SDK that can build the helper', true],
      ['Stephen Helper running', true],
      ['Input Monitoring granted to Stephen Helper', true],
      ['Accessibility for Stephen Helper (media keys)', true],
    ]);
  });

  it('issue #205: Accessibility (media keys) from hello.postEvents: ✓, ✗ with the Settings path', async () => {
    const hello = (postEvents: boolean) => doctorDeps({ files: [exe, sock], probe: async () => ({ running: true, hello: { type: 'hello', version: '1', inputMonitoring: true, postEvents } }) });
    expect((await helperDoctorChecks('/h', hello(true))).at(-1)).toMatchObject({ ok: true, label: 'Accessibility granted to Stephen Helper (media keys)', detail: 'yes' });
    expect((await helperDoctorChecks('/h', hello(false))).at(-1)).toMatchObject({ ok: false, fix: expect.stringContaining('Privacy & Security › Accessibility') });
  });

  it('running without Input Monitoring → ✗ with the Settings path; not running → info line', async () => {
    const denied = await helperDoctorChecks('/h', doctorDeps({ files: [exe, sock], probe: async () => ({ running: true, hello: { type: 'hello', version: '1', inputMonitoring: false } }) }));
    expect(denied.at(-2)).toMatchObject({ ok: false, fix: expect.stringContaining('Privacy & Security › Input Monitoring') });
    const stopped = await helperDoctorChecks('/h', doctorDeps({ files: [exe] }));
    expect(stopped.at(-1)).toMatchObject({ ok: true, info: true, label: 'Stephen Helper running' });
  });

  it('#248: the default SDK lacks SwiftUIMacros → names the SDK used instead, or what to install', async () => {
    const probe = (works: string[]) =>
      fakeRun((cmd, args) => (cmd.endsWith('swiftc') && args[0] === '-typecheck' ? (works.includes(sdkOf(args)!) ? ok() : fail(NO_MACROS)) : happy(cmd, args))).run;
    const label = 'macOS SDK that can build the helper';
    const used = (await helperDoctorChecks('/h', doctorDeps({ run: probe(['/C/MacOSX26.5.sdk']), fallbackSdks: () => ['/C/MacOSX27.1.sdk', '/C/MacOSX26.5.sdk'] }))).find((c) => c.label === label)!;
    expect(used).toMatchObject({ ok: true, detail: expect.stringMatching(/default SDK \(\/SDKs\/MacOSX.sdk\) cannot build[\s\S]*uses \/C\/MacOSX26.5.sdk/) });
    const none = (await helperDoctorChecks('/h', doctorDeps({ run: probe([]), fallbackSdks: () => ['/C/MacOSX27.1.sdk'] }))).find((c) => c.label === label)!;
    expect(none).toMatchObject({ ok: false, detail: expect.stringContaining('no SwiftUIMacros plugin'), fix: expect.stringContaining('Install an older macOS SDK') });
  });

  it('missing Xcode tools → ✗ "xcode-select --install" (info only once the helper is built); non-macOS → one info line', async () => {
    const noXcode = fakeRun((cmd) => (cmd === 'swiftc' ? fail('ENOENT', 127) : fail('xcrun: error')));
    const a = await helperDoctorChecks('/h', doctorDeps({ run: noXcode.run }));
    expect(a[1]).toMatchObject({ ok: false, fix: expect.stringContaining('xcode-select --install') });
    expect(a[1]!.info).toBeUndefined();
    const b = await helperDoctorChecks('/h', doctorDeps({ run: noXcode.run, files: [exe] }));
    expect(b[1]!.info).toBe(true);
    expect(await helperDoctorChecks('/h', doctorDeps({ platform: 'linux' }))).toEqual([
      { ok: true, info: true, label: 'Stephen Helper (push-to-talk)', detail: 'macOS only' },
    ]);
  });
});
