import { describe, expect, it } from 'vitest';
import { PROTOCOLS, launchTestBrowser } from './chromium.js';

describe.each(PROTOCOLS)('test browser over %s', (protocol) => {
  it('launches, clicks and reads a title', async () => {
    const browser = await launchTestBrowser(protocol);
    try {
      const page = await browser.newPage();
      await page.setContent(`<button onclick="document.title='clicked'">Go</button>`);
      await page.click('button');
      expect(await page.title()).toBe('clicked');
    } finally {
      await browser.close();
    }
  });
});
