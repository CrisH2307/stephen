/** `stephen eval [--only <text>] [--jobs N] [--model M] [--timeout S]` — see run.ts. */
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { probeClaudeFlags, stephenCliBuilt, stephenCliPath, type SpawnFn } from '../voice/claude.js';
import { parseVoiceConfig, resolveClaudeModel } from '../voice/config.js';
import { EVAL_CASES, type EvalCase } from './cases.js';
import { formatSummary, runEval } from './run.js';

export interface EvalArgs {
  only: string | null;
  jobs: number;
  model: string | null | undefined;
  timeoutSec: number;
}

export const EVAL_HELP = `stephen eval — score how Stephen handles one-shot requests (nothing happens on your Mac)

  --only <text>   only cases whose id or category contains <text> (e.g. routes, multi, mis-doja)
  --jobs <1-4>    cases at the same time (default 2)
  --model <m>     Claude model (default: voice.claudeModel)
  --timeout <s>   per case (default 120)

Each case is one real \`claude -p\` run with Stephen's voice lock-down and persona; Stephen's tools are
answered by a dry-run server that only records the calls. Uses your Claude plan (one run per case).`;

export function parseEvalArgs(argv: string[]): EvalArgs | { error: string } | 'help' {
  const out: EvalArgs = { only: null, jobs: 2, model: undefined, timeoutSec: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => argv[++i];
    if (a === '--help' || a === '-h') return 'help';
    else if (a === '--only') {
      const v = val();
      if (!v) return { error: '--only needs some text' };
      out.only = v.toLowerCase();
    } else if (a === '--jobs') {
      const v = Number(val());
      if (!Number.isInteger(v) || v < 1 || v > 4) return { error: '--jobs must be 1–4' };
      out.jobs = v;
    } else if (a === '--model') {
      const v = val();
      if (!v || !/^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/.test(v)) return { error: '--model needs a model name like "sonnet"' };
      out.model = resolveClaudeModel(v);
    } else if (a === '--timeout') {
      const v = Number(val());
      if (!Number.isFinite(v) || v < 10 || v > 600) return { error: '--timeout must be 10–600 seconds' };
      out.timeoutSec = v;
    } else return { error: `Unknown option "${a}" for eval.` };
  }
  return out;
}

export function selectCases(cases: readonly EvalCase[], only: string | null): EvalCase[] {
  if (!only) return [...cases];
  return cases.filter((k) => k.id.includes(only) || k.category.includes(only));
}

export interface EvalEnv {
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  out?: (l: string) => void;
  err?: (l: string) => void;
  /** Skip `claude --help` (tests). */
  noProbe?: boolean;
}

export async function runEvalCli(argv: string[], e: EvalEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  const a = parseEvalArgs(argv);
  if (a === 'help') {
    out(EVAL_HELP);
    return 0;
  }
  if ('error' in a) {
    err(`${a.error}\n\n${EVAL_HELP}`);
    return 2;
  }
  const cfg = loadConfig();
  const voice = parseVoiceConfig(cfg.voice);
  const cases = selectCases(EVAL_CASES, a.only);
  if (!cases.length) {
    err(`No eval case matches "${a.only}".`);
    return 2;
  }
  const cliPath = e.cliPath ?? stephenCliPath();
  if (!stephenCliBuilt(cliPath)) {
    err(`${cliPath} does not exist yet — run \`npm run build\` first.`);
    return 1;
  }
  let unsupported: ReadonlySet<string> | undefined;
  if (!e.noProbe) {
    const probe = await probeClaudeFlags(voice.claudePath);
    if (probe && !probe.ok) {
      err(`Your Claude Code is too old for Stephen's voice lock-down (missing ${probe.missing.join(', ')}). Update it (claude update).`);
      return 1;
    }
    if (probe?.ok) unsupported = probe.unsupportedOptional;
  }
  const model = a.model === undefined ? voice.claudeModel : a.model;
  out(`Running ${cases.length} one-shot case${cases.length === 1 ? '' : 's'} with ${model ?? 'the default model'} (${a.jobs} at a time). Nothing happens on your Mac; each case is one Claude run on your plan.`);
  const rep = await runEval({
    cases,
    outDir: join(cfg.home, 'eval'),
    claudePath: voice.claudePath,
    model,
    maxTurns: voice.maxTurns,
    nodePath: process.execPath,
    cliPath,
    unsupportedOptionalFlags: unsupported,
    timeoutMs: a.timeoutSec * 1000,
    jobs: a.jobs,
    spawn: e.spawn,
    env: e.env,
    log: out,
  });
  out('');
  out(formatSummary(rep));
  return rep.passed === rep.total ? 0 : 1;
}
