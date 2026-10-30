import type { BrowserDriver, IBrowserManager, ResolvedConfig } from '../types.js';
import { ChromeDriver } from './chrome.js';
import { BrowserManager, type BrowserManagerOptions } from './manager.js';
import { ZenDriver } from './zen.js';

export { BrowserManager } from './manager.js';
export { ChromeDriver } from './chrome.js';
export { ZenDriver } from './zen.js';

/** Builds the BrowserManager with a ChromeDriver and a ZenDriver for this config. */
export function createBrowserManager(
  cfg: ResolvedConfig,
  drivers?: Partial<Record<'chrome' | 'zen', BrowserDriver>>,
  opts?: BrowserManagerOptions,
): IBrowserManager {
  return new BrowserManager(
    cfg,
    {
      chrome: drivers?.chrome ?? new ChromeDriver(cfg),
      zen: drivers?.zen ?? new ZenDriver(cfg),
    },
    opts,
  );
}
