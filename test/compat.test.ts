/**
 * B10: N-1 data fixtures. test/fixtures/v0.1/ holds a sample of every file Stephen itself keeps, as version 0.1 writes
 * it (made by test/fixtures-v0.1.generate.test.ts with the real writers). Every later version must still read them,
 * field by field, so an update or a rollback never loses a person's data: a reader that drops a field fails here.
 * Never edit a v0.1 fixture; a later version adds a v0.2 folder next to it.
 *
 * Covered: settings (config.json, saved as settings.json because .gitignore drops config.json), memory, memory
 * suggestions, timers, a history line, a latency line, an incident line, a job state, the audit log, the tool log,
 * the conversation trust state, and an F5 recording with its label.
 * Not covered, on purpose: Claude Code's own transcripts (Claude Code's format, not ours), the Keychain, and the old
 * .env file (the person's own, read only for known names).
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { configUnknownKeys, doctor } from '../src/cli.js';
import { loadConfig, userConfigUnknownKeys } from '../src/config.js';
import { parseHistoryEntry } from '../src/history/store.js';
import { readJobState } from '../src/jobs/state.js';
import { ProposalStore } from '../src/memory/proposals.js';
import { parseMemoryFile } from '../src/memory/store.js';
import { listReplayClips, replayAccuracy, replayDir } from '../src/replay/recorder.js';
import { AuditLog } from '../src/safety/audit.js';
import { validateGateState } from '../src/safety/gate.js';
import { readSessionStateFile } from '../src/safety/session-state.js';
import { readToolLog } from '../src/server/tool-log.js';
import { parseIncidentRecord } from '../src/telemetry/incidents.js';
import { parseLatencyRecord } from '../src/telemetry/latency.js';
import { TimerStore } from '../src/timers/store.js';

const FIX = resolve(__dirname, 'fixtures/v0.1');
const T0 = new Date(2026, 10, 25, 9, 30).getTime();
const tmp = mkdtempSync(join(tmpdir(), 'stephen-compat-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const json = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as unknown;
const line = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8').split('\n')[0]!) as unknown;
let homes = 0;
/** A fresh 0700 home. */
const newHome = () => {
  const h = join(tmp, `h${++homes}`);
  mkdirSync(h, { recursive: true, mode: 0o700 });
  return h;
};
/** Put a fixture where Stephen keeps it, 0600 in 0700 folders as Stephen writes it (git stores files as 0644). */
function restore(fixture: string, dest: string): string {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  copyFileSync(join(FIX, fixture), dest);
  chmodSync(dest, 0o600);
  return dest;
}

describe("B10: today's code reads the v0.1 files", () => {
  it('settings: the known keys keep their values, and nothing is reported unknown', () => {
    const cfg = loadConfig(undefined, { HOME: tmp, STEPHEN_HOME: newHome(), STEPHEN_CONFIG: join(FIX, 'settings.json') });
    expect(cfg.chrome.mode).toBe('agent');
    expect(cfg.memory).toMatchObject({ enabled: true });
    expect(userConfigUnknownKeys(json('settings.json'))).toEqual([]);
  });

  it('memory: both items with id, text, source and times', () => {
    const m = parseMemoryFile(json('memory.json'))!;
    expect(m.nextId).toBe(3);
    expect(m.items).toEqual([
      { id: 'm1', text: 'example fact one', source: 'voice-ptt', createdAt: '2026-11-25T14:30:00.000Z', updatedAt: '2026-11-25T14:30:00.000Z' },
      { id: 'm2', text: 'example fact two', source: 'app', createdAt: '2026-11-25T14:30:00.000Z', updatedAt: '2026-11-25T14:30:00.000Z' },
    ]);
  });

  it('memory suggestions: the suggestion keeps its text and origin', () => {
    const home = newHome();
    restore('memory-proposals.json', join(home, 'memory-proposals.json'));
    expect(new ProposalStore({ home, now: () => new Date(T0) }).list()).toEqual([expect.objectContaining({ text: 'example suggestion', origin: 'you' })]);
  });

  it('timers: the timer and the reminder load with their times and text', () => {
    const home = newHome();
    restore('timers.json', join(home, 'timers.json'));
    expect(new TimerStore({ home, now: () => T0 }).list().map((t) => ({ kind: t.kind, text: t.text, dueAt: t.dueAt }))).toEqual([
      { kind: 'timer', text: 'example timer', dueAt: T0 + 600_000 },
      { kind: 'reminder', text: 'example reminder', dueAt: T0 + 3_600_000 },
    ]);
  });

  it('history: a line keeps what was said, the reply and the outcome', () => {
    expect(parseHistoryEntry(line('history.jsonl'))).toMatchObject({
      ts: '2026-11-25T14:30:00.000Z', source: 'voice-ptt', said: 'what time is it', reply: 'It is 9:30.', outcome: 'ok', tools: [], followUp: false,
      ms: 1800, turns: 1,
    });
  });

  it('latency: a line keeps its stages, model times and cost', () => {
    expect(parseLatencyRecord(line('latency.jsonl'))).toMatchObject({
      id: 'h_0000000000000001', trigger: 'ptt', route: 'model', outcome: 'ok', turns: 1,
      stages: { speechEnd: 2000, replyReady: 4000 }, modelMs: 1500, toolMs: 0, costUsd: 0.0123,
    });
  });

  it('incident: a line keeps its part, code, stage and versions', () => {
    expect(parseIncidentRecord(line('incident.jsonl'))).toMatchObject({ id: 'h_0000000000000002', stephen: '0.1.0', part: 'listen', code: 'command_error', stage: 'run' });
  });

  it('job state: task, status, budget and result', () => {
    const home = newHome();
    restore('job-state.json', join(home, 'jobs', '2026-11-25-example-job.json'));
    expect(readJobState(home, '2026-11-25-example-job')).toMatchObject({
      id: '2026-11-25-example-job', task: 'example job task', status: 'done', source: 'voice-ptt', model: 'sonnet',
      maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000, turns: 4, toolCalls: 6, costUsd: 0.21, summary: 'Example summary.',
    });
  });

  it('audit log: the entry keeps its tool, outcome and intent', async () => {
    const home = newHome();
    const path = restore('audit.log', join(home, 'audit.log'));
    expect(await new AuditLog({ path }).recent(10)).toEqual([
      expect.objectContaining({ tool: 'navigate', outcome: 'ok', intent: 'open the example page' }),
    ]);
  });

  it('tool log: the call keeps its tool, error flag, time and command id', () => {
    const home = newHome();
    const path = restore('tool-log.jsonl', join(home, 'voice', 'tool-log.jsonl'));
    expect(readToolLog(path)).toEqual([{ tool: 'navigate', isError: false, ms: 120, cmd: 'h_0000000000000001' }]);
  });

  it('conversation trust state: the private read and the approved host survive', () => {
    const home = newHome();
    const r = readSessionStateFile(restore('conversation-state.json', join(home, 'voice', 'conversation-state.json')));
    expect('state' in r).toBe(true);
    expect(validateGateState((r as { state: unknown }).state, T0)).toEqual({
      version: 1, privateReads: [{ host: 'mail.google.com', scope: 'mail.google.com', at: T0 }], trustedHosts: ['example.com'],
    });
  });

  it('F5 recording: the clip lists with its words, and its label counts in accuracy', () => {
    const home = newHome();
    for (const f of readdirSync(join(FIX, 'replay'))) restore(join('replay', f), join(replayDir(home), f));
    expect(listReplayClips(home, 30, T0 + 60_000)).toEqual([{ id: 'h_0000000000000003', startedAt: T0, transcript: 'open the example page', label: 'ok' }]);
    expect(replayAccuracy(home, 30, T0 + 60_000)).toMatchObject({ clips: 1, labelled: 1, unlabelled: 0, okShare: 1 });
  });
});

describe('B10 with B11: settings from a newer version', () => {
  const saved = { STEPHEN_HOME: process.env.STEPHEN_HOME, STEPHEN_CONFIG: process.env.STEPHEN_CONFIG };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  it('keys this version does not know: Stephen still starts, the known keys keep their values', async () => {
    const env = { HOME: tmp, STEPHEN_HOME: newHome(), STEPHEN_CONFIG: join(FIX, 'settings-unknown-key.json') };
    const cfg = loadConfig(undefined, env);
    expect(cfg.chrome.mode).toBe('agent');
    expect(cfg.memory).toMatchObject({ enabled: true });
    expect((await configUnknownKeys(env)).sort()).toEqual(['futureThing', 'memory.newOption']);
  });

  it('stephen doctor names each unknown key as info, never as a problem, and never prints a value', async () => {
    process.env.STEPHEN_HOME = newHome();
    process.env.STEPHEN_CONFIG = join(FIX, 'settings-unknown-key.json');
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(' ')));
    try {
      await doctor(false, true);
    } finally {
      spy.mockRestore();
    }
    const out = JSON.parse(printed.join('\n')) as { checks: { label: string; ok: boolean; info?: boolean; detail?: string }[] };
    const unknown = out.checks.filter((c) => c.label === 'Unknown config key');
    expect(unknown.length).toBe(2);
    for (const c of unknown) expect(c).toMatchObject({ ok: true, info: true });
    expect(printed.join('\n')).toContain('futureThing');
    expect(printed.join('\n')).toContain('memory.newOption');
    expect(printed.join('\n')).not.toContain('"on":true');
  });
});
