/**
 * Replay recorder (item 4, A6a, issue #48): saves F5 commands on this Mac so mistakes can be measured later.
 *
 * - Off by default (`voice.replay.enabled`, owner-only: config.json today, the Settings switch in PR 2). The listener
 *   asks `enabled()` on every capture, so turning it off stops saving at once.
 * - Records source `voice-ptt` only (F5, and the Ask box mic / Talk button, which press F5 in the helper). The wake
 *   word, the Stephen app's typed commands, `listen --text` and the phone never record.
 * - Per clip, in `<home>/replay/` (0700): `<id>.wav` (16 kHz mono 16-bit, only the captured command, created once
 *   with O_CREAT|O_EXCL|O_NOFOLLOW, 0600) and `<id>.json` (command id, trigger, start time, transcript; written with
 *   a temp file inside the folder + rename, 0600, so the label command in PR 3 can rewrite it the same way).
 * - Kept out of Time Machine (the backup-exclude attribute) and Spotlight (.metadata_never_index). Refuses to write when the
 *   folder resolves into iCloud Drive, ~/Library/CloudStorage or ~/Dropbox.
 * - Purged at listener start, every 6 hours while the listener runs, and on each write, by the clip's own start
 *   time (30 days; a start more than a day in the future is dropped), at most 100 clips and 50 MB of audio per day.
 * - Writes run after the command was handed off, one at a time, never awaited by the listener; a failure is
 *   swallowed and counted as `replay_write_failed`.
 *
 * Only src/voice/ (the listener) and src/cli.ts (`stephen replay delete`) load this file: nothing Claude can reach
 * may (test/replay/boundary.test.ts).
 */
import { execFile } from 'node:child_process';
import { chmodSync, constants as fsConstants, lstatSync, mkdirSync, openSync, closeSync, readdirSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validCommandId } from '../lib/command-id.js';
import { isInside, readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { REPLAY_DIR_NAME, realThroughParent } from '../lib/owner-only.js';
import { encodeWav16 } from '../voice/wav.js';

export const REPLAY_MAX_AGE_MS = 30 * 24 * 3600_000;
/** How often a running listener purges, so clips expire on time with the switch off or no F5 for weeks (#169). */
export const REPLAY_PURGE_EVERY_MS = 6 * 3600_000;
const FUTURE_SLACK_MS = 24 * 3600_000;
export const REPLAY_MAX_CLIPS = 100;
export const REPLAY_MAX_DAY_BYTES = 50 * 1024 * 1024;
/** The one source that records (F5). */
export const REPLAY_SOURCE = 'voice-ptt';
/** The code word a failed write is counted as. */
export const REPLAY_WRITE_FAILED = 'replay_write_failed';
const MAX_TRANSCRIPT_CHARS = 2000;
const NEVER_INDEX = '.metadata_never_index';

const CLIP_RE = /^(h_[0-9a-f]{16})\.(wav|json)$/;
const TEMP_RE = /^\.h_[0-9a-f]{16}\.json\..*\.tmp$/;

export function replayDir(home: string): string {
  return join(home, REPLAY_DIR_NAME);
}

/** What one clip's sidecar holds. Labels (PR 3) are added to the same file. */
export interface ReplaySidecar {
  v: 1;
  id: string;
  trigger: 'f5';
  /** Epoch ms of the F5 press: the 30-day purge goes by this. */
  startedAt: number;
  /** What speech-to-text heard. */
  transcript: string;
}

export interface ReplayCapture {
  id: string;
  /** The command source; anything but REPLAY_SOURCE is ignored. */
  source: string;
  startedAt: number;
  audio: Float32Array;
  transcript: string;
}

/** The synced folder `path` lies in (by its real path), or null. */
export function syncedFolder(path: string, userHome: string = homedir()): string | null {
  const p = realThroughParent(path);
  const u = realThroughParent(userHome);
  const places: [string, string][] = [
    [join(u, 'Library', 'Mobile Documents'), 'iCloud Drive'],
    [join(u, 'Library', 'CloudStorage'), 'a cloud storage folder'],
    [join(u, 'Dropbox'), 'Dropbox'],
  ];
  for (const [dir, name] of places) if (isInside(p, dir)) return name;
  return null;
}

/**
 * The backup-exclude attribute: what `tmutil addexclusion` sets (sticky: it travels with the folder), written with
 * xattr because tmutil itself can take ~11 s outside a terminal. `tmutil isexcluded` reports it. Throws when it
 * fails. Not a Mac: no Time Machine.
 */
async function backupExclude(dir: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  await promisify(execFile)('/usr/bin/xattr', ['-w', 'com.apple.metadata:com_apple_backup_excludeItem', 'com.apple.backupd', dir], { timeout: 10_000 });
}

interface ClipInfo {
  id: string;
  startedAt: number;
  bytes: number;
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function removeClip(dir: string, id: string): void {
  unlinkQuiet(join(dir, `${id}.wav`));
  unlinkQuiet(join(dir, `${id}.json`));
}

function readSidecar(dir: string, id: string): ReplaySidecar | null {
  const r = readPrivateJsonFile(join(dir, `${id}.json`));
  if (!('state' in r)) return null;
  const s = r.state as Partial<ReplaySidecar> | null;
  return s && s.id === id && typeof s.startedAt === 'number' && Number.isFinite(s.startedAt) ? (s as ReplaySidecar) : null;
}

/**
 * Delete expired clips (older than 30 days by their own start time), clips with no readable sidecar, and leftover
 * temp files. Returns the clips that stay, oldest first.
 */
export function purgeReplayDir(dir: string, now: number): ClipInfo[] {
  const ids = new Set<string>();
  const sizes = new Map<string, number>();
  for (const name of readdirSync(dir)) {
    if (TEMP_RE.test(name)) {
      unlinkQuiet(join(dir, name));
      continue;
    }
    const m = CLIP_RE.exec(name);
    if (!m) continue;
    ids.add(m[1]!);
    if (m[2] === 'wav') sizes.set(m[1]!, lstatSync(join(dir, name)).size);
  }
  const keep: ClipInfo[] = [];
  for (const id of ids) {
    const s = readSidecar(dir, id);
    // A start time more than a day in the future (a wrong clock, a hand-edited sidecar) would never expire: drop it.
    if (!s || !sizes.has(id) || now - s.startedAt > REPLAY_MAX_AGE_MS || s.startedAt - now > FUTURE_SLACK_MS) removeClip(dir, id);
    else keep.push({ id, startedAt: s.startedAt, bytes: sizes.get(id)! });
  }
  return keep.sort((a, b) => a.startedAt - b.startedAt);
}

const dayOf = (ms: number): string => new Date(ms).toDateString();

export interface ReplayRecorderOptions {
  home: string;
  /** Read on every capture (the owner's switch). Throwing counts as off. */
  enabled: () => boolean;
  /** Gets REPLAY_WRITE_FAILED (a code word only) when a write fails. */
  log?: (code: typeof REPLAY_WRITE_FAILED) => void;
  now?: () => number;
  /** For tests: the user's home folder (the synced-folder check). */
  userHome?: string;
  /** For tests: replaces the backup-exclude attribute write. */
  excludeFromBackups?: (dir: string) => Promise<void>;
  /** For tests: the purge interval (default REPLAY_PURGE_EVERY_MS). */
  purgeEveryMs?: number;
}

export class ReplayRecorder {
  /** Failed writes since start (each also logged as REPLAY_WRITE_FAILED). */
  failures = 0;
  private chain: Promise<void> = Promise.resolve();
  private excludedIno: number | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: ReplayRecorderOptions) {}

  /**
   * Called by the listener right after it handed the command off. Never throws, never waits: true = a clip is
   * queued (F5, recorder on), false = nothing will be saved.
   */
  capture(c: ReplayCapture): boolean {
    try {
      if (c.source !== REPLAY_SOURCE || !validCommandId(c.id) || this.o.enabled() !== true) return false;
    } catch {
      return false;
    }
    this.enqueue(() => this.write(c));
    return true;
  }

  /**
   * Listener start: fix the folder and purge old clips, also with the switch off (old clips still expire). Then
   * purge again every REPLAY_PURGE_EVERY_MS while the listener runs (unref'd: it never keeps the process alive).
   */
  start(): Promise<void> {
    if (!this.purgeTimer) {
      this.purgeTimer = setInterval(() => this.enqueue(() => this.purgeIfThere()), this.o.purgeEveryMs ?? REPLAY_PURGE_EVERY_MS);
      this.purgeTimer.unref();
    }
    this.enqueue(() => this.purgeIfThere());
    return this.idle();
  }

  /** Stops the purge timer (listener shutdown, tests). */
  stop(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  /** Purge when the recorder is on or the folder exists; never creates the folder for an owner who never used it. */
  private async purgeIfThere(): Promise<void> {
    let on = false;
    try {
      on = this.o.enabled() === true;
    } catch {
      /* off */
    }
    let exists = false;
    try {
      exists = lstatSync(replayDir(this.o.home)) !== null;
    } catch {
      /* missing */
    }
    if (!on && !exists) return;
    purgeReplayDir(await this.prepare(), this.now());
  }

  /** Resolves when every queued write is done (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => new Promise<void>((r) => setImmediate(r))) // after the command's own synchronous work
      .then(job)
      .catch(() => {
        this.failures++;
        try {
          this.o.log?.(REPLAY_WRITE_FAILED);
        } catch {
          /* never fail */
        }
      });
  }

  /** The folder, checked: not synced, a real 0700 folder of ours, out of Spotlight and Time Machine. Throws. */
  private async prepare(): Promise<string> {
    const home = this.o.home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const dir = replayDir(home);
    const synced = syncedFolder(dir, this.o.userHome);
    if (synced) throw new Error(`the replay folder would be in ${synced}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the replay folder is not a real folder');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('the replay folder belongs to another user');
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    try {
      closeSync(openSync(join(dir, NEVER_INDEX), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (this.excludedIno !== st.ino) {
      await (this.o.excludeFromBackups ?? backupExclude)(dir);
      this.excludedIno = st.ino;
    }
    return dir;
  }

  private async write(c: ReplayCapture): Promise<void> {
    const dir = await this.prepare();
    const clips = purgeReplayDir(dir, this.now());
    const wav = encodeWav16(c.audio);
    const day = dayOf(c.startedAt);
    const today = clips.filter((k) => dayOf(k.startedAt) === day).reduce((n, k) => n + k.bytes, 0);
    if (today + wav.length > REPLAY_MAX_DAY_BYTES) return; // over the day's cap: skip
    while (clips.length >= REPLAY_MAX_CLIPS) removeClip(dir, clips.shift()!.id);
    const fh = await open(join(dir, `${c.id}.wav`), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(wav);
      await fh.chmod(0o600);
    } finally {
      await fh.close();
    }
    const sidecar: ReplaySidecar = { v: 1, id: c.id, trigger: 'f5', startedAt: c.startedAt, transcript: c.transcript.slice(0, MAX_TRANSCRIPT_CHARS) };
    writePrivateJsonFileSync(join(dir, `${c.id}.json`), sidecar);
  }
}

/** Delete one clip (`id`) or all of them. Works with the switch off. Returns how many clips were deleted. Throws. */
export function deleteReplayClips(home: string, which: { all: true } | { id: string }): number {
  const dir = replayDir(home);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real folder; delete it by hand`);
  if ('id' in which) {
    const had = readdirSync(dir).some((n) => CLIP_RE.exec(n)?.[1] === which.id);
    removeClip(dir, which.id);
    return had ? 1 : 0;
  }
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    const m = CLIP_RE.exec(name);
    if (m) ids.add(m[1]!);
    if (m || TEMP_RE.test(name)) unlinkQuiet(join(dir, name));
  }
  return ids.size;
}

export const REPLAY_USAGE = `Usage:
  stephen replay delete --all     Delete every saved F5 recording
  stephen replay delete <id>      Delete one recording (its id looks like h_0123456789abcdef)

Recordings are saved only when "voice": {"replay": {"enabled": true}} is in config.json. Deleting works either way.`;

/** `stephen replay …` (owner CLI). */
export function runReplayCli(argv: string[], home: string, out: (l: string) => void = console.log, err: (l: string) => void = console.error): number {
  const [cmd, arg, ...extra] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(REPLAY_USAGE);
    return 0;
  }
  if (cmd !== 'delete' || !arg || extra.length) {
    err(REPLAY_USAGE);
    return 2;
  }
  if (arg !== '--all' && !validCommandId(arg)) {
    err(`"${arg.slice(0, 40)}" is not a recording id (they look like h_0123456789abcdef).`);
    return 2;
  }
  try {
    const n = deleteReplayClips(home, arg === '--all' ? { all: true } : { id: arg });
    out(n === 0 ? (arg === '--all' ? 'No saved recordings.' : 'No recording with that id.') : `Deleted ${n} recording${n === 1 ? '' : 's'}.`);
    return 0;
  } catch (e) {
    err(`Could not delete: ${(e as Error).message}`);
    return 1;
  }
}
