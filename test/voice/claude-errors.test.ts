/** R5: a failed model run gets a code word by fixed markers, a plain spoken line, and an incident with no text. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { INCIDENT_CODES, incidentDir, readIncidents } from '../../src/telemetry/incidents.js';
import { LatencyMonitor } from '../../src/telemetry/latency.js';
import { Assistant, FAILURE_LINES, LOCAL_STILL_WORKS, type CommandReport } from '../../src/voice/assistant.js';
import { CLAUDE_FAILURES, claudeFailure, CLAUDE_NOT_FOUND, parseClaudeOutput, type ClaudeOutcome } from '../../src/voice/claude.js';
import { RecordingChimes, RecordingSpeaker } from './helpers.js';

const result = (subtype: string, text: string) => JSON.stringify({ type: 'result', subtype, is_error: true, result: text, session_id: null });

/** What a fake claude prints for each case (stdout, exit code, stderr), as the runner hands it to parseClaudeOutput. */
const FAKE: [string, () => ClaudeOutcome, string][] = [
  ['claude_missing', () => ({ kind: 'error', message: CLAUDE_NOT_FOUND, sessionId: null }), 'spawn ENOENT'],
  ['claude_signed_out', () => parseClaudeOutput('', 1, 'Error: not logged in. Please run /login\n'), 'no result, signed out'],
  ['claude_signed_out', () => parseClaudeOutput(result('error_during_execution', 'Invalid API key · Please run /login'), 1), 'result, invalid key'],
  ['claude_usage_limit', () => parseClaudeOutput(result('error_during_execution', 'Usage limit reached · limit resets 3pm'), 1), 'plan limit'],
  ['claude_busy', () => parseClaudeOutput(result('error_during_execution', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), 1), 'overloaded'],
  ['claude_busy', () => parseClaudeOutput('', 1, 'API Error: 429 rate_limit_error\n'), 'rate limited'],
  ['claude_offline', () => parseClaudeOutput('', 1, 'Error: getaddrinfo ENOTFOUND api.anthropic.com\n'), 'no DNS'],
  ['claude_offline', () => parseClaudeOutput(result('error_during_execution', 'API Error: Connection error.'), 1), 'connection error'],
  ['claude_other', () => parseClaudeOutput(result('error_max_turns', ''), 1), 'max turns'],
  ['claude_other', () => parseClaudeOutput(result('error_max_turns', 'Usage limit reached · limit resets 3pm'), 1), 'max turns, limit phrase in the text'],
  ['claude_other', () => parseClaudeOutput('', 2, 'Error: something broke\n'), 'unknown'],
];

function make(outs: ClaudeOutcome[]) {
  const reports: CommandReport[] = [];
  const assistant = new Assistant({
    runner: { run: async () => outs.shift()!, cancel: () => false },
    speaker: new RecordingSpeaker(), chimes: new RecordingChimes(), speak: false, status: () => undefined,
    onDone: (r) => reports.push(r),
  });
  return { assistant, reports };
}

describe('R5: plain reasons when Claude fails', () => {
  it.each(FAKE)('%s (%s): the code word comes from fixed markers', (code, out, _why) => {
    const o = out();
    expect(o.kind).toBe('error');
    if (o.kind !== 'error') throw new Error('not an error');
    expect(o.failure ?? claudeFailure(o.message)).toBe(code);
  });

  it.each(FAKE)('%s (%s): the reply is the plain line, the report carries the code word', async (code, out) => {
    const { assistant } = make([out()]);
    const r = await assistant.command('what is the weather', { source: 'voice-ptt' });
    expect(r).toMatchObject({ result: 'error', failure: code });
    const line = FAILURE_LINES[code as keyof typeof FAILURE_LINES];
    if (line) expect(r.reply).toBe(`${line} ${LOCAL_STILL_WORKS}`);
    if (code === 'claude_usage_limit') expect(r.reply).toBe(`You've reached your Claude plan limit. It resets at 3pm. ${LOCAL_STILL_WORKS}`);
    if (code === 'claude_other') expect(r.reply).not.toContain(LOCAL_STILL_WORKS);
  });

  it('the subtype decides first: limit wording in a max-turns or budget result (a page can steer it) is ignored', () => {
    for (const [subtype, line] of [['error_max_turns', 'I ran out of steps before finishing.'], ['error_max_budget_usd', 'That would cost more than allowed, so I stopped.']]) {
      const o = parseClaudeOutput(result(subtype!, "You've hit your limit · resets 3pm"), 1);
      expect(o).toMatchObject({ kind: 'error', message: line });
      if (o.kind !== 'error') throw new Error('not an error');
      expect(o.failure ?? claudeFailure(o.message)).toBe('claude_other');
    }
  });

  it('"timers and memory still work" is said once per run, not on every failure', async () => {
    const offline = (): ClaudeOutcome => parseClaudeOutput('', 1, 'Error: fetch failed\n');
    const { assistant } = make([offline(), offline()]);
    const a = await assistant.command('x', { source: 'voice-ptt' });
    const b = await assistant.command('y', { source: 'voice-ptt' });
    expect(a.reply).toBe(`${FAILURE_LINES.claude_offline} ${LOCAL_STILL_WORKS}`);
    expect(b.reply).toBe(FAILURE_LINES.claude_offline);
  });

  it('a successful run has no failure code', async () => {
    const { assistant } = make([{ kind: 'ok', text: 'Hi.', sessionId: null, costUsd: null, turns: 1 }]);
    const r = await assistant.command('hello', { source: 'voice-ptt' });
    expect(r.failure).toBeUndefined();
  });

  it('every failure code is an incident code word (older versions read unknown codes as other)', () => {
    for (const c of CLAUDE_FAILURES) expect(INCIDENT_CODES).toContain(c);
  });

  describe('the incident file', () => {
    const home = mkdtempSync(join(tmpdir(), 'stephen-r5-'));
    afterAll(() => rmSync(home, { recursive: true, force: true }));

    it('gets the code word and never the error text', () => {
      const m = new LatencyMonitor({ home, loop: { reset: () => undefined, p99Ms: () => 0 } });
      m.begin('c_1', 'ptt');
      m.mark('c_1', 'asrDone');
      m.end('c_1', 'error', { failure: 'claude_signed_out' });
      m.begin('c_2', 'ptt');
      m.end('c_2', 'error');
      expect(readIncidents(home, 5).map((i) => `${i.id} ${i.code}`).sort()).toEqual(['c_1 claude_signed_out', 'c_2 command_error']);
      const raw = readdirSync(incidentDir(home)).map((f) => readFileSync(join(incidentDir(home), f), 'utf8')).join('');
      expect(raw).not.toMatch(/login|logged|api key|weather/i);
    });
  });
});
