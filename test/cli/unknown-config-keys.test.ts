import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { configUnknownKeys } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { parseVoiceConfig } from '../../src/voice/config.js';

let env: NodeJS.ProcessEnv;

/** Write config.json for this test and return the env that points loadConfig and doctor at it. */
function useConfig(raw: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'bh-unknown-'));
  mkdirSync(join(home, '.stephen'), { recursive: true });
  writeFileSync(join(home, '.stephen', 'config.json'), JSON.stringify(raw));
  env = { HOME: home };
}

beforeEach(() => {
  env = {};
});

describe('unknown config keys are a doctor warning, not a start failure', () => {
  it('a config with an unknown top-level key and an unknown voice key loads, and doctor names both', async () => {
    useConfig({ fooBar: 1, voice: { wakePhrases: ['hey stephen'], voiceFoo: true } });
    expect(() => loadConfig(undefined, env)).not.toThrow();
    expect((await configUnknownKeys(env)).sort()).toEqual(['fooBar', 'voice.voiceFoo']);
  });

  it('doctor names keys only, never their values', async () => {
    useConfig({ voice: { notAKey: 'sk-secret-value-123' } });
    const keys = await configUnknownKeys(env);
    expect(keys).toEqual(['voice.notAKey']);
    expect(JSON.stringify(keys)).not.toContain('sk-secret-value-123');
  });

  it('a known key with a wrong type still refuses to load', () => {
    useConfig({ fooBar: 1, safety: { confirm: 'sometimes' } });
    expect(() => loadConfig(undefined, env)).toThrow(/"safety\.confirm"/);
    expect(() => parseVoiceConfig({ fooBar: 1, claudePath: 5 })).toThrow(/"voice\.claudePath"/);
  });

  it('safety keys keep their checks; an unknown safety key is only listed', async () => {
    useConfig({ safety: { allowEval: true } });
    expect(() => loadConfig(undefined, env)).not.toThrow();
    expect(await configUnknownKeys(env)).toEqual(['safety.allowEval']);

    useConfig({ safety: { maxActionsPerMinute: 0 } });
    expect(() => loadConfig(undefined, env)).toThrow(/"safety\.maxActionsPerMinute"/);
  });

  it('a file that is not valid JSON gives no unknown-key list (the load check reports it)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bh-unknown-'));
    mkdirSync(join(home, '.stephen'), { recursive: true });
    writeFileSync(join(home, '.stephen', 'config.json'), '{ not json');
    expect(await configUnknownKeys({ HOME: home })).toEqual([]);
  });
});
