/**
 * `stephen phone on | off | status | setup | check` (docs/ADR-005). Owner-only: loaded on demand by src/cli.ts.
 */
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { writePrivateJsonFileSync } from '../lib/fs.js';
import { socketAnswers } from '../lib/private-socket.js';
import { isPidAlive } from '../lib/process.js';
import { REPO_ROOT } from '../lib/repo.js';
import { clean } from '../safety/text.js';
import { checkPhoneLockdown, phoneDir, phoneOnPath, phoneSocketPath, writePhoneFolder, type LockdownResult } from './setup.js';

export const PHONE_HELP = `stephen phone: talk to Stephen from your phone (Claude app, through Remote Control)

  stephen phone on      check the lock, then run Remote Control here until Ctrl-C (open it in the Claude app)
  stephen phone off     turn it off from another terminal (phone requests are refused at once)
  stephen phone status  on or off, Remote Control running, stephen listen answering
  stephen phone setup   write the phone folder (its settings lock the session to Stephen's phone tools)
  stephen phone check   prove the lock: start Claude Code there and compare its tool list (no model call)

Needs \`stephen listen\` running. The first \`on\` asks you to trust the phone folder (type y).`;

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
  if (!['setup', 'check', 'on', 'off', 'status'].includes(cmd) || rest.length) {
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
  const commandOf = e.commandOf ?? defaultCommandOf;
  const listening = (e.listening ?? ((p: string) => socketAnswers(p)))(phoneSocketPath(home));
  if (cmd === 'status') {
    const m = readMarker(home);
    const rcAlive = m !== null && m.rc > 0 && isRemoteControl(commandOf(m.rc));
    out(m ? `Phone link: on${rcAlive ? ` (Remote Control pid ${m.rc})` : ', but Remote Control is not running (run `stephen phone off`, then `on`)'}.` : 'Phone link: off.');
    out((await listening) ? '✓ stephen listen answers phone requests.' : '• stephen listen is not running: phone requests fail until you start it.');
    return 0;
  }
  if (cmd === 'off') {
    const m = readMarker(home);
    removeMarker(home);
    if (m && m.rc > 0 && isRemoteControl(commandOf(m.rc))) (e.kill ?? ((pid) => process.kill(pid, 'SIGTERM')))(m.rc);
    out(m ? 'Phone link off: phone requests are refused, Remote Control stopped.' : 'Phone link was already off.');
    return 0;
  }
  if (cmd === 'on') await writePhoneFolder(home, bridgeArgv());
  const r = await (e.check ?? checkPhoneLockdown)(phoneDir(home), { claudePath: e.claudePath ?? 'claude' });
  for (const l of formatLockdown(r)) out(l);
  if (cmd === 'check') return r.locked && !r.error ? 0 : 1;
  if (!r.locked || !r.complete || r.error) {
    err('The phone link stays off.');
    return 1;
  }
  const m = readMarker(home);
  if (m && m.rc > 0 && isRemoteControl(commandOf(m.rc))) {
    err(`The phone link is already on (Remote Control pid ${m.rc}). \`stephen phone off\` first.`);
    return 1;
  }
  if (!(await listening)) out('• stephen listen is not running: start it, or phone requests will fail.');
  // One session (`--spawn session`): Remote Control exits when it ends; the folder's settings lock its tools.
  const child = (e.spawn ?? nodeSpawn)(e.claudePath ?? 'claude', ['remote-control', '--spawn', 'session', '--no-chrome', '--permission-mode', 'default', '--name', 'Stephen'], {
    cwd: phoneDir(home),
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

/** The on marker: who runs it ({pid: stephen phone on, rc: claude remote-control}); null when off or unreadable. */
function readMarker(home: string): { pid: number; rc: number } | null {
  try {
    const j = JSON.parse(readFileSync(phoneOnPath(home), 'utf8')) as { pid?: unknown; rc?: unknown };
    return { pid: Number.isInteger(j.pid) ? (j.pid as number) : 0, rc: Number.isInteger(j.rc) ? (j.rc as number) : 0 };
  } catch {
    return null;
  }
}

function removeMarker(home: string): void {
  try {
    unlinkSync(phoneOnPath(home));
  } catch {
    /* already off */
  }
}

const isRemoteControl = (command: string): boolean => /\bclaude\b.*\bremote-control\b/.test(command);

function defaultCommandOf(pid: number): string {
  if (!isPidAlive(pid)) return '';
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
