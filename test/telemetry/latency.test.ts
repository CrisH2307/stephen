/** Latency monitor store (plan A2): what a line may hold, file safety, retention, and reading back. */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATENCY_ASR, LATENCY_IGNORED, LATENCY_REASONS, LATENCY_START, LATENCY_TOOLS, LATENCY_TTS, LATENCY_RETENTION_DAYS, LatencyMonitor, MAX_LATENCY_TOOLS, latencyDir, parseLatencyRecord } from '../../src/telemetry/latency.js';

const T0 = Date.parse('2026-11-10T15:00:00Z');

function setup(start = T0) {
  const home = mkdtempSync(join(tmpdir(), 'stephen-lat-'));
  const clock = { t: start };
  const logs: string[] = [];
  const m = new LatencyMonitor({ home, now: () => clock.t, log: (l) => logs.push(l), loop: { reset: () => undefined, p99Ms: () => 3.4 } });
  const lines = () =>
    readdirSync(latencyDir(home))
      .sort()
      .flatMap((f) => readFileSync(join(latencyDir(home), f), 'utf8').split('\n').filter(Boolean));
  return { home, clock, logs, m, lines };
}

describe('LatencyMonitor', () => {
  it('writes one line per trigger with stage offsets from the trigger', () => {
    const t = setup();
    t.m.begin('h_a', 'ptt', T0 - 1200); // key down, as told by the helper
    t.m.mark('h_a', 'speechEnd', T0 - 100);
    t.m.mark('h_a', 'captureEnd');
    t.clock.t += 400;
    t.m.mark('h_a', 'asrDone');
    t.clock.t += 2000;
    t.m.mark('h_a', 'done');
    t.m.end('h_a', 'ok', { route: 'model', followUp: true, turns: 2 });
    expect(t.lines().map((l) => JSON.parse(l))).toEqual([
      {
        v: 1,
        id: 'h_a',
        ts: new Date(T0 - 1200).toISOString(),
        trigger: 'ptt',
        route: 'model',
        tier: null,
        outcome: 'ok',
        followUp: true,
        turns: 2,
        stages: { speechEnd: 1100, captureEnd: 1200, asrDone: 1600, done: 3600 },
        loopP99Ms: 3,
      },
    ]);
    expect(t.logs).toEqual([]);
  });

  it('first audio and the model run\'s own times: numbers only, unknown or bad ones dropped', () => {
    const t = setup();
    t.m.begin('h_m', 'ptt');
    t.clock.t += 900;
    t.m.mark('h_m', 'firstAudio');
    t.m.end('h_m', 'ok', { route: 'model', turns: 3, model: { modelMs: 1800.4, toolMs: 620, firstTokenMs: 410 } });
    t.m.begin('h_n', 'ptt');
    t.m.end('h_n', 'ok', { route: 'model', model: { modelMs: -5, toolMs: Number.NaN, said: 'secret' } as never });
    const rows = t.lines().map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ id: 'h_m', stages: { firstAudio: 900 }, modelMs: 1800, toolMs: 620, firstTokenMs: 410 });
    expect(Object.keys(rows[1]).sort()).toEqual(['followUp', 'id', 'loopP99Ms', 'outcome', 'route', 'stages', 'tier', 'trigger', 'ts', 'turns', 'v']);
    expect(parseLatencyRecord({ ...rows[0], firstTokenMs: 'soon' })).not.toHaveProperty('firstTokenMs');
  });

  it('a trigger that never became a command still gets a row; a second end and unknown ids do nothing', () => {
    const t = setup();
    t.m.begin('h_w', 'wake');
    t.m.end('h_w', 'no_wake');
    t.m.end('h_w', 'ok');
    t.m.mark('h_none', 'done');
    t.m.end('h_none', 'ok');
    const rows = t.lines().map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'h_w', trigger: 'wake', outcome: 'no_wake', route: null, turns: 0, stages: {} });
  });

  it('a second begin for an open id keeps the first trigger time', () => {
    const t = setup();
    t.m.begin('h_b', 'wake');
    t.clock.t += 900;
    t.m.begin('h_b', 'app');
    t.m.mark('h_b', 'commandStart');
    t.m.end('h_b', 'ok');
    expect(JSON.parse(t.lines()[0]!)).toMatchObject({ trigger: 'wake', stages: { commandStart: 900 } });
  });

  it('privacy: a line holds only known fields, so content cannot ride along', () => {
    const SECRET = 'open my bank at https://bank.example/?token=abc';
    // Even a caller that ignores the types cannot add content: the record is rebuilt field by field.
    const rec = parseLatencyRecord({
      v: 1,
      id: 'h_p',
      ts: new Date(T0).toISOString(),
      trigger: 'wake',
      outcome: 'ok',
      route: SECRET,
      said: SECRET,
      url: SECRET,
      stages: { done: 5, [SECRET]: 1, asrDone: SECRET },
    });
    expect(JSON.stringify(rec)).not.toContain('bank');
    expect(rec).toMatchObject({ route: null, stages: { done: 5 } });
    // Ids, triggers and outcomes outside the fixed sets are refused outright.
    expect(parseLatencyRecord({ v: 1, id: SECRET, ts: new Date(T0).toISOString(), trigger: 'wake', outcome: 'ok' })).toBeNull();
    expect(parseLatencyRecord({ v: 1, id: 'h_p', ts: new Date(T0).toISOString(), trigger: SECRET, outcome: 'ok' })).toBeNull();
    expect(parseLatencyRecord({ v: 1, id: 'h_p', ts: new Date(T0).toISOString(), trigger: 'wake', outcome: SECRET })).toBeNull();
    const t = setup();
    t.m.begin(SECRET, 'wake');
    t.m.end(SECRET, 'ok');
    expect(() => readdirSync(latencyDir(t.home))).toThrow(); // nothing was written, not even the folder
  });

  it('files are private (folder 0700, file 0600)', () => {
    const t = setup();
    t.m.begin('h_f', 'cli');
    t.m.end('h_f', 'ok');
    const dir = latencyDir(t.home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
  });

  it('read returns the last N days oldest first and skips bad lines; purge drops files past retention', () => {
    const t = setup();
    t.m.begin('h_1', 'wake');
    t.m.end('h_1', 'ok');
    const file = join(latencyDir(t.home), readdirSync(latencyDir(t.home))[0]!);
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n{"v":1,"id":"h_x"}\n`);
    t.clock.t += 3 * 86_400_000;
    t.m.begin('h_2', 'ptt');
    t.m.end('h_2', 'error');
    expect(t.m.read(7).map((r) => r.id)).toEqual(['h_1', 'h_2']);
    expect(t.m.read(1).map((r) => r.id)).toEqual(['h_2']);
    expect(t.m.purge()).toBe(0);
    t.clock.t += LATENCY_RETENTION_DAYS * 86_400_000;
    expect(t.m.purge()).toBe(1); // h_1's day; h_2's day is 3 days younger
    expect(t.m.read(30).map((r) => r.id)).toEqual(['h_2']); // exactly 30 days old: still inside the window
  });
});

describe('new fields: closed lists, numbers only', () => {
  const base = { v: 1, id: 'h_a', ts: new Date(T0).toISOString(), trigger: 'ptt', route: 'model', tier: null, outcome: 'ok', followUp: false, turns: 1, stages: {} };
  const KNOWN = new Set(['v', 'id', 'ts', 'trigger', 'route', 'tier', 'outcome', 'followUp', 'turns', 'stages', 'loopP99Ms', 'modelMs', 'toolMs', 'firstTokenMs', 'silenceMs', 'asr', 'tts', 'start', 'reason', 'ignored', 'tools']);

  it('each field is kept when valid', () => {
    const r = parseLatencyRecord({ ...base, silenceMs: 85.4, asr: 'whisper-small.en', tts: 'kokoro', start: 'cold', reason: 'question', ignored: 'cooldown', stages: { chime: 70 }, tools: [{ name: 'navigate', ms: 300 }] });
    expect(r).toMatchObject({ silenceMs: 85, asr: 'whisper-small.en', tts: 'kokoro', start: 'cold', reason: 'question', ignored: 'cooldown', stages: { chime: 70 }, tools: [{ name: 'navigate', ms: 300 }] });
  });

  it('no free text enters a record: unknown keys dropped, unknown codes become other or are dropped, tools capped', () => {
    const secret = 'https://bank.example/account?token=abc ' + 'x'.repeat(500);
    const rec = parseLatencyRecord({
      ...base,
      transcript: secret,
      said: 'open my bank',
      path: '/Users/me/secret.txt',
      asr: secret,
      tts: 'some-engine',
      start: secret,
      ignored: secret,
      reason: secret,
      tier: secret,
      silenceMs: secret,
      tools: [
        { name: secret, ms: 10, args: { url: secret }, result: secret },
        { name: 'https://evil.example/x', ms: 20 },
        { name: 'navigate', ms: 'slow' },
        { name: 'click', ms: 30, cmd: secret },
        ...Array.from({ length: 40 }, () => ({ name: 'find', ms: 1 })),
      ],
    })!;
    expect(rec.asr).toBe('other');
    expect(rec.tts).toBe('other');
    expect(rec.start).toBe('other');
    expect(rec.ignored).toBe('other');
    expect(rec.reason).toBeUndefined();
    expect(rec.silenceMs).toBeUndefined();
    expect(rec.tools!.length).toBeLessThanOrEqual(MAX_LATENCY_TOOLS);
    expect(rec.tools!.slice(0, 3)).toEqual([{ name: 'other', ms: 10 }, { name: 'other', ms: 20 }, { name: 'click', ms: 30 }]);
    const line = JSON.stringify(rec);
    for (const bad of ['bank', 'token', 'secret', 'evil', 'transcript', 'Users', 'xxxx']) expect(line).not.toContain(bad);
    for (const k of Object.keys(rec)) expect(KNOWN.has(k), k).toBe(true);
    for (const t of rec.tools!) expect(Object.keys(t).sort()).toEqual(['ms', 'name']);
  });

  it('the monitor writes only closed values from end() and note()', () => {
    const t = setup();
    t.m.begin('h_x', 'wake');
    t.m.note('h_x', { asr: 'parakeet-tdt-0.6b-v2', tier: 2, reason: 'a url https://x.example', start: 'warm' });
    t.m.end('h_x', 'ok', { route: 'model', tts: 'say', tools: [{ name: 'tab_open', ms: 50 }, { name: 'rm -rf /', ms: 1 }], transcript: 'hello' } as never);
    const row = JSON.parse(t.lines()[0]!);
    expect(row).toMatchObject({ asr: 'parakeet-tdt-0.6b-v2', tier: 2, start: 'warm', tts: 'say', tools: [{ name: 'tab_open', ms: 50 }, { name: 'other', ms: 1 }] });
    expect(row).not.toHaveProperty('reason');
    expect(row).not.toHaveProperty('transcript');
    expect(t.lines()[0]).not.toMatch(/x\.example|rm -rf|hello/);
  });

  it('a record written by the old version still parses', () => {
    const old = { ...base, stages: { speechEnd: 1000, done: 3000 }, modelMs: 1500 };
    const r = parseLatencyRecord(old)!;
    expect(r).toMatchObject({ id: 'h_a', modelMs: 1500, tier: null });
    for (const k of ['tools', 'asr', 'tts', 'start', 'reason', 'ignored', 'silenceMs']) expect(r).not.toHaveProperty(k);
  });

  it('the code lists are closed and every real Stephen tool name is in LATENCY_TOOLS', () => {
    for (const l of [LATENCY_ASR, LATENCY_TTS, LATENCY_START, LATENCY_IGNORED]) expect(l.at(-1)).toBe('other');
    expect(LATENCY_REASONS.length).toBeGreaterThan(0);
    // The names registered by the server, the desktop and account tools and the announce tool, read from source.
    const real = new Set<string>();
    for (const f of ['src/server/tools.ts', 'src/desktop/index.ts', 'src/accounts/index.ts', 'src/voice/announce.ts', 'src/desktop/tools.ts']) {
      let src = '';
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/\b(?:tool|reg|add|registerTool)\(\s*'([a-z_]+)'/g)) real.add(m[1]!);
    }
    expect(real.size).toBeGreaterThan(25);
    for (const n of real) expect(LATENCY_TOOLS as readonly string[], n).toContain(n);
  });
});
