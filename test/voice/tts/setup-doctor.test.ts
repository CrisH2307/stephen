import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { voiceOutputChecks } from '../../../src/voice/tts/doctor.js';
import { KOKORO_MODEL } from '../../../src/voice/tts/kokoro.js';
import { isTtsSetupArgs, parseTtsSetupArgs, runTtsSetup } from '../../../src/voice/tts/setup.js';
import { FAKE_KEY, FakeElevenLabs, FakeSecurity } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-tts-setup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('voice-setup --tts kokoro', () => {
  it('argument parsing', () => {
    expect(isTtsSetupArgs([])).toBe(false);
    expect(isTtsSetupArgs(['--tts', 'kokoro'])).toBe(true);
    expect(isTtsSetupArgs(['--tts=kokoro'])).toBe(true);
    expect(parseTtsSetupArgs(['--tts', 'kokoro'])).toEqual({ provider: 'kokoro' });
    expect(parseTtsSetupArgs(['--tts=kokoro'])).toEqual({ provider: 'kokoro' });
    expect(parseTtsSetupArgs(['--tts'])).toMatchObject({ error: expect.stringMatching(/needs a value/) });
    expect(parseTtsSetupArgs(['--tts', 'elevenlabs'])).toMatchObject({ error: expect.stringMatching(/voice-key set/) });
    expect(parseTtsSetupArgs(['--tts', 'kokoro', '--force'])).toMatchObject({ error: expect.stringMatching(/Unknown option "--force"/) });
  });

  it('a download that does not match the pinned sha256 is deleted and nothing is installed', async () => {
    const home = mkdtempSync(join(tmp, 'h-'));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTtsSetup(['--tts', 'kokoro'], {
      home,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      download: async (_url, dest) => writeFileSync(dest, 'not the model'),
    });
    expect(code).toBe(1);
    expect(err[0]).toMatch(/checksum mismatch/);
    expect(readdirSync(join(home, 'models'))).toEqual([]);
    expect(out[0]).toMatch(/Downloading kokoro-int8-en-v0_19 \(103 MB\) from github\.com/);
  });

  it('already installed → no download', async () => {
    const home = mkdtempSync(join(tmp, 'h-'));
    const d = join(home, 'models', KOKORO_MODEL.dir);
    mkdirSync(join(d, 'espeak-ng-data'), { recursive: true });
    for (const f of KOKORO_MODEL.keep) writeFileSync(join(d, f), 'x');
    writeFileSync(join(d, '.stephen-model.json'), JSON.stringify({ sha256: KOKORO_MODEL.sha256 }));
    const out: string[] = [];
    const code = await runTtsSetup(['--tts', 'kokoro'], { home, out: (l) => out.push(l), download: async () => { throw new Error('should not download'); } });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/already installed/);
  });
});

describe('doctor: Voice output', () => {
  let el: FakeElevenLabs;
  beforeEach(async () => {
    el = await new FakeElevenLabs().start();
  });
  afterEach(() => el.stop());

  const keyDeps = (key: string | null) => {
    const sec = new FakeSecurity();
    if (key) sec.items.set('stephen-elevenlabs|tester', key);
    return { exec: sec.exec, platform: 'darwin' as const, user: 'tester', env: {} };
  };

  it('no key, no Kokoro: say, both optional (no failures)', async () => {
    const checks = await voiceOutputChecks({ home: mkdtempSync(join(tmp, 'h-')), rawVoice: {}, network: false, keys: keyDeps(null), platform: 'darwin' });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks[0]).toMatchObject({ label: 'Voice output', detail: 'say (auto)' });
    expect(checks.find((c) => c.label === 'ElevenLabs API key')?.detail).toMatch(/not found/);
    expect(checks.find((c) => c.label === 'Kokoro local voice')?.detail).toMatch(/not installed/);
  });

  it('key found: provider, where, last 4 — and never the key', async () => {
    const checks = await voiceOutputChecks({ home: mkdtempSync(join(tmp, 'h-')), rawVoice: {}, network: false, keys: keyDeps(FAKE_KEY), platform: 'darwin' });
    expect(checks[0]!.detail).toBe('elevenlabs (auto), falls back to say');
    expect(checks.find((c) => c.label === 'ElevenLabs API key')?.detail).toBe(
      'sk_…beef from macOS Keychain (service "stephen-elevenlabs") · voice YEBbZ0itqHW31uoXSBns · model eleven_flash_v2_5',
    );
    expect(JSON.stringify(checks)).not.toContain(FAKE_KEY);
    expect(el.requests).toEqual([]); // no network without --network
  });

  it('--network: credits and voice from the API', async () => {
    el.reply('/v1/user/subscription', { kind: 'json', body: { tier: 'free', character_count: 1234, character_limit: 10000, next_character_count_reset_unix: 1_798_761_600 } });
    el.reply('/v1/voices/', { kind: 'json', body: { voice_id: 'YEBbZ0itqHW31uoXSBns', name: 'Noah Yang' } });
    const checks = await voiceOutputChecks({ home: mkdtempSync(join(tmp, 'h-')), rawVoice: {}, network: true, keys: keyDeps(FAKE_KEY), platform: 'darwin', baseUrl: el.baseUrl });
    expect(checks.find((c) => c.label === 'ElevenLabs credits')).toMatchObject({ ok: true, detail: '1,234 of 10,000 used (free plan, resets 2027-01-01)' });
    expect(checks.find((c) => c.label === 'ElevenLabs voice')).toMatchObject({ ok: true, detail: '"Noah Yang" (YEBbZ0itqHW31uoXSBns)' });
    expect(el.requests.map((r) => [r.method, r.url, r.key])).toEqual([
      ['GET', '/v1/user/subscription', FAKE_KEY],
      ['GET', '/v1/voices/YEBbZ0itqHW31uoXSBns', FAKE_KEY],
    ]);
  });

  it('--network: out of credits, voice missing, bad key', async () => {
    el.reply('/v1/user/subscription', { kind: 'json', body: { tier: 'free', character_count: 10000, character_limit: 10000 } });
    el.reply('/v1/voices/', { kind: 'error', status: 404, detail: { status: 'voice_not_found', message: 'not found' } });
    let checks = await voiceOutputChecks({ home: mkdtempSync(join(tmp, 'h-')), rawVoice: {}, network: true, keys: keyDeps(FAKE_KEY), baseUrl: el.baseUrl });
    expect(checks.find((c) => c.label === 'ElevenLabs credits')?.ok).toBe(false);
    expect(checks.find((c) => c.label.startsWith('ElevenLabs voice'))).toMatchObject({ ok: false, detail: expect.stringMatching(/not found or isn't available on your plan/) });
    el.routes = [];
    el.reply('/', { kind: 'error', status: 401, detail: { status: 'invalid_api_key', message: `bad ${FAKE_KEY}` } });
    checks = await voiceOutputChecks({ home: mkdtempSync(join(tmp, 'h-')), rawVoice: {}, network: true, keys: keyDeps(FAKE_KEY), baseUrl: el.baseUrl });
    expect(checks.find((c) => c.label === 'ElevenLabs account')).toMatchObject({ ok: false, detail: expect.stringMatching(/rejected the API key sk_…beef/) });
    expect(JSON.stringify(checks)).not.toContain(FAKE_KEY);
  });

  it('explicit tts that is unavailable is a (non-blocking) problem; a bad config is reported', async () => {
    const checks = await voiceOutputChecks({ home: mkdtempSync(join(tmp, 'h-')), rawVoice: { tts: 'kokoro' }, network: false, keys: keyDeps(null) });
    expect(checks.filter((c) => !c.ok).map((c) => c.label)).toEqual(['voice.tts is "kokoro" but it is unavailable', 'Kokoro local voice']);
    const bad = await voiceOutputChecks({ home: tmp, rawVoice: { elevenlabs: { voiceId: '!' } }, network: false });
    expect(bad).toEqual([expect.objectContaining({ ok: false, label: 'Voice output config' })]);
  });
});
