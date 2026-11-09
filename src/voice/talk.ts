/**
 * "How Stephen talks" (Settings, UI-PLAN section 8): length, tone and explain-steps choose between small FIXED sentences
 * of the persona; speak and voice are the existing voice.speak and voice.tts. Nothing free-form from settings ever
 * reaches the prompt: values are enums and booleans, checked by checkTalkChanges.
 */
export const LENGTHS = ['brief', 'balanced', 'detailed'] as const;
export const TONES = ['casual', 'friendly', 'formal'] as const;
/** The preferred start of the fallback chain ElevenLabs, Kokoro, macOS say (voice.tts). */
export const VOICES = ['elevenlabs', 'kokoro', 'say'] as const;
export type Length = (typeof LENGTHS)[number];
export type Tone = (typeof TONES)[number];
export type VoiceChoice = (typeof VOICES)[number];

/** What the persona is built from. */
export interface TalkPrefs {
  length: Length;
  tone: Tone;
  explain: boolean;
}
/** TalkPrefs plus the two settings that live elsewhere in the voice config. */
export interface TalkState extends TalkPrefs {
  speak: boolean;
  voice: VoiceChoice;
}

/** Brief + Casual is exactly the persona Stephen always had (test/voice/talk.test.ts pins it). */
export const DEFAULT_TALK: TalkPrefs = { length: 'brief', tone: 'casual', explain: false };

const SAFETY_LINE =
  'Anything about safety — a refusal, a blocked site, a confirmation the user declined or still has to answer — say plainly and seriously, without slang.';

export const TONE_LINES: Record<Tone, string> = {
  casual:
    'Talk like a chill Gen-Z friend: casual, warm and quick ("bet", "got you", "say less", "on it"). Never say "certainly" or "I\'d be happy to", and never mock or roast the user. ' +
    SAFETY_LINE,
  friendly: `Talk like a warm, friendly helper: kind and relaxed, in plain words with no slang. Never say "certainly" or "I'd be happy to", and never mock or roast the user. ${SAFETY_LINE}`,
  formal: `Talk like a polite, professional assistant: complete sentences, no slang and no contractions. Never mock or roast the user. ${SAFETY_LINE}`,
};

const PLAIN = 'Plain words, no markdown, no lists, no links, no emoji.';
export const LENGTH_LINES: Record<Length, string> = {
  brief: `Reply in one or two short spoken sentences that cover every part: what you did, what you guessed, and anything that failed. ${PLAIN}`,
  balanced: `Reply in about three or four short spoken sentences that cover every part: what you did, what you guessed, and anything that failed, with the one detail that helps most. ${PLAIN}`,
  detailed: `Reply in up to six short spoken sentences that cover every part: what you did, how, what you guessed, and anything that failed, with the details that help. ${PLAIN}`,
};

export const EXPLAIN_LINE =
  'Also say what you did step by step: end your reply with one short plain line that walks through the steps in order, like "I opened Notion, then searched for your page."';

/** Sample replies for the Settings preview (the app picks one locally from the choices; never sent to Claude). */
export const TALK_SAMPLES: Record<Length, Record<Tone, string>> = {
  brief: { casual: 'Bet, playing lofi beats.', friendly: 'Sure, playing some lofi for you.', formal: 'Certainly. I am playing lofi music now.' },
  balanced: {
    casual: 'Got you, lofi is playing on YouTube Music. I picked a popular beats playlist, say the word if you want a different one.',
    friendly: 'Sure thing, lofi is playing on YouTube Music now. I picked a popular beats playlist, so tell me if you would like a different one.',
    formal: 'Certainly. Lofi is now playing on YouTube Music. I selected a popular beats playlist; please tell me if you prefer another.',
  },
  detailed: {
    casual:
      'On it, lofi is playing on YouTube Music. I opened a tab, found a popular beats playlist and started it. The volume is where it was. Say the word if you want a different vibe.',
    friendly:
      'Sure thing, lofi is playing on YouTube Music now. I opened a new tab, found a popular beats playlist and started it. The volume is unchanged, and I can pick something different if you like.',
    formal:
      'Certainly. Lofi is now playing on YouTube Music. I opened a new tab, located a popular beats playlist and started it. The volume is unchanged. Please let me know if you would like a different selection.',
  },
};

const FIELDS: Record<keyof TalkState, readonly unknown[] | 'boolean'> = {
  length: LENGTHS,
  tone: TONES,
  speak: 'boolean',
  explain: 'boolean',
  voice: VOICES,
};

export type TalkCheck = { ok: true; changes: Partial<TalkState> } | { ok: false; message: string };

/** Strict: a non-empty object, only the five known keys, each an allowed enum value or a boolean. */
export function checkTalkChanges(v: unknown): TalkCheck {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, message: 'values must be an object' };
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, message: 'values is empty' };
  const changes: Record<string, unknown> = {};
  for (const [k, x] of entries) {
    const rule = (FIELDS as Record<string, readonly unknown[] | 'boolean' | undefined>)[Object.hasOwn(FIELDS, k) ? k : ''];
    if (!rule) return { ok: false, message: `unknown setting "${k.slice(0, 40)}"` };
    if (rule === 'boolean' ? typeof x !== 'boolean' : !rule.includes(x)) {
      return { ok: false, message: rule === 'boolean' ? `${k} must be true or false` : `${k} must be one of ${rule.join(', ')}` };
    }
    changes[k] = x;
  }
  return { ok: true, changes: changes as Partial<TalkState> };
}
