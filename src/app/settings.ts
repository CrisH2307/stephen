/**
 * What `settings.get` shows in the Stephen window: a read-only snapshot of the resolved voice / memory / history /
 * app config. Built from an allow-list, never by dumping config.json: paths to key files, the Claude binary and the
 * ElevenLabs settings are left out, so nothing secret (or secret-adjacent) can reach the window even if config.json
 * grows new keys.
 */
import type { HistoryConfig } from '../history/config.js';
import type { MemoryConfig } from '../memory/config.js';
import { DEFAULT_ASR_MODEL, type VoiceConfig } from '../voice/config.js';
import { TALK_SAMPLES, type TalkState } from '../voice/talk.js';
import type { AppConfig } from './config.js';
import { talkFromConfig } from './talk.js';

export interface AppSettings {
  config: Record<string, unknown>;
  configPath: string;
}

export function appSettings(o: { voice: VoiceConfig; memory: MemoryConfig; history: HistoryConfig; app: AppConfig; configPath: string; talk?: TalkState }): AppSettings {
  const v = o.voice;
  const talk = o.talk ?? talkFromConfig(v);
  return {
    config: {
      voice: {
        model: v.claudeModel ?? 'default',
        maxTurns: v.maxTurns,
        asrModel: v.asrModel ?? DEFAULT_ASR_MODEL,
        wakeWord: v.wakeWord,
        wakePhrases: [...v.wakePhrases],
        stopPhrase: v.stopPhrase,
        speak: talk.speak,
        tts: v.tts,
        chimes: v.chimes,
        followUpWindowSec: v.followUpWindowSec,
        cooldownSec: v.cooldownSec,
        ...(v.aboutMe ? { aboutMe: v.aboutMe } : {}),
      },
      // How Stephen talks (settings.set): the current values plus the preview sentences (voice/talk.ts).
      talk: { ...talk, samples: TALK_SAMPLES },
      memory: { enabled: o.memory.enabled, confirmWakeWord: o.memory.confirmWakeWord, maxItems: o.memory.maxItems },
      history: { enabled: o.history.retentionDays > 0, retentionDays: o.history.retentionDays },
      app: { enabled: o.app.enabled, speakReplies: o.app.speakReplies },
    },
    configPath: o.configPath,
  };
}
