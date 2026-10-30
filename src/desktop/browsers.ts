/** Where Zen and Chrome are installed, for `open -a <app> <url>` (phase 1 opens URLs in these two only). */
import { join } from 'node:path';
import { ZEN_EXECUTABLE_CANDIDATES } from '../config.js';
import { appBundleOf } from '../drivers/macos.js';
import type { BrowserName, ResolvedConfig } from '../types.js';
import type { DesktopDeps } from './system.js';

export const BROWSER_LABEL: Record<BrowserName, string> = { zen: 'Zen', chrome: 'Google Chrome' };

/** Candidate .app paths for a browser, most specific first (the configured executable's bundle, then the usual places). */
export function browserAppCandidates(cfg: Pick<ResolvedConfig, 'chrome' | 'zen'>, browser: BrowserName, homeDir: string): string[] {
  const userApps = join(homeDir, 'Applications');
  const list =
    browser === 'chrome'
      ? [appBundleOf(cfg.chrome.executablePath), '/Applications/Google Chrome.app', join(userApps, 'Google Chrome.app')]
      : [
          appBundleOf(cfg.zen.executablePath),
          ...ZEN_EXECUTABLE_CANDIDATES.map((p) => appBundleOf(p)),
          join(userApps, 'Zen.app'),
          join(userApps, 'Zen Browser.app'),
        ];
  return [...new Set(list.filter((p): p is string => !!p))];
}

/** First candidate that exists, or null. */
export async function findBrowserApp(deps: DesktopDeps, cfg: Pick<ResolvedConfig, 'chrome' | 'zen'>, browser: BrowserName): Promise<string | null> {
  for (const p of browserAppCandidates(cfg, browser, deps.homeDir)) {
    if (await deps.fs.isDir(p)) return p;
  }
  return null;
}
