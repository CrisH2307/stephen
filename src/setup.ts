/**
 * `stephen setup`: the setup steps for a new friend, in order. Stops at the first red line and says in one plain
 * sentence what to do. Safe to run twice: a step that is already done is skipped. It never asks for or stores a
 * password or key (it only runs `claude auth status`, which prints no secret, and the Stephen commands).
 *
 * Every program runs through `deps` so the tests never start a real install.
 */

import { HELPER_UNCHANGED } from './helper/install.js';
import { firstLine } from './lib/process.js';

export interface RunResult {
  /** Exit code; null when the program could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program does not exist (ENOENT). */
  notFound?: boolean;
}

export interface SetupDeps {
  /** Is this Node version supported? (cli.ts passes `nodeSupported(process.versions.node)`). */
  nodeOk: boolean;
  nodeVersion: string;
  /** Run `claude <args>`. */
  runClaude: (args: string[]) => Promise<RunResult>;
  /** Run `stephen <args>` (node dist/cli.js <args>) and capture its output. */
  runStephen: (args: string[]) => Promise<RunResult>;
  exists: (path: string) => boolean;
  /** Where `install-zen-launcher` puts the app. */
  launcherPath: string;
  /** The built CLI that `install --run` registers. */
  cliPath: string;
  log: (line: string) => void;
}

interface Doctor {
  checks: { ok: boolean; info?: boolean; blocking?: boolean; label: string; detail?: string; fix?: string }[];
  blocking: number;
}

const AGAIN = 'then run `stephen setup` again.';

/** The three Mac permissions, with the exact place in System Settings. Shown at the end of a good setup. */
export const PERMISSION_LINES = [
  'Three Mac permissions (macOS asks once; if it did not, turn them on here):',
  '  1. Microphone: System Settings > Privacy & Security > Microphone > turn on "Stephen Helper".',
  '  2. Input Monitoring: System Settings > Privacy & Security > Input Monitoring > turn on "Stephen Helper".',
  '  3. Accessibility: System Settings > Privacy & Security > Accessibility > turn on "Stephen Helper".',
  'If "Stephen Helper" is not in a list, click + and choose it from your Applications folder (Home > Applications).',
];

export const FIRST_COMMAND = 'Hold F5 and say: what time is it';

/**
 * F9: where a first run stands, as code words only, for the helper's onboarding sheet (`stephen setup --status`). The
 * sheet shows its own fixed text for each word, never output from Claude Code or the network (#382, #390).
 */
export interface SetupStatus {
  claude: 'missing' | 'signed_out' | 'ok';
  models: 'missing' | 'ok';
}

export async function setupStatus(deps: Pick<SetupDeps, 'runClaude'> & { modelsReady: () => Promise<boolean> }): Promise<SetupStatus> {
  const models = (await deps.modelsReady().catch(() => false)) ? 'ok' : 'missing';
  const ver = await deps.runClaude(['--version']);
  if (ver.notFound || ver.code !== 0) return { claude: 'missing', models };
  const auth = await deps.runClaude(['auth', 'status']);
  if (auth.code !== 0 || /"loggedIn":\s*false/.test(auth.stdout)) return { claude: 'signed_out', models };
  return { claude: 'ok', models };
}

/** Run the steps. Returns the exit code: 0 when everything is ready, 1 at the first red line. */
export async function runSetup(deps: SetupDeps): Promise<number> {
  const { log } = deps;
  const total = 6;
  let n = 0;
  const head = (title: string) => log(`[${++n}/${total}] ${title}`);
  const stop = (fix: string, detail?: string): number => {
    if (detail) log(`    ${detail}`);
    log(`\nStopped. ${fix}`);
    return 1;
  };
  const skip = () => log('    already done, skipped');
  const ok = (msg: string) => log(`    ok: ${msg}`);

  head('Check Node');
  if (!deps.nodeOk) return stop(`Install Node 22 or 24 from https://nodejs.org, ${AGAIN}`, `Node ${deps.nodeVersion} is not supported.`);
  ok(`Node ${deps.nodeVersion}`);

  head('Check Claude Code');
  const ver = await deps.runClaude(['--version']);
  if (ver.notFound || ver.code !== 0) return stop(`Install Claude Code from https://claude.com/claude-code, ${AGAIN}`, 'Claude Code was not found.');
  const auth = await deps.runClaude(['auth', 'status']);
  if (auth.code !== 0 || /"loggedIn":\s*false/.test(auth.stdout)) {
    return stop(`Open Claude Code once with \`claude\` and sign in, ${AGAIN}`, 'Claude Code is not signed in.');
  }
  ok(`Claude Code ${firstLine(ver.stdout)}, signed in`);

  head('Register Stephen with Claude Code');
  const reg = await deps.runClaude(['mcp', 'get', 'stephen']);
  if (reg.code === 0 && reg.stdout.includes(deps.cliPath)) skip();
  else {
    const r = await deps.runStephen(['install', '--run']);
    if (r.code !== 0) return stop(`Run \`stephen install --run\` and read the error, ${AGAIN}`, firstLine(r.stderr || r.stdout));
    ok('registered');
  }

  head('Create the "Zen for Stephen" app');
  if (deps.exists(deps.launcherPath)) skip();
  else {
    const r = await deps.runStephen(['install-zen-launcher']);
    if (r.code !== 0) return stop(`Run \`stephen install-zen-launcher\` and read the error, ${AGAIN}`, firstLine(r.stderr || r.stdout));
    ok('created. Drag it to your Dock.');
  }

  head('Build the Stephen Helper app');
  const h = await deps.runStephen(['install-helper']);
  if (h.code !== 0) {
    return stop(`Install Apple's command line tools with \`xcode-select --install\`, ${AGAIN}`, firstLine(h.stderr || h.stdout));
  }
  if (h.stdout.includes(HELPER_UNCHANGED)) skip();
  else ok('built');

  head('Check the setup (stephen doctor)');
  const d = await deps.runStephen(['doctor', '--json']);
  let doc: Doctor | null = null;
  try {
    doc = JSON.parse(d.stdout) as Doctor;
  } catch {
    // fall through: unreadable output counts as a red line
  }
  if (!doc) return stop(`Run \`stephen doctor\` and read the first red line, ${AGAIN}`, firstLine(d.stderr || d.stdout));
  const red = doc.checks.filter((c) => !c.ok && !c.info);
  const blocker = red.find((c) => c.blocking);
  if (blocker) return stop(blocker.fix ?? `Fix "${blocker.label}", ${AGAIN}`, `${blocker.label}${blocker.detail ? `: ${blocker.detail}` : ''}`);
  for (const c of red) log(`    note: ${c.label}${c.fix ? `. ${c.fix}` : ''}`);
  ok(red.length ? 'ready (the notes above are not blocking)' : 'all green');

  log('');
  for (const l of PERMISSION_LINES) log(l);
  log('\nDone. Stephen is set up.');
  log(FIRST_COMMAND);
  return 0;
}
