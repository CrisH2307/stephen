/**
 * Opt-in probe of the REAL Claude Code with the exact job argv, settings.json and scratch environment (docs/ADR-004):
 * spends a little quota, so it is skipped unless STEPHEN_REAL_CLAUDE=1.
 *   STEPHEN_REAL_CLAUDE=1 npx vitest run test/jobs/real-claude.test.ts
 * 1. The shipped settings (sandbox on, failIfUnavailable): on a Mac the init line lists exactly the 6 tools and no MCP
 *    server; on Linux without bubblewrap the run refuses to start (`sandbox_required_unavailable`), the fail-closed
 *    pass. Either is accepted, nothing else.
 * 2. The test-only switch (sandbox off, never a user option) on the same argv: the init line lists exactly the 6
 *    tools and no MCP server, in dontAsk mode.
 * STEPHEN_REAL_CLAUDE_PATH / STEPHEN_REAL_CLAUDE_MODEL override `claude` / `sonnet`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JobSupervisor, parseJobLine, type SupervisorSpec } from '../../src/jobs/runner.js';
import { JOB_TOOLS, jobFiles } from '../../src/jobs/spec.js';
import { readPrivateJsonFile } from '../../src/lib/fs.js';
import { harness, tempRoot } from './helpers.js';

const REAL = process.env.STEPHEN_REAL_CLAUDE === '1';
const { tmp, cleanup } = tempRoot('jobs-real');
afterAll(cleanup);

async function runReal(testOnlyNoSandbox: boolean) {
  const h = harness(tmp, {
    claudePath: process.env.STEPHEN_REAL_CLAUDE_PATH ?? 'claude',
    jobs: { maxTurns: 2, maxBudgetUsd: 0.25, wallClockMin: 2, model: process.env.STEPHEN_REAL_CLAUDE_MODEL ?? 'sonnet' },
    now: undefined,
    ...(testOnlyNoSandbox ? { testOnlyNoSandbox: true } : {}),
  });
  const plan = await h.manager.plan('reply with just the word ok and do nothing else');
  if ('error' in plan) throw new Error(plan.error);
  const st = await h.manager.start(plan, 'test');
  if ('refused' in st) throw new Error(st.refused);
  const r = readPrivateJsonFile(jobFiles(join(h.home, 'jobs', plan.id)).spec);
  if (!('state' in r)) throw new Error('no spec');
  const end = await new JobSupervisor(r.state as SupervisorSpec, { audit: null }).run();
  const events = readFileSync(jobFiles(join(h.home, 'jobs', plan.id)).log, 'utf8').split('\n').map(parseJobLine).filter(Boolean);
  return { end, init: events.find((e) => e!.kind === 'init'), result: events.find((e) => e!.kind === 'result'), raw: readFileSync(jobFiles(join(h.home, 'jobs', plan.id)).log, 'utf8') };
}

describe.skipIf(!REAL)('real Claude Code with the exact job argv (opt-in: STEPHEN_REAL_CLAUDE=1)', () => {
  it('shipped settings: exactly the 6 tools and 0 MCP servers, or a fail-closed refusal without a sandbox', async () => {
    const { end, init, result } = await runReal(false);
    if (init && init.kind === 'init') {
      expect([...init.tools].sort()).toEqual([...JOB_TOOLS].sort());
      expect(init.mcpServers).toBe(0);
    } else {
      expect(result).toMatchObject({ kind: 'result', startupFailure: 'sandbox_required_unavailable' });
      expect(end).toMatchObject({ status: 'failed', error: expect.stringMatching(/sandbox isn't available/) });
      console.log('[real] fail closed: sandbox_required_unavailable (no bubblewrap here)');
    }
  }, 120_000);

  it('test-only no sandbox: init lists exactly Bash, Read, Edit, Write, Glob, Grep and no MCP server', async () => {
    const { end, init, raw } = await runReal(true);
    expect(init, raw.slice(0, 2000)).toBeTruthy();
    if (init?.kind !== 'init') return;
    expect([...init.tools].sort()).toEqual([...JOB_TOOLS].sort());
    expect(init.mcpServers).toBe(0);
    expect(raw).toMatch(/"permissionMode":"dontAsk"/);
    console.log(`[real] no-sandbox run: ${end.status} ${end.error} turns ${end.turns} cost ${end.costUsd}`);
  }, 120_000);
});
