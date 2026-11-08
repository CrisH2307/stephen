/**
 * runListen end to end (fake audio, no Claude): a job that finishes while Stephen listens gets a notification and a
 * spoken summary through the idle-only speech queue; after a restart the same job is not announced again; old job
 * state is purged at start. Needs the real keyword-spotter model (skipped without it).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { statePath, writeJobState, type JobState } from '../../src/jobs/state.js';
import type { AudioSource } from '../../src/voice/audio.js';
import { runListen, type ListenEnv } from '../../src/voice/index.js';
import { ASR_ARCHIVES, KWS_MODEL, VAD_MODEL } from '../../src/voice/models.js';
import { sleep } from '../app/helpers.js';
import { FakeTranscriber, FakeVad, FRAME, ScriptedSpotter } from '../voice/fakes.js';
import { fakeInstall, prepareKwsModel, RecordingChimes, RecordingSpeaker, waitFor } from '../voice/helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-finish-int-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

class EndlessSource implements AudioSource {
  readonly label = 'endless';
  private stopped = false;
  async start() {}
  async read() {
    if (this.stopped) return null;
    await sleep(2);
    return new Float32Array(FRAME);
  }
  async stop() {
    this.stopped = true;
  }
}

const job = (id: string, o: Partial<JobState> = {}): JobState => ({
  version: 1, id, task: 'write my lab report draft', status: 'running', folder: `/x/${id}`, cwd: `/x/${id}`, source: 'voice-ptt', createdAt: Date.now() - 600_000,
  startedAt: Date.now() - 600_000, endedAt: null, deadlineAt: Date.now() + 2_000_000, pid: process.pid, claudePid: null, sessionId: '', model: 'sonnet', web: false,
  maxTurns: 150, maxBudgetUsd: 5, wallClockMs: 2_700_000, repo: null, turns: 7, toolCalls: 3, costUsd: 0.2, denials: 0, summary: '', error: '', ...o,
});

const kws = await prepareKwsModel();

describe.skipIf(!kws.ok)('finish flow in stephen listen', () => {
  function start(home: string, notes: [string, string][]) {
    const root = mkdtempSync(join(tmp, 'models-'));
    symlinkSync(join(kws.ok ? kws.root : '', KWS_MODEL.dir), join(root, KWS_MODEL.dir));
    fakeInstall(root, VAD_MODEL);
    fakeInstall(root, ASR_ARCHIVES['whisper-small.en']);
    const source = new EndlessSource();
    const speaker = new RecordingSpeaker();
    const e: ListenEnv = {
      loadConfig: () => ({ home, voice: { claudeModel: 'haiku', speak: true }, app: { enabled: false }, jobs: { keepDays: 1 }, auditLogPath: join(home, 'audit.log') }),
      out: () => undefined,
      err: () => undefined,
      speaker,
      chimes: new RecordingChimes(),
      signals: false,
      cliPath: '/opt/stephen/dist/cli.js',
      modelsRoot: root,
      download: () => Promise.reject(new Error('must not download')),
      helper: () => null,
      source,
      engines: async () => ({ spotter: new ScriptedSpotter({}), vad: new FakeVad(), transcriber: new FakeTranscriber([]) }),
      jobNotify: (t, b) => notes.push([t, b]),
      jobPollMs: 50,
    };
    return { source, speaker, running: runListen(['--no-helper'], e) };
  }

  it('announces once, not again after a restart, and purges old logs at start', async () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
    // Not finished yet: a fresh queued job (a running one would need a real supervisor process, REVIEW-8 R8-5).
    writeJobState(home, job('2026-11-05-a', { status: 'queued', pid: null, startedAt: null, createdAt: Date.now() }));
    writeJobState(home, job('2026-10-01-old', { status: 'done', endedAt: Date.now() - 5 * 86_400_000, pid: null }));
    const notes: [string, string][] = [];
    const t = start(home, notes);
    await waitFor(() => !existsSync(statePath(home, '2026-10-01-old')), 10_000, 'purge');
    await sleep(300);
    expect(t.speaker.said.join(' ')).not.toContain('Your job');
    writeJobState(home, job('2026-11-05-a', { status: 'done', endedAt: Date.now(), pid: null, summary: 'I wrote the draft. More follows.' }));
    await waitFor(() => t.speaker.said.some((s) => s.includes("Your job 'write my lab report draft' is done: I wrote the draft.")), 10_000, 'spoken summary');
    expect(notes).toEqual([['Stephen job done', 'write my lab report draft']]);
    await sleep(300);
    expect(t.speaker.said.filter((s) => s.includes('Your job'))).toHaveLength(1);
    await t.source.stop();
    expect(await t.running).toBe(0);

    const again: [string, string][] = [];
    const t2 = start(home, again);
    await sleep(500);
    await t2.source.stop();
    expect(await t2.running).toBe(0);
    expect(again).toEqual([]);
    expect(t2.speaker.said.join(' ')).not.toContain('Your job');
  });
});
