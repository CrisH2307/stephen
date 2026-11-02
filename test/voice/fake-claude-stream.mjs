// The fake claude's long-lived `--input-format stream-json` mode (the phase 3 warm process). Speaks the same wire
// protocol as Claude Code 2.1.316 (docs/ADR-003): one JSON line per message both ways, `control_request`
// initialize / mcp_status answered with `control_response`, and one `result` line per user message, with
// `duration_api_ms` and `total_cost_usd` cumulative per process. Noise lines (system/init, assistant,
// rate_limit_event) come before every result, like the real one.
//
// It always starts a child in its own process group, standing in for `stephen serve` (FAKE_CLAUDE_SERVE_WRITES=<file>:
// that child rewrites <file> every 5 ms while alive, like an old serve saving the gate state). Pids go to
// $FAKE_CLAUDE_PIDS as {claude, child}.
// Every user message is appended to $FAKE_CLAUDE_TURNS (default "$FAKE_CLAUDE_LOG.turns") as {pid, n, prompt, line, personaExists, at}.
//   FAKE_CLAUDE_MODE  ok (default) | error (every turn: error_max_turns) | garbage (a non-JSON line instead of a result)
//                     | exit-mid-turn (exit 3 once a message arrives) | hang (never answer a message) | hang-stubborn
//                     (hang + ignore SIGTERM) | no-init (never answer initialize) | init-error (refuse initialize)
//   FAKE_CLAUDE_MCP   connected (default) | failed | pending (forever) | slow (pending for 2 polls) | drop (failed
//                     from the 2nd message on)
//   FAKE_CLAUDE_TOOLS tool names per message, e.g. "open_url,announce|media_control" (message 1 | message 2 | …),
//                     logged to the --tool-log of the --mcp-config, like the Stephen server
//   FAKE_CLAUDE_DURATION_MS / FAKE_CLAUDE_API_MS  per message: wait this long, report it (api cumulative)
//   FAKE_CLAUDE_INIT_MS  delay before answering initialize; FAKE_CLAUDE_REPLY  the reply text
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export async function runStream({ argv, at, mode, logTools }) {
  const env = process.env;
  const serveScript = env.FAKE_CLAUDE_SERVE_WRITES
    ? `const fs=require('fs');setInterval(()=>{try{fs.writeFileSync(${JSON.stringify(env.FAKE_CLAUDE_SERVE_WRITES)},'{"version":1,"privateReads":[],"trustedHosts":[]}\\n')}catch{}},5)`
    : 'setInterval(()=>{},1000)';
  const child = spawn(process.execPath, ['-e', serveScript], { stdio: 'ignore' });
  if (env.FAKE_CLAUDE_PIDS) writeFileSync(env.FAKE_CLAUDE_PIDS, JSON.stringify({ claude: process.pid, child: child.pid }));
  if (mode === 'hang-stubborn') process.on('SIGTERM', () => {});
  const personaPath = at('--append-system-prompt-file');
  const sessionId = `sess-${process.pid}`;
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const tools = (env.FAKE_CLAUDE_TOOLS ?? '').split('|');
  const duration = Number(env.FAKE_CLAUDE_DURATION_MS ?? 0);
  const apiPer = Number(env.FAKE_CLAUDE_API_MS ?? 0);
  let messages = 0;
  let polls = 0;
  let apiTotal = 0;
  let costTotal = 0;
  const mcpStatus = () => {
    const m = env.FAKE_CLAUDE_MCP ?? 'connected';
    polls++;
    if (m === 'failed') return 'failed';
    if (m === 'pending') return 'pending';
    if (m === 'slow') return polls <= 2 ? 'pending' : 'connected';
    if (m === 'drop') return messages >= 1 ? 'failed' : 'connected';
    return 'connected';
  };
  const die = (why) => {
    process.stderr.write(`Error: ${why}\n`);
    process.exit(1);
  };
  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(() => onLine(line));
  });
  rl.on('close', () => {
    queue.then(() => process.exit(0));
  });

  async function onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      die('Unexpected token in JSON input');
    }
    if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
      if (sub === 'initialize') {
        if (mode === 'no-init') return;
        if (env.FAKE_CLAUDE_INIT_MS) await new Promise((r) => setTimeout(r, Number(env.FAKE_CLAUDE_INIT_MS)));
        if (mode === 'init-error') return out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'initialize refused' } });
        return ok({ commands: [], pid: process.pid });
      }
      if (sub === 'mcp_status') return ok({ mcpServers: [{ name: 'stephen', status: mcpStatus() }] });
      return out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `unknown ${sub}` } });
    }
    if (msg.type !== 'user' || msg.message?.role !== 'user') die(`Expected message role 'user', got '${msg.message?.role}'`);
    messages++;
    const prompt = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
    const turns = env.FAKE_CLAUDE_TURNS ?? (env.FAKE_CLAUDE_LOG ? `${env.FAKE_CLAUDE_LOG}.turns` : null);
    if (turns) {
      appendFileSync(turns, JSON.stringify({ pid: process.pid, n: messages, prompt, line, personaExists: personaPath ? existsSync(personaPath) : null, at: Date.now() }) + '\n');
    }
    if (mode === 'exit-mid-turn') {
      process.stderr.write('Error: exited mid-turn\n');
      process.exit(3);
    }
    if (mode === 'hang' || mode === 'hang-stubborn') return new Promise(() => {}); // never answers: the queue stalls
    out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-sonnet', mcp_servers: [{ name: 'stephen', status: 'connected' }] });
    if (tools[messages - 1]) logTools(tools[messages - 1]);
    if (duration > 0) await new Promise((r) => setTimeout(r, duration));
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] }, session_id: sessionId });
    out({ type: 'rate_limit_event', rate_limit_info: {} });
    if (mode === 'garbage') {
      process.stdout.write('not json at all\n');
      return;
    }
    apiTotal += apiPer;
    costTotal += 0.01;
    if (mode === 'error') {
      return out({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: sessionId, num_turns: 25, duration_ms: duration, duration_api_ms: apiTotal, total_cost_usd: costTotal });
    }
    const reply = env.FAKE_CLAUDE_REPLY ?? `**Done!** ${prompt}`;
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sessionId, num_turns: 2, duration_ms: duration, duration_api_ms: apiTotal, total_cost_usd: costTotal });
  }
  void argv;
  await new Promise(() => {}); // live until stdin closes (rl close → exit) or a signal
}
