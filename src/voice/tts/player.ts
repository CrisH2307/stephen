/** Shared pieces of the TTS providers: failures, private temp audio files, and the `afplay` player. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeakHandle } from '../speech.js';
import type { TtsProviderName } from './types.js';

export type TtsFailureReason =
  | 'no-key'
  | 'bad-key'
  | 'no-credits'
  | 'voice'
  | 'rate-limited'
  | 'network'
  | 'timeout'
  | 'http'
  | 'not-installed'
  | 'engine'
  | 'player';

/** A provider could not speak. `sticky` = don't try this provider again in this session (bad key, no credits…). */
export class TtsFailure extends Error {
  constructor(
    readonly provider: TtsProviderName,
    readonly reason: TtsFailureReason,
    message: string,
    readonly sticky: boolean = false,
  ) {
    super(message);
    this.name = 'TtsFailure';
  }
}

/**
 * One voice. `speak().done` resolves when the speech finished or was cancelled, and REJECTS with a TtsFailure
 * when this provider could not say it (the chain then tries the next one).
 */
export interface TtsProvider {
  readonly name: TtsProviderName;
  speak(text: string): SpeakHandle;
}

export interface PlayHandle {
  /** Resolves when playback ends or is cancelled; rejects (TtsFailure 'player') when the player fails. */
  done: Promise<void>;
  cancel(): void;
}
export type PlayFn = (file: string, provider: TtsProviderName) => PlayHandle;

/** Play an audio file with `afplay` (macOS); cancel kills it. `command` is injectable for tests. */
export function afplayPlayer(command = 'afplay'): PlayFn {
  return (file, provider) => {
    const child = spawn(command, [file], { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let killed = false;
    let err = '';
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d.slice(0, 500)));
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', (e: NodeJS.ErrnoException) =>
        reject(new TtsFailure(provider, 'player', e.code === 'ENOENT' ? `${command} is not available (macOS only)` : `${command} failed: ${e.message}`, e.code === 'ENOENT')),
      );
      child.once('close', (code, signal) => {
        if (killed || code === 0) resolve();
        else reject(new TtsFailure(provider, 'player', `${command} failed: ${err.trim().split('\n')[0] || (signal ?? `exit ${code}`)}`));
      });
    });
    return {
      done,
      cancel: () => {
        killed = true;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      },
    };
  };
}

/**
 * Temp folders still in use. `process.exit()` (server shutdown) skips pending async cleanup, so they are removed
 * synchronously on 'exit' as well (review #4 finding 4).
 */
const liveTempDirs = new Set<string>();
let exitHookInstalled = false;
function trackTempDir(dir: string): void {
  liveTempDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const d of liveTempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
}

/** Write audio to a new private temp folder (0700) as a 0600 file; `cleanup` removes both. */
export async function writePrivateTemp(data: Uint8Array, ext: string, root: string = tmpdir()): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(root, 'stephen-tts-'));
  trackTempDir(dir);
  const file = join(dir, `speech.${ext}`);
  const cleanup = () =>
    rm(dir, { recursive: true, force: true })
      .then(() => {
        liveTempDirs.delete(dir);
      })
      .catch(() => undefined);
  try {
    await writeFile(file, data, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    await cleanup();
    throw e;
  }
  return { file, cleanup };
}

/** Play `data` from a private temp file and delete it afterwards; honours a cancel that arrived meanwhile. */
export async function playBuffer(
  data: Uint8Array,
  ext: string,
  provider: TtsProviderName,
  play: PlayFn,
  state: { cancelled: boolean; player: PlayHandle | null },
  tmpRoot?: string,
): Promise<void> {
  const { file, cleanup } = await writePrivateTemp(data, ext, tmpRoot);
  try {
    if (state.cancelled) return;
    state.player = play(file, provider);
    await state.player.done;
  } finally {
    state.player = null;
    await cleanup();
  }
}
