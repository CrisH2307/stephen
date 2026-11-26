/**
 * #109: cli.js runs `main` only as the program. Importing it (tests do) used to start `serve`, a real MCP server in
 * the test process, whose late `console.log = console.error` made the doctor test in test/compat.test.ts read nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-entry-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('cli.js entry (#109)', () => {
  it('importing cli.js starts nothing and leaves console.log alone', async () => {
    const log = console.log;
    const monitors = process.listenerCount('uncaughtExceptionMonitor');
    const keep = { HOME: process.env.HOME, STEPHEN_HOME: process.env.STEPHEN_HOME, STEPHEN_CONFIG: process.env.STEPHEN_CONFIG };
    // In case it does start: never against the real home.
    process.env.HOME = tmp;
    process.env.STEPHEN_HOME = join(tmp, '.stephen');
    process.env.STEPHEN_CONFIG = join(tmp, 'none.json');
    try {
      await import('../../src/cli.js');
      await new Promise((r) => setTimeout(r, 200)); // serve swapped console.log again after async imports
      expect(console.log).toBe(log);
      expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitors);
    } finally {
      for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('isEntry: the file itself and a link to it, nothing else', async () => {
    const { isEntry } = await import('../../src/cli.js');
    const self = resolve('src/cli.ts');
    const link = join(tmp, 'stephen');
    symlinkSync(self, link);
    expect(isEntry(self)).toBe(true);
    expect(isEntry(link)).toBe(true);
    expect(isEntry(resolve('node_modules/vitest/vitest.mjs'))).toBe(false);
    expect(isEntry(join(tmp, 'missing.js'))).toBe(false);
    expect(isEntry(undefined)).toBe(false);
  });

  const dist = resolve('dist/cli.js');
  it.skipIf(!existsSync(dist))('the built cli still runs as the program, directly and through a bin link', () => {
    const bin = join(tmp, 'stephen-bin');
    symlinkSync(dist, bin);
    for (const p of [dist, bin]) {
      const r = spawnSync(process.execPath, [p, 'help'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: tmp, STEPHEN_HOME: join(tmp, '.stephen') } });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage:');
    }
  });
});
