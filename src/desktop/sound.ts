/**
 * Phase 1.8 track C: `volume` and `media_control` — small, safe desktop controls for one-shot requests like
 * "turn it down and play the next song".
 *
 *  - Both run fixed JXA scripts with `osascript -l JavaScript -e <script> <args…>`: the arguments reach the script
 *    as `run(argv)` strings, never as script text, and they are validated here first (an enum, a 0–100 integer).
 *  - `volume` changes the Mac's output volume / mute (Standard Additions). No app is touched.
 *  - `media_control` sends play / pause / toggle / next / previous to Spotify or Apple Music — only if that app is
 *    ALREADY running (it never launches one). The first use asks macOS for Automation permission ("osascript wants
 *    to control Spotify"). This is media_control's FALLBACK: a YouTube Music or YouTube tab comes first, and is
 *    controlled in src/desktop/media-tab.ts through the browser safety gate (the only way into a page).
 */
import { BIN, type DesktopDeps } from './system.js';

export const VOLUME_ACTIONS = ['set', 'up', 'down', 'mute', 'unmute'] as const;
export type VolumeAction = (typeof VOLUME_ACTIONS)[number];
export const MEDIA_ACTIONS = ['play', 'pause', 'toggle', 'next', 'previous'] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];
export const PLAYERS = ['Spotify', 'Music'] as const;
export type Player = (typeof PLAYERS)[number];

/** Default step for "turn it up / down". */
export const VOLUME_STEP = 10;
const TIMEOUT_MS = 8000;

/** argv[0] = action, argv[1] = number (0–100). Prints {"volume": n, "muted": b}. */
export const VOLUME_JXA = `function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var a = argv[0], n = Number(argv[1]);
  if (!(n >= 0 && n <= 100)) throw new Error('bad level');
  var cur = app.getVolumeSettings().outputVolume;
  if (a === 'set') app.setVolume(null, { outputVolume: n, outputMuted: false });
  else if (a === 'up') app.setVolume(null, { outputVolume: Math.min(100, cur + n), outputMuted: false });
  else if (a === 'down') app.setVolume(null, { outputVolume: Math.max(0, cur - n) });
  else if (a === 'mute') app.setVolume(null, { outputMuted: true });
  else if (a === 'unmute') app.setVolume(null, { outputMuted: false });
  else throw new Error('bad action');
  var s = app.getVolumeSettings();
  return JSON.stringify({ volume: s.outputVolume, muted: s.outputMuted });
}`;

/**
 * argv = ["status"] → {"Spotify": {running, state}, "Music": {…}} without launching anything;
 * argv = [action, player] → acts on that player if it is running; prints {"state": …}.
 */
export const PLAYERS_JXA = `function run(argv) {
  function info(name) {
    var p;
    try { p = Application(name); } catch (e) { return { running: false }; }
    var running = false;
    try { running = p.running(); } catch (e) {}
    if (!running) return { running: false };
    var st = 'unknown';
    try { st = String(p.playerState()); } catch (e) {}
    return { running: true, state: st };
  }
  if (argv[0] === 'status') return JSON.stringify({ Spotify: info('Spotify'), Music: info('Music') });
  var a = argv[0], name = argv[1];
  if (name !== 'Spotify' && name !== 'Music') throw new Error('bad player');
  var p = Application(name);
  if (!p.running()) throw new Error('not running');
  if (a === 'play') p.play();
  else if (a === 'pause') p.pause();
  else if (a === 'toggle') p.playpause();
  else if (a === 'next') p.nextTrack();
  else if (a === 'previous') p.previousTrack();
  else throw new Error('bad action');
  var st = 'unknown';
  try { st = String(p.playerState()); } catch (e) {}
  return JSON.stringify({ state: st });
}`;

export interface VolumeState {
  volume: number | null;
  muted: boolean | null;
}

export function parseVolume(stdout: string): VolumeState {
  try {
    const o = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const v = o.volume;
    return {
      volume: typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null,
      muted: typeof o.muted === 'boolean' ? o.muted : null,
    };
  } catch {
    return { volume: null, muted: null };
  }
}

/** The number passed to the script: `level` for set (required), `step` for up/down (default VOLUME_STEP), 0 otherwise. */
export function volumeArg(action: VolumeAction, level: number | undefined): number {
  if (action === 'set') {
    if (level === undefined) throw new Error('volume set needs a level from 0 to 100');
    return level;
  }
  if (action === 'up' || action === 'down') return level ?? VOLUME_STEP;
  return 0;
}

export async function setVolume(deps: DesktopDeps, action: VolumeAction, level: number | undefined): Promise<VolumeState> {
  if (!VOLUME_ACTIONS.includes(action)) throw new Error('bad volume action');
  const n = volumeArg(action, level);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('the volume level must be a whole number from 0 to 100');
  const r = await deps.execFile(BIN.osascript, ['-l', 'JavaScript', '-e', VOLUME_JXA, action, String(n)], { timeoutMs: TIMEOUT_MS });
  return parseVolume(r.stdout);
}

export interface PlayerInfo {
  running: boolean;
  /** "playing" | "paused" | "stopped" | "unknown" (when running). */
  state?: string;
}
export type PlayersStatus = Record<Player, PlayerInfo>;

const STATES = new Set(['playing', 'paused', 'stopped', 'unknown']);

export function parsePlayers(stdout: string): PlayersStatus {
  const out: PlayersStatus = { Spotify: { running: false }, Music: { running: false } };
  try {
    const o = JSON.parse(stdout.trim()) as Record<string, unknown>;
    for (const p of PLAYERS) {
      const v = o[p] as Record<string, unknown> | undefined;
      if (v && v.running === true) {
        const st = String(v.state ?? 'unknown').toLowerCase();
        out[p] = { running: true, state: STATES.has(st) ? st : 'unknown' };
      }
    }
  } catch {
    /* nothing running as far as we can tell */
  }
  return out;
}

export async function playersStatus(deps: DesktopDeps): Promise<PlayersStatus> {
  try {
    const r = await deps.execFile(BIN.osascript, ['-l', 'JavaScript', '-e', PLAYERS_JXA, 'status'], { timeoutMs: TIMEOUT_MS });
    return parsePlayers(r.stdout);
  } catch {
    return { Spotify: { running: false }, Music: { running: false } };
  }
}

/**
 * Which player an action goes to. `want` (the user named one) must be running. Otherwise: the one that is playing;
 * else, for play/toggle/next/previous, the one that is paused (Spotify first); else none.
 */
export function pickPlayer(st: PlayersStatus, action: MediaAction, want?: Player): Player | null {
  if (want) return st[want].running ? want : null;
  const playing = PLAYERS.find((p) => st[p].running && st[p].state === 'playing');
  if (playing) return playing;
  if (action === 'pause') return null; // nothing is playing in Spotify/Music: nothing to pause there
  return PLAYERS.find((p) => st[p].running && st[p].state === 'paused') ?? PLAYERS.find((p) => st[p].running) ?? null;
}

export async function controlPlayer(deps: DesktopDeps, action: MediaAction, player: Player): Promise<string> {
  if (!MEDIA_ACTIONS.includes(action) || !PLAYERS.includes(player)) throw new Error('bad media action');
  const r = await deps.execFile(BIN.osascript, ['-l', 'JavaScript', '-e', PLAYERS_JXA, action, player], { timeoutMs: TIMEOUT_MS });
  try {
    const st = String((JSON.parse(r.stdout.trim()) as { state?: unknown }).state ?? 'unknown').toLowerCase();
    return STATES.has(st) ? st : 'unknown';
  } catch {
    return 'unknown';
  }
}


/**
 * Duck on wake (issue #205). argv = ["duck", level]: lower the output volume to `level` when it is louder and not
 * muted; prints {"saved": <old volume> | null} (null = nothing changed). argv = ["restore", n]: set the volume to n
 * (mute untouched).
 */
export const DUCK_JXA = `function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var n = Number(argv[1]);
  if (!(n >= 0 && n <= 100)) throw new Error('bad level');
  if (argv[0] === 'restore') { app.setVolume(null, { outputVolume: n }); return '{}'; }
  if (argv[0] !== 'duck') throw new Error('bad action');
  var s = app.getVolumeSettings();
  if (s.outputMuted || !(s.outputVolume > n)) return JSON.stringify({ saved: null });
  app.setVolume(null, { outputVolume: n });
  return JSON.stringify({ saved: s.outputVolume });
}`;

const level = (n: number): string => {
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('the volume level must be a whole number from 0 to 100');
  return String(n);
};

/** Lower the volume to `to`; resolves with the volume to restore later, or null when nothing changed. */
export async function duckVolume(deps: DesktopDeps, to: number): Promise<number | null> {
  const r = await deps.execFile(BIN.osascript, ['-l', 'JavaScript', '-e', DUCK_JXA, 'duck', level(to)], { timeoutMs: TIMEOUT_MS });
  try {
    const v = (JSON.parse(r.stdout.trim()) as { saved?: unknown }).saved;
    return typeof v === 'number' && v >= 0 && v <= 100 ? Math.round(v) : null;
  } catch {
    return null;
  }
}

export async function restoreVolume(deps: DesktopDeps, to: number): Promise<void> {
  await deps.execFile(BIN.osascript, ['-l', 'JavaScript', '-e', DUCK_JXA, 'restore', level(to)], { timeoutMs: TIMEOUT_MS });
}
