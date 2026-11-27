import { describe, expect, it } from 'vitest';
import { chromiumArgs } from './chromium.js';

describe('test browser flags', () => {
  it('are headless on every machine, so no visible test window can take a real click', () => {
    expect(chromiumArgs().some((a) => a.startsWith('--headless'))).toBe(true);
  });
});
