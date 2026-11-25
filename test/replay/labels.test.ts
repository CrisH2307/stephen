/**
 * Recorder PR 3 (issue #48): `stephen replay label` and `stephen replay accuracy`. A label is one fixed code and a
 * time, written atomically next to a clip that exists; it goes with its clip; accuracy is numbers only.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writePrivateJsonFileSync } from '../../src/lib/fs.js';
import { LABEL_CODES, REPLAY_MAX_AGE_MS, REPLAY_MAX_CLIPS, ReplayRecorder, labelReplayClip, replayAccuracy, replayDir, runReplayCli } from '../../src/replay/recorder.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-lab-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const NOW = Date.now();
const id = (i: number) => `h_${i.toString(16).padStart(16, '0')}`;

/** A home with clips 1..count, clip i started i minutes ago (or at `startedAt(i)`). */
async function withClips(count: number, o: { now?: () => number; startedAt?: (i: number) => number } = {}) {
  const home = join(tmp, `home${++n}`);
  const r = new ReplayRecorder({ home, enabled: () => true, now: o.now ?? (() => NOW), userHome: join(tmp, 'user'), excludeFromBackups: async () => {} });
  for (let i = 1; i <= count; i++) {
    r.capture({ id: id(i), source: 'voice-ptt', startedAt: o.startedAt?.(i) ?? NOW - i * 60_000, audio: new Float32Array(160), transcript: `command ${i}` });
    await r.idle();
  }
  return { r, home, dir: replayDir(home) };
}

const run = (argv: string[], home: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return { code: runReplayCli(argv, home, (l) => out.push(l), (l) => err.push(l)), out, err };
};
const labelsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.label.json')).sort() : []);

describe('stephen replay label', () => {
  it('accepts every code and writes only the code and the time, 0600', async () => {
    const t = await withClips(LABEL_CODES.length);
    LABEL_CODES.forEach((code, i) => {
      expect(run(['label', id(i + 1), code], t.home)).toMatchObject({ code: 0, out: [`Labelled ${id(i + 1)} as ${code}.`] });
      const path = join(t.dir, `${id(i + 1)}.label.json`);
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(saved).sort()).toEqual(['at', 'code', 'v']);
      expect(saved.code).toBe(code);
      expect(typeof saved.at).toBe('number');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it('refuses anything that is not exactly a code, and writes nothing', async () => {
    const t = await withClips(1);
    for (const bad of ['OK', 'ok ', 'wrong', 'wrong_other', 'ok,wrong_heard', '', 'it heard "bank"', 'toString', '__proto__', 'constructor']) {
      expect(run(['label', id(1), bad], t.home).code).toBe(2);
    }
    expect(() => labelReplayClip(t.home, id(1), 'free text')).toThrow('not a label code');
    expect(labelsIn(t.dir)).toEqual([]);
  });

  it('refuses a bad id, a missing clip, extra words and a missing folder', async () => {
    const t = await withClips(1);
    expect(run(['label', '../config', 'ok'], t.home).code).toBe(2);
    expect(run(['label', id(1), 'ok', 'because'], t.home).code).toBe(2);
    expect(run(['label', id(1)], t.home).code).toBe(2);
    expect(run(['label', id(9), 'ok'], t.home)).toMatchObject({ code: 1, err: ['Could not label: no recording with that id'] });
    expect(run(['label', id(1), 'ok'], join(tmp, 'nobody')).code).toBe(1);
    // A sidecar without its audio is not a clip.
    rmSync(join(t.dir, `${id(1)}.wav`));
    expect(run(['label', id(1), 'ok'], t.home).code).toBe(1);
    expect(labelsIn(t.dir)).toEqual([]);
  });

  it('atomic: relabelling replaces the file whole, and a failed write leaves the old label and no temp file', async () => {
    const t = await withClips(1);
    labelReplayClip(t.home, id(1), 'wrong_heard', 1000);
    labelReplayClip(t.home, id(1), 'ok', 2000);
    expect(JSON.parse(readFileSync(join(t.dir, `${id(1)}.label.json`), 'utf8'))).toEqual({ v: 1, code: 'ok', at: 2000 });
    chmodSync(t.dir, 0o500); // the temp file can't be created
    try {
      expect(() => labelReplayClip(t.home, id(1), 'wrong_action', 3000)).toThrow();
    } finally {
      chmodSync(t.dir, 0o700);
    }
    expect(JSON.parse(readFileSync(join(t.dir, `${id(1)}.label.json`), 'utf8'))).toEqual({ v: 1, code: 'ok', at: 2000 });
    expect(readdirSync(t.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('a label goes with its clip', () => {
  it('delete <id> and delete --all remove labels', async () => {
    const t = await withClips(3);
    for (const i of [1, 2, 3]) labelReplayClip(t.home, id(i), 'ok');
    expect(run(['delete', id(2)], t.home)).toMatchObject({ code: 0, out: ['Deleted 1 recording.'] });
    expect(labelsIn(t.dir)).toEqual([`${id(1)}.label.json`, `${id(3)}.label.json`]);
    expect(run(['delete', '--all'], t.home)).toMatchObject({ code: 0, out: ['Deleted 2 recordings.'] });
    expect(readdirSync(t.dir).filter((f) => f.startsWith('h_') || f.startsWith('.h_'))).toEqual([]);
  });

  it('the Settings Delete (deleteAll) removes labels', async () => {
    const t = await withClips(2);
    labelReplayClip(t.home, id(1), 'wrong_trigger');
    expect(await t.r.deleteAll()).toBe(2);
    expect(labelsIn(t.dir)).toEqual([]);
  });

  it('by age: an expired clip takes its label, a label without a clip and a leftover label temp file go', async () => {
    let now = NOW;
    const t = await withClips(2, { now: () => now, startedAt: (i) => (i === 1 ? NOW - REPLAY_MAX_AGE_MS + 60_000 : NOW) });
    labelReplayClip(t.home, id(1), 'ok');
    labelReplayClip(t.home, id(2), 'ok');
    writePrivateJsonFileSync(join(t.dir, `${id(7)}.label.json`), { v: 1, code: 'ok', at: NOW });
    writeFileSync(join(t.dir, `.${id(2)}.label.json.1.abc.tmp`), '{"v":1,', { mode: 0o600 });
    now = NOW + 120_000; // clip 1 is now past 30 days
    await t.r.start();
    t.r.stop();
    expect(labelsIn(t.dir)).toEqual([`${id(2)}.label.json`]);
    expect(readdirSync(t.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it(`by count: past ${REPLAY_MAX_CLIPS} clips the oldest goes with its label`, async () => {
    const t = await withClips(REPLAY_MAX_CLIPS);
    labelReplayClip(t.home, id(REPLAY_MAX_CLIPS), 'wrong_heard'); // the oldest (started the most minutes ago)
    labelReplayClip(t.home, id(1), 'ok');
    t.r.capture({ id: id(REPLAY_MAX_CLIPS + 1), source: 'voice-ptt', startedAt: NOW, audio: new Float32Array(160), transcript: 'new' });
    await t.r.idle();
    expect(existsSync(join(t.dir, `${id(REPLAY_MAX_CLIPS)}.wav`))).toBe(false);
    expect(labelsIn(t.dir)).toEqual([`${id(1)}.label.json`]);
  });
});

describe('stephen replay accuracy', () => {
  it('sums: share ok of the labelled, each wrong code, and the unlabelled count', async () => {
    const t = await withClips(10);
    const codes = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'wrong_heard', 'wrong_heard', 'wrong_action'] as const;
    codes.forEach((c, i) => labelReplayClip(t.home, id(i + 1), c));
    const a = replayAccuracy(t.home, 7);
    expect(a).toMatchObject({ days: 7, clips: 10, labelled: 9, unlabelled: 1 });
    expect(a.counts).toEqual({ ok: 6, wrong_trigger: 0, wrong_heard: 2, wrong_understood: 0, wrong_action: 1 });
    expect(a.okShare).toBeCloseTo(6 / 9);
    expect(Object.values(a.counts).reduce((x, y) => x + y, 0)).toBe(a.labelled);
    expect(run(['accuracy'], t.home)).toEqual({
      code: 0,
      err: [],
      out: [
        'F5 recordings, last 7 days: 10 (9 labelled, 1 not labelled yet)',
        'Accuracy: 66.7% ok (6 of 9)',
        'wrong_trigger: 0',
        'wrong_heard: 2',
        'wrong_understood: 0',
        'wrong_action: 1',
      ],
    });
  });

  it('--days 7 and --days 30 count by the clip\'s own start time', async () => {
    const t = await withClips(3, { startedAt: (i) => NOW - [0, 1, 6, 20][i]! * 86_400_000 - 60_000 });
    for (const i of [1, 2, 3]) labelReplayClip(t.home, id(i), i === 3 ? 'wrong_understood' : 'ok');
    expect(replayAccuracy(t.home, 7)).toMatchObject({ clips: 2, labelled: 2, okShare: 1 });
    expect(replayAccuracy(t.home, 30)).toMatchObject({ clips: 3, labelled: 3, counts: { wrong_understood: 1 } });
    expect(run(['accuracy', '--days', '30'], t.home).out[1]).toBe('Accuracy: 66.7% ok (2 of 3)');
  });

  it('a hand-edited label with a bad code counts as not labelled; no labels says so; never prints words', async () => {
    const t = await withClips(2);
    writePrivateJsonFileSync(join(t.dir, `${id(1)}.label.json`), { v: 1, code: 'it was fine', at: NOW });
    const r = run(['accuracy'], t.home);
    expect(r.out.slice(0, 2)).toEqual(['F5 recordings, last 7 days: 2 (0 labelled, 2 not labelled yet)', 'Accuracy: no labelled recordings yet']);
    expect(r.out.join('\n')).not.toMatch(/command|fine/);
    expect(run(['accuracy'], join(tmp, 'nobody')).out[0]).toBe('F5 recordings, last 7 days: 0 (0 labelled, 0 not labelled yet)');
  });

  it('refuses other --days values', async () => {
    const t = await withClips(1);
    for (const argv of [['accuracy', '--days', '1'], ['accuracy', '--days'], ['accuracy', '30'], ['accuracy', '--days', '7', 'x']]) expect(run(argv, t.home).code).toBe(2);
  });
});

describe('stephen replay list', () => {
  it('shows id, label and what was heard, newest first', async () => {
    const t = await withClips(2);
    labelReplayClip(t.home, id(2), 'wrong_trigger');
    const r = run(['list'], t.home);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(new RegExp(`^${id(1)} .* not labelled\\n  > command 1$`));
    expect(r.out[1]).toMatch(new RegExp(`^${id(2)} .* wrong_trigger\\n  > command 2$`));
    expect(run(['list'], join(tmp, 'nobody')).out).toEqual(['No saved recordings.']);
  });
});
