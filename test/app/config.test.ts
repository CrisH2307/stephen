/** The `app` section of config.json (src/app/config.ts) and its place in loadConfig. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppConfigError, parseAppConfig } from '../../src/app/config.js';
import { loadConfig } from '../../src/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-appcfg-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('parseAppConfig', () => {
  it('defaults: socket on, typed replies shown, not spoken', () => {
    expect(parseAppConfig(undefined)).toEqual({ enabled: true, speakReplies: false });
    expect(parseAppConfig({ enabled: null })).toEqual({ enabled: true, speakReplies: false });
    expect(parseAppConfig({ enabled: false, speakReplies: true })).toEqual({ enabled: false, speakReplies: true });
  });

  it('ignores unknown keys (listed for doctor) and refuses wrong types', () => {
    const unknown: string[] = [];
    expect(parseAppConfig({ token: 'x' }, unknown)).toEqual({ enabled: true, speakReplies: false });
    expect(unknown).toEqual(['app.token']);
    expect(() => parseAppConfig({ speakReplies: 'yes' })).toThrow(AppConfigError);
    expect(() => parseAppConfig({ speakReplies: 'yes' })).toThrow(/"app.speakReplies"/);
    expect(() => parseAppConfig([])).toThrow('"app" must be an object');
  });

  it('loadConfig keeps the raw "app" section for src/app to validate', () => {
    const file = join(tmp, 'config.json');
    writeFileSync(file, JSON.stringify({ app: { speakReplies: true } }));
    const cfg = loadConfig(undefined, { HOME: tmp, STEPHEN_HOME: join(tmp, 'h'), STEPHEN_CONFIG: file });
    expect(cfg.app).toEqual({ speakReplies: true });
  });
});
