/**
 * B10: N-1 data fixtures. test/fixtures/v0.1/ holds files written by the real writers of version 0.1 (settings.json, a config.json saved under another name because .gitignore drops config.json;
 * memory.json, timers.json, a history line, a latency line, an incident line, a job state). Every later version must
 * still read them, field by field, so an update or a rollback never loses a person's data. If a reader drops a field,
 * the field's check here fails. Never edit a v0.1 fixture: add a v0.2 folder next to it instead.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, userConfigUnknownKeys } from '../src/config.js';
import { parseHistoryEntry } from '../src/history/store.js';
import { readJobState } from '../src/jobs/state.js';
import { parseMemoryFile } from '../src/memory/store.js';
import { parseIncidentRecord } from '../src/telemetry/incidents.js';
import { parseLatencyRecord } from '../src/telemetry/latency.js';
import { TimerStore } from '../src/timers/store.js';

const FIX = resolve(__dirname, 'fixtures/v0.1');
const json = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as unknown;
const line = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8').split('\n')[0]!) as unknown;
const tmp = mkdtempSync(join(tmpdir(), 'stephen-compat-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('B10: today\'s code reads the v0.1 files', () => {
  it('config.json loads, and the known keys keep their values', () => {
    const cfg = loadConfig(undefined, { HOME: tmp, STEPHEN_HOME: join(tmp, 'h1'), STEPHEN_CONFIG: join(FIX, 'settings.json') });
    expect(cfg.chrome.mode).toBe('agent');
    expect(cfg.memory).toMatchObject({ enabled: true });
    expect(userConfigUnknownKeys(json('settings.json'))).toEqual([]);
  });

  it('a config with keys this version does not know still loads, and doctor can name them (B11)', () => {
    const cfg = loadConfig(undefined, { HOME: tmp, STEPHEN_HOME: join(tmp, 'h2'), STEPHEN_CONFIG: join(FIX, 'settings-unknown-key.json') });
    expect(cfg.chrome.mode).toBe('agent');
    expect(cfg.memory).toMatchObject({ enabled: true });
    expect(userConfigUnknownKeys(json('settings-unknown-key.json'))).toEqual(expect.arrayContaining(['futureThing']));
  });

  it('memory.json: both items with id, text, source and times', () => {
    const m = parseMemoryFile(json('memory.json'))!;
    expect(m).not.toBeNull();
    expect(m.nextId).toBe(3);
    expect(m.items).toEqual([
      { id: 'm1', text: 'my gym is goodlife', source: 'voice-ptt', createdAt: '2026-11-25T14:30:00.000Z', updatedAt: '2026-11-25T14:30:00.000Z' },
      { id: 'm2', text: 'my sister is Ana', source: 'app', createdAt: '2026-11-25T14:30:00.000Z', updatedAt: '2026-11-25T14:30:00.000Z' },
    ]);
  });

  it('timers.json: the timer and the reminder load with their times and text', () => {
    const home = join(tmp, 'timers');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    copyFileSync(join(FIX, 'timers.json'), join(home, 'timers.json'));
    chmodSync(join(home, 'timers.json'), 0o600); // git keeps 0644; Stephen's readers want 0600
    const store = new TimerStore({ home, now: () => 1795617000000 });
    expect(store.list().map((t) => ({ kind: t.kind, text: t.text, dueAt: t.dueAt }))).toEqual([
      { kind: 'timer', text: 'tea', dueAt: 1795617600000 },
      { kind: 'reminder', text: 'call mom', dueAt: 1795620600000 },
    ]);
  });

  it('a history line keeps what was said, the reply and the outcome', () => {
    expect(parseHistoryEntry(line('history.jsonl'))).toMatchObject({
      id: 'h_0b4e8389f79e700a', ts: '2026-11-25T14:30:00.000Z', source: 'voice-ptt', said: 'what time is it', reply: 'It is 9:30.',
      outcome: 'ok', tools: [], followUp: false, ms: 1800, turns: 1,
    });
  });

  it('a latency line keeps its stages, model times and cost', () => {
    expect(parseLatencyRecord(line('latency.jsonl'))).toMatchObject({
      id: 'h_0000000000000001', trigger: 'ptt', route: 'model', outcome: 'ok', turns: 1,
      stages: { speechEnd: 2000, replyReady: 4000 }, modelMs: 1500, toolMs: 0, costUsd: 0.0123,
    });
  });

  it('an incident line keeps its part, code, stage and versions', () => {
    expect(parseIncidentRecord(line('incident.jsonl'))).toMatchObject({
      id: 'h_0000000000000002', stephen: '0.1.0', part: 'listen', code: 'command_error', stage: 'run', node: '24.20.0', darwin: '27.2.0',
    });
  });

  it('a job state keeps its task, status, budget and result', () => {
    const home = join(tmp, 'jobs-home');
    mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
    copyFileSync(join(FIX, 'job-state.json'), join(home, 'jobs', '2026-11-25-write-a-poem.json'));
    chmodSync(join(home, 'jobs', '2026-11-25-write-a-poem.json'), 0o600);
    expect(readJobState(home, '2026-11-25-write-a-poem')).toMatchObject({
      id: '2026-11-25-write-a-poem', task: 'write a poem', status: 'done', source: 'voice-ptt', model: 'sonnet',
      maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000, turns: 4, toolCalls: 6, costUsd: 0.21, summary: 'Wrote a short poem.',
    });
  });
});
