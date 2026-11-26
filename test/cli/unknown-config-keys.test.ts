import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configUnknownKeys, doctor, ignoredKeysNotice, main, startConfigCheck } from '../../src/cli.js';
import { loadConfig, looksLikeSecretKey } from '../../src/config.js';
import { HubError } from '../../src/errors.js';
import { parseVoiceConfig } from '../../src/voice/config.js';

// Importing cli.js runs `serve`, and serveStdio would take over console.log and stdin in this worker. The tests
// only need the doctor and start-check helpers, so the MCP server start is a no-op here.
vi.mock('../../src/server/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/index.js')>()),
  serveStdio: async () => {},
}));

let env: NodeJS.ProcessEnv;

/** Write config.json for this test and return the env that points loadConfig and doctor at it. */
function useConfig(raw: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'bh-unknown-'));
  mkdirSync(join(home, '.stephen'), { recursive: true });
  writeFileSync(join(home, '.stephen', 'config.json'), JSON.stringify(raw));
  env = { HOME: home };
  return home;
}

beforeEach(() => {
  env = {};
});

const savedEnv = { STEPHEN_HOME: process.env.STEPHEN_HOME, STEPHEN_CONFIG: process.env.STEPHEN_CONFIG };

/** Run doctor on a config.json; doctor reads the real process env, so point it at the test home for the call. */
async function runDoctor(raw: unknown, json: boolean): Promise<{ code: number; out: string }> {
  const home = useConfig(raw);
  process.env.STEPHEN_HOME = join(home, '.stephen');
  process.env.STEPHEN_CONFIG = join(home, '.stephen', 'config.json');
  const printed: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    printed.push(a.map(String).join(' '));
  });
  try {
    const code = await doctor(false, json);
    return { code, out: printed.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('doctor output', () => {
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('an unknown key is info, not a problem: JSON count and summary match a clean config', async () => {
    const clean = { voice: { wakePhrases: ['hey stephen'] } };
    const dirty = { voice: { wakePhrases: ['hey stephen'], fooBar: 1 } };
    const cj = JSON.parse((await runDoctor(clean, true)).out) as { problems: number; blocking: number; checks: unknown[] };
    const dj = JSON.parse((await runDoctor(dirty, true)).out) as { problems: number; blocking: number; checks: unknown[] };
    expect(dj.problems).toBe(cj.problems);
    expect(dj.blocking).toBe(cj.blocking);
    expect(dj.checks).toContainEqual(expect.objectContaining({ label: 'Unknown config key', ok: true, info: true }));
    const summary = (s: string) => s.split('\n').filter((l) => /problem|All good/.test(l)).join('\n');
    const cText = (await runDoctor(clean, false)).out;
    const dText = (await runDoctor(dirty, false)).out;
    expect(summary(dText)).toBe(summary(cText));
    expect(dText).toContain('"voice.fooBar" is ignored');
  });

  it('an unknown key line never prints its value', async () => {
    const r = await runDoctor({ voice: { stray: 'plain-value-XYZ' } }, false);
    expect(r.out).toContain('voice.stray');
    expect(r.out).not.toContain('plain-value-XYZ');
  });

  it('a secret-looking key prints no name and no value, and blocks the start', async () => {
    const r = await runDoctor({ voice: { elevenlabs: { apiKey: 'sk-SECRET-VALUE-9' } } }, true);
    expect(r.out).not.toMatch(/\bapiKey\b|sk-SECRET/);
    expect(JSON.parse(r.out).checks).toContainEqual(expect.objectContaining({ label: 'Secret in config.json', ok: false, blocking: true }));
    expect(r.code).toBe(1);
    const text = await runDoctor({ voice: { elevenlabs: { apiKey: 'sk-SECRET-VALUE-9' } } }, false);
    expect(text.out).not.toMatch(/\bapiKey\b|sk-SECRET/);
    expect(text.out).toContain('Secret in config.json');
  });

  it('an unknown key under accounts is listed by doctor, and a secret-looking one blocks the start', async () => {
    useConfig({ accounts: { fooBar: 1, canvas: { token: 'tok-SECRET-VALUE-4' } } });
    expect((await configUnknownKeys(env)).sort()).toEqual(['accounts.canvas.token', 'accounts.fooBar']);
    const err = await startConfigCheck(env).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Keychain/);
    expect((err as Error).message).not.toContain('tok-SECRET-VALUE-4');
    expect((err as Error).message).not.toContain('canvas');
  });
});

describe('start check', () => {
  it('a secret-looking key stops the start, and the message does not name it', async () => {
    useConfig({ voice: { elevenlabs: { apiKey: 'sk-SECRET-VALUE-9' } } });
    const err = await startConfigCheck(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect((err as Error).message).toMatch(/Keychain/);
    expect((err as Error).message).not.toContain('sk-SECRET-VALUE-9');
    expect((err as Error).message).not.toMatch(/\bapiKey\b/);
  });
  it('an ordinary unknown key prints the notice on stderr and starts', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    useConfig({ fooBar: 1 });
    await expect(startConfigCheck(env)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[stephen] config: ignored keys fooBar (run stephen doctor)');
    log.mockRestore();
  });
});

describe('listen start path', () => {
  it('listen refuses a secret-looking key before it starts anything', async () => {
    const home = useConfig({ voice: { elevenlabs: { apiKey: 'sk-SECRET-VALUE-9' } } });
    const keep = { STEPHEN_HOME: process.env.STEPHEN_HOME, STEPHEN_CONFIG: process.env.STEPHEN_CONFIG };
    process.env.STEPHEN_HOME = join(home, '.stephen');
    process.env.STEPHEN_CONFIG = join(home, '.stephen', 'config.json');
    try {
      const err = await main(['listen']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HubError);
      expect((err as Error).message).toMatch(/Keychain/);
    } finally {
      for (const [k, v] of Object.entries(keep)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('start-time notice', () => {
  it('names the ignored keys on one line, by name only', () => {
    expect(ignoredKeysNotice(['safety.blockedDomain', 'chorme'])).toBe('[stephen] config: ignored keys safety.blockedDomain, chorme (run stephen doctor)');
  });
});

describe('secret-looking key names (the last word of the name)', () => {
  it.each([
    'apiKey', 'api_key', 'token', 'password', 'clientSecret', 'voice.elevenlabs.apiKey', 'gmail.refreshToken', 'accessToken',
    'openaiApiKey', 'anthropicApiKey', 'githubToken', 'botToken', 'oauthToken', 'sessionToken', 'webhookSecret', 'dbPassword',
    'bearer', 'cookie',
  ])('%s is refused', (k) => {
    expect(looksLikeSecretKey(k)).toBe(true);
  });
  it.each([
    'apiKeyFile', 'voice.elevenlabs.apiKeyFile', 'voiceId', 'claudePath', 'hotkey', 'hotKey', 'monkey', 'secretary', 'tokenLimit', 'keyboardShortcut',
  ])('%s is allowed', (k) => {
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
    useConfig({ voice: { stray: 'sk-secret-value-123' } });
    const keys = await configUnknownKeys(env);
    expect(keys).toEqual(['voice.stray']);
    expect(JSON.stringify(keys)).not.toContain('sk-secret-value-123');
  });

  it('chrome, zen and output unknown keys are listed too', async () => {
    useConfig({ chrome: { mode: 'real', chromeFoo: 1 }, zen: { zenFoo: 1 }, output: { outFoo: 1 } });
    expect((await configUnknownKeys(env)).sort()).toEqual(['chrome.chromeFoo', 'output.outFoo', 'zen.zenFoo']);
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
