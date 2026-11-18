/**
 * Replay recorder (item 4, A6a, issue #48): off by default, F5 only, the clip format, 0700/0600, Spotlight and Time
 * Machine exclusion, the synced-folder refusal, the 30-day purge, the 100-clip and 50 MB/day caps, the switch read
 * on every capture, a failing writer, and `stephen replay delete`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writePrivateJsonFileSync } from '../../src/lib/fs.js';
import {
  REPLAY_MAX_AGE_MS,
  REPLAY_MAX_CLIPS,
  REPLAY_MAX_DAY_BYTES,
  ReplayRecorder,
  replayDir,
  runReplayCli,
  syncedFolder,
  type ReplayRecorderOptions,
} from '../../src/replay/recorder.js';
import { parseLatencyRecord } from '../../src/telemetry/latency.js';
import { parseVoiceConfig } from '../../src/voice/config.js';
import { parseWav } from '../../src/voice/wav.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-rec-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const NOW = Date.parse('2026-11-17T15:00:00Z');
const id = (i: number) => `h_${i.toString(16).padStart(16, '0')}`;
const audio = (sec = 0.5) => Float32Array.from({ length: Math.round(sec * 16000) }, (_, i) => Math.sin(i / 10) * 0.5);

function rec(o: Partial<ReplayRecorderOptions> & { on?: () => boolean } = {}) {
  const home = join(tmp, `home${++n}`);
  const logs: string[] = [];
  let excluded = 0;
  const r = new ReplayRecorder({
    home,
    enabled: o.on ?? (() => true),
    log: (c) => logs.push(c),
    now: () => NOW,
    userHome: join(tmp, 'user'),
    excludeFromBackups: async () => void excluded++,
    ...o,
  });
  return { r, home, dir: replayDir(home), logs, excluded: () => excluded };
}

const clip = (i: number, o: Partial<{ source: string; startedAt: number; transcript: string; sec: number }> = {}) => ({
  id: id(i),
  source: o.source ?? 'voice-ptt',
  startedAt: o.startedAt ?? NOW,
  audio: audio(o.sec),
  transcript: o.transcript ?? 'open youtube',
});

const clipsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('h_')).sort() : []);

describe('the switch', () => {
  it('is off by default and only takes true/false; unknown keys are refused', () => {
    expect(parseVoiceConfig({}).replay).toEqual({ enabled: false });
    expect(parseVoiceConfig({ replay: { enabled: true } }).replay).toEqual({ enabled: true });
    expect(() => parseVoiceConfig({ replay: { enabled: 'yes' } })).toThrow(/replay/);
    expect(() => parseVoiceConfig({ replay: { enabled: true, keepDays: 400 } })).toThrow(/keepDays/);
  });

  it('off: nothing is saved and no folder is made', async () => {
    const t = rec({ on: () => false });
    expect(t.r.capture(clip(1))).toBe(false);
    await t.r.start();
    expect(existsSync(t.dir)).toBe(false);
  });

  it('is read on every capture: turning it off stops saving at once, a throwing read counts as off', async () => {
    let on = true;
    const t = rec({ on: () => on });
    expect(t.r.capture(clip(1))).toBe(true);
    on = false;
    expect(t.r.capture(clip(2))).toBe(false);
    await t.r.idle();
    expect(clipsIn(t.dir)).toEqual([`${id(1)}.json`, `${id(1)}.wav`]);
    const bad = rec({ on: () => { throw new Error('config broke'); } });
    expect(bad.r.capture(clip(3))).toBe(false);
  });
});

describe('F5 only', () => {
  it.each(['voice-wake', 'app', 'cli', 'phone', 'text', ''])('source %j never records', async (source) => {
    const t = rec();
    expect(t.r.capture(clip(1, { source }))).toBe(false);
    await t.r.idle();
    expect(existsSync(t.dir)).toBe(false);
  });

  it('a bad command id never records (it names the files)', async () => {
    const t = rec();
    expect(t.r.capture({ ...clip(1), id: '../../x' })).toBe(false);
  });
});

describe('one clip', () => {
  it('WAV 16 kHz mono 16-bit of the captured audio + sidecar; folder 0700, files 0600; out of Spotlight and Time Machine', async () => {
    const t = rec();
    const c = clip(7, { sec: 1.25, transcript: 'play lofi' });
    expect(t.r.capture(c)).toBe(true);
    await t.r.idle();
    expect(statSync(t.dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(t.dir).sort()).toEqual(['.metadata_never_index', `${id(7)}.json`, `${id(7)}.wav`]);
    for (const f of readdirSync(t.dir)) expect(lstatSync(join(t.dir, f)).mode & 0o777, f).toBe(0o600);
    const buf = readFileSync(join(t.dir, `${id(7)}.wav`));
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(parseWav(buf).samples.length).toBe(c.audio.length);
    expect(JSON.parse(readFileSync(join(t.dir, `${id(7)}.json`), 'utf8'))).toEqual({ v: 1, id: id(7), trigger: 'f5', startedAt: NOW, transcript: 'play lofi' });
    expect(t.excluded()).toBe(1);
    t.r.capture(clip(8));
    await t.r.idle();
    expect(t.excluded()).toBe(1); // once per folder
    expect(t.logs).toEqual([]);
  });

  it('a wrong folder mode is fixed at start', async () => {
    const t = rec({ on: () => false });
    mkdirSync(t.dir, { recursive: true });
    chmodSync(t.dir, 0o755);
    await t.r.start();
    expect(statSync(t.dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(t.dir, '.metadata_never_index'))).toBe(true);
  });

  it('a symlink at the folder or at a clip file is refused, nothing is written through it', async () => {
    const t = rec();
    const elsewhere = join(tmp, `elsewhere${n}`);
    mkdirSync(elsewhere);
    mkdirSync(t.home, { recursive: true });
    symlinkSync(elsewhere, t.dir);
    expect(t.r.capture(clip(1))).toBe(true);
    await t.r.idle();
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(t.logs).toEqual(['replay_write_failed']);

    // A link planted where the WAV goes (its sidecar there, so the purge keeps it): O_EXCL|O_NOFOLLOW refuse it.
    const u = rec();
    mkdirSync(u.dir, { recursive: true, mode: 0o700 });
    writePrivateJsonFileSync(join(u.dir, `${id(2)}.json`), { v: 1, id: id(2), trigger: 'f5', startedAt: NOW, transcript: 'x' });
    symlinkSync(join(elsewhere, 'target.wav'), join(u.dir, `${id(2)}.wav`));
    u.r.capture(clip(2));
    await u.r.idle();
    expect(existsSync(join(elsewhere, 'target.wav'))).toBe(false);
    expect(u.r.failures).toBe(1);
  });

  it.runIf(process.platform === 'darwin')('tmutil reports the real folder excluded from Time Machine', async () => {
    const t = rec({ excludeFromBackups: undefined });
    t.r.capture(clip(1));
    await t.r.idle();
    expect(t.logs).toEqual([]);
    expect(execFileSync('/usr/bin/tmutil', ['isexcluded', t.dir], { encoding: 'utf8' })).toMatch(/\[Excluded\]/);
  });
});

describe('synced folders', () => {
  const user = join(tmp, 'user');

  it.each([
    [['Library', 'Mobile Documents', 'com~apple~CloudDocs', 'stephen'], 'iCloud Drive'],
    [['Library', 'CloudStorage', 'GoogleDrive-me', 'stephen'], 'a cloud storage folder'],
    [['Dropbox', 'stephen'], 'Dropbox'],
  ])('a home under %j is refused (%s)', async (parts, name) => {
    const home = join(user, ...parts);
    expect(syncedFolder(join(home, 'replay'), user)).toBe(name);
    const logs: string[] = [];
    const r = new ReplayRecorder({ home, enabled: () => true, log: (c) => logs.push(c), userHome: user, excludeFromBackups: async () => {} });
    expect(r.capture(clip(1))).toBe(true);
    await r.idle();
    expect(existsSync(join(home, 'replay'))).toBe(false);
    expect(logs).toEqual(['replay_write_failed']);
  });

  it('by its real path: a home symlinked into Dropbox is refused; an ordinary home is fine', async () => {
    const real = join(user, 'Dropbox', 'real-home');
    mkdirSync(real, { recursive: true });
    const link = join(tmp, 'linked-home');
    symlinkSync(real, link);
    expect(syncedFolder(join(link, 'replay'), user)).toBe('Dropbox');
    expect(syncedFolder(join(user, '.stephen', 'replay'), user)).toBeNull();
  });

  it('in any letter case: ~/dropbox is ~/Dropbox on APFS (#169)', () => {
    mkdirSync(join(user, 'Dropbox'), { recursive: true });
    if (!existsSync(join(user, 'dropbox'))) return; // a case-sensitive disk
    expect(syncedFolder(join(user, 'dropbox', 'stephen', 'replay'), user)).toBe('Dropbox');
  });
});

describe('purge and caps', () => {
  it('30 days by the clip\'s own time: minus 1 s stays, plus 1 s goes (at start and on each write)', async () => {
    let now = NOW;
    const t = rec({ now: () => now });
    t.r.capture(clip(1, { startedAt: NOW }));
    t.r.capture(clip(2, { startedAt: NOW + 2000 }));
    await t.r.idle();
    now = NOW + REPLAY_MAX_AGE_MS + 1000;
    await t.r.start();
    expect(clipsIn(t.dir)).toEqual([`${id(2)}.json`, `${id(2)}.wav`]); // 2 is 30 days minus 1 s old
    now = NOW + 2000 + REPLAY_MAX_AGE_MS + 1000;
    t.r.capture(clip(3, { startedAt: now }));
    await t.r.idle();
    expect(clipsIn(t.dir)).toEqual([`${id(3)}.json`, `${id(3)}.wav`]);
  });

  it('a running listener purges on a timer, also with the switch off (#169)', async () => {
    let now = NOW;
    let on = true;
    const t = rec({ now: () => now, on: () => on, purgeEveryMs: 20 });
    t.r.capture(clip(1, { startedAt: NOW }));
    await t.r.start();
    expect(clipsIn(t.dir)).toHaveLength(2);
    on = false;
    now = NOW + REPLAY_MAX_AGE_MS + 1000;
    await new Promise((r) => setTimeout(r, 120));
    await t.r.idle();
    t.r.stop();
    expect(clipsIn(t.dir)).toEqual([]);
  });

  it('a start time more than a day in the future is dropped (#169)', async () => {
    const t = rec();
    t.r.capture(clip(1, { startedAt: NOW + 2 * 86_400_000 }));
    t.r.capture(clip(2, { startedAt: NOW + 3600_000 }));
    await t.r.idle();
    await t.r.start();
    t.r.stop();
    expect(clipsIn(t.dir)).toEqual([`${id(2)}.json`, `${id(2)}.wav`]);
  });

  it('a WAV without a readable sidecar and leftover temp files are removed', async () => {
    const t = rec();
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(t.dir, `${id(1)}.wav`), 'x', { mode: 0o600 });
    writeFileSync(join(t.dir, `.${id(2)}.json.123.abc.tmp`), 'x', { mode: 0o600 });
    await t.r.start();
    expect(readdirSync(t.dir)).toEqual(['.metadata_never_index']);
  });

  it(`at most ${REPLAY_MAX_CLIPS} clips: the oldest goes first`, async () => {
    const t = rec();
    for (let i = 1; i <= REPLAY_MAX_CLIPS + 1; i++) t.r.capture(clip(i, { startedAt: NOW - 3600_000 + i, sec: 0.05 }));
    await t.r.idle();
    const files = clipsIn(t.dir);
    expect(files).toHaveLength(REPLAY_MAX_CLIPS * 2);
    expect(files).not.toContain(`${id(1)}.wav`);
    expect(files).toContain(`${id(REPLAY_MAX_CLIPS + 1)}.wav`);
  });

  it('50 MB of audio per day: over it, the clip is skipped', async () => {
    const t = rec();
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const big = join(t.dir, `${id(1)}.wav`);
    const fd = openSync(big, 'w', 0o600);
    ftruncateSync(fd, REPLAY_MAX_DAY_BYTES - 1000); // sparse: no real 50 MB written
    closeSync(fd);
    writePrivateJsonFileSync(join(t.dir, `${id(1)}.json`), { v: 1, id: id(1), trigger: 'f5', startedAt: NOW - 1000, transcript: 'x' });
    t.r.capture(clip(2, { sec: 1 }));
    await t.r.idle();
    expect(existsSync(join(t.dir, `${id(2)}.wav`))).toBe(false);
    t.r.capture(clip(3, { startedAt: NOW + 24 * 3600_000, sec: 1 })); // the next day
    await t.r.idle();
    expect(existsSync(join(t.dir, `${id(3)}.wav`))).toBe(true);
  });
});

describe('a failing writer never fails or delays a command', () => {
  it('capture returns at once; the error is counted as the code word only', async () => {
    const t = rec({ excludeFromBackups: () => Promise.reject(new Error('disk full: /secret/path')) });
    const t0 = performance.now();
    expect(t.r.capture(clip(1))).toBe(true);
    expect(performance.now() - t0).toBeLessThan(50);
    await t.r.idle();
    expect(t.r.failures).toBe(1);
    expect(t.logs).toEqual(['replay_write_failed']);
  });

  it('a write that never finishes does not block capture', () => {
    const t = rec({ excludeFromBackups: () => new Promise<void>(() => {}) });
    for (let i = 1; i <= 3; i++) expect(t.r.capture(clip(i))).toBe(true);
  });
});

describe('stephen replay delete', () => {
  async function withClips() {
    const t = rec();
    for (const i of [1, 2, 3]) t.r.capture(clip(i));
    await t.r.idle();
    return t;
  }
  const run = (argv: string[], home: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return { code: runReplayCli(argv, home, (l) => out.push(l), (l) => err.push(l)), out, err };
  };

  it('<id> deletes one clip (audio and sidecar); --all deletes the rest; both need no switch', async () => {
    const t = await withClips();
    expect(run(['delete', id(2)], t.home)).toMatchObject({ code: 0, out: ['Deleted 1 recording.'] });
    expect(clipsIn(t.dir)).toEqual([`${id(1)}.json`, `${id(1)}.wav`, `${id(3)}.json`, `${id(3)}.wav`]);
    expect(run(['delete', id(2)], t.home)).toMatchObject({ code: 0, out: ['No recording with that id.'] });
    expect(run(['delete', '--all'], t.home)).toMatchObject({ code: 0, out: ['Deleted 2 recordings.'] });
    expect(clipsIn(t.dir)).toEqual([]);
    expect(run(['delete', '--all'], join(tmp, 'nobody'))).toMatchObject({ code: 0, out: ['No saved recordings.'] });
  });

  it('refuses anything but an id or --all', async () => {
    const t = await withClips();
    expect(run(['delete', '../config.json'], t.home).code).toBe(2);
    expect(run(['delete'], t.home).code).toBe(2);
    expect(run(['purge'], t.home).code).toBe(2);
    expect(clipsIn(t.dir)).toHaveLength(6);
  });
});

describe('telemetry', () => {
  it('a latency row keeps replay 0|1 and nothing else under that name', () => {
    const base = { v: 1, id: id(1), ts: new Date(NOW).toISOString(), trigger: 'ptt', route: 'model', outcome: 'ok', followUp: false, turns: 1, stages: {} };
    expect(parseLatencyRecord({ ...base, replay: 1 })).toMatchObject({ replay: 1 });
    expect(parseLatencyRecord({ ...base, replay: 'open youtube' })).not.toHaveProperty('replay');
  });
});
