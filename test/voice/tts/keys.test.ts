import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseTtsConfig } from '../../../src/voice/tts/config.js';
import { findApiKey } from '../../../src/voice/tts/keys.js';
import { runVoiceKey, type VoiceKeyEnv } from '../../../src/connect/voice-key.js';
import { redactKey, scrubKey } from '../../../src/voice/tts/redact.js';
import { FAKE_KEY, FakeSecurity, OTHER_FAKE_KEY } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-tts-keys-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function keyFile(content: string, mode: number): string {
  const p = join(mkdtempSync(join(tmp, 'f-')), 'eleven.key');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

const cfgWith = (apiKeyFile?: string) => parseTtsConfig(apiKeyFile ? { elevenlabs: { apiKeyFile } } : {});
const SVC = 'stephen-elevenlabs|tester';

describe('redaction', () => {
  it('shows only sk_… and the last 4 characters', () => {
    expect(redactKey(FAKE_KEY)).toBe('sk_…beef');
    expect(redactKey('abcdefghijklmnop1234')).toBe('…1234');
    expect(redactKey('short')).toBe('…');
    expect(scrubKey(`bad key ${FAKE_KEY}!`, FAKE_KEY)).toBe('bad key sk_…beef!');
  });
});

describe('key lookup order: Keychain → $ELEVENLABS_API_KEY → apiKeyFile', () => {
  it('Keychain first, via argv (no shell), for this user', async () => {
    const sec = new FakeSecurity();
    sec.items.set(SVC, FAKE_KEY);
    const file = keyFile(OTHER_FAKE_KEY, 0o600);
    const r = await findApiKey(cfgWith(file), { exec: sec.exec, platform: 'darwin', user: 'tester', env: { ELEVENLABS_API_KEY: OTHER_FAKE_KEY } });
    expect(r.found).toMatchObject({ key: FAKE_KEY, source: 'keychain' });
    expect(sec.calls).toEqual([{ file: 'security', args: ['find-generic-password', '-s', 'stephen-elevenlabs', '-a', 'tester', '-w'] }]);
  });

  it('then the environment, then the key file', async () => {
    const sec = new FakeSecurity();
    const file = keyFile(`${OTHER_FAKE_KEY}\n`, 0o600);
    const viaEnv = await findApiKey(cfgWith(file), { exec: sec.exec, platform: 'darwin', user: 'tester', env: { ELEVENLABS_API_KEY: FAKE_KEY } });
    expect(viaEnv.found).toMatchObject({ key: FAKE_KEY, source: 'env', where: '$ELEVENLABS_API_KEY' });
    const viaFile = await findApiKey(cfgWith(file), { exec: sec.exec, platform: 'darwin', user: 'tester', env: {} });
    expect(viaFile.found).toMatchObject({ key: OTHER_FAKE_KEY, source: 'file', where: file });
    expect(await findApiKey(cfgWith(), { exec: sec.exec, platform: 'darwin', user: 'tester', env: {} })).toEqual({ found: null, notes: [] });
  });

  it('does not run `security` off macOS', async () => {
    const sec = new FakeSecurity();
    const r = await findApiKey(cfgWith(), { exec: sec.exec, platform: 'linux', env: { ELEVENLABS_API_KEY: FAKE_KEY } });
    expect(r.found?.source).toBe('env');
    expect(sec.calls).toEqual([]);
  });

  it('refuses a key file other users can read, with a chmod hint', async () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      const file = keyFile(FAKE_KEY, mode);
      const r = await findApiKey(cfgWith(file), { platform: 'linux', env: {} });
      expect(r.found).toBeNull();
      expect(r.notes[0]).toContain(`refused. Fix: chmod 600 ${file}`);
      expect(r.notes.join()).not.toContain(FAKE_KEY);
    }
    expect((await findApiKey(cfgWith(keyFile(FAKE_KEY, 0o400)), { platform: 'linux', env: {} })).found?.source).toBe('file');
  });

  it('refuses a key file owned by someone else, a missing file and junk content', async () => {
    const file = keyFile(FAKE_KEY, 0o600);
    expect((await findApiKey(cfgWith(file), { platform: 'linux', env: {}, uid: 12345 })).notes[0]).toMatch(/not owned by you/);
    expect((await findApiKey(cfgWith(join(tmp, 'nope')), { platform: 'linux', env: {} })).notes[0]).toMatch(/not found/);
    const junk = keyFile('my key is "sk_1234567890123456789"', 0o600);
    const r = await findApiKey(cfgWith(junk), { platform: 'linux', env: {} });
    expect(r.notes[0]).toMatch(/does not contain an API key/);
    expect(r.notes[0]).not.toContain('sk_1234567890123456789');
  });

  it('expands ~ in apiKeyFile', async () => {
    const dir = mkdtempSync(join(tmp, 'home-'));
    writeFileSync(join(dir, 'k'), FAKE_KEY, { mode: 0o600 });
    const r = await findApiKey(cfgWith('~/k'), { platform: 'linux', env: {}, home: dir });
    expect(r.found?.where).toBe(join(dir, 'k'));
  });

  it('ignores a malformed env value', async () => {
    const r = await findApiKey(cfgWith(), { platform: 'linux', env: { ELEVENLABS_API_KEY: 'not a key' } });
    expect(r.found).toBeNull();
    expect(r.notes).toEqual(['$ELEVENLABS_API_KEY is set but does not look like an API key — ignored']);
  });
});

describe('stephen voice-key', () => {
  function env(sec: FakeSecurity, over: Partial<VoiceKeyEnv> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const e: VoiceKeyEnv = { exec: sec.exec, platform: 'darwin', user: 'tester', env: {}, out: (l) => out.push(l), err: (l) => err.push(l), ...over };
    return { e, out, err };
  }

  it('set: reads the key, stores it via `security -i` on stdin (never argv), verifies, prints only the last 4', async () => {
    const sec = new FakeSecurity();
    const { e, out, err } = env(sec, { readSecret: async () => `  ${FAKE_KEY}\n` });
    expect(await runVoiceKey(['set'], e)).toBe(0);
    expect(sec.items.get(SVC)).toBe(FAKE_KEY);
    for (const c of sec.calls) expect(c.args.join(' ')).not.toContain(FAKE_KEY);
    expect(sec.calls[0]).toEqual({
      file: 'security',
      args: ['-i'],
      input: `add-generic-password -U -s stephen-elevenlabs -a tester -l "Stephen ElevenLabs API key" -w ${FAKE_KEY}\n`,
    });
    expect(out.join('\n')).toContain('sk_…beef');
    expect([...out, ...err].join('\n')).not.toContain(FAKE_KEY);
    expect(out.join('\n')).toMatch(/rotate it/);
  });

  it('set replaces an existing key (-U)', async () => {
    const sec = new FakeSecurity();
    sec.items.set(SVC, OTHER_FAKE_KEY);
    expect(await runVoiceKey(['set'], env(sec, { readSecret: async () => FAKE_KEY }).e)).toBe(0);
    expect(sec.items.get(SVC)).toBe(FAKE_KEY);
  });

  it('set fails when the item is not there afterwards (security -i exits 0 on errors)', async () => {
    const sec = new FakeSecurity();
    sec.dropInteractiveAdds = true;
    const { e, err } = env(sec, { readSecret: async () => FAKE_KEY });
    expect(await runVoiceKey(['set'], e)).toBe(1);
    expect(err.join()).toMatch(/not found in the Keychain after storing/);
  });

  it('set refuses empty or malformed input before touching the Keychain', async () => {
    for (const bad of ['', '   ', 'sk_abc def ghi jkl mno pqr', `${FAKE_KEY}"; rm -rf ~`, 'sk_short']) {
      const sec = new FakeSecurity();
      const { e, err } = env(sec, { readSecret: async () => bad });
      expect(await runVoiceKey(['set'], e), JSON.stringify(bad)).toBe(1);
      expect(sec.calls).toEqual([]);
      expect(err.join()).not.toContain(FAKE_KEY);
    }
  });

  it('set/delete are macOS-only; status works anywhere', async () => {
    const sec = new FakeSecurity();
    const { e, err } = env(sec, { platform: 'linux', readSecret: async () => FAKE_KEY });
    expect(await runVoiceKey(['set'], e)).toBe(1);
    expect(err[0]).toMatch(/macOS-only.*ELEVENLABS_API_KEY/);
    const s = env(sec, { platform: 'linux', env: { ELEVENLABS_API_KEY: FAKE_KEY } });
    expect(await runVoiceKey(['status'], s.e)).toBe(0);
    expect(s.out[0]).toBe('ElevenLabs API key: sk_…beef — from $ELEVENLABS_API_KEY.');
  });

  it('status: where it was found, last 4 only; exit 1 when none', async () => {
    const sec = new FakeSecurity();
    sec.items.set(SVC, FAKE_KEY);
    const a = env(sec);
    expect(await runVoiceKey(['status'], a.e)).toBe(0);
    expect(a.out).toEqual(['ElevenLabs API key: sk_…beef — from macOS Keychain (service "stephen-elevenlabs").']);
    const b = env(new FakeSecurity());
    expect(await runVoiceKey(['status'], b.e)).toBe(1);
    expect(b.out[0]).toMatch(/No ElevenLabs API key found/);
    const file = keyFile(FAKE_KEY, 0o644);
    const c = env(new FakeSecurity(), { ttsConfig: () => cfgWith(file) });
    expect(await runVoiceKey(['status'], c.e)).toBe(1);
    expect(c.err[0]).toMatch(/chmod 600/);
  });

  it('delete removes the item; deleting nothing is fine', async () => {
    const sec = new FakeSecurity();
    sec.items.set(SVC, FAKE_KEY);
    const a = env(sec, { env: { ELEVENLABS_API_KEY: OTHER_FAKE_KEY } });
    expect(await runVoiceKey(['delete'], a.e)).toBe(0);
    expect(sec.items.size).toBe(0);
    expect(sec.calls.at(-1)!.args).toEqual(['delete-generic-password', '-s', 'stephen-elevenlabs', '-a', 'tester']);
    expect(a.out.join('\n')).toMatch(/Deleted[\s\S]*ELEVENLABS_API_KEY is still set/);
    const b = env(sec);
    expect(await runVoiceKey(['delete'], b.e)).toBe(0);
    expect(b.out[0]).toMatch(/no ElevenLabs key/);
  });

  it('usage errors', async () => {
    const sec = new FakeSecurity();
    expect(await runVoiceKey([], env(sec).e)).toBe(2);
    expect(await runVoiceKey(['show'], env(sec).e)).toBe(2);
    expect(await runVoiceKey(['set', FAKE_KEY], env(sec).e)).toBe(2); // a key on argv is refused, not stored
    expect(sec.calls).toEqual([]);
    expect(await runVoiceKey(['--help'], env(sec).e)).toBe(0);
  });
});
