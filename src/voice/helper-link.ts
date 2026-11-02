/**
 * The listener's view of "Stephen Helper" (the Swift menu-bar agent, track A). The helper supplies key events
 * (push-to-talk Fn+Option, Esc) and whether the Mac is playing sound; the microphone stays with `stephen listen`.
 *
 * `HelperLink` is a local, structurally compatible copy of `IHelperClient` from `src/helper/client.ts`, so the
 * listener can be built and tested without that module (a fake in tests; the real client is loaded lazily).
 * `HelperBridge` wraps a started link: it tracks the connection and the latest `audio` event, dedupes menu-bar
 * `state` updates and answers "is sound playing right now?" with a fresh `query_audio`.
 */
import type { HelperCommand, HelperEvent } from '../helper/protocol.js';
import type { Phase } from './assistant.js';

export type HelperEventType = HelperEvent['type'];
export type HelperEventOf<T extends HelperEventType> = Extract<HelperEvent, { type: T }>;
export type HelperStartResult = { ok: true; hello: HelperEventOf<'hello'> } | { ok: false; reason: string };
export type MenuState = Extract<HelperCommand, { type: 'state' }>['state'];

/** Structurally compatible with `IHelperClient` (src/helper/client.ts). */
export interface HelperLink {
  start(): Promise<HelperStartResult>;
  on<T extends HelperEventType>(event: T, fn: (e: HelperEventOf<T>) => void): () => void;
  send(cmd: HelperCommand): void;
  close(): void;
  /** True while connected (the real client has it; a link without it counts as connected after start()). */
  readonly connected?: boolean;
  onConnection?(fn: (connected: boolean) => void): () => void;
}

export const HELPER_HINT = 'Install the helper for push-to-talk and no wake-word cooldown: stephen install-helper';
export const PTT_NEEDS_HELPER =
  'Push-to-talk only (voice.wakeWord false / --ptt-only) needs Stephen Helper for the F5 / Fn+Option keys: run `stephen install-helper`, ' +
  'or turn the wake word back on.';
/** How long to wait for a fresh `audio` answer before using the last known value. */
export const AUDIO_QUERY_WAIT_MS = 300;

export class HelperBridge {
  private up = true;
  private playing: boolean | null = null;
  private lastState: MenuState | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly link: HelperLink) {
    this.offs.push(link.on('audio', (e) => (this.playing = e.playing)));
    const onConn = link.onConnection?.((c) => {
      this.up = c;
      if (!c) this.playing = null; // unknown until the next hello/audio
      else {
        link.send({ type: 'query_audio' });
        if (this.lastState) link.send({ type: 'state', state: this.lastState });
      }
    });
    if (onConn) this.offs.push(onConn);
    link.send({ type: 'query_audio' });
  }

  /** Start the link; null (with the reason) when the helper is not available. Never throws. */
  static async connect(link: HelperLink): Promise<{ bridge: HelperBridge } | { reason: string }> {
    let r: HelperStartResult;
    try {
      r = await link.start();
    } catch (e) {
      r = { ok: false, reason: (e as Error).message };
    }
    if (!r.ok) {
      try {
        link.close();
      } catch {
        // ignore
      }
      return { reason: r.reason };
    }
    return { bridge: new HelperBridge(link) };
  }

  get connected(): boolean {
    return this.link.connected ?? this.up;
  }

  /** Latest `audio.playing` from the helper; null when unknown or disconnected. */
  get audioPlaying(): boolean | null {
    return this.connected ? this.playing : null;
  }

  on<T extends HelperEventType>(event: T, fn: (e: HelperEventOf<T>) => void): () => void {
    const off = this.link.on(event, fn);
    this.offs.push(off);
    return off;
  }

  /** Menu-bar indicator; consecutive duplicates are not re-sent. */
  setState(state: MenuState): void {
    if (state === this.lastState) return;
    this.lastState = state;
    this.link.send({ type: 'state', state });
  }

  get state(): MenuState | null {
    return this.lastState;
  }

  /** Ask the helper to show the Stephen window (`stephen app` through app.sock). false when not connected. */
  openWindow(): boolean {
    if (!this.connected) return false;
    this.link.send({ type: 'open_window' });
    return true;
  }

  /**
   * Is the Mac playing sound right now? Sends `query_audio` and waits up to `waitMs` for the answer, else uses the
   * last known value. Without a connected helper: false (callers then behave as before the helper existed).
   */
  queryAudio(waitMs: number = AUDIO_QUERY_WAIT_MS): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(v);
      };
      const timer = setTimeout(() => finish(this.playing ?? false), waitMs);
      const off = this.link.on('audio', (e) => finish(e.playing));
      this.link.send({ type: 'query_audio' });
    });
  }

  close(): void {
    this.setState('idle');
    for (const off of this.offs.splice(0)) off();
    try {
      this.link.close();
    } catch {
      // ignore
    }
  }
}

/** Assistant hooks that report its phases to the menu bar and keep replies quiet while sound plays. */
export function assistantHooks(bridge: HelperBridge | null): { onPhase?: (p: Phase) => void; soundPlaying?: () => Promise<boolean> } {
  if (!bridge) return {};
  return {
    onPhase: (p) => {
      if (p === 'running') bridge.setState('working');
      else if (p === 'speaking') bridge.setState('speaking');
    },
    soundPlaying: () => bridge.queryAudio(),
  };
}

/**
 * The real client from track A (`src/helper/client.ts`, `createHelperClient({ home })`), loaded lazily so this
 * branch builds and runs without it. Returns null when the module or its factory is missing.
 */
export async function loadHelperClient(home: string): Promise<HelperLink | null> {
  const spec = '../helper/client.js';
  let mod: { createHelperClient?: (o: { home: string }) => HelperLink };
  try {
    mod = (await import(/* @vite-ignore */ spec)) as typeof mod;
  } catch {
    return null;
  }
  if (typeof mod.createHelperClient !== 'function') return null;
  try {
    return mod.createHelperClient({ home });
  } catch {
    return null;
  }
}
