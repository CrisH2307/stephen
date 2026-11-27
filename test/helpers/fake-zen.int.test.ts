/**
 * The fake zen (test/helpers/fake-zen.ts) runs its Chrome headless even when a caller forgets the flag. A visible
 * test window on a Mac took a real click and failed the selftest checkbox check once (#410, same cause as #456).
 * On a Mac the first case fails without the guard: Chrome reports a normal "Chrome/..." user agent. On Linux the
 * caller's CI flags are kept (minus their headless flag here), so the case checks the guard there too.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumArgs, chromiumPath } from './chromium.js';
import { writeFakeZen } from './fake-zen.js';

let home: string;
let fakeZen: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bh-fake-zen-'));
  fakeZen = await writeFakeZen(home, await chromiumPath());
}, 60_000);

afterAll(() => {
  if (!home) return;
  try {
    execFileSync('pkill', ['-KILL', '-f', home], { stdio: 'ignore' });
  } catch {
    /* none left */
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Starts the fake zen on a fresh profile and resolves with its BiDi url. */
function start(profile: string, extras: string[]): Promise<{ proc: ChildProcess; url: string }> {
  mkdirSync(profile);
  const proc = spawn(fakeZen, ['--profile', profile, ...extras], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((done, fail) => {
    let err = '';
    proc.stderr!.on('data', (c: Buffer) => {
      err += c.toString();
      const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(err);
      if (m) done({ proc, url: m[1] });
    });
    proc.on('exit', (code) => fail(new Error(`fake zen exited ${code}: ${err}`)));
  });
}

async function userAgent(url: string): Promise<string> {
  const browser = await puppeteer.connect({ browserWSEndpoint: url + '/session', protocol: 'webDriverBiDi' });
  try {
    const page = await browser.newPage();
    return await page.evaluate(() => navigator.userAgent);
  } finally {
    await browser.disconnect();
  }
}

/** The --headless flags on the main Chrome process for `profile` (child processes carry --type=). */
function headlessFlags(profile: string): string[] {
  const line = execFileSync('ps', ['-eo', 'args='])
    .toString()
    .split('\n')
    .find((l) => l.includes(`--user-data-dir=${profile}`) && !l.includes('--type='));
  return (line ?? '').split(/\s+/).filter((a) => a.startsWith('--headless'));
}

describe('fake zen: Chrome always headless', () => {
  it('a caller with no headless flag still gets a headless Chrome', async () => {
    const extras = chromiumArgs().filter((a) => !a.startsWith('--headless'));
    const profile = join(home, 'no-flag');
    const { proc, url } = await start(profile, extras);
    try {
      expect(await userAgent(url)).toContain('HeadlessChrome');
      expect(headlessFlags(profile)).toEqual(['--headless']);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 60_000);

  it("a caller's own headless flag is kept, not doubled", async () => {
    const profile = join(home, 'own-flag');
    const { proc, url } = await start(profile, chromiumArgs());
    try {
      expect(await userAgent(url)).toContain('HeadlessChrome');
      expect(headlessFlags(profile)).toHaveLength(1);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 60_000);
});
