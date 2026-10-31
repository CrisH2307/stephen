/** The "Voice output" lines of `stephen doctor` (and `doctor --network` for the ElevenLabs account checks). */
import { join } from 'node:path';
import { parseTtsConfig } from './config.js';
import { checkElevenLabsAccount } from './elevenlabs.js';
import { findApiKey, type KeyDeps } from './keys.js';
import { isKokoroInstalled, kokoroDir } from './kokoro.js';
import { redactKey } from './redact.js';
import type { TtsProviderName } from './types.js';

const TTS_CHAIN: readonly TtsProviderName[] = ['elevenlabs', 'kokoro', 'say'];

export interface VoiceOutputCheck {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  info?: boolean;
}

export interface VoiceDoctorDeps {
  home: string;
  rawVoice: unknown;
  network: boolean;
  keys?: KeyDeps;
  baseUrl?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
}

export async function voiceOutputChecks(d: VoiceDoctorDeps): Promise<VoiceOutputCheck[]> {
  const out: VoiceOutputCheck[] = [];
  let cfg;
  try {
    cfg = parseTtsConfig(d.rawVoice);
  } catch (e) {
    return [{ ok: false, label: 'Voice output config', detail: (e as Error).message, fix: 'Fix the "voice" section of config.json (see docs/VOICE.md "Voice output").' }];
  }
  const lookup = await findApiKey(cfg, { home: d.home, ...d.keys });
  const root = join(d.home, 'models');
  const kokoro = await isKokoroInstalled(root).catch(() => false);
  const mac = (d.platform ?? process.platform) === 'darwin';

  const available = { elevenlabs: !!lookup.found, kokoro, say: true };
  const order = TTS_CHAIN.slice(cfg.tts === 'auto' ? 0 : TTS_CHAIN.indexOf(cfg.tts)).filter((p) => available[p]);
  out.push({
    ok: true,
    info: true,
    label: 'Voice output',
    detail: `${order[0]}${cfg.tts === 'auto' ? ' (auto)' : ''}${order.length > 1 ? `, falls back to ${order.slice(1).join(' → ')}` : ''}`,
  });
  const configuredMissing = cfg.tts !== 'auto' && order[0] !== cfg.tts;
  if (configuredMissing) {
    out.push({
      ok: false,
      label: `voice.tts is "${cfg.tts}" but it is unavailable`,
      fix: cfg.tts === 'elevenlabs' ? 'Run `stephen voice-key set`.' : 'Run `stephen voice-setup --tts kokoro`.',
    });
  }

  for (const n of lookup.notes) out.push({ ok: false, label: 'ElevenLabs API key', detail: n });
  if (lookup.found) {
    out.push({ ok: true, label: 'ElevenLabs API key', detail: `${redactKey(lookup.found.key)} from ${lookup.found.where} · voice ${cfg.elevenlabs.voiceId} · model ${cfg.elevenlabs.modelId}` });
    if (d.network) {
      const acct = await checkElevenLabsAccount(lookup.found.key, cfg.elevenlabs.voiceId, {
        ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
        ...(d.fetch ? { fetch: d.fetch } : {}),
      });
      const s = acct.subscription;
      if (s && 'error' in s) out.push({ ok: false, label: 'ElevenLabs account', detail: s.error });
      else if (s) {
        const left = s.limit - s.used;
        out.push({
          ok: left > 0,
          label: 'ElevenLabs credits',
          detail: `${s.used.toLocaleString('en-US')} of ${s.limit.toLocaleString('en-US')} used (${s.tier} plan${s.resetsAt ? `, resets ${s.resetsAt}` : ''})`,
          fix: 'Out of credits: Stephen uses the local voice until they reset (or upgrade the plan).',
        });
      }
      const v = acct.voice;
      if (v && 'error' in v) out.push({ ok: false, label: `ElevenLabs voice ${cfg.elevenlabs.voiceId}`, detail: v.error, fix: 'Pick a voice from your ElevenLabs "My Voices" and set voice.elevenlabs.voiceId.' });
      else if (v) out.push({ ok: true, label: 'ElevenLabs voice', detail: `"${v.name}" (${cfg.elevenlabs.voiceId})` });
    } else {
      out.push({ ok: true, info: true, label: 'ElevenLabs account', detail: 'not checked (run `stephen doctor --network` to check credits and the voice)' });
    }
  } else {
    out.push({
      ok: cfg.tts !== 'elevenlabs',
      info: cfg.tts !== 'elevenlabs',
      label: 'ElevenLabs API key',
      detail: 'not found (Keychain, $ELEVENLABS_API_KEY, voice.elevenlabs.apiKeyFile) — optional',
      fix: 'Run `stephen voice-key set` to use the ElevenLabs voice.',
    });
  }

  out.push({
    ok: kokoro || cfg.tts !== 'kokoro',
    info: !kokoro && cfg.tts !== 'kokoro',
    label: 'Kokoro local voice',
    detail: kokoro ? kokoroDir(root) : 'not installed — optional (`stephen voice-setup --tts kokoro`, ~103 MB)',
    fix: 'Run `stephen voice-setup --tts kokoro`.',
  });
  if (!mac) out.push({ ok: true, info: true, label: 'Audio playback', detail: 'afplay/say are macOS-only — replies are not spoken on this system' });
  return out;
}
