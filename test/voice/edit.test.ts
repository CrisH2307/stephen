/**
 * ADR-010 edit and resend in the runners: a resend is the resume path (ADR-007 v2). It starts a NEW Claude process
 * (never `--resume` of the old session) whose serve gets `--assume-private-read` and window trust.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EDIT_DONE_HEAD, RESUME_WRAPPER_HEAD, quotePrompt } from '../../src/history/resume.js';
import type { HistoryEntry } from '../../src/history/store.js';
import { claimServeInstance, newServeInstance, serveLockPath } from '../../src/server/instance.js';
import { toolLogPath } from '../../src/server/tool-log.js';
import { Assistant, type CommandReport, type ResumeRequest, type Trust } from '../../src/voice/assistant.js';
import { ClaudeRunner, writeMcpConfig } from '../../src/voice/claude.js';
import { ToolLogRunner } from '../../src/voice/command-log.js';
import { Conversation, ConversationRunner } from '../../src/voice/conversation.js';
import { fakeClaudePath, readFakeLog, RecordingChimes, RecordingSpeaker } from './helpers.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-edit-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const CONV = 'c_00112233aabbccdd';
const line = (id: string, said: string, source: HistoryEntry['source'], s: number, steps?: HistoryEntry['steps']): HistoryEntry => ({
  id, ts: new Date(Date.UTC(2026, 10, 20, 10, 0, s)).toISOString(), source, said, reply: `re: ${said}`, outcome: 'ok', tools: [], followUp: s > 1, ms: 5, turns: 1, conv: CONV, ...(steps ? { steps } : {}),
});
const EARLIER = [line('h_0000000000000001', 'read my mail', 'voice-ptt', 1)];
const REPLACED = [line('h_0000000000000002', 'play sarah', 'voice-wake', 2, [{ text: 'navigate youtube.com', status: 'ok' }])];
const edit: ResumeRequest = {
  saved: () => true,
  prompt: (m, trust) => quotePrompt(EARLIER, trust, m, REPLACED),
  edit: { conv: CONV, id: REPLACED[0]!.id, source: 'voice-wake' },
};
const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('ADR-010: the serve of a resend', () => {
  it('the serve argv of a resend has --assume-private-read and window trust; a new process, the wrapper, then the edited message', async () => {
    const home = join(tmp, 'argv');
    mkdirSync(join(home, 'voice'), { recursive: true, mode: 0o700 });
    const seen: { trust: Trust; apr: boolean | undefined; args: string[] }[] = [];
    const log = join(tmp, 'argv.log');
    const claude = new ClaudeRunner({
      claudePath: fakeClaudePath(),
      maxTurns: 15,
      model: null,
      mcpConfigPath: '/unused',
      followUps: true,
      cwd: tmp,
      env: { ...process.env, FAKE_CLAUDE_LOG: log },
      serveInstance: async (trust, apr) => {
        const id = newServeInstance();
        const inst = { id, lockPath: serveLockPath(home, id), mcpConfigPath: await writeMcpConfig(join(home, 'voice'), '/usr/bin/node', '/x/cli.js', null, null, id, trust, null, apr) };
        claimServeInstance(home, id, 1);
        seen.push({ trust, apr, args: JSON.parse(readFileSync(inst.mcpConfigPath, 'utf8')).mcpServers.stephen.args as string[] });
        return inst;
      },
    });
    const runner = new ToolLogRunner(new ConversationRunner(claude, new Conversation({ dir: join(home, 'voice'), windowSec: 180 })), toolLogPath(home));
    const reports: CommandReport[] = [];
    const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {}, onDone: (r) => reports.push(r) });

    await assistant.command('play sarah', { source: 'voice-wake' }); // the old conversation, at wake trust
    await assistant.command('play sara', { source: 'app', resume: edit });

    expect(seen.map((s) => [s.trust, s.apr === true])).toEqual([['wake', false], ['trusted', true]]);
    expect(seen[1]!.args).toContain('--assume-private-read');
    expect(seen[1]!.args).not.toContain('--trust'); // window trust: no --trust wake
    const runs = readFakeLog(log);
    expect(runs[1]!.argv).not.toContain('--resume');
    const p = flagValue(runs[1]!.argv, '-p')!;
    expect(p.startsWith(RESUME_WRAPPER_HEAD)).toBe(true);
    expect(p).toContain(`${EDIT_DONE_HEAD}\n- navigate youtube.com`);
    expect(p.endsWith('\n\nplay sara')).toBe(true);
    // The report: source app, a new conversation, and the message it is a version of.
    expect(reports[1]).toMatchObject({ source: 'app', said: 'play sara', editOf: { conv: CONV, id: REPLACED[0]!.id, source: 'voice-wake' } });
    expect(reports[1]!.conv).not.toBe(reports[0]!.conv);
    expect(reports[0]).not.toHaveProperty('editOf');
  });

  it('a resend whose message is gone sends nothing and writes no editOf', async () => {
    const runs: string[] = [];
    const reports: CommandReport[] = [];
    const runner = { run: async (p: string) => (runs.push(p), { kind: 'ok' as const, text: 'x', sessionId: 's', costUsd: 0, turns: 1 }), cancel: () => false };
    const assistant = new Assistant({ runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {}, onDone: (r) => reports.push(r) });
    await assistant.command('play sara', { source: 'app', resume: { ...edit, saved: () => false } });
    expect(runs).toEqual([]);
    expect(reports[0]).not.toHaveProperty('editOf');
  });
});
