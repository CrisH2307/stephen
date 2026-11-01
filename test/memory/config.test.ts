/** The `memory` config section: src/memory/config.ts, and loadConfig carrying it raw like `voice`. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MemoryConfigError, parseMemoryConfig } from '../../src/memory/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-memory-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('parseMemoryConfig', () => {
  it('defaults: enabled, wake-word remember confirmed, 30 items', () => {
    for (const raw of [undefined, null, {}, { enabled: null, maxItems: null }]) {
      expect(parseMemoryConfig(raw)).toEqual({ enabled: true, confirmWakeWord: true, maxItems: 30 });
    }
  });

  it('accepts valid values', () => {
    expect(parseMemoryConfig({ enabled: false, confirmWakeWord: false, maxItems: 5 })).toEqual({ enabled: false, confirmWakeWord: false, maxItems: 5 });
    expect(parseMemoryConfig({ maxItems: 1 }).maxItems).toBe(1);
  });

  it('rejects bad values and unknown keys with a clear message', () => {
    expect(() => parseMemoryConfig({ maxItems: 31 })).toThrow(MemoryConfigError);
    expect(() => parseMemoryConfig({ maxItems: 31 })).toThrow(/"memory\.maxItems"/);
    expect(() => parseMemoryConfig({ maxItems: 0 })).toThrow(/maxItems/);
    expect(() => parseMemoryConfig({ maxItems: 2.5 })).toThrow(/maxItems/);
    expect(() => parseMemoryConfig({ enabled: 'yes' })).toThrow(/"memory\.enabled"/);
    expect(() => parseMemoryConfig({ remember: true })).toThrow(/unknown key "memory\.remember"/);
    expect(() => parseMemoryConfig([])).toThrow(/must be an object/);
    expect(() => parseMemoryConfig('on')).toThrow(/must be an object/);
  });
});

describe('loadConfig memory section', () => {
  it('is {} when absent and passes the raw section through (file, then overrides)', () => {
    const home = join(tmp, 'h1');
    expect(loadConfig({}, { HOME: tmp, STEPHEN_HOME: home }).memory).toEqual({});
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { maxItems: 10, enabled: false } }));
    const cfg = loadConfig({ memory: { enabled: true } } as never, { HOME: tmp, STEPHEN_HOME: home });
    expect(cfg.memory).toEqual({ maxItems: 10, enabled: true });
    expect(parseMemoryConfig(cfg.memory)).toEqual({ enabled: true, confirmWakeWord: true, maxItems: 10 });
  });
});
