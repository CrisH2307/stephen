/**
 * Voice-output settings: the `tts`, `elevenlabs` and `kokoro` keys of the "voice" section of config.json
 * (plus the existing `voice` / `rate` keys, which configure macOS `say`). voice/config.ts spreads
 * TTS_CONFIG_SHAPE into its schema; the MCP server (announce) and `stephen voice-key` / `doctor` use
 * parseTtsConfig on the raw section, so a problem elsewhere in "voice" never blocks voice output.
 */
import { homedir } from 'node:os';
import { z } from 'zod';

/** The owner's ElevenLabs voice ("Noah Yang"). */
export const DEFAULT_ELEVENLABS_VOICE_ID = 'YEBbZ0itqHW31uoXSBns';
/** Lowest-latency current ElevenLabs model (~75–100 ms; half the credits per character of multilingual_v2). */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';
export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

/** Speaker names of kokoro-en-v0_19, in speaker-id order (af/am = US female/male, bf/bm = UK). */
export const KOKORO_SPEAKERS = [
  'af',
  'af_bella',
  'af_nicole',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_michael',
  'bf_emma',
  'bf_isabella',
  'bm_george',
  'bm_lewis',
] as const;
export type KokoroSpeakerName = (typeof KOKORO_SPEAKERS)[number];
export const DEFAULT_KOKORO_SPEAKER: KokoroSpeakerName = 'am_michael';

export const TTS_PROVIDER_SETTINGS = ['auto', 'elevenlabs', 'kokoro', 'say'] as const;
export type TtsProviderSetting = (typeof TTS_PROVIDER_SETTINGS)[number];

const ElevenLabsSchema = z.strictObject({
  voiceId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{8,64}$/, 'voice.elevenlabs.voiceId must be an ElevenLabs voice id like "YEBbZ0itqHW31uoXSBns"')
    .default(DEFAULT_ELEVENLABS_VOICE_ID),
  modelId: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{3,64}$/, 'voice.elevenlabs.modelId must be a model id like "eleven_flash_v2_5"')
    .default(DEFAULT_ELEVENLABS_MODEL),
  /** A file holding only the API key; must be mode 0600 (or stricter). Used after Keychain and $ELEVENLABS_API_KEY. */
  apiKeyFile: z.string().trim().min(1).max(1000).nullish(),
  /** Give up on ElevenLabs (and use the next voice) after this long. */
  timeoutSec: z.number().min(1).max(30).default(8),
});

const KokoroSchema = z.strictObject({
  /** Speaker name (e.g. "am_michael", "bf_emma") or its id 0–10. */
  speaker: z.union([z.enum(KOKORO_SPEAKERS), z.number().int().min(0).max(KOKORO_SPEAKERS.length - 1)]).default(DEFAULT_KOKORO_SPEAKER),
  /** 1 = normal; 1.2 = 20 % faster. */
  speed: z.number().min(0.5).max(2).default(1),
});

/** Spread into voice/config.ts's VoiceConfigSchema. */
export const TTS_CONFIG_SHAPE = {
  /** Voice for spoken replies: auto = ElevenLabs if a key is found, else Kokoro if installed, else `say`. */
  tts: z.enum(TTS_PROVIDER_SETTINGS).default('auto'),
  elevenlabs: ElevenLabsSchema.prefault({}),
  kokoro: KokoroSchema.prefault({}),
};

/** say(1) voice names (same rule as voice/config.ts). */
const sayVoice = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/, 'voice must be a macOS voice name like "Samantha" (see `say -v ?`)');

const TtsConfigSchema = z.object({
  ...TTS_CONFIG_SHAPE,
  voice: sayVoice.nullish(),
  rate: z.number().int().min(90).max(720).nullish(),
});

export interface TtsConfig {
  tts: TtsProviderSetting;
  elevenlabs: { voiceId: string; modelId: string; apiKeyFile?: string | null; timeoutSec: number };
  kokoro: { speaker: KokoroSpeakerName | number; speed: number };
  /** macOS `say` voice and words per minute (null = system default). */
  voice: string | null;
  rate: number | null;
}

export class TtsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsConfigError';
  }
}

/** Validate the voice-output keys of the raw "voice" section (other keys are ignored). Throws TtsConfigError. */
export function parseTtsConfig(rawVoice: unknown): TtsConfig {
  const obj: Record<string, unknown> = {};
  if (rawVoice !== null && rawVoice !== undefined) {
    if (typeof rawVoice !== 'object' || Array.isArray(rawVoice)) throw new TtsConfigError('"voice" must be an object');
    for (const k of ['tts', 'elevenlabs', 'kokoro', 'voice', 'rate']) {
      const v = (rawVoice as Record<string, unknown>)[k];
      if (v !== null && v !== undefined) obj[k] = v;
    }
  }
  const r = TtsConfigSchema.safeParse(obj);
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => {
        if (i.code === 'unrecognized_keys') return `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"voice.${[...i.path, k].join('.')}"`).join(', ')}`;
        return `"voice.${i.path.map(String).join('.')}": ${i.message}`;
      })
      .join('; ');
    throw new TtsConfigError(`Invalid voice output config: ${msg}`);
  }
  return { ...r.data, voice: r.data.voice ?? null, rate: r.data.rate ?? null };
}

export function kokoroSpeakerId(s: KokoroSpeakerName | number): number {
  return typeof s === 'number' ? s : KOKORO_SPEAKERS.indexOf(s);
}

/** `~/x` → `<home>/x`. */
export function expandHome(p: string, home: string = homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? `${home}${p.slice(1)}` : p;
}
