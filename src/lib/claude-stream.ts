/** Claude Code `--output-format stream-json` lines → the few events Stephen reads (jobs, the phone lock-down check). */

export type StreamEvent =
  | { kind: 'init'; tools: string[]; mcpServers: number; mcpServerNames: string[]; sessionId: string }
  | { kind: 'assistant'; messageId: string; toolUses: number }
  | { kind: 'denied' }
  | { kind: 'result'; subtype: string; isError: boolean; text: string; turns: number | null; costUsd: number | null; denials: number; startupFailure: string; errors: string[] };

/** One stream-json line → the event the supervisor cares about (null for everything else). Never throws. */
export function parseStreamLine(line: string): StreamEvent | null {
  if (!line.startsWith('{')) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  if (j.type === 'system' && j.subtype === 'init') {
    return {
      kind: 'init',
      tools: Array.isArray(j.tools) ? j.tools.filter((t): t is string => typeof t === 'string') : [],
      mcpServers: Array.isArray(j.mcp_servers) ? j.mcp_servers.length : -1,
      mcpServerNames: Array.isArray(j.mcp_servers)
        ? (j.mcp_servers as { name?: unknown }[]).map((m) => (typeof m?.name === 'string' ? m.name : '?'))
        : [],
      sessionId: typeof j.session_id === 'string' ? j.session_id : '',
    };
  }
  if (j.type === 'system' && j.subtype === 'permission_denied') return { kind: 'denied' };
  if (j.type === 'assistant') {
    const m = j.message as { id?: unknown; content?: unknown } | undefined;
    const content = Array.isArray(m?.content) ? (m!.content as { type?: unknown }[]) : [];
    return { kind: 'assistant', messageId: typeof m?.id === 'string' ? m.id : '', toolUses: content.filter((c) => c?.type === 'tool_use').length };
  }
  if (j.type === 'result') {
    return {
      kind: 'result',
      subtype: typeof j.subtype === 'string' ? j.subtype : '',
      isError: j.is_error === true,
      text: typeof j.result === 'string' ? j.result : '',
      turns: typeof j.num_turns === 'number' ? j.num_turns : null,
      costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
      startupFailure: typeof j.startup_failure_reason === 'string' ? j.startup_failure_reason : '',
      errors: Array.isArray(j.errors) ? j.errors.filter((e): e is string => typeof e === 'string') : [],
    };
  }
  return null;
}
