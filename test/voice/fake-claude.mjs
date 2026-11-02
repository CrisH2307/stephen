#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests — never call the real one (it would spend the user's quota).
// Records its argv/cwd to $FAKE_CLAUDE_LOG (one JSON line per run), then:
//   FAKE_CLAUDE_MODE=ok (default)  print a `--output-format json` result; session_id = the --resume id (Stephen never
//                                  passes one; tests check that) or "sess-<n>"
//   FAKE_CLAUDE_MODE=hang          start a child (`sleep 60`, like the MCP server), write both pids to
//                                  $FAKE_CLAUDE_PIDS, and wait to be killed
//   FAKE_CLAUDE_MODE=hang-stubborn like hang, but ignore SIGTERM (exercises the SIGKILL escalation)
//   FAKE_CLAUDE_MODE=error         print an error_max_turns result
//   FAKE_CLAUDE_MODE=garbage       print non-JSON and exit 1
// FAKE_CLAUDE_TOOLS=open_url,announce: act like the Stephen server logging those tool calls to the `--tool-log` file
// named in the --mcp-config file (any mode except hang/garbage).
// FAKE_CLAUDE_STARTUP_MS / FAKE_CLAUDE_DURATION_MS / FAKE_CLAUDE_API_MS (ok mode): wait start-up + duration ms, and
// report duration_ms / duration_api_ms like the real result JSON (timing tests).
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
let n = 1;
if (log) {
  try {
    n = readFileSync(log, 'utf8').split('\n').filter(Boolean).length + 1;
  } catch {
    // first run
  }
  // The persona file exists only while claude runs (review 5, R5-3), so record what it held at start-up.
  const pf = argv.indexOf('--append-system-prompt-file');
  let persona;
  if (pf >= 0) {
    try {
      persona = { text: readFileSync(argv[pf + 1], 'utf8'), mode: statSync(argv[pf + 1]).mode & 0o777 };
    } catch {
      persona = null;
    }
  }
  appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, ...(persona !== undefined ? { persona } : {}) }) + '\n');
}
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const at = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.env.FAKE_CLAUDE_TOOLS && mode !== 'hang' && mode !== 'hang-stubborn' && mode !== 'garbage') {
  const cfg = JSON.parse(readFileSync(at('--mcp-config'), 'utf8'));
  const serveArgs = cfg.mcpServers.stephen.args;
  const i = serveArgs.indexOf('--tool-log');
  if (i >= 0) {
    for (const tool of process.env.FAKE_CLAUDE_TOOLS.split(',')) appendFileSync(serveArgs[i + 1], JSON.stringify({ tool, isError: false, ms: 5 }) + '\n');
  }
}

if (mode === 'hang' || mode === 'hang-stubborn') {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  if (mode === 'hang-stubborn') process.on('SIGTERM', () => {});
  if (process.env.FAKE_CLAUDE_PIDS) writeFileSync(process.env.FAKE_CLAUDE_PIDS, JSON.stringify({ claude: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: `sess-${n}`, num_turns: 15 }) + '\n');
} else if (mode === 'garbage') {
  process.stdout.write('not json\n');
  process.stderr.write('Error: something broke\n');
  process.exit(1);
} else {
  const startup = Number(process.env.FAKE_CLAUDE_STARTUP_MS ?? 0);
  const duration = process.env.FAKE_CLAUDE_DURATION_MS !== undefined ? Number(process.env.FAKE_CLAUDE_DURATION_MS) : undefined;
  if (startup + (duration ?? 0) > 0) await new Promise((r) => setTimeout(r, startup + (duration ?? 0)));
  const timing = duration !== undefined ? { duration_ms: duration, duration_api_ms: Number(process.env.FAKE_CLAUDE_API_MS ?? 0) } : {};
  const prompt = at('-p') ?? '';
  const reply = process.env.FAKE_CLAUDE_REPLY ?? `**Done!** I opened [YouTube](https://www.youtube.com/) for "${prompt}".`;
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: at('--resume') ?? `sess-${n}`, total_cost_usd: 0.01, num_turns: 2, ...timing }) + '\n',
  );
}
