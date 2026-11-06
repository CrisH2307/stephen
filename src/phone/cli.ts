/**
 * `stephen phone setup | check` (docs/ADR-005, build step 1). Owner-only: loaded on demand by src/cli.ts.
 * `on | off | status` come with build step 5.
 */
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { REPO_ROOT } from '../lib/repo.js';
import { clean } from '../safety/text.js';
import { checkPhoneLockdown, phoneDir, writePhoneFolder, type LockdownResult } from './setup.js';

export const PHONE_HELP = `stephen phone: talk to Stephen from your phone (Claude app, through Remote Control)

  stephen phone setup   write the phone folder (its settings lock the session to Stephen's phone tools)
  stephen phone check   prove the lock: start Claude Code there and compare its tool list (no model call)`;

export interface PhoneCliEnv {
  home?: string;
  claudePath?: string;
  check?: typeof checkPhoneLockdown;
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
  if (!['setup', 'check'].includes(cmd) || rest.length) {
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
  const r = await (e.check ?? checkPhoneLockdown)(phoneDir(home), { claudePath: e.claudePath ?? 'claude' });
  for (const l of formatLockdown(r)) out(l);
  return r.locked && !r.error ? 0 : 1;
}
