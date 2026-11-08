/**
 * `stephen phone on | off | status | setup | check` (docs/ADR-005). Owner-only: loaded on demand by src/cli.ts.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { writePrivateJsonFileSync } from '../lib/fs.js';
import { socketAnswers } from '../lib/private-socket.js';
import { commandOf as defaultCommandOf } from '../lib/process.js';
import { REPO_ROOT } from '../lib/repo.js';
import { clean } from '../safety/text.js';
import {
  checkPhoneLockdown,
  isRemoteControl,
  phoneAuth,
  phoneClaudeEnv,
  phoneConfigDir,
  phoneDir,
  phoneOnPath,
  phoneSocketPath,
  readPhoneMarker as readMarker,
  removePhoneMarker as removeMarker,
  stopPhoneLink,
  writePhoneFolder,
  type LockdownResult,
  type PhoneAuth,
} from './setup.js';

export const PHONE_HELP = `stephen phone: talk to Stephen from your phone (Claude app, through Remote Control)

  stephen phone login   sign in the phone's own Claude Code config, once (it opens your browser)
  stephen phone on      check the lock, then run Remote Control here until Ctrl-C (open it in the Claude app)
  stephen phone off     turn it off from another terminal (phone requests are refused at once)
  stephen phone status  on or off, Remote Control running, stephen listen answering, sign-in
  stephen phone setup   write the phone folder (its settings lock the session to Stephen's phone tools)
  stephen phone check   prove the lock: start Claude Code there and compare its tool list (no model call)

Needs \`stephen listen\` running. The phone session has its own Claude Code config (so /config typed on the phone
can't change yours): sign it in once with \`stephen phone login\`. The first \`on\` asks you to trust the phone
folder (type y).`;

export interface PhoneCliEnv {
  home?: string;
  claudePath?: string;
  check?: typeof checkPhoneLockdown;
  /** Runs `claude remote-control …` (tests: a fake). */
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** The command line of a pid ('' when gone); off uses it to stop only a Remote Control process. */
  commandOf?: (pid: number) => string;
  /** Does `stephen listen` answer on phone.sock? */
  listening?: (socketPath: string) => Promise<boolean>;
  kill?: (pid: number) => void;
  /** `claude auth status` for the phone config: signed in, and until when (tests: a fake). */
  auth?: () => PhoneAuth | Promise<PhoneAuth>;
  out?: (l: string) => void;
  err?: (l: string) => void;
}

/** The argv that starts the bridge MCP: this node, this install's cli.js. */
export const bridgeArgv = () => ({ command: process.execPath, args: [join(REPO_ROOT, 'dist', 'cli.js'), 'phone-bridge'] });

export function formatLockdown(r: LockdownResult): string[] {
  if (r.error) return [`✗ Not proven locked: ${clean(r.error, 200)}. The phone channel stays off.`];
  if (!r.locked) return [`✗ NOT locked: the phone session could also use ${r.extra.length} other tool(s): ${clean(r.extra.slice(0, 8).join(', '), 300)}${r.extra.length > 8 ? ', …' : ''}. The phone channel stays off.`];
  const lines = ['✓ Locked: the phone session can use only Stephen phone tools.'];
  lines.push(r.complete ? '✓ All phone tools present.' : `• Missing (the bridge isn't running yet): ${r.missing.join(', ')}`);
  return lines;
}

export async function runPhoneCli(argv: string[], e: PhoneCliEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(PHONE_HELP);
    return 0;
  }
  if (!['setup', 'check', 'on', 'off', 'status', 'login'].includes(cmd) || rest.length) {
    err(`Unknown phone command "${clean([cmd, ...rest].join(' '), 60)}".\n\n${PHONE_HELP}`);
    return 2;
  }
  const home = e.home ?? loadConfig().home;
  if (cmd === 'setup') {
    const dir = await writePhoneFolder(home, bridgeArgv());
    out(`Wrote the phone folder: ${dir}`);
    out('Next: `stephen phone check`.');
    return 0;
  }
  const env = phoneClaudeEnv(home);
  const claude = e.claudePath ?? 'claude';
  const spawnFn = e.spawn ?? nodeSpawn;
  const auth = async (): Promise<PhoneAuth> => (e.auth ? e.auth() : phoneAuth(home, claude));
  if (cmd === 'login') {
    await writePhoneFolder(home, bridgeArgv());
    out(`Signing in the phone's Claude Code config (${phoneConfigDir(home)}). Use the same Claude account.`);
    const child = spawnFn(claude, ['auth', 'login'], { env, stdio: 'inherit' });
    return new Promise<number>((resolve) => {
      child.on('error', (x) => (err(`Couldn't start claude: ${x.message}`), resolve(1)));
      child.on('exit', (c) => resolve(c ?? 0));
    });
  }
  const commandOf = e.commandOf ?? defaultCommandOf;
  const listening = (e.listening ?? ((p: string) => socketAnswers(p)))(phoneSocketPath(home));
  if (cmd === 'status') {
    const m = readMarker(home);
    const rcAlive = m !== null && m.rc > 0 && isRemoteControl(commandOf(m.rc));
    out(m ? `Phone link: on${rcAlive ? ` (Remote Control pid ${m.rc})` : ', but Remote Control is not running (run `stephen phone off`, then `on`)'}.` : 'Phone link: off.');
    out((await listening) ? '✓ stephen listen answers phone requests.' : '• stephen listen is not running: phone requests fail until you start it.');
    const a = await auth();
    out(a.loggedIn ? `✓ Phone sign-in OK${a.expiresAt ? ` until ${a.expiresAt.slice(0, 10)}` : ''}.` : '• The phone config is not signed in: run `stephen phone login`.');
    return 0;
  }
  if (cmd === 'off') {
    const m = stopPhoneLink(home, { commandOf, ...(e.kill ? { kill: e.kill } : {}) });
    out(m ? 'Phone link off: phone requests are refused, Remote Control stopped.' : 'Phone link was already off.');
    return 0;
  }
  if (cmd === 'on') await writePhoneFolder(home, bridgeArgv());
  const r = await (e.check ?? checkPhoneLockdown)(phoneDir(home), { claudePath: claude, env });
  for (const l of formatLockdown(r)) out(l);
  if (cmd === 'check') return r.locked && !r.error ? 0 : 1;
  if (!r.locked || !r.complete || r.error) {
    err('The phone link stays off.');
    return 1;
  }
  if (!(await auth()).loggedIn) {
    err('The phone config is not signed in. Run `stephen phone login` once, then `stephen phone on`.');
    return 1;
  }
  const m = readMarker(home);
  if (m && m.rc > 0 && isRemoteControl(commandOf(m.rc))) {
    err(`The phone link is already on (Remote Control pid ${m.rc}). \`stephen phone off\` first.`);
    return 1;
  }
  if (!(await listening)) out('• stephen listen is not running: start it, or phone requests will fail.');
  // One session (`--spawn session`): Remote Control exits when it ends; the folder's settings lock its tools.
  const child = spawnFn(claude, ['remote-control', '--spawn', 'session', '--no-chrome', '--permission-mode', 'default', '--name', 'Stephen'], {
    cwd: phoneDir(home),
    env,
    stdio: 'inherit',
  });
  writePrivateJsonFileSync(phoneOnPath(home), { pid: process.pid, rc: child.pid ?? 0 });
  out('Phone link on. Open "Stephen" in the Claude app (Code). Ctrl-C here, or `stephen phone off`, ends it.');
  const code = await new Promise<number>((resolve) => {
    child.on('error', (x) => {
      err(`Couldn't start Remote Control: ${x.message}`);
      resolve(1);
    });
    child.on('exit', (c) => resolve(c ?? 0));
  });
  const now = readMarker(home);
  if (now && now.pid === process.pid) removeMarker(home);
  out('Phone link off.');
  return code;
}
