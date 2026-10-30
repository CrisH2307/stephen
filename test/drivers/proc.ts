/** Integration helpers: spawn a detached Chromium the way a user/agent browser would run, and clean up. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';
import { readDevToolsActivePort, type DevToolsActivePort } from '../../src/drivers/macos.js';
import { isPidAlive } from '../../src/drivers/util.js';

/** Spawn Chromium detached with its own user-data-dir and a debugging port (writes DevToolsActivePort). */
export async function spawnDetachedChromium(userDataDir: string, url = 'about:blank'): Promise<{ child: ChildProcess; port: DevToolsActivePort }> {
  const child = spawn(
    await chromiumPath(),
    [...chromiumArgs(), `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', url],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(join(userDataDir, 'DevToolsActivePort'))) {
      const port = await readDevToolsActivePort(userDataDir);
      if (port) return { child, port };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  killGroup(child.pid);
  throw new Error('Chromium did not write DevToolsActivePort');
}

/** SIGKILL a detached process group and wait until it is gone. */
export async function killGroup(pid: number | undefined): Promise<void> {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

export { isPidAlive };
