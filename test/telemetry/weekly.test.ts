/** `stephen report --week` (F13): numbers, code words, versions and dates only, whatever the records hold. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWeekly, formatWeekly, runWeeklyCli } from '../../src/telemetry/cli.js';
import { INCIDENT_CODES, readIncidents, recordIncident } from '../../src/telemetry/incidents.js';
import { LATENCY_OUTCOMES, LatencyMonitor, latencyDir } from '../../src/telemetry/latency.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-weekly-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const NOW = new Date(2026, 10, 26, 12, 0); // local noon, 2026-11-26
const at = (daysAgo: number, h = 10) => new Date(2026, 10, 26 - daysAgo, h, 0).toISOString();

/** Words that must never reach the summary: a command, a host, a name, a path. */
const PLANTED = ['open my bank', 'evil.example.com', 'Alice Smith', '/Users/alice/secret.txt'];

function home(): string {
  const h = mkdtempSync(join(tmp, 'h'));
  mkdirSync(latencyDir(h), { recursive: true, mode: 0o700 });
  const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, followUp: false, turns: 0, tier: null, ...o });
  const rows = [
    line({ id: 'h_0000000000000001', ts: at(0), trigger: 'ptt', route: 'model', outcome: 'ok', costUsd: 0.25, stages: { speechEnd: 100, replyReady: 2100 }, transcript: PLANTED[0], host: PLANTED[1] }),
    line({ id: 'h_0000000000000002', ts: at(0, 11), trigger: 'wake', route: 'timer', outcome: 'ok', stages: { speechEnd: 100, replyReady: 600 }, name: PLANTED[2] }),
    line({ id: 'h_0000000000000003', ts: at(2), trigger: 'phone', route: 'job', outcome: 'error', costUsd: 0.5, path: PLANTED[3] }),
    line({ id: 'h_0000000000000004', ts: at(3), trigger: 'wake', route: null, outcome: 'wake_ignored', ignored: PLANTED[1] }),
    line({ id: 'h_0000000000000005', ts: at(9), trigger: 'ptt', route: 'model', outcome: 'ok', costUsd: 9 }), // older than a week
  ];
  writeFileSync(join(latencyDir(h), `latency-2026-11-26.jsonl`), `${rows.join('\n')}\n`, { mode: 0o600 });
  recordIncident(h, { part: 'listen', code: 'claude_offline', stage: 'run' }, new Date(at(1)));
  recordIncident(h, { part: PLANTED[2]!, code: PLANTED[1], stage: PLANTED[3] }, new Date(at(1)));
  return h;
}

async function week(h: string): Promise<string> {
  const out: string[] = [];
  await runWeeklyCli({ monitor: new LatencyMonitor({ home: h, now: () => NOW.getTime() }), incidents: readIncidents(h, 100), now: NOW, stephen: '0.9.1', claude: '2.1.318', out: (l) => out.push(l) });
  return out.join('\n');
}

// Every word of the output: fixed English labels, code words, numbers, versions and dates. Nothing else.
const LABELS = 'Stephen week to Claude Code Commands failed jobs started model cost USD Local commands speech reply median ms p95 n Model no timed Incidents none Per day cost'.split(' ');
const ALLOWED = new Set<string>([...LABELS, ...INCIDENT_CODES, ...LATENCY_OUTCOMES]);
const ok = (token: string) => ALLOWED.has(token) || /^\d{4}-\d{2}-\d{2}$/.test(token) || /^\d+(\.\d+)*$/.test(token) || /^n=\d+$/.test(token);

describe('stephen report --week', () => {
  it('counts the last 7 local days and nothing older', async () => {
    const s = buildWeekly(new LatencyMonitor({ home: home(), now: () => NOW.getTime() }).read(8), [], NOW, {});
    expect(s.from).toBe('2026-11-20');
    expect(s.to).toBe('2026-11-26');
    expect(s.days).toHaveLength(7);
    expect([s.commands, s.failed, s.jobs, s.usd]).toEqual([3, 1, 1, 0.75]); // the wake_ignored line is not a command, the 9 USD run is too old
    expect(s.model).toEqual({ n: 1, p50: 2000, p95: 2000 });
    expect(s.local).toEqual({ n: 1, p50: 500, p95: 500 });
    expect([s.stephen, s.claude]).toEqual(['unknown', 'unknown']);
  });

  it('planted words in the records never reach the output, and every word is allowed', async () => {
    const text = await week(home());
    for (const w of PLANTED) expect(text).not.toContain(w);
    expect(text).toContain('Incidents: claude_offline 1, other 1');
    expect(text).toContain('Stephen 0.9.1, Claude Code 2.1.318');
    const bad = text.split(/[\s,():]+/).filter((t) => t && !ok(t));
    expect(bad).toEqual([]);
  });

  it('a version that is not digits and dots shows as unknown', () => {
    const s = buildWeekly([], [], NOW, { stephen: '1.0.0; rm -rf ~', claude: 'Alice' });
    expect([s.stephen, s.claude]).toEqual(['unknown', 'unknown']);
    expect(formatWeekly(s)).toContain('no timed commands');
  });
});
