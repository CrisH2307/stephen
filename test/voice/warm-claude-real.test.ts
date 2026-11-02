/**
 * Opt-in probe of the REAL Claude Code stream protocol (docs/ADR-003): spends a little of the user's quota, so it is
 * skipped unless STEPHEN_REAL_CLAUDE=1. Needs `claude` logged in and `npm run build` (the eval's dry-run server is the
 * MCP server, so no tool acts). Checks what WarmClaude relies on: initialize, mcp_status → connected, two commands on
 * one process and one session, per-command differences of the cumulative cost / api time, and kill() of the group.
 *   STEPHEN_REAL_CLAUDE=1 npx vitest run test/voice/warm-claude-real.test.ts
 * STEPHEN_REAL_CLAUDE_PATH / STEPHEN_REAL_CLAUDE_MODEL override `claude` / `sonnet`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evalMcpConfig } from '../../src/eval/run.js';
import { stephenCliPath } from '../../src/voice/claude.js';
import { WarmClaude } from '../../src/voice/warm-claude.js';
import { isAlive } from './helpers.js';

const REAL = process.env.STEPHEN_REAL_CLAUDE === '1';
const tmp = mkdtempSync(join(tmpdir(), 'stephen-warm-real-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!REAL)('real Claude Code over stream-json (opt-in: STEPHEN_REAL_CLAUDE=1)', () => {
  it('initialize, MCP connected, two commands on one process and session, per-command cost, kill', async () => {
    expect(existsSync(stephenCliPath()), 'run `npm run build` first').toBe(true);
    const cwd = join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const mcpConfigPath = join(tmp, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify(evalMcpConfig(process.execPath, stephenCliPath(), join(tmp, 'calls.jsonl'))));
    // Like the probes: no variables of a Claude Code session this test may itself run in.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|CLAUDECODE$|CCR_|AI_AGENT$)/.test(k)));
    const p = new WarmClaude(
      {
        claudePath: process.env.STEPHEN_REAL_CLAUDE_PATH ?? 'claude',
        maxTurns: 4,
        model: process.env.STEPHEN_REAL_CLAUDE_MODEL ?? 'sonnet',
        mcpConfigPath,
        followUps: true,
        personaFile: join(tmp, 'persona.txt'),
        cwd,
        env,
      },
      undefined,
      [],
    );
    const t0 = Date.now();
    await p.ready();
    const readyMs = Date.now() - t0;
    expect(existsSync(join(tmp, 'persona.txt'))).toBe(false);
    const a = await p.turn('Reply with just the word: one');
    const b = await p.turn('Reply with just the word: two');
    expect(a).toMatchObject({ kind: 'ok', text: expect.stringMatching(/one/i) });
    expect(b).toMatchObject({ kind: 'ok', text: expect.stringMatching(/two/i) });
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    expect(b.sessionId).toBe(a.sessionId);
    // Per command (differences of the cumulative numbers): each is positive on its own.
    expect(a.costUsd).toBeGreaterThan(0);
    expect(b.costUsd).toBeGreaterThan(0);
    expect(b.apiMs).toBeGreaterThan(0);
    const pid = p.pid!;
    await p.kill();
    expect(isAlive(pid)).toBe(false);
    process.stderr.write(`[warm real] ready ${readyMs} ms; one: api ${a.apiMs} ms $${a.costUsd?.toFixed(4)}; two: api ${b.apiMs} ms $${b.costUsd?.toFixed(4)}\n`);
  }, 120_000);
});
