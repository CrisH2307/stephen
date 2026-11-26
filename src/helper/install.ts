/**
 * `stephen install-helper [--dry-run]`: compile helper/*.swift with the Mac's own Swift compiler, assemble
 * `~/Applications/Stephen Helper.app` (LSUIElement, bundle id dev.stephen.helper), sign it ad hoc and open it once
 * so macOS can ask for Input Monitoring. Every program runs with an argv array (no shell).
 */
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { packageVersion } from '../server/index.js';
import { type RunFn, type RunResult, defaultRun, shellQuote } from '../zen-launcher.js';
import { HelperClient, openHelperArgv } from './client.js';
import { HELPER_APP_NAME, HELPER_BUNDLE_ID, HELPER_EXECUTABLE, MAX_SOCKET_PATH_BYTES, helperAppPath, helperLogPath, helperSocketPath } from './paths.js';

export const INSTALL_HELPER_USAGE = 'stephen install-helper [--dry-run] [--force]';
/** main.swift holds the top-level code and goes last; Theme + Components are the shared UI kit; AppClient + AppWindow are the Stephen window. */
export const HELPER_SOURCES = [
  'Core.swift', 'Theme.swift',
  'Components/Sidebar.swift', 'Components/Controls.swift', 'Components/Lists.swift', 'Components/ChatThread.swift',
  'AppProtocol.swift', 'AppConnection.swift', 'AppClient.swift', 'AppConfirm.swift', 'StephenControl.swift', 'AppWindow.swift', 'AskBox.swift', 'MainWindow.swift', 'OnboardingSheet.swift', 'HomeView.swift', 'Palette.swift', 'MemoryPage.swift', 'ConversationsPage.swift', 'JobsPage.swift', 'AppearanceSettings.swift', 'SettingsPage.swift', 'main.swift',
] as const;
export const HELPER_FRAMEWORKS = ['AppKit', 'CoreAudio', 'CoreGraphics', 'ServiceManagement', 'SwiftUI'] as const;
/** The start of the line install-helper prints when it skipped the build. update and setup match it to tell a skip from a rebuild. */
export const HELPER_UNCHANGED = 'Nothing changed';
export const XCODE_TOOLS_FIX = 'Install Apple\'s command line tools: run `xcode-select --install` (or install Xcode), then run `stephen install-helper` again.';

/** `<package>/helper` — the Swift sources ship next to dist/ and src/. */
export function helperSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'helper');
}

export interface SwiftCompiler {
  /** Program to run: an absolute path from `xcrun --find swiftc`, or `swiftc` (found on PATH). */
  swiftc: string;
  /** macOS SDK (from xcrun) — passed as -sdk because a toolchain swiftc run by path may not find it itself. */
  sdkPath: string | null;
  /** Shown in messages: "xcrun" or "PATH". */
  via: 'xcrun' | 'PATH';
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** Find swiftc: `xcrun --find swiftc` first, then `swiftc` on PATH. */
export async function findSwiftCompiler(run: RunFn): Promise<{ ok: true; compiler: SwiftCompiler } | { ok: false; reason: string }> {
  const x = await run('/usr/bin/xcrun', ['--find', 'swiftc'], 60_000);
  const path = firstLine(x.stdout);
  if (x.code === 0 && path) {
    const sdk = await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], 60_000);
    const sdkPath = sdk.code === 0 ? firstLine(sdk.stdout) || null : null;
    return { ok: true, compiler: { swiftc: path, sdkPath, via: 'xcrun' } };
  }
  const v = await run('swiftc', ['--version'], 60_000);
  if (v.code === 0) return { ok: true, compiler: { swiftc: 'swiftc', sdkPath: null, via: 'PATH' } };
  const why = firstLine(x.stderr || x.stdout) || `xcrun exit code ${x.code}`;
  return { ok: false, reason: `No Swift compiler found (xcrun --find swiftc: ${why}; no swiftc on PATH).` };
}

/** Command Line Tools keeps its macOS SDKs here; the fallback SDKs come from this folder (#248). */
export const CLT_SDKS_DIR = '/Library/Developer/CommandLineTools/SDKs';
/** swiftc's error when the SDK's SwiftUI needs a macro plugin this toolchain lacks (Command Line Tools on macOS 27.2, #248). */
export const SWIFTUI_MACROS_MISSING = /plugin for module 'SwiftUIMacros' not found/;
/** What to do when no SDK can build the helper's SwiftUI (only the older SDK was verified, on macOS 27.2.1). */
export const SDK_FIX =
  'Install an older macOS SDK next to the default one in ' + CLT_SDKS_DIR + ' (a Command Line Tools package that ships ' +
  'MacOSX26.x.sdk), or install the full Xcode for this macOS and select it: `sudo xcode-select -s /Applications/Xcode.app`.';

/**
 * The other macOS SDKs to try, newest first: `MacOSX<version>.sdk` entries of `names`, each real folder once (MacOSX26.sdk
 * is a link to MacOSX26.5.sdk), without the default SDK. Pure: `real` resolves links. Picks nothing by itself: every
 * candidate must still build (buildWithSdkFallback).
 */
export function fallbackSdks(dir: string, names: readonly string[], defaultSdk: string | null, real: (p: string) => string | null): string[] {
  const version = (n: string) => /^MacOSX(\d+(?:\.\d+)*)\.sdk$/.exec(n)?.[1]?.split('.').map(Number) ?? null;
  const skip = defaultSdk ? real(defaultSdk) : null;
  const byReal = new Map<string, number[]>();
  for (const n of names) {
    const v = version(n);
    const r = v ? real(join(dir, n)) : null;
    if (!v || !r || r === skip) continue;
    const had = byReal.get(r);
    if (!had || v.length > had.length) byReal.set(r, v); // keep the most precise name of a folder
  }
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  return [...byReal.entries()].sort((a, b) => cmp(a[1], b[1])).map(([r]) => r);
}

/** fallbackSdks over the real Command Line Tools folder. */
export function listFallbackSdks(defaultSdk: string | null): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(CLT_SDKS_DIR);
  } catch {
    return [];
  }
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  return fallbackSdks(CLT_SDKS_DIR, names, defaultSdk, real);
}

export interface SdkBuildResult {
  ok: boolean;
  /** The SDK of the successful build, else of the first (default) try. */
  sdkPath: string | null;
  /** The default SDK, when a fallback SDK was used instead. */
  fallbackFrom: string | null;
  /** The result of the successful build, else of the first try (its error is the one to show). */
  result: RunResult;
  /** Every SDK tried, in order (null = swiftc's own default). */
  tried: (string | null)[];
}

/**
 * Build with the default SDK. Only when that fails with the SwiftUIMacros plugin error, try the other SDKs newest first
 * and keep the first one that builds (#248). `build` returns code 0 only for a real, complete build.
 */
export async function buildWithSdkFallback(defaultSdk: string | null, build: (sdk: string | null) => Promise<RunResult>, others: () => string[]): Promise<SdkBuildResult> {
  const first = await build(defaultSdk);
  const tried: (string | null)[] = [defaultSdk];
  if (first.code === 0) return { ok: true, sdkPath: defaultSdk, fallbackFrom: null, result: first, tried };
  if (!SWIFTUI_MACROS_MISSING.test(first.stderr + first.stdout)) return { ok: false, sdkPath: defaultSdk, fallbackFrom: null, result: first, tried };
  for (const sdk of others()) {
    tried.push(sdk);
    const r = await build(sdk);
    if (r.code === 0) return { ok: true, sdkPath: sdk, fallbackFrom: defaultSdk ?? 'swiftc default', result: r, tried };
  }
  return { ok: false, sdkPath: defaultSdk, fallbackFrom: null, result: first, tried };
}

/** One line about a fallback build: which SDK could not build and which one was used. */
export function sdkFallbackNote(b: SdkBuildResult): string {
  return `The default SDK (${b.fallbackFrom}) cannot build SwiftUI's @State with these command line tools (no SwiftUIMacros plugin), so the helper uses ${b.sdkPath}.`;
}

/** A tiny SwiftUI view with @State. Typechecking it takes about a second and fails like the full build when the SDK needs the missing plugin. */
const STATE_PROBE = 'import SwiftUI\nstruct StephenSdkProbe: View { @State var n = 0; var body: some View { Text("\\(n)") } }\n';

/** For doctor: the same SDK choice as install-helper, by typechecking STATE_PROBE instead of building the whole helper (#248). */
export async function probeHelperSdk(c: SwiftCompiler, run: RunFn, others: (defaultSdk: string | null) => string[] = listFallbackSdks): Promise<SdkBuildResult> {
  const dir = await mkdtemp(join(tmpdir(), 'stephen-sdk-'));
  try {
    const file = join(dir, 'probe.swift');
    await writeFile(file, STATE_PROBE, 'utf8');
    return await buildWithSdkFallback(c.sdkPath, (sdk) => run(c.swiftc, ['-typecheck', '-swift-version', '5', ...(sdk ? ['-sdk', sdk] : []), file], 60_000), () => others(c.sdkPath));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The swiftc argv (after the program). */
export function swiftcArgs(sourceDir: string, outFile: string, sdkPath: string | null): string[] {
  return [
    '-O',
    '-swift-version',
    '5',
    ...(sdkPath ? ['-sdk', sdkPath] : []),
    '-o',
    outFile,
    ...HELPER_SOURCES.map((f) => join(sourceDir, f)),
    ...HELPER_FRAMEWORKS.flatMap((f) => ['-framework', f]),
  ];
}

export function codesignArgs(appPath: string): string[] {
  return ['--force', '--sign', '-', '--identifier', HELPER_BUNDLE_ID, appPath];
}

export function renderInfoPlist(template: string, version: string): string {
  const v = /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : '0.0.0';
  return template.replace(/__VERSION__/g, v);
}

export interface HelperInstallPlan {
  appPath: string;
  sourceDir: string;
  version: string;
  stephenHome: string;
}

export function planHelperInstall(opts: Partial<HelperInstallPlan> = {}): HelperInstallPlan {
  return {
    appPath: opts.appPath ?? helperAppPath(),
    sourceDir: opts.sourceDir ?? helperSourceDir(),
    version: opts.version ?? packageVersion(),
    stephenHome: opts.stephenHome ?? loadConfig().home,
  };
}

/** The stamp sits beside the app, never inside it: a file inside the bundle would break the signature. */
export const helperStampPath = (appPath: string) => join(dirname(appPath), `.${basename(appPath)}.stamp`);

/**
 * One sha256 over everything that decides the built app: each Swift source (name + content, sorted), the Info.plist
 * template, the version, the swiftc and codesign arguments, and the compiler identity (`swiftc --version`).
 * Returns null on any doubt (unreadable file, compiler version not readable), which means "build".
 */
export async function helperFingerprint(plan: HelperInstallPlan, c: SwiftCompiler, run: RunFn): Promise<string | null> {
  try {
    const v = await run(c.swiftc, ['--version'], 60_000);
    if (v.code !== 0 || !v.stdout.trim()) return null;
    const h = createHash('sha256');
    const part = (s: string | Buffer) => h.update(`${Buffer.byteLength(s)}:`).update(s);
    for (const f of [...HELPER_SOURCES, 'Info.plist'].sort()) {
      part(f);
      part(await readFile(join(plan.sourceDir, f)));
    }
    part(plan.version);
    part(JSON.stringify([c.swiftc, v.stdout.trim(), swiftcArgs('<src>', '<out>', c.sdkPath).map((a) => a.replace(/^<src>\//, '')), codesignArgs('<app>')]));
    return h.digest('hex');
  } catch {
    return null;
  }
}

export interface InstallHelperDeps {
  run: RunFn;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  log: (line: string) => void;
  /** Ask a running helper to quit (so the rebuilt app replaces it). Default: send `quit` over its socket. */
  quitRunning: (stephenHome: string) => Promise<boolean>;
  /** Open the app once at the end (default true). */
  openAfter: boolean;
  /** Other macOS SDKs to try when the default one lacks SwiftUIMacros (#248). Default: listFallbackSdks. */
  fallbackSdks?: (defaultSdk: string | null) => string[];
}

export async function quitRunningHelper(stephenHome: string): Promise<boolean> {
  const sock = helperSocketPath(stephenHome);
  if (!existsSync(sock)) return false;
  const c = new HelperClient({ home: stephenHome, launch: false, helloTimeoutMs: 1_000 });
  const r = await c.start();
  if (r.ok) c.send({ type: 'quit' });
  c.close();
  if (!r.ok) return false;
  for (let i = 0; i < 20 && existsSync(sock); i++) await new Promise((res) => setTimeout(res, 100));
  return true;
}

export function defaultInstallHelperDeps(): InstallHelperDeps {
  return {
    run: defaultRun,
    platform: process.platform,
    exists: existsSync,
    log: (l) => console.log(l),
    quitRunning: quitRunningHelper,
    openAfter: true,
  };
}

const display = (cmd: string, args: string[]) => [cmd, ...args].map((a) => (/^[\w./=+:-]+$/.test(a) ? a : shellQuote(a))).join(' ');

export function nextSteps(plan: HelperInstallPlan): string[] {
  return [
    'Next:',
    `  1. Open it once (install-helper just did): open -a ${shellQuote(plan.appPath)} --args --home ${shellQuote(plan.stephenHome)}`,
    '     A ○ appears in the menu bar. macOS asks whether "Stephen Helper" may receive keystrokes from any application:',
    '     click "Open System Settings" and turn Stephen Helper on.',
    '     No prompt? System Settings › Privacy & Security › Input Monitoring → turn on "Stephen Helper"',
    `     (click + and choose ${plan.appPath} if it is not listed). The menu shows "Input Monitoring: granted" once it works.`,
    '  2. System Settings › Keyboard › "Press 🌐 key to" → "Do Nothing" (otherwise holding Fn opens the emoji picker',
    '     or starts dictation).',
    '  3. Run `stephen listen`, hold F5 (or Fn+Option) while you talk, let go to send. Esc cancels a running command.',
    '',
    'Rebuilding changes the app\'s signature, so macOS may ask for Input Monitoring again after `stephen install-helper`.',
    'If it then shows "granted" but keys do nothing, remove Stephen Helper from the Input Monitoring list (−) and add it again.',
    `Log: ${helperLogPath(plan.stephenHome)}`,
  ];
}

/** Build and install the app (or print the plan with dryRun). Returns the exit code. */
export async function installHelper(plan: HelperInstallPlan, opts: { dryRun?: boolean; force?: boolean }, deps: InstallHelperDeps): Promise<0 | 1> {
  const { log } = deps;
  const darwin = deps.platform === 'darwin';
  const missing = HELPER_SOURCES.filter((f) => !deps.exists(join(plan.sourceDir, f)));
  const sockBytes = Buffer.byteLength(helperSocketPath(plan.stephenHome));

  if (opts.dryRun) {
    log(`Dry run — nothing was built.${darwin ? '' : ' (install-helper only works on macOS.)'}\n`);
    let swiftc = '<swiftc>';
    let sdk: string | null = null;
    if (darwin) {
      const found = await findSwiftCompiler(deps.run);
      if (found.ok) {
        swiftc = found.compiler.swiftc;
        sdk = found.compiler.sdkPath;
        log(`Swift compiler: ${swiftc} (via ${found.compiler.via})`);
      } else {
        log(`Swift compiler: not found — ${found.reason} ${XCODE_TOOLS_FIX}`);
      }
    } else {
      log('Swift compiler: looked up with `xcrun --find swiftc`, else `swiftc` on PATH');
    }
    if (missing.length) log(`Missing sources in ${plan.sourceDir}: ${missing.join(', ')}`);
    const out = join('<tmp>', HELPER_EXECUTABLE);
    log(
      [
        `App:     ${plan.appPath} (bundle id ${HELPER_BUNDLE_ID}, version ${plan.version})`,
        `Sources: ${plan.sourceDir}`,
        '',
        'Commands:',
        `  ${display(swiftc, swiftcArgs(plan.sourceDir, out, sdk))}`,
        `  write ${join(plan.appPath, 'Contents', 'Info.plist')} (from ${join(plan.sourceDir, 'Info.plist')})`,
        `  copy ${out} → ${join(plan.appPath, 'Contents', 'MacOS', HELPER_EXECUTABLE)}`,
        `  ${display('/usr/bin/codesign', codesignArgs(plan.appPath))}`,
        `  ${display('/usr/bin/open', openHelperArgv(plan.appPath, plan.stephenHome))}`,
      ].join('\n'),
    );
    return 0;
  }

  if (!darwin) {
    log('install-helper is macOS-only: it builds a Swift menu-bar app. (Use --dry-run to see what it would do.)');
    return 1;
  }
  if (missing.length || !deps.exists(join(plan.sourceDir, 'Info.plist'))) {
    log(`The helper sources are missing from ${plan.sourceDir} (${[...missing, 'Info.plist'].join(', ')}). Reinstall Stephen.`);
    return 1;
  }
  if (sockBytes > MAX_SOCKET_PATH_BYTES) {
    log(`Stephen's home folder path is too long for the helper's socket (${helperSocketPath(plan.stephenHome)}, ${sockBytes} bytes; max ${MAX_SOCKET_PATH_BYTES}). Set STEPHEN_HOME to a shorter folder.`);
    return 1;
  }

  const found = await findSwiftCompiler(deps.run);
  if (!found.ok) {
    log(`${found.reason}\n${XCODE_TOOLS_FIX}`);
    return 1;
  }
  const { swiftc, sdkPath } = found.compiler;

  // Only ever replace an app we made.
  const plistPath = join(plan.appPath, 'Contents', 'Info.plist');
  if (deps.exists(plan.appPath)) {
    const plist = await readFile(plistPath, 'utf8').catch(() => '');
    if (!plist.includes(`<string>${HELPER_BUNDLE_ID}</string>`)) {
      log(`${plan.appPath} already exists and was not made by Stephen. Move it away (or rename it), then run this again.`);
      return 1;
    }
  }

  // Nothing changed and the installed app is intact and signed: build nothing, so macOS keeps the permission grant.
  const fingerprint = await helperFingerprint(plan, found.compiler, deps.run);
  const stampFile = helperStampPath(plan.appPath);
  if (fingerprint && !opts.force && deps.exists(plan.appPath)) {
    const stamp = (await readFile(stampFile, 'utf8').catch(() => '')).trim();
    if (stamp === fingerprint && (await deps.run('/usr/bin/codesign', ['--verify', '--strict', plan.appPath], 60_000)).code === 0) {
      log(`${HELPER_UNCHANGED}, so the build was skipped. ${plan.appPath} is already installed and signed.`);
      return 0;
    }
  }

  const tmp = await mkdtemp(join(tmpdir(), 'stephen-helper-'));
  const staging = join(dirname(plan.appPath), `.${basename(plan.appPath)}.tmp-${process.pid}`);
  try {
    const out = join(tmp, HELPER_EXECUTABLE);
    log(`Compiling Stephen Helper with ${swiftc} (this takes a minute)…`);
    const b = await buildWithSdkFallback(
      sdkPath,
      async (sdk) => {
        const r = await deps.run(swiftc, swiftcArgs(plan.sourceDir, out, sdk), 600_000);
        return r.code === 0 && !deps.exists(out) ? { ...r, code: 1 } : r;
      },
      () => (deps.fallbackSdks ?? listFallbackSdks)(sdkPath),
    );
    if (!b.ok) {
      const r = b.result;
      const text = (r.stderr || r.stdout).trim().split('\n').slice(0, 40).join('\n');
      log(`✗ swiftc failed (exit code ${r.code}):\n${text}\n\nCommand: ${display(swiftc, swiftcArgs(plan.sourceDir, out, sdkPath))}`);
      if (b.tried.length > 1) log(`The default SDK has no SwiftUIMacros plugin, and no other SDK built it either (tried ${b.tried.slice(1).join(', ')}). ${SDK_FIX}`);
      else if (SWIFTUI_MACROS_MISSING.test(text)) log(`The default SDK has no SwiftUIMacros plugin, and there is no other SDK in ${CLT_SDKS_DIR}. ${SDK_FIX}`);
      else if (/xcrun: error|invalid active developer path|unable to find sdk|no such module/i.test(text)) log(XCODE_TOOLS_FIX);
      return 1;
    }
    log(`SDK: ${b.sdkPath ?? 'swiftc default'}`);
    if (b.fallbackFrom) log(sdkFallbackNote(b));

    const template = await readFile(join(plan.sourceDir, 'Info.plist'), 'utf8');
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(staging, 'Contents', 'Info.plist'), renderInfoPlist(template, plan.version), 'utf8');
    const exe = join(staging, 'Contents', 'MacOS', HELPER_EXECUTABLE);
    await copyFile(out, exe);
    await chmod(exe, 0o755);
    const sign = await deps.run('/usr/bin/codesign', codesignArgs(staging), 120_000);
    if (sign.code !== 0) {
      log(`✗ codesign failed: ${(sign.stderr || sign.stdout).trim() || `exit code ${sign.code}`}`);
      return 1;
    }

    const wasRunning = await deps.quitRunning(plan.stephenHome).catch(() => false);
    if (wasRunning) log('Asked the running Stephen Helper to quit.');
    await rm(stampFile, { force: true });
    await rm(plan.appPath, { recursive: true, force: true });
    await rename(staging, plan.appPath);
    if (fingerprint) await writeFile(stampFile, `${fingerprint}\n`, 'utf8');
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }

  log(`✓ Built ${plan.appPath} (version ${plan.version}, ad-hoc signed as ${HELPER_BUNDLE_ID})`);
  if (deps.openAfter) {
    const openArgv = openHelperArgv(plan.appPath, plan.stephenHome);
    let o = await deps.run('/usr/bin/open', openArgv, 30_000);
    if (o.code !== 0) {
      // -600 (procNotFound): the old helper is still exiting / LaunchServices still has the replaced bundle. Retry once.
      await new Promise((r) => setTimeout(r, 2000));
      o = await deps.run('/usr/bin/open', openArgv, 30_000);
    }
    if (o.code !== 0) log(`Could not open it: ${(o.stderr || o.stdout).trim() || `exit code ${o.code}`}`);
  }
  log(['', ...nextSteps(plan)].join('\n'));
  return 0;
}

export async function runInstallHelper(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const unknown = argv.filter((a) => a !== '--dry-run' && a !== '--force');
  if (unknown.length) {
    console.error(`Unknown option "${unknown[0]}".\nUsage: ${INSTALL_HELPER_USAGE}`);
    return 1;
  }
  return installHelper(planHelperInstall(), { dryRun, force }, defaultInstallHelperDeps());
}

export { HELPER_APP_NAME };
