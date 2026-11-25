/**
 * Replay recorder (item 4, A6a, issue #48): saves F5 commands on this Mac so mistakes can be measured later.
 *
 * - Off by default (`voice.replay.enabled`, owner-only: config.json or the Settings switch, app.sock `replay.set`).
 *   The listener asks `enabled()` on every capture and again before each write, so turning it off stops saving at once.
 * - Records source `voice-ptt` only (F5, and the Ask box mic / Talk button, which press F5 in the helper). The wake
 *   word, the Stephen app's typed commands, `listen --text` and the phone never record.
 * - Per clip, in `<home>/replay/` (0700): `<id>.wav` (16 kHz mono 16-bit, only the captured command, created once
 *   with O_CREAT|O_EXCL|O_NOFOLLOW, 0600) and `<id>.json` (command id, trigger, start time, transcript; written with
 *   a temp file inside the folder + rename, 0600).
 * - Labels (PR 3): `stephen replay label <id> <code>` writes `<id>.label.json` next to the clip (temp file + rename,
 *   0600) holding only `{v, code, at}`; the code is one of LABEL_CODES, never free text. A label goes with its clip
 *   (purge by age or count, `delete`). `stephen replay accuracy` counts them (numbers only).
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
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { validCommandId } from '../lib/command-id.js';
import { isInside, readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { REPLAY_DIR_NAME, realThroughParent } from '../lib/owner-only.js';
import { clean } from '../safety/text.js';
import { encodeWav16 } from '../voice/wav.js';

export const REPLAY_MAX_AGE_MS = 30 * 24 * 3600_000;
/** How often a running listener purges, so clips expire on time with the switch off or no F5 for weeks (#169). */
export const REPLAY_PURGE_EVERY_MS = 6 * 3600_000;
const FUTURE_SLACK_MS = 24 * 3600_000;
export const REPLAY_MAX_CLIPS = 100;
/** Clips that may wait in memory for the disk; more are dropped (a stuck write must not hold them all). */
export const REPLAY_MAX_WAITING = 5;
/** Time limit per write or purge. */
export const REPLAY_JOB_TIMEOUT_MS = 30_000;
export const REPLAY_MAX_DAY_BYTES = 50 * 1024 * 1024;
/** The one source that records (F5). */
export const REPLAY_SOURCE = 'voice-ptt';
/** The code word a failed write is counted as. */
export const REPLAY_WRITE_FAILED = 'replay_write_failed';
const MAX_TRANSCRIPT_CHARS = 2000;
const NEVER_INDEX = '.metadata_never_index';

const CLIP_RE = /^(h_[0-9a-f]{16})\.(wav|json|label\.json)$/;
const TEMP_RE = /^\.h_[0-9a-f]{16}\.(label\.)?json\..*\.tmp$/;

/** The only label codes: what went wrong with an F5 command, or `ok`. */
export const LABEL_CODES = ['ok', 'wrong_trigger', 'wrong_heard', 'wrong_understood', 'wrong_action'] as const;
export type LabelCode = (typeof LABEL_CODES)[number];
const isLabelCode = (v: unknown): v is LabelCode => typeof v === 'string' && (LABEL_CODES as readonly string[]).includes(v);

/** What a clip's label file holds: the code and when it was set (epoch ms). Nothing else. */
export interface ReplayLabel {
  v: 1;
  code: LabelCode;
  at: number;
}

export function replayDir(home: string): string {
  return join(home, REPLAY_DIR_NAME);
}

/** What one clip's sidecar holds. Its label is a file of its own (`<id>.label.json`). */
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
    // Older Google Drive and OneDrive apps sync these folders in the home folder (newer ones use CloudStorage).
    [join(u, 'Google Drive'), 'Google Drive'],
    [join(u, 'My Drive'), 'Google Drive'],
  ];
  for (const [dir, name] of places) if (isInside(p, dir)) return name;
  // "OneDrive" or "OneDrive - <organization>".
  const top = isInside(p, u) ? relative(u, p).split(sep)[0] : undefined;
  return top && /^OneDrive( - .+)?$/.test(top) ? 'OneDrive' : null;
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
  unlinkQuiet(join(dir, `${id}.label.json`));
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
  /** For tests: the time limit per write or purge (default REPLAY_JOB_TIMEOUT_MS). */
  jobTimeoutMs?: number;
}

export class ReplayRecorder {
  /** Failed writes since start (each also logged as REPLAY_WRITE_FAILED). */
  failures = 0;
  private chain: Promise<void> = Promise.resolve();
  private excludedIno: number | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  /** Clips queued and not yet written: each holds its audio in memory. */
  private waiting = 0;
  /** deleteAll calls so far: a write that started before one never lands after it (#208). */
  private deletes = 0;

  constructor(private readonly o: ReplayRecorderOptions) {}

  /**
   * Called by the listener right after it handed the command off. Never throws, never waits: true = a clip is
   * queued (F5, recorder on), false = nothing will be saved.
   */
  capture(c: ReplayCapture): boolean {
    try {
      if (c.source !== REPLAY_SOURCE || !validCommandId(c.id) || !this.isOn()) return false;
    } catch {
      return false;
    }
    // A stuck disk must not pile up the owner's audio in memory (#169, review point 7): past the cap, drop it.
    if (this.waiting >= REPLAY_MAX_WAITING) return false;
    this.waiting++;
    const gen = this.deletes; // a Delete pressed after this capture drops it (#208)
    this.enqueue(() => this.write(c, gen), () => this.waiting--);
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

  /**
   * `stephen replay delete --all` for the Settings switch's Delete (issue #48 PR 2): runs after the writes already
   * queued, so a clip captured before the switch went off can't land after the delete. A write stuck past its time
   * limit still running then sees the delete and removes its own clip (#208). Resolves to how many clips
   * were deleted; rejects when the folder can't be cleared.
   */
  deleteAll(): Promise<number> {
    this.deletes++; // any write already started (even one past its time limit) drops its clip
    const run = this.chain.then(() => deleteReplayClips(this.o.home, { all: true }));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isOn(): boolean {
    try {
      return this.o.enabled() === true;
    } catch {
      return false;
    }
  }

  /** Purge when the recorder is on or the folder exists; never creates the folder for an owner who never used it. */
  private async purgeIfThere(): Promise<void> {
    const on = this.isOn();
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

  /**
   * One job at a time, after the command's own synchronous work. A job that takes longer than the time limit counts
   * as failed and the queue moves on (the stuck call itself can't be cancelled; it holds its one clip until it ends).
   */
  private enqueue(job: () => Promise<void>, done?: () => void): void {
    const limitMs = this.o.jobTimeoutMs ?? REPLAY_JOB_TIMEOUT_MS;
    const timed = (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('replay write timed out')), limitMs);
        timer.unref();
      });
      return Promise.race([job(), limit]).finally(() => clearTimeout(timer));
    };
    this.chain = this.chain
      .then(() => new Promise<void>((r) => setImmediate(r)))
      .then(timed)
      .finally(() => done?.())
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

  private async write(c: ReplayCapture, gen: number): Promise<void> {
    // Switched off, or Delete pressed, while this clip waited or while it is being written: not saved. Checked after
    // every await, so after "off" or "Delete" is answered no clip lands (PR 2, #208).
    const wanted = (): boolean => this.deletes === gen && this.isOn();
    if (!wanted()) return;
    const dir = await this.prepare();
    if (!wanted()) return;
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
    if (!wanted()) {
      removeClip(dir, c.id);
      return;
    }
    const sidecar: ReplaySidecar = { v: 1, id: c.id, trigger: 'f5', startedAt: c.startedAt, transcript: c.transcript.slice(0, MAX_TRANSCRIPT_CHARS) };
    writePrivateJsonFileSync(join(dir, `${c.id}.json`), sidecar);
  }
}

/** Delete one clip (`id`) or all of them. Works with the switch off. Returns how many clips were deleted. Throws. */
export function deleteReplayClips(home: string, which: { all: true } | { id: string }): number {
  const dir = realReplayDir(home);
  if (!dir) return 0;
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

/** The replay folder when it is a real folder; null when missing. Throws when it is anything else. */
function realReplayDir(home: string): string | null {
  const dir = replayDir(home);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real folder; delete it by hand`);
  return dir;
}

function readLabel(dir: string, id: string): ReplayLabel | null {
  const r = readPrivateJsonFile(join(dir, `${id}.label.json`));
  if (!('state' in r)) return null;
  const l = r.state as Partial<ReplayLabel> | null;
  return l && isLabelCode(l.code) && typeof l.at === 'number' && Number.isFinite(l.at) ? { v: 1, code: l.code, at: l.at } : null;
}

/** A clip that is really there: a regular audio file and a readable sidecar. */
function clipThere(dir: string, id: string): ReplaySidecar | null {
  try {
    if (!lstatSync(join(dir, `${id}.wav`)).isFile()) return null;
  } catch {
    return null;
  }
  return readSidecar(dir, id);
}

/**
 * Label one saved clip. Throws when the id or code is not one of the allowed shapes, or the clip is not there.
 * Writes `<id>.label.json` with a temp file and a rename (0600): a reader sees the old label or the new one, never
 * half a file. Labelling again replaces the label.
 */
export function labelReplayClip(home: string, id: string, code: string, now: number = Date.now()): ReplayLabel {
  if (!validCommandId(id)) throw new Error('not a recording id');
  if (!isLabelCode(code)) throw new Error('not a label code');
  const dir = realReplayDir(home);
  if (!dir || !clipThere(dir, id)) throw new Error('no recording with that id');
  const label: ReplayLabel = { v: 1, code, at: now };
  writePrivateJsonFileSync(join(dir, `${id}.label.json`), label);
  return label;
}

export interface ReplayClipRow {
  id: string;
  startedAt: number;
  transcript: string;
  label: LabelCode | null;
}

/** Saved clips that started in the last `days` days (by their own start time), newest first. Reads only. */
export function listReplayClips(home: string, days: number = REPLAY_MAX_AGE_MS / 86_400_000, now: number = Date.now()): ReplayClipRow[] {
  const dir = realReplayDir(home);
  if (!dir) return [];
  const since = now - days * 86_400_000;
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    const m = CLIP_RE.exec(name);
    if (m) ids.add(m[1]!);
  }
  const rows: ReplayClipRow[] = [];
  for (const id of ids) {
    const s = clipThere(dir, id);
    if (!s || s.startedAt < since || s.startedAt - now > FUTURE_SLACK_MS) continue;
    rows.push({ id, startedAt: s.startedAt, transcript: typeof s.transcript === 'string' ? s.transcript : '', label: readLabel(dir, id)?.code ?? null });
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt);
}

export interface ReplayAccuracy {
  days: number;
  clips: number;
  labelled: number;
  unlabelled: number;
  counts: Record<LabelCode, number>;
  /** Share of labelled clips that are `ok`, 0 to 1; null when none is labelled. */
  okShare: number | null;
}

/** Numbers only: how many clips, how many labelled, the count per code and the share labelled `ok`. */
export function replayAccuracy(home: string, days: number, now: number = Date.now()): ReplayAccuracy {
  const counts = Object.fromEntries(LABEL_CODES.map((c) => [c, 0])) as Record<LabelCode, number>;
  const rows = listReplayClips(home, days, now);
  for (const r of rows) if (r.label) counts[r.label]++;
  const labelled = rows.filter((r) => r.label).length;
  return { days, clips: rows.length, labelled, unlabelled: rows.length - labelled, counts, okShare: labelled ? counts.ok / labelled : null };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
function when(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const REPLAY_USAGE = `Usage:
  stephen replay list             Saved F5 recordings, newest first: id, time, label, what was heard
  stephen replay label <id> <code>
                                  Label one recording. The code is one of:
                                    ok                the command was done right
                                    wrong_trigger     F5 started a command you did not want
                                    wrong_heard       speech to text heard the wrong words
                                    wrong_understood  the words were right, the plan was wrong
                                    wrong_action      the plan was right, the action went wrong
  stephen replay accuracy [--days 7|30]
                                  Share of labelled F5 commands that are ok, and the count of each wrong code
  stephen replay delete --all     Delete every saved F5 recording (and its label)
  stephen replay delete <id>      Delete one recording (its id looks like h_0123456789abcdef)

Recordings are saved only while the switch in Settings, Privacy and permissions is on ("voice": {"replay": {"enabled": true}}
in config.json). Deleting works either way.`;

/** `stephen replay …` (owner CLI). */
export function runReplayCli(argv: string[], home: string, out: (l: string) => void = console.log, err: (l: string) => void = console.error): number {
  const [cmd, arg, ...extra] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(REPLAY_USAGE);
    return 0;
  }
  if (cmd === 'list' && !arg) {
    try {
      const rows = listReplayClips(home);
      if (!rows.length) {
        out('No saved recordings.');
        return 0;
      }
      for (const r of rows) out(`${r.id}  ${when(r.startedAt)}  ${r.label ?? 'not labelled'}\n  > ${clean(r.transcript, 200)}`);
      out(`\nThe audio is in ${replayDir(home)}/<id>.wav`);
      return 0;
    } catch (e) {
      err(`Could not read: ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd === 'label' && arg && extra.length === 1) {
    if (!validCommandId(arg)) {
      err(`"${clean(arg, 40)}" is not a recording id (they look like h_0123456789abcdef).`);
      return 2;
    }
    if (!isLabelCode(extra[0])) {
      err(`"${clean(extra[0], 40)}" is not a label. Use one of: ${LABEL_CODES.join(', ')}.`);
      return 2;
    }
    try {
      labelReplayClip(home, arg, extra[0]);
      out(`Labelled ${arg} as ${extra[0]}.`);
      return 0;
    } catch (e) {
      err(`Could not label: ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd === 'accuracy') {
    const rest = [arg, ...extra].filter((a) => a !== undefined);
    const days = rest.length === 0 ? 7 : rest.length === 2 && rest[0] === '--days' && (rest[1] === '7' || rest[1] === '30') ? Number(rest[1]) : 0;
    if (!days) {
      err(REPLAY_USAGE);
      return 2;
    }
    try {
      const a = replayAccuracy(home, days);
      out(`F5 recordings, last ${a.days} days: ${a.clips} (${a.labelled} labelled, ${a.unlabelled} not labelled yet)`);
      out(a.okShare === null ? 'Accuracy: no labelled recordings yet' : `Accuracy: ${(a.okShare * 100).toFixed(1)}% ok (${a.counts.ok} of ${a.labelled})`);
      for (const c of LABEL_CODES) if (c !== 'ok') out(`${c}: ${a.counts[c]}`);
      return 0;
    } catch (e) {
      err(`Could not read: ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd !== 'delete' || !arg || extra.length) {
    err(REPLAY_USAGE);
    return 2;
  }
  if (arg !== '--all' && !validCommandId(arg)) {
    err(`"${clean(arg, 40)}" is not a recording id (they look like h_0123456789abcdef).`);
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
