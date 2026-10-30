/**
 * `browser-hub zen-launch` and `browser-hub install-zen-launcher`.
 *
 * Gecko only enables its Remote Agent (WebDriver BiDi) when Zen is STARTED with
 * --remote-debugging-port; a Zen opened normally can never be attached to. So instead of the server
 * launching Zen (it is attach-only by default), the user opens their everyday Zen through a small
 * "Zen for Claude" app that runs `zen-launch`:
 *  - a Claude-ready Zen already runs → bring it to the front, exit 0;
 *  - Zen runs normally → exit 2 (the app then offers "Quit and reopen"; `--quit-running` asks Zen to
 *    quit like ⌘Q via AppleScript, waits for it, then launches) — never kill/SIGKILL;
 *  - otherwise launch Zen on the real profile with remote control, record it in the state file, exit 0.
 * zen-launch never opens a BiDi session (Gecko allows one at a time; `serve` attaches later).
 *
 * Exit codes: 0 = Zen is ready for Claude, 2 = the user must do something, 1 = error.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHubError } from './errors.js';
import {
  DEFAULT_ZEN_BUNDLE_ID,
  appBundleOf,
  appleScriptString,
  isProcessRunning as defaultIsProcessRunning,
  osascriptQuitArgv,
  readAppBundleInfo,
} from './drivers/macos.js';
import { type Clock, errText, realClock } from './drivers/util.js';
import { ZEN_LAUNCHER_APP_NAME, ZenDriver, isZenAttachOnly } from './drivers/zen.js';
import type { ResolvedConfig } from './types.js';

export type ExitCode = 0 | 1 | 2;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Run a program (no shell); a spawn failure is reported as code 127. */
export const defaultRun: RunFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const raw = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
      const code = typeof raw === 'number' ? raw : err ? 127 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === 127 ? err.message : '')) });
    });
  });

// ───────────────────────────── zen-launch ─────────────────────────────

export interface ZenLaunchOptions {
  /** Ask a normally-running Zen to quit (AppleScript, like ⌘Q), wait for it, then launch. */
  quitRunning?: boolean;
}

export interface ZenLaunchDeps {
  cfg: ResolvedConfig;
  driver: Pick<ZenDriver, 'inspect' | 'launchForClaude'>;
  isProcessRunning: (name: string) => Promise<boolean>;
  run: RunFn;
  platform: NodeJS.Platform;
  clock: Clock;
  /** How long to wait for Zen to quit after asking it to (default 20 s). */
  quitTimeoutMs: number;
  pollIntervalMs: number;
}

export type ZenLaunchStatus = 'launched' | 'already-running' | 'zen-running' | 'quit-failed' | 'needs-user' | 'error';

export interface ZenLaunchResult {
  exitCode: ExitCode;
  status: ZenLaunchStatus;
  message: string;
  notes: string[];
  pid?: number;
  wsUrl?: string;
  profileDir?: string;
  logPath?: string;
}

/** Start of the exit-2 message for "Zen is open normally"; the launcher app keys its "Reopen" dialog on it. */
export const ZEN_RUNNING_NORMALLY_LEAD = 'Zen is open without Claude access.';

export const ZEN_RUNNING_NORMALLY_MESSAGE =
  `${ZEN_RUNNING_NORMALLY_LEAD} Quit Zen (⌘Q) and run this again, or run \`browser-hub zen-launch --quit-running\` ` +
  'to have Zen asked to quit and reopened for Claude. Your tabs come back if Zen is set to restore your previous session.';

export function defaultZenLaunchDeps(cfg: ResolvedConfig): ZenLaunchDeps {
  return {
    cfg,
    driver: new ZenDriver(cfg),
    isProcessRunning: defaultIsProcessRunning,
    run: defaultRun,
    platform: process.platform,
    clock: realClock,
    quitTimeoutMs: 20_000,
    pollIntervalMs: 250,
  };
}

async function zenBundleId(cfg: ResolvedConfig): Promise<{ app: string | null; bundleId: string }> {
  const app = appBundleOf(cfg.zen.executablePath);
  const bundleId = app ? ((await readAppBundleInfo(app)).bundleId ?? DEFAULT_ZEN_BUNDLE_ID) : DEFAULT_ZEN_BUNDLE_ID;
  return { app, bundleId };
}

/** Start the user's Zen with Claude access (see file comment). Never kills anything; never opens a BiDi session. */
export async function runZenLaunch(opts: ZenLaunchOptions, deps: ZenLaunchDeps): Promise<ZenLaunchResult> {
  const { cfg } = deps;
  const notes: string[] = [];
  if (cfg.zen.mode !== 'real') {
    notes.push(
      `Your config has "zen": {"mode": "${cfg.zen.mode}"}, so Claude uses the separate agent Zen and will not use this one. ` +
        'Remove "mode" from the "zen" section of ~/.browser-hub/config.json to use your own Zen.',
    );
  } else if (!isZenAttachOnly(cfg)) {
    notes.push('"zen.launch" is "auto": browser-hub may also start Zen itself when it is not running.');
  }
  const fail = (exitCode: ExitCode, status: ZenLaunchStatus, message: string): ZenLaunchResult => ({ exitCode, status, message, notes });

  try {
    const readiness = await deps.driver.inspect('real');
    if (readiness.kind === 'ready' && readiness.state) {
      const st = readiness.state;
      if (deps.platform === 'darwin') {
        const { app, bundleId } = await zenBundleId(cfg);
        // Bring it to the front (activates the running Zen; does not start another).
        const r = await deps.run('/usr/bin/open', app ? ['-a', app] : ['-b', bundleId], 10_000);
        if (r.code !== 0) notes.push(`Could not bring Zen to the front: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`);
      }
      return {
        exitCode: 0,
        status: 'already-running',
        message: `Zen is already running with Claude access (pid ${st.pid}).`,
        notes,
        pid: st.pid,
        wsUrl: st.wsUrl,
        profileDir: st.profileDir,
        ...(st.logPath ? { logPath: st.logPath } : {}),
      };
    }

    // A Zen started by an earlier zen-launch that is still starting up: wait for it (launchForClaude resumes it).
    if (readiness.kind !== 'starting' && (await deps.isProcessRunning('zen'))) {
      if (!opts.quitRunning) return fail(2, 'zen-running', ZEN_RUNNING_NORMALLY_MESSAGE);
      if (deps.platform !== 'darwin') {
        return fail(2, 'quit-failed', 'Asking Zen to quit only works on macOS. Quit Zen yourself, then run `browser-hub zen-launch` again.');
      }
      const { bundleId } = await zenBundleId(cfg);
      const r = await deps.run('/usr/bin/osascript', osascriptQuitArgv(bundleId), 30_000);
      if (r.code !== 0) {
        const why = (r.stderr || r.stdout).trim().split('\n')[0] || `osascript exit code ${r.code}`;
        return fail(2, 'quit-failed', `Could not ask Zen to quit (${why}). Quit Zen yourself (⌘Q), then try again. browser-hub never force-quits Zen.`);
      }
      const deadline = deps.clock.now() + deps.quitTimeoutMs;
      while (await deps.isProcessRunning('zen')) {
        if (deps.clock.now() >= deadline) {
          return fail(
            2,
            'quit-failed',
            `Zen did not quit within ${Math.round(deps.quitTimeoutMs / 1000)} s — it may be asking you to confirm closing windows or tabs. ` +
              'Answer that (or quit Zen with ⌘Q), then try again. browser-hub never force-quits Zen.',
          );
        }
        await deps.clock.sleep(deps.pollIntervalMs);
      }
      notes.push('Asked Zen to quit; it closed normally.');
    }

    const info = await deps.driver.launchForClaude();
    return {
      exitCode: 0,
      status: 'launched',
      message: info.resumed
        ? `Zen finished starting with Claude access (pid ${info.pid}).`
        : `Started Zen with Claude access (pid ${info.pid}).`,
      notes,
      pid: info.pid,
      wsUrl: info.wsUrl,
      profileDir: info.profileDir,
      logPath: info.logPath,
    };
  } catch (e) {
    const needsUser = isHubError(e) && e.code === 'NEEDS_USER';
    return fail(needsUser ? 2 : 1, needsUser ? 'needs-user' : 'error', isHubError(e) ? e.message : errText(e));
  }
}

/** Human-readable zen-launch output. */
export function formatZenLaunch(r: ZenLaunchResult): string {
  const lines: string[] = [];
  if (r.exitCode === 0) {
    lines.push(`✓ ${r.message}`);
    if (r.profileDir) lines.push(`  Profile: ${r.profileDir}`);
    if (r.wsUrl) lines.push(`  Remote control: ${r.wsUrl} (this Mac only)`);
    if (r.logPath) lines.push(`  Zen log: ${r.logPath}`);
    lines.push(
      '  Claude Code can now use your open Zen windows.',
      '  While this Zen runs, any program on this Mac can control it (no password on that local port).',
      '  When you no longer need Claude in Zen, quit it (⌘Q) and open Zen normally.',
    );
  } else {
    lines.push(`${r.exitCode === 2 ? '!' : '✗'} ${r.message}`);
  }
  for (const n of r.notes) lines.push(`  Note: ${n}`);
  return lines.join('\n');
}

export function parseZenLaunchArgs(argv: string[]): { quitRunning: boolean; json: boolean } | { error: string } {
  const out = { quitRunning: false, json: false };
  for (const a of argv) {
    if (a === '--quit-running') out.quitRunning = true;
    else if (a === '--json') out.json = true;
    else return { error: `Unknown option "${a}".` };
  }
  return out;
}

// ───────────────────────────── install-zen-launcher ─────────────────────────────

export const ZEN_LAUNCHER_USAGE = 'browser-hub install-zen-launcher [--dry-run]';
/** Written into the applet so a re-install only ever replaces an app browser-hub made. */
const LAUNCHER_MARKER = 'browser-hub-zen-launcher';

/** `~/Applications/Zen for Claude.app` */
export function zenLauncherAppPath(userHome: string = process.env.HOME?.trim() || homedir()): string {
  return join(userHome, 'Applications', `${ZEN_LAUNCHER_APP_NAME}.app`);
}

const DIALOG_REOPEN =
  'Zen is open without Claude access. Quit and reopen it for Claude? Your tabs come back if Zen restores your previous session.';

/**
 * The applet's AppleScript. Paths are AppleScript string literals (quotes/backslashes escaped) and
 * reach the shell only through `quoted form of`, so spaces, quotes and $ in paths are inert. Plain
 * local variables, not `property`: applets write changed properties back into themselves.
 * Exit 2 offers "Reopen" only for "Zen is open normally" (other exit-2 cases, e.g. no profile found,
 * just show zen-launch's message — `do shell script` puts the command's stderr into errMsg).
 */
export function buildLauncherAppleScript(nodePath: string, cliPath: string): string {
  const title = appleScriptString(ZEN_LAUNCHER_APP_NAME);
  return `-- ${ZEN_LAUNCHER_APP_NAME}: opens Zen with Claude access.
-- Generated by \`browser-hub install-zen-launcher\`; run that again to update it.

on zenLaunch(extraArgs)
	set nodePath to ${appleScriptString(nodePath)}
	set cliPath to ${appleScriptString(cliPath)}
	do shell script (quoted form of nodePath) & " " & (quoted form of cliPath) & " zen-launch" & extraArgs
end zenLaunch

on showError(msg)
	display dialog msg with title ${title} buttons {"OK"} default button "OK" with icon stop
end showError

on run
	try
		my zenLaunch("")
	on error errMsg number errNum
		if errNum is -128 then return
		if errNum is 2 and errMsg contains ${appleScriptString(ZEN_RUNNING_NORMALLY_LEAD)} then
			-- Zen is open normally: offer to quit it (like ⌘Q) and reopen it with Claude access.
			try
				display dialog ${appleScriptString(DIALOG_REOPEN)} with title ${title} buttons {"Cancel", "Reopen"} default button "Reopen" cancel button "Cancel" with icon caution
			on error number -128
				return
			end try
			try
				my zenLaunch(" --quit-running")
			on error errMsg2 number errNum2
				if errNum2 is not -128 then my showError(errMsg2)
			end try
		else
			my showError(errMsg)
		end if
	end try
end run
`;
}

export interface LauncherPlan {
  appPath: string;
  nodePath: string;
  cliPath: string;
  zenApp: string | null;
  iconPath: string | null;
  script: string;
}

export async function planZenLauncher(
  cfg: ResolvedConfig,
  paths: { nodePath: string; cliPath: string; appPath?: string },
): Promise<LauncherPlan> {
  const zenApp = appBundleOf(cfg.zen.executablePath);
  const iconPath = zenApp ? (await readAppBundleInfo(zenApp)).iconPath : null;
  return {
    appPath: paths.appPath ?? zenLauncherAppPath(),
    nodePath: paths.nodePath,
    cliPath: paths.cliPath,
    zenApp,
    iconPath,
    script: buildLauncherAppleScript(paths.nodePath, paths.cliPath),
  };
}

export function formatLauncherPlan(plan: LauncherPlan): string {
  return [
    `App:     ${plan.appPath}`,
    `Runs:    ${shellQuote(plan.nodePath)} ${shellQuote(plan.cliPath)} zen-launch`,
    `Icon:    ${plan.iconPath ?? `none found${plan.zenApp ? ` in ${plan.zenApp}/Contents/Resources` : ''} (the app keeps the default applet icon)`}`,
    '',
    'AppleScript:',
    plan.script,
  ].join('\n');
}

/** POSIX single-quote quoting (display only — the applet itself uses AppleScript's `quoted form of`). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface InstallLauncherDeps {
  run: RunFn;
  platform: NodeJS.Platform;
  exists: (p: string) => Promise<boolean>;
  log: (line: string) => void;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function defaultInstallLauncherDeps(): InstallLauncherDeps {
  return { run: defaultRun, platform: process.platform, exists: pathExists, log: (l) => console.log(l) };
}

/** Build `Zen for Claude.app` with osacompile (or just print the plan with dryRun). Returns the exit code. */
export async function installZenLauncher(plan: LauncherPlan, opts: { dryRun?: boolean }, deps: InstallLauncherDeps): Promise<ExitCode> {
  const { log } = deps;
  if (opts.dryRun) {
    log(`Dry run — nothing was created.${deps.platform === 'darwin' ? '' : ' (install-zen-launcher only works on macOS.)'}\n`);
    log(formatLauncherPlan(plan));
    return 0;
  }
  if (deps.platform !== 'darwin') {
    log('install-zen-launcher is macOS-only: it builds an AppleScript app with osacompile. (Use --dry-run to see what it would create.)');
    return 1;
  }
  if (!(await deps.exists(plan.cliPath))) {
    log(`${plan.cliPath} does not exist yet — run \`npm run build\` first, then run install-zen-launcher again.`);
    return 1;
  }
  if (await deps.exists(plan.appPath)) {
    if (!(await deps.exists(join(plan.appPath, 'Contents', 'Resources', LAUNCHER_MARKER)))) {
      log(`${plan.appPath} already exists and was not made by browser-hub. Move it away (or rename it), then run this again.`);
      return 1;
    }
    await rm(plan.appPath, { recursive: true, force: true });
  }
  await mkdir(join(plan.appPath, '..'), { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'bh-launcher-'));
  try {
    const src = join(tmp, 'launcher.applescript');
    await writeFile(src, plan.script, 'utf8');
    const r = await deps.run('/usr/bin/osacompile', ['-o', plan.appPath, src], 60_000);
    if (r.code !== 0) {
      log(`osacompile failed: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
      return 1;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  const resources = join(plan.appPath, 'Contents', 'Resources');
  let iconNote = 'default applet icon (no Zen icon found)';
  if (plan.iconPath) {
    try {
      await copyFile(plan.iconPath, join(resources, 'applet.icns'));
      iconNote = `Zen's icon (${plan.iconPath})`;
    } catch (e) {
      iconNote = `default applet icon (could not copy Zen's icon: ${errText(e)})`;
    }
  }
  await writeFile(join(resources, LAUNCHER_MARKER), 'Created by browser-hub install-zen-launcher.\n', 'utf8');
  // Changing Resources invalidates osacompile's ad-hoc signature: re-sign ad hoc (best effort) and nudge Finder's icon cache.
  await deps.run('/usr/bin/codesign', ['--force', '--sign', '-', plan.appPath], 60_000).catch(() => undefined);
  await deps.run('/usr/bin/touch', [plan.appPath], 10_000).catch(() => undefined);

  log(
    [
      `✓ Created ${plan.appPath}`,
      `  Icon: ${iconNote}`,
      `  It runs: ${shellQuote(plan.nodePath)} ${shellQuote(plan.cliPath)} zen-launch`,
      '',
      `Next: open ~/Applications in Finder and drag "${ZEN_LAUNCHER_APP_NAME}" to your Dock.`,
      `Open Zen with it (instead of Zen's own icon) whenever you want Claude to use your Zen. If Zen is already open`,
      'normally, it offers to quit and reopen it for Claude. If you move or rebuild browser-hub or switch Node versions,',
      'run `browser-hub install-zen-launcher` again.',
    ].join('\n'),
  );
  return 0;
}
