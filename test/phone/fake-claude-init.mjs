#!/usr/bin/env node
// Fake `claude -p … --output-format stream-json`: a SessionStart hook line, then the init line with the tools in
// $FAKE_TOOLS (comma list), then waits like a real run waiting on the model. FAKE_MODE=exit: exits before init.
if (process.env.FAKE_MODE === 'exit') process.exit(1);
console.log(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }));
const tools = (process.env.FAKE_TOOLS ?? '').split(',').filter(Boolean);
console.log(JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: [], session_id: 's1', cwd: process.cwd() }));
setTimeout(() => {}, 30_000);
