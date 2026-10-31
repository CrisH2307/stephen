import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../src/voice/claude.js';
import { PTT_NEEDS_HELPER } from '../../src/voice/helper-link.js';
import { FOLLOW_UP_IGNORED_NOTE, runListen, runVoiceSetup, type ListenEnv } from '../../src/voice/index.js';
import { FakeHelper } from './fakes.js';
import { fakeClaudePath, readFakeLog, RecordingChimes, RecordingSpeaker } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-listen-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function env(voice: Record<string, unknown> = {}, extra: Partial<ListenEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const speaker = new RecordingSpeaker();
  const chimes = new RecordingChimes();
  const e: ListenEnv = {
    loadConfig: () => ({ home: join(tmp, 'home'), voice }),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    speaker,
    chimes,
    signals: false,
    cliPath: '/opt/stephen/dist/cli.js',
    ...extra,
  };
  return { e, out, err, speaker, chimes };
}

describe('stephen listen --text', () => {
  it('--text "open youtube" --dry-run prints the exact claude argv and runs nothing', async () => {
    const t = env({ claudePath: '/usr/local/bin/claude', maxTurns: 8 });
    expect(await runListen(['--text', 'open youtube', '--dry-run'], t.e)).toBe(0);
    const line = t.out.find((l) => l.startsWith('claude argv (dry run): '))!;
    const argv = JSON.parse(line.slice(line.indexOf('['))) as string[];
    const mcpPath = join(tmp, 'home', 'voice', 'mcp-config.json');
    expect(argv).toEqual(['/usr/local/bin/claude', ...buildClaudeArgs('open youtube', { claudePath: 'x', maxTurns: 8, model: null, mcpConfigPath: mcpPath })]);
    expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual({ mcpServers: { stephen: { command: process.execPath, args: ['/opt/stephen/dist/cli.js', 'serve', '--confirm', 'dialog', '--voice'] } } });
    expect(t.out[0]).toMatch(/^MCP config \(.*mcp-config\.json\): \{"mcpServers":\{"stephen":/);
    expect(t.speaker.said).toEqual([]); // dry run never speaks
    expect(t.chimes.played).toEqual([]);
  });

  it('voice.followUpWindowSec still loads but is reported as ignored; --text never resumes', async () => {
    const log = join(tmp, 'followup.log');
    const t = env({ claudePath: fakeClaudePath(), followUpWindowSec: 120 }, { env: { ...process.env, FAKE_CLAUDE_LOG: log } });
    expect(await runListen(['--text', 'open youtube'], t.e)).toBe(0);
    expect(await runListen(['--text', 'now search for lo-fi'], t.e)).toBe(0);
    expect(t.err.filter((l) => l === FOLLOW_UP_IGNORED_NOTE)).toHaveLength(2);
    expect(FOLLOW_UP_IGNORED_NOTE).toMatch(/ignored in phase 1/);
    expect(readFakeLog(log).map((r) => r.argv.includes('--resume'))).toEqual([false, false]);
    const quiet = env({ claudePath: fakeClaudePath() }, { env: { ...process.env, FAKE_CLAUDE_LOG: join(tmp, 'quiet.log') } });
    await runListen(['--text', 'x'], quiet.e);
    expect(quiet.err.filter((l) => /followUpWindowSec/.test(l))).toEqual([]);
  });

  it('--text runs (fake) Claude and speaks the cleaned-up reply', async () => {
    const log = join(tmp, 'text.log');
    const t = env({ claudePath: fakeClaudePath() }, { env: { ...process.env, FAKE_CLAUDE_LOG: log } });
    expect(await runListen(['--text', 'open youtube'], t.e)).toBe(0);
    const runs = readFakeLog(log);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.argv.slice(0, 2)).toEqual(['-p', 'open youtube']);
    expect(runs[0]!.cwd).toBe(join(tmp, 'home', 'voice', 'workdir'));
    expect(t.speaker.said).toEqual(['Done! I opened YouTube for "open youtube".']);
    expect(t.chimes.played).toEqual(['done']);
    expect(t.out).toEqual(expect.arrayContaining(['Heard: "open youtube"', 'Working…']));
    expect(t.out.some((l) => /^Done \(\d+\.\d s\)$/.test(l))).toBe(true);
  });

  it('--no-speak / speak:false prints the reply only; errors give exit 1', async () => {
    const t = env({ claudePath: fakeClaudePath(), speak: false }, { env: { ...process.env, FAKE_CLAUDE_MODE: 'error' } });
    expect(await runListen(['--text', 'x'], t.e)).toBe(1);
    expect(t.speaker.said).toEqual([]);
    expect(t.out).toContain('Problem: I ran out of steps before finishing.');
  });

  it('rejects bad config and bad options with exit 2', async () => {
    const bad = env({ wakePhrase: 'stephen' });
    expect(await runListen(['--text', 'x'], bad.e)).toBe(2);
    expect(bad.err[0]).toMatch(/Invalid voice config: "voice.wakePhrase"/);
    const opt = env();
    expect(await runListen(['--frobnicate'], opt.e)).toBe(2);
    expect(opt.err[0]).toMatch(/Unknown option "--frobnicate"/);
    const help = env();
    expect(await runListen(['--help'], help.e)).toBe(0);
    expect(help.out[0]).toMatch(/stephen listen \[options\]/);
  });

  it('voice-setup reports download failures without throwing', async () => {
    const t = env({}, { modelsRoot: join(tmp, 'models'), download: async () => Promise.reject(new Error('offline')) });
    expect(await runVoiceSetup([], t.e)).toBe(1);
    expect(t.err[0]).toMatch(/voice-setup failed: offline/);
    expect(await runVoiceSetup(['--bogus'], t.e)).toBe(2);
  });
});

describe('stephen listen: push-to-talk only needs the helper', () => {
  it('--ptt-only without a helper exits 1 with an install hint (before loading any model)', async () => {
    const t = env({}, { helper: () => null, download: async () => Promise.reject(new Error('must not download')) });
    expect(await runListen(['--ptt-only'], t.e)).toBe(1);
    expect(t.err).toContain(PTT_NEEDS_HELPER + ' (Stephen Helper is not installed)');
  });

  it('voice.wakeWord false with a helper that fails to start exits 1 with its reason', async () => {
    const t = env({ wakeWord: false }, { helper: () => new FakeHelper({ ok: false, reason: 'helper did not answer' }) });
    expect(await runListen([], t.e)).toBe(1);
    expect(t.err).toContain(`${PTT_NEEDS_HELPER} (helper did not answer)`);
  });

  it('--text never connects to the helper', async () => {
    let calls = 0;
    const t = env({}, { helper: () => (calls++, null) });
    expect(await runListen(['--text', 'open youtube', '--dry-run'], t.e)).toBe(0);
    expect(calls).toBe(0);
  });

  it('usage mentions push-to-talk, --ptt-only and --no-helper', async () => {
    const t = env();
    await runListen(['--help'], t.e);
    expect(t.out[0]).toMatch(/--ptt-only/);
    expect(t.out[0]).toMatch(/--no-helper/);
    expect(t.out[0]).toMatch(/hold Fn\+Option/);
  });
});
