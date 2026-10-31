/**
 * Stephen Helper ⇄ Node protocol (FROZEN contract for phase 1.5 — see docs/HANDOVER.md).
 *
 * "Stephen Helper.app" is a tiny signed Swift menu-bar agent (LSUIElement) built on the user's Mac by
 * `stephen install-helper`. It owns the Input Monitoring permission (global Fn+Option and Esc) and watches
 * whether the Mac is playing sound. It does NOT record audio (the microphone stays with `stephen listen`).
 *
 * Transport: a Unix domain socket created by the HELPER at `<stephen home>/run/helper.sock` (dir 0700,
 * socket 0600). `stephen listen` connects as a client (one client at a time; a new client replaces the old).
 * Messages are newline-delimited JSON objects, UTF-8, one per line, ≤ 4 KiB each. Unknown types are ignored
 * by both sides. The helper is started with `open -a "<path>/Stephen Helper.app" --args --home <home>`
 * so macOS attributes permissions to the helper app itself (not to Terminal).
 */

/** helper → node */
export type HelperEvent =
  | { type: 'hello'; version: string; inputMonitoring: boolean }
  /** Fn+Option both went down (push-to-talk pressed). */
  | { type: 'ptt_down'; at: number }
  /**
   * Either key released (push-to-talk released). `heldMs` = how long both were held. `aborted: true` is set only
   * by the Node client when the connection dropped mid-press (no real release was seen): the listener must
   * DISCARD that recording, never send a cut-off command (review #4 finding 1).
   */
  | { type: 'ptt_up'; at: number; heldMs: number; aborted?: boolean }
  /** Esc pressed (listen-only: the key still reaches the frontmost app in phase 1.5). */
  | { type: 'esc'; at: number }
  /** Default output device started/stopped playing sound (CoreAudio kAudioDevicePropertyDeviceIsRunningSomewhere). */
  | { type: 'audio'; playing: boolean; at: number }
  | { type: 'error'; message: string };

/** node → helper */
export type HelperCommand =
  /** Menu-bar indicator state. */
  | { type: 'state'; state: 'idle' | 'listening' | 'recording' | 'working' | 'speaking' }
  /** Ask for a fresh `audio` event. */
  | { type: 'query_audio' }
  | { type: 'quit' };

export const HELPER_PROTOCOL_VERSION = '1';
/** Push-to-talk presses shorter than this are ignored (accidental taps). */
export const PTT_MIN_HOLD_MS = 250;
/** Recording stops at this length even if the keys are still held. */
export const PTT_MAX_HOLD_MS = 30_000;
