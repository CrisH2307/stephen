/**
 * Where a voice command's time goes: ClaudeRunner measures spawn → exit and splits it with Claude Code's own
 * duration_ms / duration_api_ms (the fake claude simulates start-up, model and tool time; the real model is never called).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeRunner, formatTiming, parseClaudeOutput, type ClaudeTiming } from '../../src/voice/claude.js';
import { fakeClaudePath } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-timing-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('voice command timing', () => {
  it('reads duration_ms / duration_api_ms from the result JSON', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', result: 'Bet.', num_turns: 3, duration_ms: 3200, duration_api_ms: 2600 });
    expect(parseClaudeOutput(out, 0)).toMatchObject({ kind: 'ok', durationMs: 3200, apiMs: 2600, turns: 3 });
  });

  it('formats the split: start-up + MCP, model, tools + overhead', () => {
    expect(formatTiming({ wallMs: 4300, durationMs: 3200, apiMs: 2600, turns: 3 })).toBe('claude: 4.3 s (start-up + MCP 1.1 s, model 2.6 s in 3 turns, tools + overhead 0.6 s)');
    expect(formatTiming({ wallMs: 900, durationMs: null, apiMs: null, turns: null })).toBe('claude: 0.9 s');
  });

  it('formats the warm path: the pre-warm lead or the follow-up number, then the same split (comparable with one-shot)', () => {
    // Pre-warmed 3 s before the command: nothing left to wait for.
    expect(formatTiming({ wallMs: 1900, durationMs: 1880, apiMs: 1800, turns: 1, warm: { command: 1, leadMs: 3000 } })).toBe(
      'claude: 1.9 s (warm, spawned 3.0 s ahead; start-up + MCP 0.0 s, model 1.8 s in 1 turn, tools + overhead 0.1 s)',
    );
    // Spawned only 0.4 s ahead: the command waited about 1.1 s of start-up.
    expect(formatTiming({ wallMs: 3400, durationMs: 2300, apiMs: 2000, turns: 2, warm: { command: 1, leadMs: 400 } })).toBe(
      'claude: 3.4 s (warm, spawned 0.4 s ahead; start-up + MCP 1.1 s, model 2.0 s in 2 turns, tools + overhead 0.3 s)',
    );
    expect(formatTiming({ wallMs: 1700, durationMs: 1690, apiMs: 1500, turns: 1, warm: { command: 3, leadMs: null } })).toBe(
      'claude: 1.7 s (warm, follow-up 3 on this process; start-up + MCP 0.0 s, model 1.5 s in 1 turn, tools + overhead 0.2 s)',
    );
    expect(formatTiming({ wallMs: 800, durationMs: null, apiMs: null, turns: null, warm: { command: 1, leadMs: 0 } })).toBe('claude: 0.8 s (warm, spawned 0.0 s ahead)');
  });

  it('ClaudeRunner reports the timing of a finished run (fake claude: 300 ms start-up, 400 ms run, 250 ms model)', async () => {
    const timings: ClaudeTiming[] = [];
    const runner = new ClaudeRunner({
      claudePath: fakeClaudePath(),
      maxTurns: 15,
      model: 'haiku',
      mcpConfigPath: join(tmp, 'mcp.json'),
      cwd: tmp,
      env: { ...process.env, FAKE_CLAUDE_STARTUP_MS: '300', FAKE_CLAUDE_DURATION_MS: '400', FAKE_CLAUDE_API_MS: '250' },
      onTiming: (t) => timings.push(t),
    });
    const r = await runner.run('play one call away');
    expect(r.kind).toBe('ok');
    expect(timings).toHaveLength(1);
    const t = timings[0]!;
    expect(t).toMatchObject({ durationMs: 400, apiMs: 250, turns: 2 });
    expect(t.wallMs).toBeGreaterThanOrEqual(700);
    // start-up (wall − duration) ≥ the simulated 300 ms + node's own start
    expect(t.wallMs - t.durationMs!).toBeGreaterThanOrEqual(300);
    expect(formatTiming(t)).toMatch(/^claude: \d+\.\d s \(start-up \+ MCP \d+\.\d s, model 0\.3 s in 2 turns, tools \+ overhead 0\.1 s\)$/);
  });
});
