/** Incident log tests (docs/NFR-STEPHEN.md section 9): parsing, recording, reading, purging. */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LatencyMonitor } from '../../src/telemetry/latency.js';
import { incidentDir, parseIncidentRecord, recordIncident, readIncidents, purgeIncidents, lastStage } from '../../src/telemetry/incidents.js';

const T0 = new Date(2026, 10, 10, 15, 0).getTime(); // local time: day files are named by the local day

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'stephen-inc-'));
  return { home };
}

describe('parseIncidentRecord', () => {
  const evil = 'https://evil.example/path?q=my secret words';

  it('drops free text in every field: id/ts bad -> null; part/code/stage -> other; stephen -> 0.0.0; node -> 0; darwin dropped', () => {
    // First test id bad
    const badId = parseIncidentRecord({ v: 1, id: evil, ts: new Date(T0).toISOString(), stephen: evil, part: evil, code: evil, stage: evil, node: evil, darwin: evil });
    expect(badId).toBeNull();

    // Now test ts bad
    const badTs = parseIncidentRecord({ v: 1, id: 'good_id', ts: evil, stephen: evil, part: evil, code: evil, stage: evil, node: evil, darwin: evil });
    expect(badTs).toBeNull();

    // Valid id and ts, now test each field gets evil -> safe
    const rec = parseIncidentRecord({
      v: 1,
      id: 'good_id',
      ts: new Date(T0).toISOString(),
      stephen: evil,
      part: evil,
      code: evil,
      stage: evil,
      node: evil,
      darwin: evil,
      message: evil,
      transcript: evil,
      url: evil,
      host: evil,
      path: evil,
      name: evil,
      audio: evil,
    })!;

    expect(rec.id).toBe('good_id');
    expect(rec.stephen).toBe('0.0.0');
    expect(rec.part).toBe('other');
    expect(rec.code).toBe('other');
    expect(rec.stage).toBe('other');
    expect(rec.node).toBe('0');
    // darwin: free text is not a version, so it is dropped
    expect(rec.darwin).toBeUndefined();

    // Verify JSON.stringify does not contain evil or secret
    const line = JSON.stringify(rec);
    expect(line).not.toContain('evil');
    expect(line).not.toContain('secret');

    // Verify unknown top-level keys are dropped
    expect(rec).not.toHaveProperty('message');
    expect(rec).not.toHaveProperty('transcript');
    expect(rec).not.toHaveProperty('url');
    expect(rec).not.toHaveProperty('host');
    expect(rec).not.toHaveProperty('path');
    expect(rec).not.toHaveProperty('name');
    expect(rec).not.toHaveProperty('audio');
    expect(Object.keys(rec).sort()).toEqual(['code', 'id', 'node', 'part', 'stage', 'stephen', 'ts', 'v']);
  });

  it('keeps real versions, and a version with words around it is dropped', () => {
    const ok = parseIncidentRecord({ v: 1, id: 'good_id', ts: new Date(T0).toISOString(), stephen: '0.1.0', node: '24.1.0', darwin: '25.2.0' })!;
    expect(ok).toMatchObject({ stephen: '0.1.0', node: '24.1.0', darwin: '25.2.0' });
    const words = parseIncidentRecord({ v: 1, id: 'good_id', ts: new Date(T0).toISOString(), stephen: '0.1.0 my secret', darwin: 'Darwin 25.2.0 on cris-mac' })!;
    expect(words.stephen).toBe('0.0.0');
    expect(words).not.toHaveProperty('darwin');
  });

  it('stages: unknown keys dropped, negative/NaN/string/>=86400000 dropped, 12.6 rounds to 13, stages array dropped', () => {
    const rec = parseIncidentRecord({
      v: 1,
      id: 'good_id',
      ts: new Date(T0).toISOString(),
      stephen: '1.0.0',
      part: 'listen',
      code: 'command_error',
      stage: 'asrDone',
      node: '18.0.0',
      stages: {
        speechEnd: 100,
        captureEnd: -5,
        asrDone: NaN,
        commandStart: 'bad',
        replyReady: 900,
        firstAudio: 12.6,
        done: 86400000,
        chime: 86399999,
        evil_key: 555,
        unknown_stage: 777,
      },
    })!;

    expect(rec.stages).toEqual({
      speechEnd: 100,
      replyReady: 900,
      firstAudio: 13,
      chime: 86399999,
    });

    // Test stages is array -> dropped, no stages property
    const recArray = parseIncidentRecord({
      v: 1,
      id: 'good_id',
      ts: new Date(T0).toISOString(),
      stephen: '1.0.0',
      part: 'listen',
      code: 'command_error',
      stage: 'run',
      node: '18.0.0',
      stages: [100, 200, 300],
    })!;
    expect(recArray.stages).toBeUndefined();
  });

  it('modelMs, toolMs, firstTokenMs are numbers only, unknown or bad ones dropped', () => {
    const rec = parseIncidentRecord({
      v: 1,
      id: 'good_id',
      ts: new Date(T0).toISOString(),
      stephen: '1.0.0',
      part: 'listen',
      code: 'command_error',
      stage: 'run',
      node: '18.0.0',
      modelMs: 1234.5,
      toolMs: -100,
      firstTokenMs: 'bad',
    })!;

    expect(rec.modelMs).toBe(1235);
    expect(rec.toolMs).toBeUndefined();
    expect(rec.firstTokenMs).toBeUndefined();
  });
});

describe('recordIncident', () => {
  it('writes one line to <home>/incidents/YYYY-MM-DD.jsonl', () => {
    const { home } = setup();
    const now = new Date(2026, 10, 10, 15, 30);
    const result = recordIncident(home, { part: 'listen', code: 'command_error' }, now);

    expect(result).not.toBeNull();
    expect(result?.id).toBeTruthy();
    expect(result?.part).toBe('listen');
    expect(result?.code).toBe('command_error');

    const dir = incidentDir(home);
    const files = readdirSync(dir);
    expect(files).toEqual(['2026-11-10.jsonl']);

    const content = readFileSync(join(dir, '2026-11-10.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe(result?.id);
    expect(parsed.part).toBe('listen');
    expect(parsed.code).toBe('command_error');
  });

  it('file mode 0o600, folder mode 0o700', () => {
    if (process.platform === 'win32') return;

    const { home } = setup();
    const now = new Date(2026, 10, 10, 15, 30);
    recordIncident(home, { part: 'listen', code: 'uncaught' }, now);

    const dir = incidentDir(home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const file = join(dir, '2026-11-10.jsonl');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never throws: pass a home that is a regular file', () => {
    const { home } = setup();
    const file = join(home, 'notadir');
    writeFileSync(file, 'not a directory');

    const result = recordIncident(file, { part: 'listen', code: 'uncaught' }, new Date());
    expect(result).toBeNull();
  });
});

describe('readIncidents', () => {
  it('returns newest first across two day files, last caps count', () => {
    const { home } = setup();
    const now1 = new Date(2026, 10, 10, 10, 0);
    const now2 = new Date(2026, 10, 11, 10, 0);

    recordIncident(home, { part: 'listen', code: 'command_error', id: 'c1' }, now1);
    recordIncident(home, { part: 'serve', code: 'uncaught', id: 'c2' }, now1);
    recordIncident(home, { part: 'helper', code: 'helper_lost', id: 'c3' }, now2);
    recordIncident(home, { part: 'job', code: 'error', id: 'c4' }, now2);

    const all = readIncidents(home, 10);
    expect(all.map(r => r.id)).toEqual(['c4', 'c3', 'c2', 'c1']);

    const just3 = readIncidents(home, 3);
    expect(just3.map(r => r.id)).toEqual(['c4', 'c3', 'c2']);

    const just1 = readIncidents(home, 1);
    expect(just1.map(r => r.id)).toEqual(['c4']);
  });

  it('skips bad lines', () => {
    const { home } = setup();
    const now = new Date(2026, 10, 10, 10, 0);

    // Write a valid record
    recordIncident(home, { part: 'listen', code: 'command_error', id: 'good' }, now);

    // Write invalid lines directly
    const dir = incidentDir(home);
    const file = join(dir, '2026-11-10.jsonl');
    const existing = readFileSync(file, 'utf8');
    writeFileSync(file, existing + '{not json}\n{"v":2,"id":"bad"}\n{"v":1,id:"also bad"}\n');

    const all = readIncidents(home, 5);
    expect(all.map(r => r.id)).toEqual(['good']);
  });
});

describe('purgeIncidents', () => {
  it('deletes a day file older than 30 days and keeps a recent one', () => {
    const { home } = setup();
    const now = new Date(2026, 10, 10, 10, 0);

    // Old incident
    const oldDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31);
    recordIncident(home, { part: 'listen', code: 'uncaught', id: 'old' }, oldDate);

    // Recent incident
    recordIncident(home, { part: 'listen', code: 'command_error', id: 'new' }, now);

    const dir = incidentDir(home);
    expect(readdirSync(dir)).toHaveLength(2);

    const removed = purgeIncidents(home, now);
    expect(removed).toBe(1);

    expect(readdirSync(dir)).toHaveLength(1);
    expect(readIncidents(home, 5).map(r => r.id)).toEqual(['new']);
  });
});

describe('lastStage', () => {
  it('{} -> trigger', () => {
    expect(lastStage({})).toBe('trigger');
    expect(lastStage(undefined)).toBe('trigger');
  });

  it('{ asrDone: 5, done: 9 } -> done', () => {
    expect(lastStage({ asrDone: 5, done: 9 })).toBe('done');
  });

  it('returns highest value stage (ties go to later key)', () => {
    expect(lastStage({ done: 100, asrDone: 100 })).toBe('asrDone');
  });
});

describe('crash path writes incident', () => {
  it('end with error writes incident with part listen, code command_error, id, stage, modelMs', () => {
    const { home } = setup();
    const now = Date.now();

    const m = new LatencyMonitor({ home, now: () => now, loop: { reset: () => undefined, p99Ms: () => 0 } });
    m.begin('c_1', 'ptt');
    m.mark('c_1', 'asrDone');
    m.end('c_1', 'error', { model: { modelMs: 50 } });

    const incidents = readIncidents(home, 5);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      id: 'c_1',
      part: 'listen',
      code: 'command_error',
      stage: 'asrDone',
      modelMs: 50,
    });
  });

  it("end with 'ok' writes no incident (incidents folder absent or empty)", () => {
    const { home } = setup();
    const now = Date.now();

    const m = new LatencyMonitor({ home, now: () => now, loop: { reset: () => undefined, p99Ms: () => 0 } });
    m.begin('c_ok', 'ptt');
    m.mark('c_ok', 'asrDone');
    m.end('c_ok', 'ok', { model: { modelMs: 50 } });

    // Check incidents folder is empty or doesn't exist
    const dir = incidentDir(home);
    try {
      const files = readdirSync(dir);
      expect(files).toHaveLength(0);
    } catch {
      // Folder doesn't exist, which is fine
    }

    const incidents = readIncidents(home, 5);
    expect(incidents).toHaveLength(0);
  });
});