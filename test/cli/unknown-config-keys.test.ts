import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configUnknownKeys, ignoredKeysNotice, startConfigCheck } from '../../src/cli.js';
import { loadConfig, looksLikeSecretKey } from '../../src/config.js';
import { HubError } from '../../src/errors.js';
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

describe('start check', () => {
  it('a secret-looking key stops the start, and the message does not name it', async () => {
    useConfig({ voice: { elevenlabs: { apiKey: 'sk-SECRET-VALUE-9' } } });
    const err = await startConfigCheck(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect((err as Error).message).toMatch(/Keychain/);
    expect((err as Error).message).not.toMatch(/apiKey|sk-SECRET/);
  });
  it('an ordinary unknown key prints the notice on stderr and starts', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    useConfig({ fooBar: 1 });
    await expect(startConfigCheck(env)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[stephen] config: ignored keys fooBar (run stephen doctor)');
    log.mockRestore();
  });
});

describe('start-time notice', () => {
  it('names the ignored keys on one line, by name only', () => {
    expect(ignoredKeysNotice(['safety.blockedDomain', 'chorme'])).toBe('[stephen] config: ignored keys safety.blockedDomain, chorme (run stephen doctor)');
  });
});

describe('secret-looking key names', () => {
  it.each(['apiKey', 'voice.elevenlabs.apiKey', 'gmail.refreshToken', 'clientSecret', 'password', 'accessToken'])('%s looks like a secret', (k) => {
    expect(looksLikeSecretKey(k)).toBe(true);
  });
  it.each(['apiKeyFile', 'voice.elevenlabs.apiKeyFile', 'voiceId', 'claudePath'])('%s does not', (k) => {
    expect(looksLikeSecretKey(k)).toBe(false);
  });
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
