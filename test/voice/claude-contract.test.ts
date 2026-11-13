// Stephen's contract with the Claude Code CLI: the flags it probes, the version range, the limit message, and every
// field the stream-json parsers read (recorded fixtures, Claude Code 2.1.316 help and 2.1.319 stream).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStreamLine } from '../../src/lib/claude-stream.js';
import {
  TESTED_CLAUDE_MAX,
  TESTED_CLAUDE_MIN,
  buildClaudeArgs,
  checkClaudeFlags,
  claudeVersionCheck,
  claudeVersionStatus,
  outcomeFromResult,
  planLimitMessage,
  type ResultJson,
} from '../../src/voice/claude.js';
import { contextTokensOf, contextWindowOf } from '../../src/voice/warm-claude.js';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const settings = { claudePath: 'claude', maxTurns: 15, model: null, effort: 'high', mcpConfigPath: '/h/voice/mcp-config.json' };

describe('--effort is probed like the other optional flags', () => {
  const help = fixture('claude-help-2.1.316.txt');
  const oldHelp = help.split('\n').filter((l) => !l.includes('--effort')).join('\n'); // a Claude Code without the flag
  const argsFor = (h: string) => {
    const p = checkClaudeFlags(h);
    if (!p.ok) throw new Error('probe failed');
    return buildClaudeArgs('hi', { ...settings, unsupportedOptionalFlags: p.unsupportedOptional });
  };
  it('a help text without --effort: the configured effort is not sent', () => {
    const a = argsFor(oldHelp);
    expect(a).not.toContain('--effort');
    expect(a).toContain('--strict-mcp-config'); // the command still runs with the full lock-down
  });
  it('a help text that lists --effort: it is sent', () => {
    const a = argsFor(help);
    expect(a[a.indexOf('--effort') + 1]).toBe('high');
  });
});

describe('Claude Code version range', () => {
  it('the range is ordered', () => expect(claudeVersionStatus(TESTED_CLAUDE_MIN).status).toBe('ok'));
  it('inside', () => {
    expect(claudeVersionStatus('2.1.319 (Claude Code)')).toEqual({ version: '2.1.319', status: 'ok' });
    expect(claudeVersionCheck('2.1.317 (Claude Code)')).toMatchObject({ ok: true, label: 'Claude Code version' });
  });
  it('below, above: a warning that names the range', () => {
    expect(claudeVersionStatus('2.1.200').status).toBe('below');
    expect(claudeVersionStatus('2.0.999').status).toBe('below');
    expect(claudeVersionStatus('2.2.0').status).toBe('above');
    const w = claudeVersionCheck('3.0.0 (Claude Code)');
    expect(w.ok).toBe(false);
    expect(w).not.toHaveProperty('blocking');
    expect(w.detail).toContain(TESTED_CLAUDE_MAX);
  });
  it('unparseable or missing', () => {
    expect(claudeVersionStatus('banana').status).toBe('unknown');
    expect(claudeVersionCheck('banana')).toMatchObject({ ok: false });
    expect(claudeVersionCheck(null)).toMatchObject({ ok: false });
  });
});

describe('plan limit message', () => {
  it('matches the CLI wording and keeps the reset time', () => {
    const t = "You've hit your 5-hour limit · resets 11:50pm (America/Toronto)";
    expect(planLimitMessage(t)).toBe("You've reached your Claude plan limit. It resets at 11:50pm.");
    expect(outcomeFromResult({ type: 'result', subtype: 'success', is_error: true, result: t })).toMatchObject({
      kind: 'error',
      message: "You've reached your Claude plan limit. It resets at 11:50pm.",
    });
  });
  it('no reset time in the text: none is invented', () => {
    expect(planLimitMessage('Usage limit reached')).toBe("You've reached your Claude plan limit.");
  });
  it('other errors are untouched', () => {
    expect(planLimitMessage('Something about a rate of limits')).toBeNull();
    expect(outcomeFromResult({ type: 'result', is_error: true, result: 'boom' })).toMatchObject({ message: 'boom' });
  });
});

describe('stream-json contract (recorded Claude Code 2.1.319)', () => {
  const lines = fixture('claude-stream-2.1.319.jsonl').trim().split('\n');
  const msgs = lines.map((l) => JSON.parse(l) as Record<string, any>);
  const of = (t: string) => msgs.find((m) => m.type === t)!;
  const need = (where: string, v: unknown, type: 'string' | 'number' | 'boolean' | 'array' | 'object') => {
    const ok = type === 'array' ? Array.isArray(v) : typeof v === type && v !== null;
    expect(ok, `Claude Code stream-json: "${where}" must be a ${type} (renamed or removed?)`).toBe(true);
  };

  it('system/init: the fields parseStreamLine and the warm runner read', () => {
    const m = of('system');
    expect(m.subtype, 'system.subtype must be "init"').toBe('init');
    need('system.tools', m.tools, 'array');
    need('system.mcp_servers', m.mcp_servers, 'array');
    need('system.session_id', m.session_id, 'string');
    expect(parseStreamLine(lines[0]!)).toEqual({ kind: 'init', tools: [], mcpServers: 0, mcpServerNames: [], sessionId: m.session_id });
  });
  it('assistant: message.id, message.content, message.usage token counts', () => {
    const m = of('assistant');
    need('assistant.message.id', m.message?.id, 'string');
    need('assistant.message.content', m.message?.content, 'array');
    need('assistant.message.usage', m.message?.usage, 'object');
    for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) need(`assistant.message.usage.${k}`, m.message.usage[k], 'number');
    expect(parseStreamLine(lines[1]!)).toEqual({ kind: 'assistant', messageId: m.message.id, toolUses: 0 });
    expect(contextTokensOf(m)).toBeGreaterThan(0);
  });
  it('result: subtype, is_error, result, num_turns, cost, durations, denials, modelUsage.contextWindow, session_id', () => {
    const m = of('result');
    need('result.subtype', m.subtype, 'string');
    need('result.is_error', m.is_error, 'boolean');
    need('result.result', m.result, 'string');
    need('result.num_turns', m.num_turns, 'number');
    need('result.total_cost_usd', m.total_cost_usd, 'number');
    need('result.duration_ms', m.duration_ms, 'number');
    need('result.duration_api_ms', m.duration_api_ms, 'number');
    need('result.permission_denials', m.permission_denials, 'array');
    need('result.session_id', m.session_id, 'string');
    need('result.modelUsage', m.modelUsage, 'object');
    for (const [name, u] of Object.entries<any>(m.modelUsage)) need(`result.modelUsage.${name}.contextWindow`, u.contextWindow, 'number');
    expect(contextWindowOf(m)).toBeGreaterThan(0);
    expect(parseStreamLine(lines[2]!)).toMatchObject({ kind: 'result', subtype: 'success', isError: false, text: m.result, turns: m.num_turns, costUsd: m.total_cost_usd, denials: 0 });
    expect(outcomeFromResult(m as ResultJson)).toMatchObject({ kind: 'ok', sessionId: m.session_id });
  });
});
