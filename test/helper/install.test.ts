/**
 * `stephen install-helper` and the doctor lines, with every program faked (no swiftc, codesign or open runs):
 * compiler lookup and the actionable "xcode-select --install" error, the argv arrays, the app bundle layout,
 * refusing to replace an app Stephen did not make, --dry-run, and the doctor checks.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helperDoctorChecks, type HelperDoctorDeps } from '../../src/helper/doctor.js';
import {
  type InstallHelperDeps,
  codesignArgs,
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
    for (const f of ['Core.swift', 'main.swift', 'Info.plist']) expect(existsSync(join(src, f)), f).toBe(true);
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
      '-O', '-swift-version', '5', '-sdk', '/SDK', '-o', '/tmp/x/Stephen Helper', '/src/Core.swift', '/src/main.swift',
      '-framework', 'AppKit', '-framework', 'CoreAudio', '-framework', 'CoreGraphics',
    ]);
    expect(swiftcArgs('/src', '/o', null)).not.toContain('-sdk');
    expect(codesignArgs('/A/Stephen Helper.app')).toEqual(['--force', '--sign', '-', '--identifier', 'dev.stephen.helper', '/A/Stephen Helper.app']);
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

    const swiftc = f.calls.find((c) => c.cmd.endsWith('swiftc'))!;
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

describe('doctor: helper lines', () => {
  function doctorDeps(over: Partial<HelperDoctorDeps> & { files?: string[] } = {}): HelperDoctorDeps {
    const files = new Set(over.files ?? []);
    return {
      platform: 'darwin',
      appPath: '/U/Applications/Stephen Helper.app',
      exists: (p) => files.has(p),
      run: fakeRun(happy).run,
      probe: async () => ({ running: false, reason: 'ECONNREFUSED' }),
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
    ]);
    expect(c[0]!.fix).toContain('stephen install-helper');
  });

  it('installed + running + granted → ✓ lines from hello', async () => {
    const c = await helperDoctorChecks('/h', doctorDeps({ files: [exe, sock], probe: async () => ({ running: true, hello: { type: 'hello', version: '1', inputMonitoring: true } }) }));
    expect(c.map((x) => [x.label, x.ok])).toEqual([
      ['Stephen Helper installed (push-to-talk: hold Fn+Option)', true],
      ['Xcode command line tools (Swift compiler, to build the helper)', true],
      ['Stephen Helper running', true],
      ['Input Monitoring granted to Stephen Helper', true],
    ]);
  });

  it('running without Input Monitoring → ✗ with the Settings path; not running → info line', async () => {
    const denied = await helperDoctorChecks('/h', doctorDeps({ files: [exe, sock], probe: async () => ({ running: true, hello: { type: 'hello', version: '1', inputMonitoring: false } }) }));
    expect(denied.at(-1)).toMatchObject({ ok: false, fix: expect.stringContaining('Privacy & Security › Input Monitoring') });
    const stopped = await helperDoctorChecks('/h', doctorDeps({ files: [exe] }));
    expect(stopped.at(-1)).toMatchObject({ ok: true, info: true, label: 'Stephen Helper running' });
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
