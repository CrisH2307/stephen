/**
 * Wake word while sound plays (issue #205): Stephen lowers the volume, listens, and takes only a media command.
 *
 * Safety rule: a video can say "Hey Stephen". So after a wake word WHILE SOUND WAS PLAYING, the grammar classifier
 * (src/voice/grammar/classify.ts, Tier 1) decides, never the model: only stop, pause, play / resume, next,
 * previous, volume and mute run, here, without Claude. Anything else is not run ("Hold F5 for that."). The worst a
 * video can do is pause the music or change the volume. F5 keeps full commands. Nothing spoken is a confirmation.
 */
import { controlPlayer, duckVolume, pickPlayer, playersStatus, restoreVolume, setVolume, type MediaAction } from '../desktop/sound.js';
import type { DesktopDeps } from '../desktop/system.js';
import { classify } from './grammar/classify.js';
import type { HelperBridge, MediaKeyAction } from './helper-link.js';

export type MediaCommand =
  | { verb: 'pause' | 'stop' | 'play' | 'resume' | 'next' | 'previous' | 'mute' | 'unmute' }
  | { verb: 'volume'; arg: 'up' | 'down' | number };

export const HOLD_F5 = 'Hold F5 for that.';
/** Default `voice.duckVolume`: the output volume while Stephen listens over playing sound. */
export const DEFAULT_DUCK_VOLUME = 20;

/** The media command `text` is, or null. No owner lists: "play <title>" and "open <app>" are never media commands. */
export function mediaCommand(text: string): MediaCommand | null {
  const k = classify(text, { apps: [], sites: {} });
  if (k.tier !== 1) return null;
  switch (k.verb) {
    case 'play':
      return k.arg === undefined && !k.entity ? { verb: 'play' } : null;
    case 'pause':
    case 'stop':
    case 'resume':
    case 'next':
    case 'previous':
    case 'mute':
    case 'unmute':
      return { verb: k.verb };
    case 'volume':
      return k.arg === 'up' || k.arg === 'down' || typeof k.arg === 'number' ? { verb: 'volume', arg: k.arg } : null;
    default:
      return null; // open, timer, remember, forget
  }
}

/** What the listener needs for sound (injected; fakes in tests). */
export interface SoundControl {
  /** Lower the output volume to `level`; resolves with the volume to restore (null = nothing was changed). */
  duck(level: number): Promise<number | null>;
  restore(volume: number): Promise<void>;
  /** Run one media command. Resolves with a short status line; rejects when it could not be done. */
  media(cmd: MediaCommand): Promise<string>;
}

const LABEL: Record<MediaCommand['verb'], string> = {
  pause: 'Paused.', stop: 'Paused.', play: 'Playing.', resume: 'Playing.', next: 'Next track.', previous: 'Previous track.',
  mute: 'Muted.', unmute: 'Unmuted.', volume: 'Volume changed.',
};

/**
 * The real SoundControl: volume by AppleScript, media keys through Stephen Helper, and Spotify / Apple Music by
 * AppleScript when the key can't be pressed.
 */
export function soundControl(deps: DesktopDeps, bridge: () => HelperBridge | null): SoundControl {
  return {
    duck: (level) => duckVolume(deps, level),
    restore: (v) => restoreVolume(deps, v),
    async media(c) {
      if (c.verb === 'volume') {
        const st = typeof c.arg === 'number' ? await setVolume(deps, 'set', c.arg) : await setVolume(deps, c.arg, undefined);
        return st.volume !== null ? `Volume ${st.volume}%.` : LABEL.volume;
      }
      if (c.verb === 'mute' || c.verb === 'unmute') {
        await setVolume(deps, c.verb, undefined);
        return LABEL[c.verb];
      }
      const action: MediaKeyAction & MediaAction = c.verb === 'stop' ? 'pause' : c.verb === 'resume' ? 'play' : c.verb;
      const r = (await bridge()?.media(action)) ?? { ok: false, reason: "Stephen Helper isn't connected" };
      if (r.ok) return LABEL[c.verb];
      const p = pickPlayer(await playersStatus(deps), action);
      if (!p) throw new Error(r.reason);
      await controlPlayer(deps, action, p);
      return LABEL[c.verb];
    },
  };
}
