import { z } from 'zod';
import { TTS_CONFIG_SHAPE } from './tts/config.js';
import { ConfigError } from '../lib/errors.js';
import { LENGTHS, TONES } from './talk.js';

/** Offline speech-to-text models the listener can use (see models.ts for the pinned archives). */
export const ASR_MODELS = [
  'whisper-small.en',
  'parakeet-tdt-0.6b-v2',
  'moonshine-base-v2',
  'whisper-tiny.en',
  'whisper-base.en',
  'moonshine-tiny',
  'moonshine-base',
] as const;
export type AsrModelId = (typeof ASR_MODELS)[number];
/** Used when `voice.asrModel` is not set (see docs/VOICE.md "Speech-to-text models" for the benchmark). */
export const DEFAULT_ASR_MODEL: AsrModelId = 'whisper-small.en';
/** The previous default: used (with a hint to run `stephen voice-setup`) when the new default isn't downloaded yet. */
export const FALLBACK_ASR_MODEL: AsrModelId = 'whisper-tiny.en';

/**
 * A wake/stop phrase: plain English words (letters and inner apostrophes). The keyword spotter needs the phrase
 * tokenized into its BPE units, so anything else (digits, punctuation, non-Latin letters) is refused here rather
 * than failing later. Wake phrases may be one word ("stephen": it gets the stricter `bareWakeThreshold`); the stop
 * phrase needs 2–4 words, since a one-word stop phrase would cancel commands on any passing "stop".
 */
const phrase = (what: string, minWords: 1 | 2) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' ').toLowerCase())
    .pipe(
      z
        .string()
        .regex(
          new RegExp(`^[a-z]+(?:'[a-z]+)?(?: [a-z]+(?:'[a-z]+)?){${minWords - 1},3}$`),
          `${what} must be ${minWords === 1 ? '1' : '2'}–4 plain English words (letters only), e.g. "hey stephen"`,
        ),
    );

/** Wake phrases used when config.json sets neither `wakePhrases` nor the old single `wakePhrase`. */
export const DEFAULT_WAKE_PHRASES = ['hey stephen', 'yo stephen', 'ok stephen', 'stephen'] as const;

/** say(1) voice names: letters, digits, spaces and a little punctuation; never an option-looking value. */
const voiceName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/, 'voice must be a macOS voice name like "Samantha" (see `say -v ?`)');

/** Default `bareWakeThreshold` (see docs/VOICE.md "Wake phrases" for the measurements). */
export const BARE_WAKE_THRESHOLD_DEFAULT = 0.35;

export const CLAUDE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;
const claudeModel = z.string().trim().regex(CLAUDE_MODEL_RE, 'claudeModel must be a model alias or name like "sonnet"');

/** `claude --effort` levels. Absent or null = Claude Code's own default (no flag). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The voice default: the fastest model (see docs/VOICE.md "Model" for the speed/quality trade-off). */
export const DEFAULT_VOICE_CLAUDE_MODEL = 'sonnet';

/** null/absent → the voice default; "default" → no --model flag (Claude Code's own default). */
export function resolveClaudeModel(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return DEFAULT_VOICE_CLAUDE_MODEL;
  return v.toLowerCase() === 'default' ? null : v;
}

/** One "about me" value: a single line, printable, short. */
const aboutValue = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'must be one line of plain text');

/** voice.aboutMe — facts the user chose to tell Stephen (see aboutMeLines in claude.ts). */
export const AboutMeSchema = z
  .strictObject({
    name: aboutValue.optional(),
    home: aboutValue.optional(),
    school: aboutValue.optional(),
    work: aboutValue.optional(),
    /** Up to 10 more short facts ("my prof for SOFE 3980 is Dr. X", "I like lofi and R&B"). */
    notes: z.array(aboutValue).max(10).optional(),
  });
export type AboutMe = z.output<typeof AboutMeSchema>;

const VoiceConfigSchema = z
  .strictObject({
    /** Phrases that start a command (any of them). Default: DEFAULT_WAKE_PHRASES. */
    wakePhrases: z.array(phrase('each of wakePhrases', 1)).min(1).max(8).optional(),
    /** Old single-phrase form of `wakePhrases` (still accepted). */
    wakePhrase: phrase('wakePhrase', 1).optional(),
    /** Phrase that cancels the running command / stops Stephen talking. */
    stopPhrase: phrase('stopPhrase', 2).default('stephen stop'),
    /** Microphone: PvRecorder device index (-1 = system default) or part of the device name. */
    device: z.union([z.number().int().min(-1).max(255), z.string().trim().min(1).max(200)]).nullish(),
    /** Speech-to-text model; unset = DEFAULT_ASR_MODEL (falling back to whisper-tiny.en until it is downloaded). */
    asrModel: z.enum(ASR_MODELS).optional(),
    /** Keyword-spotter trigger threshold (higher = fewer false wakes, more misses). */
    keywordsThreshold: z.number().min(0.05).max(0.95).default(0.3),
    /** Threshold for one-word wake phrases (bare "Stephen"), which false-trigger more easily. */
    bareWakeThreshold: z.number().min(0.05).max(0.95).default(BARE_WAKE_THRESHOLD_DEFAULT),
    /** Keyword-spotter boosting score (higher = easier to trigger). */
    keywordsScore: z.number().min(0.5).max(5).default(1.0),
    /** Re-check the transcript for the wake phrase and drop the command if it isn't there (cuts false wakes). */
    verifyWake: z.boolean().default(true),
    /** Path or command name of the Claude Code CLI. */
    claudePath: z.string().trim().min(1).max(1000).default('claude'),
    /**
     * Model for the headless session (`claude --model`). Default "haiku": the fastest model, plenty for one-shot
     * voice commands. Use "sonnet" (or a full model name) for better judgement on harder requests, or "default"
     * for Claude Code's own default (no --model flag). See docs/VOICE.md "Model".
     */
    claudeModel: claudeModel.nullish(),
    /** Effort for the headless session (`claude --effort`); settable live from the Stephen window (Settings > Model). */
    claudeEffort: z.enum(EFFORTS).nullish(),
    /** Model turns per command. 25 leaves room for multi-step requests ("open Notion and play lofi and …"). */
    maxTurns: z.number().int().min(1).max(100).default(25),
    /**
     * Facts about the user that Stephen may use without asking ("routes from my home to Union Station").
     * Sent to Claude with every command; only what you put here. See docs/VOICE.md "About me".
     */
    aboutMe: AboutMeSchema.optional(),
    /**
     * How the persona (with aboutMe and memory) reaches Claude. "auto" (default): in a 0600 file
     * (<home>/voice/persona.txt, `--append-system-prompt-file`) when `claude --help` mentions that flag, else on argv
     * (`--append-system-prompt`, visible in `ps`). "on": always the file. "off": always argv. See docs/VOICE.md "Memory".
     */
    personaFile: z.enum(['auto', 'on', 'off']).default('auto'),
    /**
     * Follow-ups: a command that starts within this many seconds of the previous command's end continues its
     * conversation (Claude `--resume` + the safety gate's memory via `serve --session-state`; see
     * src/voice/conversation.ts). 0 = every command starts fresh. Default 180, at most 1800.
     */
    followUpWindowSec: z.number().int().min(0).max(1800).default(180),
    /**
     * Phase 3: one long-lived Claude Code per conversation, started when the wake word fires or F5 goes down, so its
     * start-up is hidden while you talk (docs/ADR-003). The listener checks the stream protocol at start and falls
     * back to one `claude -p` per command if it fails. false = always one `claude -p` per command (as before).
     */
    warm: z.boolean().default(true),
    /**
     * After every command, the wake word is ignored for this many seconds (a page or video Stephen just opened
     * may say "Hey Stephen…"). Press Enter in the listener's terminal to re-arm early. 0 = no cooldown.
     * Only used without Stephen Helper: with it, the wake word is ignored only while the Mac plays sound.
     */
    cooldownSec: z.number().min(0).max(600).default(20),
    /**
     * "Hey Stephen" on/off. false = push-to-talk only (hold Fn+Option), which needs Stephen Helper
     * (`stephen install-helper`). The stop phrase keeps working either way.
     */
    wakeWord: z.boolean().default(true),
    /** Settings > How Stephen talks: reply length, tone, and a closing step line (voice/talk.ts). */
    length: z.enum(LENGTHS).default('brief'),
    tone: z.enum(TONES).default('casual'),
    explain: z.boolean().default(false),
    /** Speak the reply with macOS `say`. */
    speak: z.boolean().default(true),
    /** macOS `say` voice (default: the system voice). */
    voice: voiceName.nullish(),
    /** Speech rate in words per minute (default: the system rate). */
    rate: z.number().int().min(90).max(720).nullish(),
    /** Tink on wake, Pop when done. */
    chimes: z.boolean().default(true),
    /** Silence that ends a short command. */
    silenceSec: z.number().min(0.3).max(3).default(0.8),
    /**
     * Silence that ends a longer command (after ~2.5 s of talking): room for a thinking pause between parts of a
     * multi-step request. Values below silenceSec act like silenceSec.
     */
    longSilenceSec: z.number().min(0.3).max(4).default(1.5),
    /**
     * When a command ends on a joining word ("…and", "…then", "um"), keep listening this many more seconds and
     * join the parts (once). 0 = off. Push-to-talk ends on release and is never extended.
     */
    continueSec: z.number().min(0).max(10).default(4),
    /** Longest wake-word command (whisper hears at most 30 s). */
    maxCommandSec: z.number().min(2).max(60).default(25),
    /** Give up if nothing is said this long after the wake word. */
    noSpeechTimeoutSec: z.number().min(1).max(30).default(5),
    /**
     * Replay recorder (src/replay/recorder.ts, issue #48): save the audio and words of F5 commands on this Mac for
     * 30 days, to measure mistakes. Off by default. Only the owner turns it on: the Settings switch (app.sock
     * `replay.set`, src/app/replay-switch.ts) or config.json by hand. No tool writes this key. The listener re-reads it
     * on every F5 press, so turning it off stops saving at once.
     */
    replay: z.strictObject({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    /** Voice output: `tts` (auto|elevenlabs|kokoro|say), `elevenlabs` {voiceId, modelId, apiKeyFile, timeoutSec}, `kokoro` {speaker, speed}. */
    ...TTS_CONFIG_SHAPE,
  })
  .refine((c) => !(c.wakePhrases && c.wakePhrase), {
    message: 'set either wakePhrases (a list) or the old single wakePhrase, not both',
    path: ['wakePhrase'],
  })
  .refine((c) => !(c.wakePhrases ?? [c.wakePhrase ?? '']).includes(c.stopPhrase), {
    message: 'the stop phrase must differ from every wake phrase',
    path: ['stopPhrase'],
  });


export type VoiceConfig = Omit<
  z.output<typeof VoiceConfigSchema>,
  'device' | 'claudeModel' | 'voice' | 'rate' | 'wakePhrase' | 'wakePhrases' | 'asrModel'
> & {
  /** All wake phrases (deduplicated, ≥ 1). */
  wakePhrases: string[];
  /** The first wake phrase — shown in status lines ("Listening for …"). */
  wakePhrase: string;
  /** The configured speech-to-text model, or null = the default (see resolveAsrModel in models.ts). */
  asrModel: AsrModelId | null;
  device: number | string | null;
  /** `--model` value; null = no flag (config "default"). */
  claudeModel: string | null;
  voice: string | null;
  rate: number | null;
};

export class VoiceConfigError extends ConfigError {
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
  const wakePhrases = [...new Set(r.data.wakePhrases ?? (r.data.wakePhrase ? [r.data.wakePhrase] : DEFAULT_WAKE_PHRASES))];
  return {
    ...r.data,
    wakePhrases,
    wakePhrase: wakePhrases[0]!,
    asrModel: r.data.asrModel ?? null,
    device: r.data.device ?? null,
    claudeModel: resolveClaudeModel(r.data.claudeModel),
    voice: r.data.voice ?? null,
    rate: r.data.rate ?? null,
  };
}
