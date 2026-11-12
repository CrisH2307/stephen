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
//                     | exit-mid-turn (exit 3 once a message arrives) | hang (system/init, then never answer) | hang-stubborn
//                     (hang + ignore SIGTERM) | no-init (never answer initialize) | init-error (refuse initialize)
//   FAKE_CLAUDE_MCP   connected (default) | failed | pending (forever) | slow (pending for 2 polls) | drop (failed
//                     from the 2nd message on)
//   FAKE_CLAUDE_TOOLS tool names per message, e.g. "open_url,announce|media_control" (message 1 | message 2 | …),
//                     logged to the --tool-log of the --mcp-config, like the Stephen server
//   FAKE_CLAUDE_DURATION_MS / FAKE_CLAUDE_API_MS  per message: wait this long, report it (api cumulative)
//   FAKE_CLAUDE_STEPS=<ms>  per message, like a tool turn with --include-partial-messages: a stream_event (first token),
//                     an assistant line (tool call), <ms> later a user line (tool result), <ms> later the final assistant
//   FAKE_CLAUDE_INIT_MS  delay before answering initialize; FAKE_CLAUDE_REPLY  the reply text
//   FAKE_CLAUDE_TRANSCRIPT_DIR  write <dir>/<session id>.jsonl at system/init, like Claude Code's transcript
// Serve instance (docs/REVIEW-7.md R7-1): when the --mcp-config gives serve `--instance <id>`, the serve child takes
// `<folder of the config>/../run/serve-<id>.lock` like `stephen serve` (O_EXCL, 0600, its pid), and logs
// {pid, claim: first|restarted} to $FAKE_CLAUDE_SERVE_LOG. Like Claude Code, a dead serve child is started again when
// the next message comes. FAKE_CLAUDE_SERVE_DIES  after-1 (SIGKILL the serve after message 1's result) | midturn-1
// (kill it and start a new one in the middle of message 1). FAKE_CLAUDE_SERVE_LATE_TOOL=<name>: on SIGTERM the serve
// waits 50 ms, appends that tool to the --tool-log, then exits (a tool of a cancelled command finishing late).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

export async function runStream({ argv, at, mode, logTools }) {
  const env = process.env;
  const serveArgs = (() => {
    try {
      return JSON.parse(readFileSync(at('--mcp-config'), 'utf8')).mcpServers.stephen.args;
    } catch {
      return [];
    }
  })();
  const argOf = (flag) => (serveArgs.indexOf(flag) >= 0 ? serveArgs[serveArgs.indexOf(flag) + 1] : null);
  const instance = argOf('--instance');
  const lock = instance ? join(dirname(dirname(at('--mcp-config'))), 'run', `serve-${instance}.lock`) : null;
  const parts = ["const fs=require('fs');"];
  if (lock) {
    parts.push(
      `let claim='first';try{fs.mkdirSync(${JSON.stringify(dirname(lock))},{recursive:true,mode:0o700});const fd=fs.openSync(${JSON.stringify(lock)},'wx',0o600);fs.writeSync(fd,process.pid+'\\n');fs.closeSync(fd)}catch(e){claim=e.code==='EEXIST'?'restarted':'error'}`,
      env.FAKE_CLAUDE_SERVE_LOG ? `fs.appendFileSync(${JSON.stringify(env.FAKE_CLAUDE_SERVE_LOG)},JSON.stringify({pid:process.pid,claim})+'\\n');` : '',
    );
  }
  if (env.FAKE_CLAUDE_SERVE_WRITES) {
    parts.push(`setInterval(()=>{try{fs.writeFileSync(${JSON.stringify(env.FAKE_CLAUDE_SERVE_WRITES)},'{"version":1,"privateReads":[],"trustedHosts":[]}\\n')}catch{}},5);`);
  }
  if (env.FAKE_CLAUDE_SERVE_LATE_TOOL && argOf('--tool-log')) {
    const rec = JSON.stringify({ tool: env.FAKE_CLAUDE_SERVE_LATE_TOOL, isError: false, ms: 5 }) + '\n';
    parts.push(`process.on('SIGTERM',()=>setTimeout(()=>{fs.appendFileSync(${JSON.stringify(argOf('--tool-log'))},${JSON.stringify(rec)});process.exit(0)},50));`);
  }
  parts.push('setInterval(()=>{},1000);');
  const serveScript = parts.join('');
  let child = null;
  let childAlive = false;
  const startServe = () => {
    child = spawn(process.execPath, ['-e', serveScript], { stdio: 'ignore' });
    childAlive = true;
    child.once('exit', () => (childAlive = false));
    if (env.FAKE_CLAUDE_PIDS) writeFileSync(env.FAKE_CLAUDE_PIDS, JSON.stringify({ claude: process.pid, child: child.pid }));
  };
  /** Kill the serve and wait until it is gone. */
  const killServe = () =>
    new Promise((r) => {
      if (!childAlive) return r();
      child.once('exit', () => r());
      child.kill('SIGKILL');
    });
  /** The lock is taken before "connected" (like stephen serve, which claims before it connects). */
  const lockTaken = () => !lock || existsSync(lock);
  startServe();
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
    if (!lockTaken()) return 'pending';
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
    if (!childAlive) startServe(); // Claude Code starts a dead MCP server again, silently
    const prompt = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
    const turns = env.FAKE_CLAUDE_TURNS ?? (env.FAKE_CLAUDE_LOG ? `${env.FAKE_CLAUDE_LOG}.turns` : null);
    if (turns) {
      appendFileSync(turns, JSON.stringify({ pid: process.pid, n: messages, prompt, line, personaExists: personaPath ? existsSync(personaPath) : null, at: Date.now() }) + '\n');
    }
    if (mode === 'exit-mid-turn') {
      process.stderr.write('Error: exited mid-turn\n');
      process.exit(3);
    }
    // Like Claude Code: system/init (with the session id) first, and the transcript is on disk from then on.
    out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-sonnet', mcp_servers: [{ name: 'stephen', status: 'connected' }] });
    if (env.FAKE_CLAUDE_TRANSCRIPT_DIR) appendFileSync(join(env.FAKE_CLAUDE_TRANSCRIPT_DIR, `${sessionId}.jsonl`), JSON.stringify({ prompt }) + '\n');
    if (mode === 'hang' || mode === 'hang-stubborn') return new Promise(() => {}); // never answers: the queue stalls
    if (tools[messages - 1]) logTools(tools[messages - 1]);
    if (env.FAKE_CLAUDE_SERVE_DIES === `midturn-${messages}`) {
      await killServe();
      startServe(); // the next tool call of this turn goes to a new serve
      await new Promise((r) => setTimeout(r, 100)); // it has taken (or found) the lock
    }
    if (duration > 0) await new Promise((r) => setTimeout(r, duration));
    if (env.FAKE_CLAUDE_STEPS) {
      const step = () => new Promise((r) => setTimeout(r, Number(env.FAKE_CLAUDE_STEPS)));
      out({ type: 'stream_event', event: { type: 'message_start' }, session_id: sessionId });
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SECRET-TOKEN-TEXT' } }, session_id: sessionId });
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }, session_id: sessionId });
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__stephen__open_url', input: {} }] }, session_id: sessionId });
      await step();
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-TOOL-RESULT' }] }, session_id: sessionId });
      await step();
    }
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
    if (env.FAKE_CLAUDE_SERVE_DIES === `after-${messages}`) await killServe();
  }
  void argv;
  await new Promise(() => {}); // live until stdin closes (rl close → exit) or a signal
}
