/**
 * WarmConversationRunner (src/voice/conversation.ts): one warm process per conversation and its end rules. Every end
 * runs kill → closed → reset (session id, then state file) before the next spawn. Most tests drive an in-memory
 * process with fake timers (the 60 s / 25 commands / 30 min caps, the window); the last block uses the real fake
 * claude subprocess (process group, an old serve that keeps writing the state file, tool log per command).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Assistant } from '../../src/voice/assistant.js';
import { mcpConfig, type ClaudeOutcome, type ClaudeTiming } from '../../src/voice/claude.js';
import { ToolLogRunner } from '../../src/voice/command-log.js';
import { CONVERSATION_FILE, Conversation, MAX_WARM_COMMANDS, PREWARM_UNUSED_MS, WarmConversationRunner, memoryKey } from '../../src/voice/conversation.js';
import { WarmClaude, type WarmClaudeOptions, type WarmProcess } from '../../src/voice/warm-claude.js';
import { toolLogPath } from '../../src/server/tool-log.js';
import { fakeClaudePath, isAlive, RecordingChimes, RecordingSpeaker, waitFor } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-warm-runner-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => {
  const d = join(tmp, `voice-${++dirs}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

const OK = (sessionId = 'sess-1'): ClaudeOutcome => ({ kind: 'ok', text: 'ok', sessionId, costUsd: 0.01, turns: 1, durationMs: 900, apiMs: 800 });
type Next = ClaudeOutcome | 'hold';

/** An in-memory warm process. Its kill() closes one macrotask later, so the ordering is observable. */
class FakeProc implements WarmProcess {
  readonly spawnedAt = Date.now();
  exited = false;
  readonly turns: string[] = [];
  private readonly exitFns: (() => void)[] = [];
  private release: ((o: ClaudeOutcome) => void) | null = null;
  constructor(
    readonly id: number,
    readonly memoryKey: string | undefined,
    private readonly w: World,
  ) {}
  ready(): Promise<void> {
    return this.w.ready(this);
  }
  turn(prompt: string): Promise<ClaudeOutcome> {
    this.turns.push(prompt);
    this.w.events.push(`turn:${this.id}`);
    const n = this.w.next.length ? this.w.next.shift()! : OK();
    if (n === 'hold') return new Promise((r) => (this.release = r));
    return Promise.resolve(n);
  }
  async kill(): Promise<void> {
    if (this.exited) return;
    this.w.events.push(`kill:${this.id}`);
    await new Promise((r) => setImmediate(r));
    this.exit();
  }
  killNow(): void {
    this.w.events.push(`killNow:${this.id}`);
    this.exit();
  }
  /** Exit (killed, or crashed on its own). */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.w.events.push(`closed:${this.id}`);
    this.release?.({ kind: 'cancelled' });
    for (const fn of this.exitFns.splice(0)) fn();
  }
  onExit(fn: () => void): void {
    this.exitFns.push(fn);
  }
}

interface World {
  events: string[];
  next: Next[];
  ready: (p: FakeProc) => Promise<void>;
}

function harness(windowSec = 180) {
  const dir = freshDir();
  let memory = ['my gym is goodlife'];
  const w: World = { events: [], next: [], ready: async () => undefined };
  const conv = new Conversation({ dir, windowSec, memoryKey: () => memoryKey(memory) });
  const reset = conv.reset.bind(conv);
  conv.reset = () => {
    w.events.push('reset');
    reset();
  };
  const procs: FakeProc[] = [];
  const timings: ClaudeTiming[] = [];
  const runner = new WarmConversationRunner({
    conversation: conv,
    start: (key) => {
      const p = new FakeProc(procs.length + 1, key, w);
      procs.push(p);
      w.events.push(`spawn:${p.id}`);
      return p;
    },
    onTiming: (t) => timings.push(t),
  });
  const plantState = () => writeFileSync(conv.statePath, '{"version":1,"privateReads":[{"host":"mail.google.com","scope":"mail.google.com","at":1}],"trustedHosts":[]}\n', { mode: 0o600 });
  return {
    dir,
    conv,
    runner,
    procs,
    w,
    timings,
    plantState,
    setMemory: (m: string[]) => (memory = m),
    stateExists: () => existsSync(conv.statePath),
  };
}

/** Let promise chains and setImmediate callbacks run (timers are fake). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Process `id` was killed (unless it exited by itself), closed, and the conversation reset after the close and
 * before process id+1 spawned.
 */
function expectEndedInOrder(events: string[], id: number, selfExit = false): void {
  const kill = events.indexOf(`kill:${id}`);
  const closed = events.indexOf(`closed:${id}`);
  const reset = events.indexOf('reset', closed);
  if (!selfExit) {
    expect(kill, events.join(' ')).toBeGreaterThanOrEqual(0);
    expect(closed, events.join(' ')).toBeGreaterThan(kill);
    expect(events.slice(kill, closed), 'no reset while the process may still write').not.toContain('reset');
  }
  expect(closed, events.join(' ')).toBeGreaterThanOrEqual(0);
  expect(reset, events.join(' ')).toBeGreaterThan(closed);
  const next = events.indexOf(`spawn:${id + 1}`);
  if (next >= 0) expect(next, events.join(' ')).toBeGreaterThan(reset);
}

describe('WarmConversationRunner (in-memory process, fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('a pre-warmed process takes the command; a follow-up in the window reuses it (same process, "follow-up")', async () => {
    const h = harness();
    h.runner.prewarm();
    await settle();
    expect(h.w.events).toEqual(['reset', 'spawn:1']); // fresh gate before the spawn
    vi.advanceTimersByTime(3000); // the user talks for 3 s
    expect(h.runner.followUp()).toBe(false);
    expect(await h.runner.run('how long to tmu station')).toMatchObject({ kind: 'ok' });
    h.runner.commandEnded();
    vi.advanceTimersByTime(60_000);
    expect(h.runner.followUp()).toBe(true);
    expect(await h.runner.run('what about by car')).toMatchObject({ kind: 'ok' });
    expect(h.procs).toHaveLength(1);
    expect(h.procs[0]!.turns).toEqual(['how long to tmu station', 'what about by car']);
    expect(h.w.events.filter((e) => e.startsWith('kill'))).toEqual([]);
    expect(h.timings.map((t) => t.warm)).toEqual([
      { command: 1, leadMs: 3000 },
      { command: 2, leadMs: null },
    ]);
    expect(JSON.parse(readFileSync(join(h.dir, CONVERSATION_FILE), 'utf8')).sessionId).toBe('sess-1');
  });

  it('without a pre-warm, run() spawns (cold) after resetting the conversation', async () => {
    const h = harness();
    h.plantState(); // a leftover from an earlier listener
    await h.runner.run('open youtube');
    expect(h.w.events.slice(0, 3)).toEqual(['reset', 'spawn:1', 'turn:1']);
    expect(h.timings[0]!.warm).toEqual({ command: 1, leadMs: 0 });
  });

  const triggers: [string, (h: ReturnType<typeof harness>) => Promise<void>][] = [
    [
      'the window ran out (timer)',
      async () => {
        vi.advanceTimersByTime(180_001);
        await settle();
      },
    ],
    [
      'the window ran out (checked before the command)',
      async () => {
        vi.setSystemTime(Date.now() + 180_001); // the clock jumps (sleep), the timer has not fired
      },
    ],
    ['a memory change from the router (endConversation)', async (h) => h.runner.endConversation()],
    ['a memory change elsewhere (app, CLI, hand edit)', async (h) => void h.setMemory(['my gym is anytime fitness'])],
    ['Esc / "Stephen stop" while idle', async (h) => h.runner.endConversation()],
    ['the process exited on its own while idle', async (h) => h.procs[0]!.exit()],
  ];
  it.each(triggers)('%s: kill → closed → reset (state file gone) before the next spawn', async (what, trigger) => {
    const h = harness();
    await h.runner.run('one');
    h.runner.commandEnded();
    h.plantState(); // the serve noted a private read
    await trigger(h);
    expect(h.runner.followUp()).toBe(false);
    await h.runner.run('two');
    expectEndedInOrder(h.w.events, 1, what.includes('exited on its own'));
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.turns).toEqual(['two']);
    expect(h.stateExists()).toBe(false);
  });

  it.each([
    ['an error result', { kind: 'error', message: 'I ran out of steps before finishing.', sessionId: 'sess-1' } as ClaudeOutcome],
    ['MCP not connected', { kind: 'error', message: "Stephen's tools are not connected (MCP status: failed).", sessionId: null } as ClaudeOutcome],
    ['an OK result without a session id', { kind: 'ok', text: 'ok', sessionId: null, costUsd: 0, turns: 1 } as ClaudeOutcome],
  ])('%s ends the conversation in order; the next command starts fresh', async (_what, outcome) => {
    const h = harness();
    await h.runner.run('one');
    h.plantState();
    h.w.next.push(outcome);
    const out = await h.runner.run('two');
    expect(out).toEqual(outcome);
    await settle();
    expectEndedInOrder(h.w.events, 1);
    expect(h.stateExists()).toBe(false);
    expect(existsSync(join(h.dir, CONVERSATION_FILE))).toBe(false);
    await h.runner.run('three');
    expect(h.procs.map((p) => p.turns)).toEqual([['one', 'two'], ['three']]);
  });

  it('cancel during a command kills the process: the command is cancelled, then the reset', async () => {
    const h = harness();
    h.w.next.push('hold');
    const run = h.runner.run('play a long podcast');
    await settle();
    h.plantState();
    expect(h.runner.cancel()).toBe(true);
    expect(await run).toEqual({ kind: 'cancelled' });
    await settle();
    expectEndedInOrder(h.w.events, 1);
    expect(h.stateExists()).toBe(false);
    expect(h.runner.cancel()).toBe(false); // nothing running
  });

  it('cancel while the process is still starting: cancelled, nothing is sent', async () => {
    const h = harness();
    let go!: () => void;
    h.w.ready = () => new Promise((r) => (go = r));
    const run = h.runner.run('open youtube');
    await settle();
    h.runner.cancel();
    go();
    expect(await run).toEqual({ kind: 'cancelled' });
    expect(h.procs[0]!.turns).toEqual([]);
  });

  it('a process that never gets ready: an error, ended, and the next command spawns fresh', async () => {
    const h = harness();
    h.w.ready = async (p) => {
      if (p.id === 1) throw new Error("Stephen's tools didn't start (MCP status: failed).");
    };
    expect(await h.runner.run('one')).toMatchObject({ kind: 'error', message: expect.stringMatching(/MCP status: failed/) });
    await settle();
    expectEndedInOrder(h.w.events, 1);
    expect(await h.runner.run('two')).toMatchObject({ kind: 'ok' });
    expect(h.procs[1]!.turns).toEqual(['two']);
  });

  it('a memory change between the pre-warm and the command discards the pre-warmed process', async () => {
    const h = harness();
    h.runner.prewarm();
    await settle();
    expect(h.procs[0]!.memoryKey).toBe(memoryKey(['my gym is goodlife']));
    h.setMemory(['my gym is goodlife', 'my sister is Mai']); // e.g. "remember …" said in the app meanwhile
    await h.runner.run('text my sister');
    expectEndedInOrder(h.w.events, 1);
    expect(h.procs[0]!.turns).toEqual([]);
    expect(h.procs[1]!.memoryKey).toBe(memoryKey(['my gym is goodlife', 'my sister is Mai']));
    expect(h.procs[1]!.turns).toEqual(['text my sister']);
  });

  it('a memory change while the process starts: it is replaced once before anything is sent', async () => {
    const h = harness();
    h.w.ready = async (p) => {
      if (p.id === 1) h.setMemory(['changed while starting']);
    };
    expect(await h.runner.run('hi')).toMatchObject({ kind: 'ok' });
    expect(h.procs.map((p) => p.turns)).toEqual([[], ['hi']]);
    expectEndedInOrder(h.w.events, 1);
  });

  it(`an unused pre-warmed process is killed after ${PREWARM_UNUSED_MS / 1000} s`, async () => {
    const h = harness();
    h.runner.prewarm(); // a false wake
    await settle();
    h.plantState();
    vi.advanceTimersByTime(PREWARM_UNUSED_MS - 1);
    await settle();
    expect(h.procs[0]!.exited).toBe(false);
    vi.advanceTimersByTime(1);
    await settle();
    expectEndedInOrder(h.w.events, 1);
    expect(h.stateExists()).toBe(false);
    expect(h.runner.process).toBeNull();
  });

  it(`a live process ends after ${MAX_WARM_COMMANDS} commands; the next one is fresh`, async () => {
    const h = harness();
    for (let i = 1; i <= MAX_WARM_COMMANDS; i++) {
      if (i > 1) expect(h.runner.followUp(), `command ${i}`).toBe(true);
      expect(await h.runner.run(`command ${i}`)).toMatchObject({ kind: 'ok' });
      h.runner.commandEnded();
      vi.advanceTimersByTime(20_000);
    }
    await settle();
    expect(h.procs[0]!.turns).toHaveLength(MAX_WARM_COMMANDS);
    expectEndedInOrder(h.w.events, 1);
    expect(h.runner.followUp()).toBe(false);
    await h.runner.run('one more');
    expect(h.procs[1]!.turns).toEqual(['one more']);
  });

  it('a live process ends once it is 30 minutes old, even inside the window', async () => {
    const h = harness(1800);
    for (let i = 0; i < 3; i++) {
      await h.runner.run(`c${i}`);
      h.runner.commandEnded();
      vi.advanceTimersByTime(10 * 60_000); // t = 10, 20, 30 min
    }
    expect(h.procs).toHaveLength(1);
    expect(h.runner.followUp()).toBe(false);
    await h.runner.run('c3');
    expectEndedInOrder(h.w.events, 1);
    expect(h.procs[1]!.turns).toEqual(['c3']);
  });

  it('window 0: every command ends its process (in order), and the next one is still pre-warmed', async () => {
    const h = harness(0);
    h.runner.prewarm();
    await settle();
    await h.runner.run('one');
    await settle();
    expectEndedInOrder(h.w.events, 1);
    h.runner.prewarm();
    await settle();
    expect(h.procs).toHaveLength(2);
    expect(h.runner.followUp()).toBe(false);
    await h.runner.run('two');
    expect(h.procs[1]!.turns).toEqual(['two']);
    expect(existsSync(join(h.dir, CONVERSATION_FILE))).toBe(false);
  });

  it('prewarm is a no-op while a command runs, and when a usable process is up', async () => {
    const h = harness();
    h.w.next.push('hold');
    const run = h.runner.run('one');
    await settle();
    h.runner.prewarm();
    await settle();
    expect(h.procs).toHaveLength(1);
    h.procs[0]!.exit(); // ends the held turn
    await run;
    await settle();
    await h.runner.run('two');
    h.runner.prewarm(); // inside the window: keep the live process
    await settle();
    expect(h.procs).toHaveLength(2);
  });

  it('a pre-warm after the window ran out (timer not fired yet) replaces the old process right away', async () => {
    const h = harness();
    await h.runner.run('one');
    vi.setSystemTime(Date.now() + 181_000);
    h.runner.prewarm();
    await settle();
    expectEndedInOrder(h.w.events, 1);
    expect(h.procs).toHaveLength(2);
  });

  it('Esc while idle with no process still deletes the state file', async () => {
    const h = harness();
    h.plantState();
    h.runner.endConversation();
    await settle();
    expect(h.stateExists()).toBe(false);
  });

  it('shutdown (listener exit) ends the conversation in order; killNow is the synchronous last resort', async () => {
    const h = harness();
    await h.runner.run('one');
    h.plantState();
    await h.runner.shutdown();
    expectEndedInOrder(h.w.events, 1);
    expect(h.stateExists()).toBe(false);
    await h.runner.run('two');
    h.runner.killNow();
    expect(h.w.events).toContain('killNow:2');
  });

  it('the Assistant prints "(follow-up)" for a command on the live process', async () => {
    const h = harness();
    const lines: string[] = [];
    const a = new Assistant({ runner: h.runner, speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: (l) => lines.push(l) });
    a.prewarm();
    await settle();
    await a.handle('one');
    await a.handle('two');
    expect(lines.filter((l) => l.startsWith('Working'))).toEqual(['Working…', 'Working… (follow-up)']);
    expect(h.procs).toHaveLength(1);
  });
});

// ───────────── with the real fake-claude subprocess ─────────────

/** `env` may use the conversation's state file path (the fake serve can be told to keep writing it). */
function realHarness(env: (statePath: string) => Record<string, string>) {
  const home = freshDir();
  const voiceDir = join(home, 'voice');
  mkdirSync(voiceDir, { recursive: true, mode: 0o700 });
  const conv = new Conversation({ dir: voiceDir, windowSec: 180 });
  const pids = join(home, 'pids.json');
  const toolLog = toolLogPath(home);
  const mcpConfigPath = join(voiceDir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig('/usr/bin/node', '/x/cli.js', conv.statePath, toolLog)));
  const o: WarmClaudeOptions = {
    claudePath: fakeClaudePath(),
    maxTurns: 25,
    model: 'sonnet',
    mcpConfigPath,
    followUps: true,
    personaFile: join(voiceDir, 'persona.txt'),
    cwd: home,
    env: { ...process.env, FAKE_CLAUDE_PIDS: pids, ...env(conv.statePath) },
    killGraceMs: 500,
    mcpPollMs: 20,
  };
  const runner = new WarmConversationRunner({ conversation: conv, start: (key) => new WarmClaude(o, key, []) });
  const procs = (): { claude: number; child: number } => JSON.parse(readFileSync(pids, 'utf8'));
  return { conv, runner, toolLog, procs, spawned: () => existsSync(pids) };
}

describe('WarmConversationRunner with the real fake claude', () => {
  it('kill before reset: an old serve that keeps rewriting the state file is gone before the file is deleted', async () => {
    // The fake serve rewrites the conversation's state file every 5 ms for as long as it lives.
    const h = realHarness((statePath) => ({ FAKE_CLAUDE_SERVE_WRITES: statePath }));
    expect(await h.runner.run('read my email')).toMatchObject({ kind: 'ok' });
    await waitFor(() => existsSync(h.conv.statePath), 5000, 'the serve writes state');
    await h.runner.shutdown();
    const { claude, child } = h.procs();
    expect(isAlive(claude)).toBe(false);
    expect(isAlive(child)).toBe(false);
    await new Promise((res) => setTimeout(res, 100)); // a live writer would have re-created it by now
    expect(existsSync(h.conv.statePath)).toBe(false);
  });

  it('cancel during a tool call kills the whole group (claude and its serve)', async () => {
    const h = realHarness(() => ({ FAKE_CLAUDE_MODE: 'hang' }));
    const run = h.runner.run('play a long podcast');
    await waitFor(h.spawned, 5000, 'spawn');
    await new Promise((res) => setTimeout(res, 200));
    expect(h.runner.cancel()).toBe(true);
    expect(await run).toEqual({ kind: 'cancelled' });
    await h.runner.shutdown();
    const { claude, child } = h.procs();
    expect(isAlive(claude)).toBe(false);
    expect(isAlive(child)).toBe(false);
  });

  it('one long-lived serve: ToolLogRunner gives each command only its own tool names', async () => {
    const h = realHarness(() => ({ FAKE_CLAUDE_TOOLS: 'open_url,announce|media_control|' }));
    const runner = new ToolLogRunner(h.runner, h.toolLog);
    await runner.run('open youtube and say hi');
    expect(runner.tools().map((t) => t.tool)).toEqual(['open_url', 'announce']);
    const pid = h.procs().claude;
    await runner.run('pause it');
    expect(runner.tools().map((t) => t.tool)).toEqual(['media_control']);
    await runner.run('what time is it');
    expect(runner.tools()).toEqual([]);
    expect(h.procs().claude).toBe(pid); // all three on the same process
    await h.runner.shutdown();
  });
});
