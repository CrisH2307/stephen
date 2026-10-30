/**
 * Shared test helper: a real headless Chromium (from @sparticuz/chromium) for integration tests.
 * Launch with protocol 'cdp' (what Chrome uses) or 'webDriverBiDi' (the exact puppeteer code path Zen uses).
 */
import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';

export type TestProtocol = 'cdp' | 'webDriverBiDi';
export const PROTOCOLS: TestProtocol[] = ['cdp', 'webDriverBiDi'];

let exePromise: Promise<string> | null = null;

/** Absolute path to the Chromium binary (extracted once per process). */
export function chromiumPath(): Promise<string> {
  exePromise ??= chromium.executablePath();
  return exePromise;
}

/** Flags needed to run this Chromium in the sandbox-less CI container. */
export function chromiumArgs(): string[] {
  return [...chromium.args];
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
