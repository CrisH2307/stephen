/**
 * Shared test helper: a real headless Chromium (from @sparticuz/chromium) for integration tests.
 * Launch with protocol 'cdp' (what Chrome uses) or 'webDriverBiDi' (the exact puppeteer code path Zen uses).
 */
import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';

export type TestProtocol = 'cdp' | 'webDriverBiDi';
export const PROTOCOLS: TestProtocol[] = ['cdp', 'webDriverBiDi'];

let exePromise: Promise<string> | null = null;

/**
 * @sparticuz/chromium ships a Linux-only binary. On macOS use the installed Google Chrome instead (override with
 * STEPHEN_TEST_CHROME); puppeteer and the drivers give it a throwaway --user-data-dir, never the owner's profile.
 */
const MAC_CHROME = process.env.STEPHEN_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Absolute path to the Chromium binary (extracted once per process). */
export function chromiumPath(): Promise<string> {
  exePromise ??= process.platform === 'darwin' ? Promise.resolve(MAC_CHROME) : chromium.executablePath();
  return exePromise;
}

/**
 * Flags needed to run this Chromium in the sandbox-less CI container. The Mac's own Chrome needs none locally, but on
 * the macOS CI runner a visible window loses clicks under load (#195), so CI runs it headless.
 */
export function chromiumArgs(): string[] {
  if (process.platform !== 'darwin') return [...chromium.args];
  return process.env.CI ? ['--headless'] : [];
}

export async function launchTestBrowser(protocol: TestProtocol): Promise<Browser> {
  return puppeteer.launch({
    executablePath: await chromiumPath(),
    args: chromiumArgs(),
    headless: true,
    protocol,
    defaultViewport: { width: 1280, height: 900 },
  });
}
