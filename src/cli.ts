#!/usr/bin/env node
// browser-hub CLI. Commands: serve (default) | doctor | selftest | install [--run] | zen-launch | install-zen-launcher | help | --version
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFilePath, loadConfig } from './config.js';
import { createBrowserManager } from './drivers/index.js';
import { securePrivateDirs } from './drivers/util.js';
import {
  findZenExecutable,
  getBrowserVersion,
  isProcessRunning,
  readDevToolsActivePort,
  resolveZenRealProfile,
} from './drivers/macos.js';
import { ZEN_ATTACH_ONLY_LABEL, ZenDriver, isZenAttachOnly } from './drivers/zen.js';
import { errorMessage } from './errors.js';
import { pageEngine } from './page/index.js';
import { createSafety } from './safety/index.js';
import { SELFTEST_USAGE, emergencyCleanup, parseSelftestArgs, runSelftest } from './selftest/index.js';
import { packageVersion, serveStdio } from './server/index.js';
import type { ResolvedConfig } from './types.js';
import {
  ZEN_LAUNCHER_USAGE,
  defaultInstallLauncherDeps,
  defaultZenLaunchDeps,
  formatZenLaunch,
  installZenLauncher,
  parseZenLaunchArgs,
  planZenLauncher,
  runZenLaunch,
  zenLauncherAppPath,
} from './zen-launcher.js';

const MIN_NODE: [number, number] = [20, 19];
const MIN_CHROME = 144;

const HELP = `browser-hub ${packageVersion()} — MCP server that lets Claude Code use Zen and Chrome on macOS

Usage:
  browser-hub [serve]        Run the MCP server on stdio (what Claude Code starts)
  browser-hub doctor         Check this Mac's setup and print fixes
  browser-hub selftest       Prove each browser works end to end, safely (temporary agent profile,
                             local test pages only; closes what it opened). Options:
                             --browser chrome|zen|all (default all)  --keep-open  --json
  browser-hub install        Print the "claude mcp add" command for this install
  browser-hub install --run  …and run it (registers browser-hub for all your projects)
  browser-hub zen-launch     Open your everyday Zen with Claude access (remote control on), then exit.
                             --quit-running  ask a normally-open Zen to quit (like ⌘Q) and reopen it
                             --json          machine-readable result
                             Exit code: 0 ready, 2 you need to do something, 1 error
  browser-hub install-zen-launcher [--dry-run]
                             Create "~/Applications/Zen for Claude.app" (runs zen-launch; put it in your Dock)
  browser-hub help | --help  This help
  browser-hub --version      Print the version

Config: ${configFilePath()}  (env BROWSER_HUB_HOME, BROWSER_HUB_CONFIG)`;

// ───────────────────────────── serve ─────────────────────────────

async function serve(): Promise<void> {
  // stdout carries MCP JSON-RPC only — route all console output to stderr before anything can log.
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
  const cfg = loadConfig();
  // Profiles, state and saved page output are private to this user (mode 0700).
  try {
    await securePrivateDirs(cfg);
  } catch (e) {
    console.error(`[browser-hub] could not secure ${cfg.home}: ${errorMessage(e)}`);
  }
  const manager = createBrowserManager(cfg);
  await serveStdio({ cfg, manager, engine: pageEngine, safetyFactory: createSafety });
}

// ───────────────────────────── doctor ─────────────────────────────

interface Check {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  /** A failed blocking check makes doctor exit 1. */
  blocking?: boolean;
  /** Informational line (no ✓/✗ judgement). */
  info?: boolean;
}

function versionAtLeast(v: string, min: [number, number]): boolean {
  const [maj = 0, minor = 0] = v.replace(/^v/, '').split('.').map(Number);
  return maj > min[0] || (maj === min[0] && minor >= min[1]);
}

function majorOf(version: string | null): number | null {
  const m = version ? /(\d+)\.\d+/.exec(version) : null;
  return m ? Number(m[1]) : null;
}

async function tryCall<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

async function writable(dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.doctor-${process.pid}`);
    await writeFile(probe, 'ok', { mode: 0o600 });
    await rm(probe, { force: true });
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

async function doctor(): Promise<number> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  add({
    ok: process.platform === 'darwin',
    label: 'macOS',
    detail: process.platform,
    fix: 'browser-hub drives Zen and Chrome on macOS. Other platforms only work with explicit config paths (tests).',
    blocking: true,
  });
  add({
    ok: versionAtLeast(process.versions.node, MIN_NODE),
    label: `Node.js ≥ ${MIN_NODE.join('.')}`,
    detail: process.versions.node,
    fix: 'Install a current Node.js LTS (https://nodejs.org or `brew install node`).',
    blocking: true,
  });

  let cfg: ResolvedConfig | null = null;
  try {
    cfg = loadConfig();
    add({ ok: true, label: 'Config loads', detail: existsSync(configFilePath()) ? configFilePath() : `defaults (no ${configFilePath()})` });
  } catch (e) {
    add({ ok: false, label: 'Config loads', detail: errorMessage(e), fix: `Fix ${configFilePath()} (it must be valid JSON; see README "Configuration").`, blocking: true });
  }

  if (cfg) {
    const err = await writable(cfg.home);
    add({ ok: !err, label: 'Home dir writable', detail: err ? `${cfg.home}: ${err}` : cfg.home, fix: `Make ${cfg.home} writable, or set BROWSER_HUB_HOME.`, blocking: true });

    // ── Chrome
    const chromeExists = existsSync(cfg.chrome.executablePath);
    const chromeVersion = chromeExists ? (await tryCall(() => getBrowserVersion(cfg!.chrome.executablePath))).value ?? null : null;
    const chromeMajor = majorOf(chromeVersion);
    add({
      ok: chromeExists,
      label: 'Chrome installed',
      detail: chromeExists ? `${cfg.chrome.executablePath}${chromeVersion ? ` (${chromeVersion})` : ''}` : `not found at ${cfg.chrome.executablePath}`,
      fix: 'Install Google Chrome, or set "chrome": {"executablePath": "…"} in config.',
    });
    if (chromeExists && cfg.chrome.mode === 'real') {
      add({
        ok: chromeMajor !== null && chromeMajor >= MIN_CHROME,
        label: `Chrome ≥ ${MIN_CHROME} (needed for real-profile mode)`,
        detail: chromeVersion ?? 'version unknown',
        fix: 'Update Chrome (Chrome menu → Help → About Google Chrome), or set "chrome": {"mode": "agent"}.',
      });
      const port = await tryCall(() => readDevToolsActivePort(cfg!.chrome.userDataDir));
      add({
        ok: !!port.value,
        label: 'Chrome remote debugging enabled',
        detail: port.value ? `DevToolsActivePort → port ${port.value.port}` : (port.error ?? `no DevToolsActivePort in ${cfg.chrome.userDataDir}`),
        fix: 'Open chrome://inspect/#remote-debugging in Chrome, turn on "Allow remote debugging for this browser instance", keep Chrome open, and click Allow when Chrome asks the first time browser-hub connects.',
      });
    } else if (cfg.chrome.mode === 'agent') {
      add({ ok: true, info: true, label: 'Chrome agent profile', detail: `${cfg.chrome.agentProfileDir}${existsSync(cfg.chrome.agentProfileDir) ? '' : ' (created on first use)'}` });
    }

    // ── Zen
    let zenPath: string | null = existsSync(cfg.zen.executablePath) ? cfg.zen.executablePath : null;
    if (!zenPath) zenPath = (await tryCall(() => findZenExecutable())).value ?? null;
    const zenVersion = zenPath ? (await tryCall(() => getBrowserVersion(zenPath!))).value ?? null : null;
    add({
      ok: !!zenPath,
      label: 'Zen installed',
      detail: zenPath ? `${zenPath}${zenVersion ? ` (${zenVersion})` : ''}` : `not found at ${cfg.zen.executablePath}`,
      fix: 'Install Zen (https://zen-browser.app) into /Applications, or set "zen": {"executablePath": "…"} in config.',
    });
    if (!chromeExists && !zenPath) {
      add({ ok: false, label: 'At least one browser available', fix: 'Install Chrome or Zen (see above).', blocking: true });
    }
    const zenAttach = isZenAttachOnly(cfg);
    add({
      ok: true,
      info: true,
      label: 'Zen mode',
      detail: `${cfg.zen.mode} · launch: ${zenAttach ? 'never' : 'auto'}${zenAttach ? ` — ${ZEN_ATTACH_ONLY_LABEL}` : cfg.zen.mode === 'agent' ? ' — browser-hub starts a separate agent Zen window' : ' — browser-hub relaunches Zen on your profile when Zen is quit'}`,
    });
    if (cfg.zen.mode === 'real') {
      const prof = await tryCall(() => resolveZenRealProfile(cfg!));
      add({
        ok: !!prof.value,
        label: 'Zen real profile found',
        detail: prof.value ?? prof.error ?? `no profile in ${cfg.zen.zenAppSupportDir}/profiles.ini`,
        fix: 'Set "zen": {"profilePath": "/Users/<you>/Library/Application Support/zen/Profiles/<name>"} (Zen: about:profiles shows it).',
      });
      const ready = await tryCall(() => new ZenDriver(cfg!).inspect('real'));
      const readiness = ready.value?.kind ?? 'none';
      const running = (await tryCall(() => isProcessRunning('zen'))).value === true;
      const launcher = zenLauncherAppPath();
      const launcherExists = existsSync(launcher);
      const openHint = launcherExists
        ? `Open Zen with the "Zen for Claude" app (${launcher}) or run \`browser-hub zen-launch\`.`
        : 'Run `browser-hub install-zen-launcher` once, then open Zen with the "Zen for Claude" app (or run `browser-hub zen-launch`).';
      if (readiness === 'ready' || readiness === 'starting') {
        const st = ready.value!.state!;
        add({ ok: true, label: 'Claude-ready Zen running', detail: readiness === 'ready' ? `pid ${st.pid}, ${st.wsUrl}` : `pid ${st.pid}, still starting` });
      } else if (running) {
        add({
          ok: false,
          label: 'Claude-ready Zen running',
          detail: 'no — Zen is open normally (without Claude access)',
          fix: `Quit Zen (⌘Q) and reopen it for Claude. ${openHint} Your tabs come back if Zen restores your previous session.`,
        });
      } else {
        add({ ok: true, info: true, label: 'Claude-ready Zen running', detail: `no — Zen is not open. ${zenAttach ? openHint : 'browser-hub starts it when needed (launch: auto).'}` });
      }
      add({ ok: true, info: true, label: 'Zen running normally (without Claude access)', detail: running && readiness === 'none' ? 'yes' : 'no' });
      add({
        ok: launcherExists,
        label: '"Zen for Claude" launcher app',
        detail: launcherExists ? launcher : `not found at ${launcher}`,
        fix: 'Run `browser-hub install-zen-launcher` (creates the app; then drag it to your Dock).',
      });
      if (!zenAttach) {
        add({
          ok: !running || readiness !== 'none',
          label: 'Zen is not running (real-profile mode, launch: auto)',
          detail: running ? 'Zen is running' : 'not running',
          fix: 'Quit Zen (⌘Q) before browser-hub connects — it relaunches Zen with remote control on your profile.',
        });
      }
    } else {
      add({ ok: true, info: true, label: 'Zen agent profile', detail: `${cfg.zen.agentProfileDir}${existsSync(cfg.zen.agentProfileDir) ? '' : ' (created on first use; runs alongside your normal Zen)'}` });
    }

    add({ ok: true, info: true, label: 'Audit log', detail: cfg.auditLogPath });
    add({ ok: true, info: true, label: 'Saved output', detail: cfg.output.saveDir });
    add({ ok: true, info: true, label: 'Modes', detail: `chrome: ${cfg.chrome.mode} · zen: ${cfg.zen.mode} · default browser: ${cfg.defaultBrowser} · confirm: ${cfg.safety.confirm}` });
  }

  const out: string[] = [`browser-hub doctor (v${packageVersion()})`, ''];
  for (const c of checks) {
    const mark = c.info ? '•' : c.ok ? '✓' : '✗';
    out.push(`${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok && c.fix) out.push(`    fix: ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.ok);
  const blocking = failed.filter((c) => c.blocking);
  out.push(
    '',
    failed.length === 0
      ? 'All good. Next: `browser-hub selftest` tries each browser end to end (temporary profile, local test pages).'
      : `${failed.length} problem${failed.length === 1 ? '' : 's'}${blocking.length ? ` (${blocking.length} blocking)` : ' (none blocking)'}.`,
  );
  console.log(out.join('\n'));
  return blocking.length ? 1 : 0;
}

// ───────────────────────────── selftest ─────────────────────────────

async function selftest(argv: string[]): Promise<number> {
  const opts = parseSelftestArgs(argv);
  if ('error' in opts) {
    console.error(`${opts.error}\nUsage: ${SELFTEST_USAGE}`);
    return 2;
  }
  // Ctrl-C mid-run: stop the browsers this run started (only those) and delete its temp dirs.
  const onSignal = (signal: NodeJS.Signals) => {
    emergencyCleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const report = await runSelftest(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    return report.exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// ───────────────────────────── install ─────────────────────────────

function distCliPath(): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'dist') return here;
  return resolve(dirname(here), '..', 'dist', 'cli.js');
}

async function install(run: boolean): Promise<number> {
  const cli = distCliPath();
  const args = ['mcp', 'add', '--scope', 'user', 'browser-hub', '--', 'node', cli, 'serve'];
  const printable = `claude mcp add --scope user browser-hub -- node "${cli}" serve`;
  if (!existsSync(cli)) console.log(`Note: ${cli} does not exist yet — run \`npm run build\` first.\n`);
  if (!run) {
    console.log(`Register browser-hub with Claude Code (all projects):\n\n  ${printable}\n\nThen restart Claude Code and check /mcp. Or run: browser-hub install --run`);
    return 0;
  }
  console.log(`Running: ${printable}`);
  return new Promise((resolveExit) => {
    execFile('claude', args, (err, stdout, stderr) => {
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
      if (err) {
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        console.error(
          notFound
            ? 'The `claude` command was not found. Install Claude Code, or run the command above in a terminal where `claude` works.'
            : `claude mcp add failed: ${err.message.split('\n')[0]}. If browser-hub is already registered, remove it first: claude mcp remove --scope user browser-hub`,
        );
        resolveExit(1);
        return;
      }
      console.log('Done. Restart Claude Code, then run /mcp to see browser-hub.');
      resolveExit(0);
    });
  });
}

// ───────────────────────────── zen-launch ─────────────────────────────

async function zenLaunch(argv: string[]): Promise<number> {
  const opts = parseZenLaunchArgs(argv);
  if ('error' in opts) {
    console.error(`${opts.error}\nUsage: browser-hub zen-launch [--quit-running] [--json]`);
    return 1;
  }
  const cfg = loadConfig();
  try {
    await securePrivateDirs(cfg);
  } catch {
    // best effort (the state dir is created 0700 when written)
  }
  const result = await runZenLaunch({ quitRunning: opts.quitRunning }, defaultZenLaunchDeps(cfg));
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else if (result.exitCode === 0) console.log(formatZenLaunch(result));
  // Not ready: the message goes to stderr, which is what the "Zen for Claude" app shows in its dialog.
  else console.error(formatZenLaunch(result));
  return result.exitCode;
}

async function installLauncher(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) {
    console.error(`Unknown option "${unknown[0]}".\nUsage: ${ZEN_LAUNCHER_USAGE}`);
    return 1;
  }
  const cfg = loadConfig();
  const plan = await planZenLauncher(cfg, { nodePath: process.execPath, cliPath: distCliPath() });
  return installZenLauncher(plan, { dryRun }, defaultInstallLauncherDeps());
}

// ───────────────────────────── main ─────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', ...rest] = argv;
  switch (cmd) {
    case 'serve':
      await serve();
      return -1; // keep running
    case 'doctor':
      return doctor();
    case 'selftest':
      return selftest(rest);
    case 'install':
      return install(rest.includes('--run'));
    case 'zen-launch':
      return zenLaunch(rest);
    case 'install-zen-launcher':
      return installLauncher(rest);
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case '--version':
    case '-v':
    case 'version':
      console.log(packageVersion());
      return 0;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`browser-hub: ${errorMessage(e)}`);
    process.exit(1);
  },
);
