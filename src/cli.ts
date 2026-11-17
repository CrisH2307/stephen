#!/usr/bin/env node
// Stephen CLI (`stephen`; `browser-hub` is a compatibility alias for the same file).
// Commands: serve (default) | doctor | selftest | install [--run] | listen | eval | eval-clicks | memory | history | latency | jobs | app | accounts | connect | disconnect | voice-setup | voice-key | zen-launch | install-zen-launcher | install-helper | help | --version
import { readCommandId } from './lib/command-id.js';
import { parseServeArgs } from './serve-args.js';
import { RESTARTED_EXIT_CODE, claimServeInstance } from './server/instance.js';
import { withSessionState } from './safety/session-state.js';
import type { ServerDepsWithVoice } from './voice/announce.js';
import { voiceOutputChecks } from './voice/tts/doctor.js';
import { parseTtsConfig } from './voice/tts/index.js';
import { isTtsSetupArgs, runTtsSetup } from './voice/tts/setup.js';
import { execFile } from 'node:child_process';
import { helperDoctorChecks } from './helper/doctor.js';
import { runInstallHelper } from './helper/install.js';
import { existsSync, realpathSync } from 'node:fs';
import { REPO_ROOT } from './lib/repo.js';
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFilePath, legacyHomeNotice, loadConfig, resolveStephenHome, type HubConfig } from './config.js';
import { createBrowserManager } from './drivers/index.js';
import { securePrivateDirs } from './drivers/util.js';
import {
  findZenExecutable,
  getBrowserVersion,
  isProcessRunning,
  readDevToolsActivePort,
  resolveZenRealProfile,
} from './drivers/macos.js';
import { LEGACY_ZEN_LAUNCHER_APP_NAME, ZEN_ATTACH_ONLY_LABEL, ZEN_LAUNCHER_APP_NAME, ZenDriver, isZenAttachOnly } from './drivers/zen.js';
import { errorMessage } from './errors.js';
import { defaultRunClaude, runInstall } from './install.js';
import { pageEngine } from './page/index.js';
import { createSafety } from './safety/index.js';
import { SELFTEST_USAGE, emergencyCleanup, parseSelftestArgs, runSelftest } from './selftest/index.js';
import { packageVersion, serveStdio } from './server/index.js';
import type { ResolvedConfig } from './types.js';
import {
  ZEN_LAUNCHER_USAGE,
  defaultInstallLauncherDeps,
  defaultZenLaunchDeps,
  findLegacyZenLauncher,
  shellQuote,
  formatZenLaunch,
  installZenLauncher,
  parseZenLaunchArgs,
  planZenLauncher,
  runZenLaunch,
  zenLauncherAppPath,
} from './zen-launcher.js';

const MIN_NODE: [number, number] = [20, 19];
const MIN_CHROME = 144;

const HELP = `stephen ${packageVersion()} — lets Claude use your Mac's browsers (Zen and Chrome), from Claude Code or by voice

Usage:
  stephen [serve]        Run the MCP server on stdio (what Claude Code starts; tools are mcp__stephen__*)
  stephen doctor         Check this Mac's setup and print fixes (--network: also check the ElevenLabs account; --json)
  stephen selftest       Prove each browser works end to end, safely (temporary agent profile,
                         local test pages only; closes what it opened). Options:
                         --browser chrome|zen|all (default all)  --keep-open  --json
  stephen install        Print the "claude mcp add" command for this install
  stephen install --run  …and run it (registers stephen for all your projects; removes an old browser-hub registration)
  stephen listen         "Hey Stephen" voice listener (see docs/VOICE.md; --text "open youtube" skips the mic)
  stephen eval           score one-shot voice requests with a dry-run of Stephen's tools (--only routes, --jobs 2)
  stephen eval-clicks    measure click reliability on local test pages in a headless Chrome (--runs 20, --youtube)
  stephen memory list | add "<text>" | forget <id> | clear
                         What you asked Stephen to remember ("remember …"); clear asks first
  stephen history [--limit N] | clear
                         Show your recent commands (kept on this Mac only), or delete them
  stephen latency [--days 1|7|30] [--json]
                         How long commands take: p50 and p95 per trigger and route, and the 10 slowest
  stephen mac-checks [--json]
                         Pass or fail for the technical checks of the Mac test plan, section 13
  stephen jobs [list] | status <id> | show <id> | stop <id>
                         Background jobs ("Stephen, start a job to …"; each start asks in a dialog)
  stephen phone login | on | off | status | setup | check
                         Talk to Stephen from your phone (Claude app, Remote Control), locked to Stephen's phone tools
  stephen accounts [test canvas|calendar|notion|weather]
                         Which account secrets and Gmail accounts Stephen finds (never the values)
  stephen connect gmail <label> | disconnect gmail <label>
                         Sign in to a Gmail account once, read-only (Google's page opens; token in the Keychain)
  stephen app            Open the Stephen window (chat, memory, history, settings, audit) in Stephen Helper
  stephen voice-setup    Download and check the local wake-word and speech models (once)
  stephen voice-setup --tts kokoro
                         Download the local Kokoro voice (~103 MB; used when ElevenLabs is unavailable)
  stephen voice-key set|status|delete
                         Store / show (last 4 chars) / remove your ElevenLabs API key in the macOS Keychain
  stephen zen-launch     Open your everyday Zen with Stephen access (remote control on), then exit.
                         --quit-running  ask a normally-open Zen to quit (like ⌘Q) and reopen it
                         --json          machine-readable result
                         Exit code: 0 ready, 2 you need to do something, 1 error
  stephen install-zen-launcher [--dry-run]
                         Create "~/Applications/${ZEN_LAUNCHER_APP_NAME}.app" (runs zen-launch; put it in your Dock)
  stephen install-helper [--dry-run] [--force]
                         Build "~/Applications/Stephen Helper.app" (F5 or Fn+Option push-to-talk, Esc; needs Xcode tools)
  stephen help | --help  This help
  stephen --version      Print the version

Config: ${configFilePath()}  (env STEPHEN_HOME, STEPHEN_CONFIG)`;

// ───────────────────────────── serve ─────────────────────────────

async function serve(argv: string[] = []): Promise<void> {
  // stdout carries MCP JSON-RPC only — route all console output to stderr before anything can log.
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
  const cfg = loadConfig();
  const opts = parseServeArgs(argv, { home: cfg.home });
  if ('error' in opts) throw new Error(opts.error);
  if (opts.dryRun) {
    // stephen eval: same tools, nothing acts (src/eval/dry-server.ts). No home dirs touched, no browser, no audit.
    const { buildDryRunServer, fileRecorder, readFakePage } = await import('./eval/dry-server.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const deps: ServerDepsWithVoice = { cfg, manager: createBrowserManager(cfg), engine: pageEngine, safetyFactory: createSafety, voice: {}, ...(opts.trust ? { trust: opts.trust } : {}) };
    const page = opts.dryRun.fakePage !== undefined ? readFakePage(opts.dryRun.fakePage) : undefined;
    const { server } = buildDryRunServer(deps, packageVersion(), fileRecorder(opts.dryRun.record), { ...(page !== undefined ? { page } : {}), ...(opts.trust ? { trust: opts.trust } : {}) });
    const bye = () => process.exit(0);
    process.stdin.once('end', bye);
    process.stdin.once('close', bye);
    process.once('SIGTERM', bye);
    process.once('SIGINT', bye);
    await server.connect(new StdioServerTransport());
    return;
  }
  // --instance: one serve per id. A second serve of the same id is Claude Code restarting a dead one behind the
  // listener's back (docs/REVIEW-7.md R7-1): it refuses every tool call and exits. Any other failure throws (no tools).
  let restarted: (() => void) | undefined;
  if (opts.instance && claimServeInstance(cfg.home, opts.instance) === 'restarted') {
    console.error(`[stephen] serve instance ${opts.instance} already ran: Claude Code restarted serve, so every tool call is refused`);
    let exiting = false;
    restarted = () => {
      if (exiting) return;
      exiting = true;
      setTimeout(() => process.exit(RESTARTED_EXIT_CODE), 250); // let the refusal reach Claude Code first
    };
  }
  // --trust wake: a wake-word conversation (R7-2). Logged here; each refused email read is in the audit log.
  if (opts.trust) console.error('[stephen] trust: wake word (email: who and when only; gmail_read refused)');
  if (opts.confirm) cfg.safety.confirm = opts.confirm;
  if (opts.voice) parseTtsConfig(cfg.voice); // fail fast on a bad voice-output config
  // Profiles, state and saved page output are private to this user (mode 0700).
  try {
    await securePrivateDirs(cfg);
  } catch (e) {
    console.error(`[stephen] could not secure ${cfg.home}: ${errorMessage(e)}`);
  }
  const manager = createBrowserManager(cfg);
  // --session-state: the gate's memory follows the voice conversation (imported now if present, saved on change).
  const withState = opts.sessionState ? withSessionState(createSafety, opts.sessionState) : createSafety;
  // --assume-private-read: arm the taint before the first action (after the state binding, so it is saved too).
  // --command-file: the audit log stamps the listener's command id on each entry. The gate never sees the id.
  const commandFile = opts.commandFile;
  const withCmd: typeof createSafety = commandFile ? (c, d) => withState(c, { ...d, commandId: () => readCommandId(commandFile) }) : withState;
  const safetyFactory: typeof createSafety = opts.assumePrivateRead
    ? (c, d) => {
        const s = withCmd(c, d);
        s.gate.notePrivateData('private');
        return s;
      }
    : withCmd;
  const deps: ServerDepsWithVoice = {
    cfg,
    manager,
    engine: pageEngine,
    safetyFactory,
    ...(opts.voice ? { voice: {} } : {}),
    ...(opts.toolLog ? { toolLog: opts.toolLog } : {}),
    ...(commandFile ? { commandFile } : {}),
    ...(restarted ? { restarted } : {}),
    ...(opts.trust ? { trust: opts.trust } : {}),
  };
  await serveStdio(deps);
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

async function doctor(network = false, json = false): Promise<number> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  add({
    ok: process.platform === 'darwin',
    label: 'macOS',
    detail: process.platform,
    fix: 'Stephen drives Zen and Chrome on macOS. Other platforms only work with explicit config paths (tests).',
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

  const homeInfo = resolveStephenHome();
  if (homeInfo.legacy) {
    add({ ok: true, info: true, label: 'Home folder', detail: legacyHomeNotice(homeInfo.dir) });
  }
  for (const w of repoPersonalFiles(REPO_ROOT, cfg?.home ?? homeInfo.dir)) add({ ok: false, label: w.label, detail: w.detail, fix: w.fix });

  if (cfg) {
    const err = await writable(cfg.home);
    add({ ok: !err, label: 'Home dir writable', detail: err ? `${cfg.home}: ${err}` : cfg.home, fix: `Make ${cfg.home} writable, or set STEPHEN_HOME.`, blocking: true });

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
        fix: 'Open chrome://inspect/#remote-debugging in Chrome, turn on "Allow remote debugging for this browser instance", keep Chrome open, and click Allow when Chrome asks the first time Stephen connects.',
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
      detail: `${cfg.zen.mode} · launch: ${zenAttach ? 'never' : 'auto'}${zenAttach ? ` — ${ZEN_ATTACH_ONLY_LABEL}` : cfg.zen.mode === 'agent' ? ' — Stephen starts a separate agent Zen window' : ' — Stephen relaunches Zen on your profile when Zen is quit'}`,
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
        ? `Open Zen with the "${ZEN_LAUNCHER_APP_NAME}" app (${launcher}) or run \`stephen zen-launch\`.`
        : `Run \`stephen install-zen-launcher\` once, then open Zen with the "${ZEN_LAUNCHER_APP_NAME}" app (or run \`stephen zen-launch\`).`;
      if (readiness === 'ready' || readiness === 'starting') {
        const st = ready.value!.state!;
        add({ ok: true, label: 'Stephen-ready Zen running', detail: readiness === 'ready' ? `pid ${st.pid}, ${urlHost(st.wsUrl)}` : `pid ${st.pid}, still starting` });
      } else if (running) {
        add({
          ok: false,
          label: 'Stephen-ready Zen running',
          detail: 'no — Zen is open normally (without Stephen access)',
          fix: `Quit Zen (⌘Q) and reopen it for Stephen. ${openHint} Your tabs come back if Zen restores your previous session.`,
        });
      } else {
        add({ ok: true, info: true, label: 'Stephen-ready Zen running', detail: `no — Zen is not open. ${zenAttach ? openHint : 'Stephen starts it when needed (launch: auto).'}` });
      }
      add({ ok: true, info: true, label: 'Zen running normally (without Stephen access)', detail: running && readiness === 'none' ? 'yes' : 'no' });
      add({
        ok: launcherExists,
        label: `"${ZEN_LAUNCHER_APP_NAME}" launcher app`,
        detail: launcherExists ? launcher : `not found at ${launcher}`,
        fix: 'Run `stephen install-zen-launcher` (creates the app; then drag it to your Dock).',
      });
      if (!zenAttach) {
        add({
          ok: !running || readiness !== 'none',
          label: 'Zen is not running (real-profile mode, launch: auto)',
          detail: running ? 'Zen is running' : 'not running',
          fix: 'Quit Zen (⌘Q) before Stephen connects — it relaunches Zen with remote control on your profile.',
        });
      }
    } else {
      add({ ok: true, info: true, label: 'Zen agent profile', detail: `${cfg.zen.agentProfileDir}${existsSync(cfg.zen.agentProfileDir) ? '' : ' (created on first use; runs alongside your normal Zen)'}` });
    }

    const legacyLauncher = findLegacyZenLauncher();
    if (legacyLauncher) {
      add({
        ok: false,
        label: `Old "${LEGACY_ZEN_LAUNCHER_APP_NAME}" launcher app (from browser-hub)`,
        detail: legacyLauncher,
        fix: `Run \`stephen install-zen-launcher\` (creates "${ZEN_LAUNCHER_APP_NAME}"), put that in your Dock instead, then delete the old app: rm -rf ${shellQuote(legacyLauncher)}`,
      });
    }

    for (const c of await helperDoctorChecks(cfg.home)) add(c);

    const claudeVersion = await new Promise<string | null>((res) => {
      execFile(String(((cfg as Partial<HubConfig>).voice as { claudePath?: unknown } | undefined)?.claudePath ?? 'claude'), ['--version'], { timeout: 15_000 }, (e, stdout) => res(e ? null : String(stdout)));
    });
    add((await import('./voice/claude.js')).claudeVersionCheck(claudeVersion));

    add({ ok: true, info: true, label: 'Audit log', detail: cfg.auditLogPath });
    add({ ok: true, info: true, label: 'Saved output', detail: cfg.output.saveDir });
    for (const c of await voiceOutputChecks({ home: cfg.home, rawVoice: (cfg as Partial<HubConfig>).voice ?? {}, network })) add(c);

    add({ ok: true, info: true, label: 'Modes', detail: `chrome: ${cfg.chrome.mode} · zen: ${cfg.zen.mode} · default browser: ${cfg.defaultBrowser} · confirm: ${cfg.safety.confirm}` });
  }

  const failed = checks.filter((c) => !c.ok);
  const blocking = failed.filter((c) => c.blocking);
  if (json) {
    // For the Stephen window (src/app/control.ts doctor.run).
    console.log(JSON.stringify({ checks, problems: failed.length, blocking: blocking.length }));
    return blocking.length ? 1 : 0;
  }
  const out: string[] = [`stephen doctor (v${packageVersion()})`, ''];
  for (const c of checks) {
    const mark = c.info ? '•' : c.ok ? '✓' : '✗';
    out.push(`${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok && c.fix) out.push(`    fix: ${c.fix}`);
  }
  out.push(
    '',
    failed.length === 0
      ? 'All good. Next: `stephen selftest` tries each browser end to end (temporary profile, local test pages).'
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
  return runInstall(
    { run, cliPath: distCliPath() },
    { runClaude: defaultRunClaude, exists: existsSync, log: (l) => console.log(l), error: (l) => console.error(l) },
  );
}

// ───────────────────────────── zen-launch ─────────────────────────────

async function zenLaunch(argv: string[]): Promise<number> {
  const opts = parseZenLaunchArgs(argv);
  if ('error' in opts) {
    console.error(`${opts.error}\nUsage: stephen zen-launch [--quit-running] [--json]`);
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
  // Not ready: the message goes to stderr, which is what the "Zen for Stephen" app shows in its dialog.
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
      await serve(rest);
      return -1; // keep running
    case 'doctor':
      return doctor(rest.includes('--network'), rest.includes('--json'));
    case 'selftest':
      return selftest(rest);
    case 'install':
      return install(rest.includes('--run'));
    case 'zen-launch':
      return zenLaunch(rest);
    case 'install-zen-launcher':
      return installLauncher(rest);
    case 'install-helper': {
      const code = await runInstallHelper(rest);
      // Lets the helper start `stephen listen` itself (ROADMAP P2); owner-only code, loaded on demand.
      if (code === 0 && !rest.includes('--dry-run')) (await import('./app/control.js')).writeLaunchInfo(loadConfig().home, distCliPath());
      return code;
    }
    case 'listen':
      // Loaded on demand: `stephen serve` (the process Claude talks to) never loads memory, app or history code.
      return (await import('./voice/index.js')).runListen(rest);
    case 'eval':
      return (await import('./eval/cli.js')).runEvalCli(rest);
    case 'eval-clicks':
      return (await import('./eval/clicks.js')).runClickEvalCli(rest);
    case 'memory':
      return (await import('./memory/cli.js')).runMemoryCli(rest);
    case 'history':
      return (await import('./history/cli.js')).runHistoryCli(rest);
    case 'latency':
      return (await import('./telemetry/cli.js')).runLatencyCli(rest);
    case 'mac-checks':
      return (await import('./checks/mac-checks.js')).runMacChecksCli(rest);
    case 'jobs':
      // Owner-only, and the per-job supervisor (`jobs _run`): loaded on demand, never by `stephen serve`.
      return (await import('./jobs/cli.js')).runJobsCli(rest);
    case 'phone-bridge':
      // The phone session's MCP server (docs/ADR-005): reaches the listener only through phone.sock.
      return (await import('./phone/bridge.js')).runPhoneBridge();
    case 'phone':
      // Owner-only (writes the phone folder, starts claude for the lock-down check): loaded on demand.
      return (await import('./phone/cli.js')).runPhoneCli(rest);
    case 'app':
      return (await import('./app/cli.js')).runAppCli(rest);
    case 'accounts':
      // Owner-only (it writes config.json): loaded on demand, never by `stephen serve` (review 7, R7-8).
      return (await import('./connect/accounts-cli.js')).runAccountsCli(rest);
    case 'connect':
    case 'disconnect':
      // Owner-only sign-in (OAuth + Keychain write): loaded on demand, never by `stephen serve` (boundary test).
      return (await import('./connect/gmail-oauth.js')).runConnectCli(cmd, rest);
    case 'voice-setup':
      return isTtsSetupArgs(rest) ? runTtsSetup(rest, { home: loadConfig().home }) : (await import('./voice/index.js')).runVoiceSetup(rest);
    case 'voice-key':
      // Owner-only Keychain write: loaded on demand (review 7, R7-8).
      return (await import('./connect/voice-key.js')).runVoiceKey(rest, { ttsConfig: () => parseTtsConfig(loadConfig().voice) });
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
    console.error(`stephen: ${errorMessage(e)}`);
    process.exit(1);
  },
);

/**
 * Personal files that belong in Stephen's home folder, not the repo (docs/PLAN-WORK-SPLIT.md §12): a repo copy (a job's
 * worktree, a clone) must never carry secrets, and a repo config.json is not the one Stephen reads unless it is a link
 * to it. Pure apart from lstat / realpath.
 */
/**
 * host:port of a URL, never its path (REVIEW-9 R9-12: Zen's WebSocket URL carries a session id; doctor output reaches
 * the window and the log). "connected" when it doesn't parse.
 */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || 'connected';
  } catch {
    return 'connected';
  }
}

export function repoPersonalFiles(repo: string, home: string): { label: string; detail: string; fix: string }[] {
  const out: { label: string; detail: string; fix: string }[] = [];
  const envPath = join(repo, '.env');
  if (existsSync(envPath)) {
    out.push({
      label: 'Secrets outside the repo',
      detail: `${envPath} holds secrets inside the code folder`,
      fix: `Move each one to the Keychain with \`stephen accounts set <name>\` (or to ${join(home, '.env')}, chmod 600), then delete ${envPath}.`,
    });
  }
  const cfgPath = join(repo, 'config.json');
  if (existsSync(cfgPath)) {
    let same = false;
    try {
      same = realpathSync(cfgPath) === realpathSync(join(home, 'config.json'));
    } catch {
      /* the home one is missing */
    }
    if (!same) {
      out.push({
        label: 'Repo config.json',
        detail: `${cfgPath} is not Stephen's config (Stephen reads ${join(home, 'config.json')})`,
        fix: `Delete it, or replace it with a link: ln -sf ${join(home, 'config.json')} ${cfgPath}`,
      });
    }
  }
  return out;
}
