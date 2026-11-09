/**
 * settings.set: the five "How Stephen talks" settings. They live in config.json's "voice" section (length, tone,
 * explain, speak, tts), where hand-edited config already is, so `stephen listen` reads them the same way at start.
 * The store keeps the current values for the running listener: the persona and the speaker read them at the next
 * command (the persona of a warm conversation that is already running changes at the next conversation).
 */
import { updateConfigSection } from '../config-write.js';
import type { VoiceConfig } from '../voice/config.js';
import type { TalkState } from '../voice/talk.js';

/** tts "auto" starts at ElevenLabs (when a key exists), so the app shows it as ElevenLabs. */
export function talkFromConfig(v: Pick<VoiceConfig, 'length' | 'tone' | 'explain' | 'speak' | 'tts'>): TalkState {
  return { length: v.length, tone: v.tone, explain: v.explain, speak: v.speak, voice: v.tts === 'auto' ? 'elevenlabs' : v.tts };
}

export class TalkStore {
  private state: TalkState;
  constructor(
    private readonly file: string,
    initial: TalkState,
  ) {
    this.state = { ...initial };
  }

  get(): TalkState {
    return { ...this.state };
  }

  /** Validated changes (checkTalkChanges): written to config.json first, then applied. Throws if the file can't be written. */
  set(changes: Partial<TalkState>): TalkState {
    const next = { ...this.state, ...changes };
    // Only what changed is written (an untouched "tts": "auto" stays auto).
    const { voice: tts, ...rest } = changes;
    updateConfigSection(this.file, 'voice', (old) => ({ ...old, ...rest, ...(tts ? { tts } : {}) }));
    this.state = next;
    return this.get();
  }
}
