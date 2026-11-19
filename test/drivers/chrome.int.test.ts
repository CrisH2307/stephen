/**
 * ChromeDriver against a real Chromium (CDP).
 * a) agent mode: launch → open tab → disconnect (Chromium keeps running) → a fresh driver reattaches
 *    via DevToolsActivePort without spawning → after the process dies, a stale file triggers a relaunch.
 * b) real mode: a "user" Chromium started with remote debugging is attached via its DevToolsActivePort,
 *    its existing tab is listed, and disconnecting leaves it alive.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { afterAll, describe, expect, it } from 'vitest';
import { ChromeDriver } from '../../src/drivers/chrome.js';
import { createBrowserManager } from '../../src/drivers/index.js';
import type { SpawnFn } from '../../src/drivers/util.js';
import type { BrowserDriver } from '../../src/types.js';
import { chromiumArgs, chromiumPath } from '../helpers/chromium.js';
import { type TestConfig, makeTestConfig } from './helpers.js';
import { isPidAlive, killGroup, spawnDetachedChromium } from './proc.js';

const pids = new Set<number>();
const configs: TestConfig[] = [];

afterAll(async () => {
  for (const pid of pids) await killGroup(pid);
  for (const c of configs) c.cleanup();
});

function recordingSpawn(counter: { n: number }): SpawnFn {
  return (cmd, args, opts) => {
    counter.n += 1;
    const child = nodeSpawn(cmd, [...args], opts);
    if (child.pid) pids.add(child.pid);
    return child;
  };
}

/** A stand-in Zen driver so createBrowserManager doesn't build a real ZenDriver. */
const idleZen: BrowserDriver = {
  name: 'zen',
  protocol: 'webDriverBiDi',
  connect: () => Promise.reject(new Error('not used')),
  current: () => null,
  status: () => ({ name: 'zen', connected: false, mode: null, protocol: 'webDriverBiDi', version: null, detail: 'unused' }),
  disconnect: async () => undefined,
};

describe('ChromeDriver agent mode (real Chromium)', () => {
  it('launches, reattaches after disconnect without spawning, relaunches after a crash', async () => {
    const tc = makeTestConfig();
    configs.push(tc);
    tc.cfg.chrome.executablePath = await chromiumPath();
    tc.cfg.chrome.extraArgs = chromiumArgs(); // includes --headless='shell' and --single-process, passed verbatim
    tc.cfg.chrome.mode = 'agent';

    // 1) First server: launch.
    const spawns1 = { n: 0 };
    const d1 = new ChromeDriver(tc.cfg, { spawn: recordingSpawn(spawns1) });
    const m1 = createBrowserManager(tc.cfg, { chrome: d1, zen: idleZen });
    await m1.connect('chrome');
    expect(spawns1.n).toBe(1);
    expect(d1.status()).toMatchObject({ connected: true, mode: 'agent', protocol: 'cdp' });
    // The version is read after connect, without waiting: poll for it (a fixed 50 ms was too short on macOS CI).
    for (let i = 0; i < 200 && !d1.status().version; i++) await new Promise((r) => setTimeout(r, 25));
    expect(d1.status().version).toMatch(/Chrom/i);

    const { id, page } = await m1.openTab('chrome');
    expect(id).toMatch(/^c\d+$/);
    await page.goto('data:text/html,<title>Agent Tab</title><p>hi</p>');
    const tabs = await m1.listTabs('chrome');
    expect(tabs.find((t) => t.id === id)).toMatchObject({ title: 'Agent Tab', current: true });

    await m1.shutdown();
    expect(d1.current()).toBeNull();
    const [pid] = [...pids];
    expect(pid && isPidAlive(pid)).toBe(true);

    // 2) "Restarted" server: reattach via DevToolsActivePort, no spawn.
    const spawns2 = { n: 0 };
    const d2 = new ChromeDriver(tc.cfg, { spawn: recordingSpawn(spawns2) });
    const m2 = createBrowserManager(tc.cfg, { chrome: d2, zen: idleZen });
    await m2.connect('chrome');
    expect(spawns2.n).toBe(0);
    expect(d2.status().detail).toMatch(/Reattached/);
    const titles = (await m2.listTabs('chrome')).map((t) => t.title);
    expect(titles).toContain('Agent Tab');
    await m2.shutdown();

    // 3) Agent Chrome dies; its DevToolsActivePort is now stale → relaunch.
    await killGroup(pid);
    const spawns3 = { n: 0 };
    const d3 = new ChromeDriver(tc.cfg, { spawn: recordingSpawn(spawns3) });
    await d3.connect('agent');
    expect(spawns3.n).toBe(1);
    expect(d3.status().detail).toMatch(/Launched/);
    await d3.disconnect();
  });
});

describe('ChromeDriver real mode (simulated user Chrome)', () => {
  it('attaches via DevToolsActivePort, lists the existing tab, leaves the browser running', async () => {
    const tc = makeTestConfig();
    configs.push(tc);
    mkdirSync(tc.cfg.chrome.userDataDir, { recursive: true });
    const { child, port } = await spawnDetachedChromium(tc.cfg.chrome.userDataDir, 'data:text/html,<title>User Tab</title>hello');
    if (child.pid) pids.add(child.pid);
    tc.cfg.chrome.mode = 'real';

    const driver = new ChromeDriver(tc.cfg, {
      spawn: () => {
        throw new Error('real mode must never spawn');
      },
    });
    const m = createBrowserManager(tc.cfg, { chrome: driver, zen: idleZen });
    const tabs = await m.listTabs('chrome', true);
    expect(tabs).toEqual([expect.objectContaining({ id: 'c1', browser: 'chrome', title: 'User Tab' })]);
    expect(driver.status()).toMatchObject({ connected: true, mode: 'real' });
    expect(driver.status().detail).toContain(`port ${port.port}`);

    await m.shutdown();
    expect(isPidAlive(child.pid!)).toBe(true);
    // Still accepting connections and the user's tab survived.
    const again = await puppeteer.connect({ browserWSEndpoint: port.wsEndpoint, defaultViewport: null });
    const urls = (await again.pages()).map((p) => p.url());
    expect(urls.some((u) => u.startsWith('data:text/html'))).toBe(true);
    await again.disconnect();
  });

  it('gives actionable NEEDS_USER when Chrome is gone but DevToolsActivePort is stale', async () => {
    const tc = makeTestConfig();
    configs.push(tc);
    mkdirSync(tc.cfg.chrome.userDataDir, { recursive: true });
    const { child } = await spawnDetachedChromium(join(tc.cfg.chrome.userDataDir));
    await killGroup(child.pid);
    const driver = new ChromeDriver(tc.cfg);
    await expect(driver.connect('real')).rejects.toMatchObject({
      code: 'NEEDS_USER',
      message: expect.stringContaining('chrome://inspect/#remote-debugging'),
    });
  });
});
