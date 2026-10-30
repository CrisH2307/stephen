import { z } from 'zod';

/** Offline speech-to-text models the listener can use (see models.ts for the pinned archives). */
export const ASR_MODELS = ['whisper-tiny.en', 'whisper-base.en', 'moonshine-tiny', 'moonshine-base'] as const;
export type AsrModelId = (typeof ASR_MODELS)[number];

/**
 * A wake/stop phrase: 2–4 plain English words (letters and inner apostrophes). The keyword spotter needs the
 * phrase tokenized into its BPE units, so anything else (digits, punctuation, non-Latin letters) is refused here
 * rather than failing later. One-word phrases are refused: they false-trigger far too often.
 */
const phrase = (what: string) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' ').toLowerCase())
    .pipe(
      z
        .string()
        .regex(
          /^[a-z]+(?:'[a-z]+)?(?: [a-z]+(?:'[a-z]+)?){1,3}$/,
          `${what} must be 2–4 plain English words (letters only), e.g. "hey stephen"`,
        ),
    );

/** say(1) voice names: letters, digits, spaces and a little punctuation; never an option-looking value. */
const voiceName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/, 'voice must be a macOS voice name like "Samantha" (see `say -v ?`)');

const claudeModel = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/, 'claudeModel must be a model alias or name like "sonnet"');

const VoiceConfigSchema = z
  .strictObject({
    /** Phrase that starts a command. */
    wakePhrase: phrase('wakePhrase').default('hey stephen'),
    /** Phrase that cancels the running command / stops Stephen talking. */
    stopPhrase: phrase('stopPhrase').default('stephen stop'),
    /** Microphone: PvRecorder device index (-1 = system default) or part of the device name. */
    device: z.union([z.number().int().min(-1).max(255), z.string().trim().min(1).max(200)]).nullish(),
    asrModel: z.enum(ASR_MODELS).default('whisper-tiny.en'),
    /** Keyword-spotter trigger threshold (higher = fewer false wakes, more misses). */
    keywordsThreshold: z.number().min(0.05).max(0.95).default(0.3),
    /** Keyword-spotter boosting score (higher = easier to trigger). */
    keywordsScore: z.number().min(0.5).max(5).default(1.0),
    /** Re-check the transcript for the wake phrase and drop the command if it isn't there (cuts false wakes). */
    verifyWake: z.boolean().default(true),
    /** Path or command name of the Claude Code CLI. */
    claudePath: z.string().trim().min(1).max(1000).default('claude'),
    /** Optional model alias for the headless session (e.g. "sonnet", "haiku"). */
    claudeModel: claudeModel.nullish(),
    maxTurns: z.number().int().min(1).max(100).default(15),
    /**
     * IGNORED in phase 1 (still accepted so an existing config.json keeps working): every voice command starts
     * a fresh Claude session. Resuming would keep Claude's memory of earlier commands while the new Stephen
     * server's safety gate starts with no memory of private reads or approvals. Follow-ups return in phase 3.
     */
    followUpWindowSec: z.number().int().min(0).max(3600).nullish(),
    /**
     * After every command, the wake word is ignored for this many seconds (a page or video Stephen just opened
     * may say "Hey Stephen…"). Press Enter in the listener's terminal to re-arm early. 0 = no cooldown.
     */
    cooldownSec: z.number().min(0).max(600).default(20),
    /** Speak the reply with macOS `say`. */
    speak: z.boolean().default(true),
    /** macOS `say` voice (default: the system voice). */
    voice: voiceName.nullish(),
    /** Speech rate in words per minute (default: the system rate). */
    rate: z.number().int().min(90).max(720).nullish(),
    /** Tink on wake, Pop when done. */
    chimes: z.boolean().default(true),
    /** Silence that ends a command. */
    silenceSec: z.number().min(0.3).max(3).default(0.8),
    /** Longest command. */
    maxCommandSec: z.number().min(2).max(60).default(12),
    /** Give up if nothing is said this long after the wake word. */
    noSpeechTimeoutSec: z.number().min(1).max(30).default(5),
  })
  .refine((c) => c.wakePhrase !== c.stopPhrase, { message: 'wakePhrase and stopPhrase must differ', path: ['stopPhrase'] });

export type VoiceConfig = Omit<z.output<typeof VoiceConfigSchema>, 'device' | 'claudeModel' | 'voice' | 'rate' | 'followUpWindowSec'> & {
  device: number | string | null;
  /** Set only when config.json has it; ignored in phase 1 (runListen prints a note). */
  followUpWindowSec: number | null;
  claudeModel: string | null;
  voice: string | null;
  rate: number | null;
};

export class VoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceConfigError';
  }
}

function describe(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      if (i.code === 'unrecognized_keys') return `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"voice.${k}"`).join(', ')}`;
      const key = i.path.map(String).join('.');
      return `"voice${key ? `.${key}` : ''}": ${i.message}`;
    })
    .join('; ');
}

/** Validate the raw `voice` section of config.json (null values mean "use the default"). Throws VoiceConfigError. */
export function parseVoiceConfig(raw: unknown): VoiceConfig {
  const obj: Record<string, unknown> = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new VoiceConfigError('"voice" must be an object');
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v !== null && v !== undefined) obj[k] = v;
  }
  const r = VoiceConfigSchema.safeParse(obj);
  if (!r.success) throw new VoiceConfigError(`Invalid voice config: ${describe(r.error)}`);
  return {
    ...r.data,
    device: r.data.device ?? null,
    claudeModel: r.data.claudeModel ?? null,
    voice: r.data.voice ?? null,
    rate: r.data.rate ?? null,
    followUpWindowSec: r.data.followUpWindowSec ?? null,
  };
}
