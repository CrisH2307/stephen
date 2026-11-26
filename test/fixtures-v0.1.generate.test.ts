/**
 * B10: how test/fixtures/v0.1/ was made. Runs only with STEPHEN_GEN_FIXTURES=1, never in CI: the fixtures are frozen.
 * Every file comes from Stephen's own writer, into a temp home, then is copied. Run it only on the v0.1 code (the
 * commit that added test/compat.test.ts); a later version adds a v0.2 folder and its own generator instead.
 *   STEPHEN_GEN_FIXTURES=1 npx vitest run test/fixtures-v0.1.generate.test.ts
 * The data is neutral placeholder text, never anything personal.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { HistoryStore } from '../src/history/store.js';
import { writeJobState } from '../src/jobs/state.js';
import { ProposalStore } from '../src/memory/proposals.js';
import { MemoryStore } from '../src/memory/store.js';
import { ReplayRecorder, labelReplayClip, replayDir } from '../src/replay/recorder.js';
import { AuditLog } from '../src/safety/audit.js';
import { writeSessionStateFileSync } from '../src/safety/session-state.js';
import { appendToolLog } from '../src/server/tool-log.js';
import { recordIncident } from '../src/telemetry/incidents.js';
import { LatencyMonitor } from '../src/telemetry/latency.js';
import { TimerStore } from '../src/timers/store.js';
import { Conversation } from '../src/voice/conversation.js';

/** 2026-11-25 14:30 UTC, in every time zone. */
export const T0 = Date.UTC(2026, 10, 25, 14, 30);
const OUT = resolve(__dirname, 'fixtures/v0.1');
const first = (dir: string) => join(dir, readdirSync(dir).sort()[0]!);

describe.runIf(process.env.STEPHEN_GEN_FIXTURES === '1')('generate the v0.1 fixtures', () => {
  it('writes every store with its real writer', async () => {
    mkdirSync(join(OUT, 'replay'), { recursive: true });
    const home = mkdtempSync(join(tmpdir(), 'stephen-fix-'));
    const at = new Date(T0);

    const mem = new MemoryStore({ home, now: () => at });
    await mem.add('example fact one', 'voice-ptt');
    await mem.add('example fact two', 'app');
    copyFileSync(join(home, 'memory.json'), join(OUT, 'memory.json'));

    new ProposalStore({ home, now: () => at }).propose('example suggestion', 'you');
    copyFileSync(join(home, 'memory-proposals.json'), join(OUT, 'memory-proposals.json'));

    const timers = new TimerStore({ home, now: () => T0 });
    timers.add('timer', T0 + 600_000, 'example timer', 600_000);
    timers.add('reminder', T0 + 3_600_000, 'example reminder');
    copyFileSync(join(home, 'timers.json'), join(OUT, 'timers.json'));

    new HistoryStore({ home, retentionDays: 7, now: () => at }).append({
      source: 'voice-ptt', said: 'what time is it', reply: 'It is 9:30.', outcome: 'ok', tools: [], followUp: false, ms: 1800, turns: 1,
    } as never);
    copyFileSync(first(join(home, 'history')), join(OUT, 'history.jsonl'));

    const lat = new LatencyMonitor({ home, now: () => T0 });
    lat.begin('h_0000000000000001', 'ptt', T0);
    lat.mark('h_0000000000000001', 'speechEnd', T0 + 2000);
    lat.mark('h_0000000000000001', 'replyReady', T0 + 4000);
    lat.end('h_0000000000000001', 'ok', { route: 'model', turns: 1, costUsd: 0.0123, model: { modelMs: 1500, toolMs: 0 } });
    copyFileSync(first(join(home, 'telemetry')), join(OUT, 'latency.jsonl'));

    recordIncident(home, { part: 'listen', code: 'command_error', stage: 'run', id: 'h_0000000000000002' }, at);
    copyFileSync(first(join(home, 'incidents')), join(OUT, 'incident.jsonl'));

    mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
    writeJobState(home, {
      version: 1, id: '2026-11-25-example-job', task: 'example job task', status: 'done', folder: '/Users/user/Stephen Jobs/2026-11-25-example-job',
      cwd: '/Users/user/Stephen Jobs/2026-11-25-example-job', source: 'voice-ptt', createdAt: T0, startedAt: T0, endedAt: T0 + 60_000,
      deadlineAt: T0 + 2_700_000, pid: null, claudePid: null, sessionId: null, model: 'sonnet', web: false, maxTurns: 150, maxBudgetUsd: 5,
      wallClockMs: 2_700_000, repo: null, turns: 4, toolCalls: 6, costUsd: 0.21, denials: 0, summary: 'Example summary.', error: '',
    } as never);
    copyFileSync(join(home, 'jobs', '2026-11-25-example-job.json'), join(OUT, 'job-state.json'));

    const audit = new AuditLog({ path: join(home, 'audit.log') });
    await audit.append({ ts: at.toISOString(), tool: 'navigate', outcome: 'ok', intent: 'open the example page' });
    copyFileSync(join(home, 'audit.log'), join(OUT, 'audit.log.fixture')); // .gitignore drops *.log

    mkdirSync(join(home, 'voice'), { recursive: true, mode: 0o700 });
    appendToolLog(join(home, 'voice', 'tool-log.jsonl'), { tool: 'navigate', isError: false, ms: 120, cmd: 'h_0000000000000001' });
    copyFileSync(join(home, 'voice', 'tool-log.jsonl'), join(OUT, 'tool-log.jsonl'));

    writeSessionStateFileSync(join(home, 'voice', 'conversation-state.json'), {
      version: 1, privateReads: [{ host: 'mail.google.com', scope: 'mail.google.com', at: T0 }], trustedHosts: ['example.com'],
    });
    copyFileSync(join(home, 'voice', 'conversation-state.json'), join(OUT, 'conversation-state.json'));

    // The follow-up conversation (src/voice/conversation.ts): the Claude session id, its end time and its trust.
    new Conversation({ dir: join(home, 'voice'), windowSec: 120, now: () => T0 }).remember('11111111-2222-4333-8444-555555555555', undefined, 'trusted');
    copyFileSync(join(home, 'voice', 'conversation.json'), join(OUT, 'conversation.json'));

    const rec = new ReplayRecorder({ home, enabled: () => true, now: () => T0, userHome: join(home, 'user'), excludeFromBackups: async () => {} });
    rec.capture({ id: 'h_0000000000000003', source: 'voice-ptt', startedAt: T0, audio: new Float32Array(160), transcript: 'open the example page' });
    await rec.idle();
    labelReplayClip(home, 'h_0000000000000003', 'ok', T0 + 1000);
    for (const f of readdirSync(replayDir(home))) copyFileSync(join(replayDir(home), f), join(OUT, 'replay', f));

    writeFileSync(join(OUT, 'settings.json'), `${JSON.stringify({ chrome: { mode: 'agent' }, memory: { enabled: true } }, null, 2)}\n`);
    writeFileSync(join(OUT, 'settings-unknown-key.json'), `${JSON.stringify({ chrome: { mode: 'agent' }, memory: { enabled: true, newOption: 2 }, futureThing: { on: true } }, null, 2)}\n`);
  });
});
