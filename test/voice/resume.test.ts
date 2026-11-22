/**
 * ADR-007 v2 (resume) in the runners: a resumed command starts a NEW Claude process (never `--resume` of the old
 * session, never a live warm process) whose serve gets `--assume-private-read` and the new command's trust.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RESUME_WRAPPER_HEAD, resumePrompt } from '../../src/history/resume.js';
import type { HistoryEntry } from '../../src/history/store.js';
import { parseServeArgs } from '../../src/serve-args.js';
import { claimServeInstance, newServeInstance, serveLockPath } from '../../src/server/instance.js';
import { toolLogPath } from '../../src/server/tool-log.js';
import { Assistant, type ResumeRequest, type Trust } from '../../src/voice/assistant.js';
import { ClaudeRunner, mcpConfig, writeMcpConfig, type ClaudeOutcome } from '../../src/voice/claude.js';
import { ToolLogRunner } from '../../src/voice/command-log.js';
import { Conversation, ConversationRunner, WarmConversationRunner } from '../../src/voice/conversation.js';
import type { WarmProcess } from '../../src/voice/warm-claude.js';
import { fakeClaudePath, readFakeLog, RecordingChimes, RecordingSpeaker } from './helpers.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-resume-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const CONV = 'c_00112233aabbccdd';
const OLD: HistoryEntry[] = [
  { id: 'h_0000000000000001', ts: '2026-11-20T10:00:00.000Z', source: 'app', said: 'read my mail', reply: 'Two new emails.', outcome: 'ok', tools: [], followUp: false, ms: 5, turns: 1, conv: CONV },
];
const resume: ResumeRequest = { prompt: (m, trust) => resumePrompt(OLD, CONV, trust, m) };
const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const quiet = { speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => {} };

describe('ADR-007 v2: the serve of a resumed conversation', () => {
  it('the serve argv of a resumed conversation contains --assume-private-read and the new command\'s trust', async () => {
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
    const conversation = new Conversation({ dir: join(home, 'voice'), windowSec: 180 });
    // The listener's chain: ToolLogRunner → ConversationRunner → ClaudeRunner (each must pass the flag on).
    const runner = new ToolLogRunner(new ConversationRunner(claude, conversation), toolLogPath(home));
    const assistant = new Assistant({ runner, ...quiet });

    await assistant.command('read my mail', { source: 'app' });
    await assistant.command('what did the second one say', { source: 'app', resume });
    await assistant.command('reply thanks', { source: 'app' }); // from here an ordinary follow-up

    expect(seen.map((s) => [s.trust, s.apr === true])).toEqual([['trusted', false], ['trusted', true], ['trusted', false]]);
    // The window's trust is `trusted`: no --trust flag (a wake serve would carry --trust wake).
    expect(seen[1]!.args).toContain('--assume-private-read');
    expect(seen[1]!.args).not.toContain('--trust');
    expect(seen[0]!.args).not.toContain('--assume-private-read');
    const runs = readFakeLog(log);
    // A fresh start: the resumed run never reopens the old session; the wrapper is its prompt.
    expect(runs[1]!.argv).not.toContain('--resume');
    expect(flagValue(runs[1]!.argv, '-p').startsWith(RESUME_WRAPPER_HEAD)).toBe(true);
    expect(flagValue(runs[1]!.argv, '-p').endsWith('\n\nwhat did the second one say')).toBe(true);
    // The next command continues the resumed conversation (not the old one).
    expect(flagValue(runs[2]!.argv, '--resume')).toBe('sess-2');

    // With another command trust the serve gets that trust too, and serve parses both flags.
    for (const t of ['trusted', 'wake', 'phone'] as Trust[]) {
      const args = mcpConfig('/n', '/c', null, null, null, t, null, true).mcpServers.stephen!.args;
      const parsed = parseServeArgs(args.slice(2));
      expect(parsed, t).toMatchObject({ assumePrivateRead: true, ...(t === 'trusted' ? {} : { trust: 'wake' }), confirm: t === 'phone' ? 'deny' : 'app' });
    }
  });

  it('fails closed: a resumed run without a fresh serve instance never starts Claude', async () => {
    const log = join(tmp, 'closed.log');
    const claude = new ClaudeRunner({ claudePath: fakeClaudePath(), maxTurns: 15, model: null, mcpConfigPath: '/static', cwd: tmp, env: { ...process.env, FAKE_CLAUDE_LOG: log } });
    const out = await claude.run('hello', { trust: 'trusted', assumePrivateRead: true });
    expect(out.kind).toBe('error');
    expect(readFakeLog(log)).toEqual([]);
  });

  it('warm: a resumed command ends the live process and starts a new one whose serve has --assume-private-read', async () => {
    const dir = join(tmp, 'warm');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const procs: (WarmProcess & { turns: string[]; killed: boolean })[] = [];
    let n = 0;
    const runner = new WarmConversationRunner({
      conversation: new Conversation({ dir, windowSec: 180 }),
      start: (memoryKey, trust, assumePrivateRead) => {
        const id = ++n;
        const p = {
          spawnedAt: Date.now(),
          memoryKey,
          trust,
          assumePrivateRead,
          exited: false,
          sessionId: null as string | null,
          turns: [] as string[],
          killed: false,
          ready: async () => undefined,
          turn: async (prompt: string): Promise<ClaudeOutcome> => {
            p.turns.push(prompt);
            p.sessionId = `sess-${id}`;
            return { kind: 'ok', text: 'ok', sessionId: `sess-${id}`, costUsd: 0, turns: 1 };
          },
          kill: async () => {
            p.killed = true;
            p.exited = true;
          },
          killNow: () => undefined,
          onExit: () => undefined,
        };
        procs.push(p);
        return p;
      },
    });
    const assistant = new Assistant({ runner, ...quiet });
    await assistant.command('read my mail', { source: 'app' });
    runner.prewarm('trusted'); // a live process is up and would take a follow-up
    await assistant.command('what did it say', { source: 'app', resume });
    await assistant.command('thanks', { source: 'app' });
    expect(procs.map((p) => p.assumePrivateRead)).toEqual([false, true]);
    expect(procs[0]!.killed).toBe(true);
    expect(procs[0]!.turns).toEqual(['read my mail']);
    // The new process got the wrapper first, then the ordinary follow-up.
    expect(procs[1]!.turns[0]!.startsWith(RESUME_WRAPPER_HEAD)).toBe(true);
    expect(procs[1]!.turns[1]).toBe('thanks');
    await runner.shutdown();
  });
});
