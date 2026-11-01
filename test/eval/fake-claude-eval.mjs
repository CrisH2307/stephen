#!/usr/bin/env node
// Stand-in for `claude -p` in the eval tests — never the real one (it would spend the owner's quota).
// Like the real thing it reads --mcp-config, starts that MCP server (Stephen's `serve --dry-run --record …`) over
// stdio, and calls tools on it; WHICH tools come from $FAKE_EVAL_SCRIPT (JSON: { "<prompt>": { calls: [{tool, args}],
// reply, mode? } }). mode "hang" = never answer (timeout tests), "error" = an error_max_turns result.
// Every run's argv is appended to $FAKE_EVAL_LOG; with $FAKE_EVAL_RESULTS, every tool result's text is appended there.
import { appendFileSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
const at = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.FAKE_EVAL_LOG) appendFileSync(process.env.FAKE_EVAL_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
const prompt = (at('-p') ?? '').trim();
const script = JSON.parse(readFileSync(process.env.FAKE_EVAL_SCRIPT, 'utf8'));
const plan = script[prompt] ?? { calls: [], reply: 'Not sure what you mean?' };

const cfg = JSON.parse(readFileSync(at('--mcp-config'), 'utf8'));
const srv = cfg.mcpServers.stephen;
const client = new Client({ name: 'fake-claude', version: '0' });
await client.connect(new StdioClientTransport({ command: srv.command, args: srv.args, stderr: 'ignore', env: process.env }));

if (plan.mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  let turns = 1;
  for (const c of plan.calls) {
    const r = await client.callTool({ name: c.tool, arguments: c.args ?? {} });
    if (process.env.FAKE_EVAL_RESULTS) appendFileSync(process.env.FAKE_EVAL_RESULTS, JSON.stringify({ prompt, tool: c.tool, text: r.content?.[0]?.text ?? '' }) + '\n');
    turns++;
  }
  await client.close();
  const res =
    plan.mode === 'error'
      ? { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's1', num_turns: 25 }
      : { type: 'result', subtype: 'success', is_error: false, result: plan.reply ?? 'Done.', session_id: 's1', total_cost_usd: 0.002, num_turns: turns };
  process.stdout.write(JSON.stringify(res) + '\n');
  process.exit(0);
}
