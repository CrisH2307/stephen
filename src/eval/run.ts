/**
 * `stephen eval`: run the one-shot eval set through the REAL `claude -p` with the REAL voice lock-down and persona
 * (buildClaudeArgs, with EVAL_ABOUT_ME), but with Stephen's tools served by `serve --dry-run` — every tool call is
 * recorded and answered with a fake result; nothing happens on the Mac. Each case is scored (score.ts), a table is
 * printed, and the report is saved to <home>/eval/<stamp>/report.json so later changes can be compared.
 *
 * Uses the owner's Claude login (one run per case). docs/PLAN-1.8-ONE-SHOT.md, track D.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeRunner, type ClaudeOutcome, type SpawnFn } from '../voice/claude.js';
import type { AboutMe } from '../voice/config.js';
import { EVAL_ABOUT_ME, type EvalCase } from './cases.js';
import { readDryCalls, type DryCall } from './dry-server.js';
import { scoreRun, type Score } from './score.js';

export interface EvalOptions {
  cases: readonly EvalCase[];
  /** Where reports go: <outDir>/<stamp>/… */
  outDir: string;
  claudePath: string;
  model: string | null;
  maxTurns: number;
  nodePath: string;
  cliPath: string;
  /** Optional lock-down flags this `claude` lacks (from probeClaudeFlags). */
  unsupportedOptionalFlags?: ReadonlySet<string>;
  /** Per-case time limit. Default 120 s. */
  timeoutMs?: number;
  /** Cases run at the same time. Default 2, at most 4. */
  jobs?: number;
  aboutMe?: AboutMe;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface CaseResult extends Score {
  id: string;
  category: string;
  say: string;
  reply: string;
  calls: DryCall[];
  error?: string;
  turns: number | null;
  ms: number;
  costUsd: number | null;
}

export interface EvalReport {
  startedAt: string;
  model: string | null;
  passed: number;
  total: number;
  byCategory: Record<string, { passed: number; total: number }>;
  results: CaseResult[];
  file: string;
}

/** MCP config for one case: only Stephen's dry-run server, recording into `record`. */
export function evalMcpConfig(nodePath: string, cliPath: string, record: string) {
  return { mcpServers: { stephen: { command: nodePath, args: [cliPath, 'serve', '--dry-run', '--record', record] } } };
}

/** "2026-10-31T21-05-09" (file-name safe). */
export function stamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/:/g, '-');
}

async function runCase(k: EvalCase, dir: string, o: EvalOptions): Promise<CaseResult> {
  const caseDir = join(dir, k.id);
  const cwd = join(caseDir, 'cwd'); // empty: no project CLAUDE.md or settings
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const record = join(caseDir, 'calls.jsonl');
  const mcpConfigPath = join(caseDir, 'mcp-config.json');
  await writeFile(mcpConfigPath, JSON.stringify(evalMcpConfig(o.nodePath, o.cliPath, record), null, 2) + '\n', { mode: 0o600 });
  const runner = new ClaudeRunner({
    claudePath: o.claudePath,
    maxTurns: o.maxTurns,
    model: o.model,
    mcpConfigPath,
    followUps: false, // every case is a fresh one-shot command (and nothing is saved)
    aboutMe: o.aboutMe ?? EVAL_ABOUT_ME,
    unsupportedOptionalFlags: o.unsupportedOptionalFlags,
    cwd,
    env: o.env,
    spawn: o.spawn,
    killGraceMs: 1000,
  });
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    runner.cancel();
  }, o.timeoutMs ?? 120_000);
  let outcome: ClaudeOutcome;
  try {
    outcome = await runner.run(k.say);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - t0;
  const calls = readDryCalls(await readFile(record, 'utf8').catch(() => ''));
  const reply = outcome.kind === 'ok' ? outcome.text : '';
  const error = timedOut ? `timed out after ${Math.round((o.timeoutMs ?? 120_000) / 1000)} s` : outcome.kind === 'error' ? outcome.message : outcome.kind === 'cancelled' ? 'cancelled' : undefined;
  const score = scoreRun(k.expect, { calls, reply, ...(error ? { error } : {}) });
  return {
    id: k.id,
    category: k.category,
    say: k.say,
    ...score,
    reply,
    calls,
    ...(error ? { error } : {}),
    turns: outcome.kind === 'ok' ? outcome.turns : null,
    ms,
    costUsd: outcome.kind === 'ok' ? outcome.costUsd : null,
  };
}

/** Run every case (a small pool), score, save the report. */
export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const started = (o.now ?? (() => new Date()))();
  const dir = join(o.outDir, stamp(started));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const jobs = Math.max(1, Math.min(4, o.jobs ?? 2));
  const results: CaseResult[] = new Array(o.cases.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= o.cases.length) return;
      const k = o.cases[i]!;
      const r = await runCase(k, dir, o);
      results[i] = r;
      o.log?.(formatLine(r, i + 1, o.cases.length));
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  const byCategory: EvalReport['byCategory'] = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { passed: 0, total: 0 });
    c.total++;
    if (r.pass) c.passed++;
  }
  const file = join(dir, 'report.json');
  const report: EvalReport = {
    startedAt: started.toISOString(),
    model: o.model,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    byCategory,
    results,
    file,
  };
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

const brief = (c: DryCall): string => {
  const main = c.args.url ?? c.args.query ?? c.args.app ?? c.args.text ?? '';
  return main ? `${c.tool}(${String(main).slice(0, 70)})` : c.tool;
};

/** One progress line per finished case. */
export function formatLine(r: CaseResult, i: number, n: number): string {
  const head = `${r.pass ? '✓' : '✗'} [${i}/${n}] ${r.id} — "${r.say}" (${(r.ms / 1000).toFixed(1)} s${r.turns !== null ? `, ${r.turns} turns` : ''})`;
  if (r.pass) return head;
  const calls = r.calls.length ? r.calls.map(brief).join(' → ') : 'no tool calls';
  return `${head}\n    ${r.reasons.join('; ')}\n    did: ${calls}\n    said: ${r.reply ? `"${r.reply.slice(0, 200)}"` : '(nothing)'}`;
}

/** The summary printed at the end. */
export function formatSummary(rep: EvalReport): string {
  const lines = [`One-shot eval: ${rep.passed}/${rep.total} passed (model ${rep.model ?? 'default'}).`];
  for (const [c, v] of Object.entries(rep.byCategory)) lines.push(`  ${c.padEnd(9)} ${v.passed}/${v.total}`);
  const ms = rep.results.map((r) => r.ms).sort((a, b) => a - b);
  if (ms.length) lines.push(`  median time ${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s per request`);
  lines.push(`Report: ${rep.file}`);
  return lines.join('\n');
}
