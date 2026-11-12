/** `stephen mac-checks`: each check passes on good data and fails on the one bad case it exists for. */
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecks, runMacChecksCli, type CheckEnv } from '../../src/checks/mac-checks.js';

const NOW = new Date('2026-11-10T15:00:00');
const ID = 'h_0123456789abcdef';
const OTHER = 'h_fedcba9876543210';
const row = (o: object = {}) => JSON.stringify({ v: 1, id: ID, ts: '2026-11-10T15:00:00.000Z', trigger: 'ptt', route: 'model', tier: null, outcome: 'ok', followUp: false, turns: 1, stages: { speechEnd: 0, done: 900 }, ...o });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'stephen-mc-'));
  const env: CheckEnv = { home, auditLog: join(home, 'audit.log'), now: NOW, platform: process.platform };
  const put = (rel: string, body: string, mode = 0o600) => {
    const p = join(home, rel);
    mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(p, body, { mode });
    chmodSync(p, mode);
    return p;
  };
  const good = () => {
    mkdirSync(join(home, 'telemetry'), { recursive: true });
    chmodSync(join(home, 'telemetry'), 0o700);
    put('telemetry/latency-2026-11-10.jsonl', `${row()}\n`);
    put('voice/tool-log.jsonl', `{"tool":"navigate","isError":false,"ms":5,"cmd":"${ID}"}\n`);
    put('voice/command.json', `{"id":"${ID}"}`);
    put('history/2026-11-10.jsonl', `{"id":"${ID}"}\n`);
    put('audit.log', `{"tool":"navigate","cmd":"${ID}"}\n`);
  };
  const status = () => Object.fromEntries(runChecks(env).map((r) => [r.id, r.status]));
  return { home, env, put, good, status };
}
const posix = process.platform === 'win32' ? it.skip : it;

describe('mac-checks', () => {
  it('skips everything on an empty home, and a skip is not a failure', async () => {
    const t = setup();
    expect(Object.values(t.status()).every((s) => s === 'skip')).toBe(true);
    const out: string[] = [];
    expect(await runMacChecksCli([], { out: (l) => out.push(l), env: t.env })).toBe(0);
    expect(out.at(-1)).toBe('0 passed, 0 failed, 11 skipped');
  });

  it('passes every check on good data', async () => {
    const t = setup();
    t.good();
    expect(Object.values(t.status()).every((s) => s === 'pass')).toBe(true);
    const out: string[] = [];
    expect(await runMacChecksCli([], { out: (l) => out.push(l), env: t.env })).toBe(0);
    expect(out[0]).toBe('PASS  13.1a  the latency folder is private (0700) (~/telemetry)');
  });

  posix('fails on a wrong folder mode and a wrong file mode', () => {
    const t = setup();
    t.good();
    chmodSync(join(t.home, 'telemetry'), 0o755);
    chmodSync(join(t.home, 'telemetry', 'latency-2026-11-10.jsonl'), 0o644);
    expect(t.status()).toMatchObject({ '13.1a': 'fail', '13.1b': 'fail' });
  });

  posix('fails on a wrong command file mode, and on a symlinked latency file', () => {
    const t = setup();
    t.good();
    chmodSync(join(t.home, 'voice', 'command.json'), 0o644);
    t.put('real.jsonl', `${row()}\n`);
    symlinkSync(join(t.home, 'real.jsonl'), join(t.home, 'telemetry', 'latency-2026-11-09.jsonl'));
    expect(t.status()).toMatchObject({ '13.3e': 'fail', '13.1b': 'fail' });
  });

  it('fails on a free-text field in a latency line, but not on known numbers', () => {
    const t = setup();
    t.good();
    t.put('telemetry/latency-2026-11-10.jsonl', `${row()}\n${row({ transcript: 'open youtube' })}\n`);
    expect(t.status()).toMatchObject({ '13.1c': 'pass', '13.1d': 'fail' });
    t.put('telemetry/latency-2026-11-10.jsonl', `${row({ stages: { speechEnd: 'open youtube' } })}\n`);
    expect(t.status()['13.1d']).toBe('fail');
    t.put('telemetry/latency-2026-11-10.jsonl', `${row({ route: 'open youtube' })}\n`);
    expect(t.status()['13.1c']).toBe('fail');
  });

  it('fails on a bad command id and on a line that is not JSON', () => {
    const t = setup();
    t.good();
    t.put('telemetry/latency-2026-11-10.jsonl', `${row({ id: 'h_short' })}\nnot json\n`);
    expect(t.status()['13.1c']).toBe('fail');
  });

  it('fails when a latency file is older than the retention', () => {
    const t = setup();
    t.good();
    t.put('telemetry/latency-2026-09-01.jsonl', `${row()}\n`);
    expect(t.status()['13.1e']).toBe('fail');
  });

  it('fails when the tool log has two ids', () => {
    const t = setup();
    t.good();
    t.put('voice/tool-log.jsonl', `{"cmd":"${ID}"}\n{"cmd":"${OTHER}"}\n`);
    expect(t.status()['13.3a']).toBe('fail');
  });

  it('fails when the id is missing from one log, each log on its own', () => {
    for (const [file, key] of [['telemetry/latency-2026-11-10.jsonl', '13.3b'], ['history/2026-11-10.jsonl', '13.3c'], ['audit.log', '13.3d']] as const) {
      const t = setup();
      t.good();
      t.put(file, `{"id":"${OTHER}","cmd":"${OTHER}"}\n`);
      const s = t.status();
      expect(s[key]).toBe('fail');
      expect(Object.entries(s).filter(([, v]) => v === 'fail').map(([k]) => k)).toContain(key);
    }
  });

  it('fails when command.json holds a different id', () => {
    const t = setup();
    t.good();
    t.put('voice/command.json', `{"id":"${OTHER}"}`);
    expect(t.status()['13.3f']).toBe('fail');
  });

  it('skips file modes on Windows', () => {
    const t = setup();
    t.good();
    t.env.platform = 'win32';
    expect(t.status()).toMatchObject({ '13.1a': 'skip', '13.1b': 'skip', '13.3e': 'skip' });
  });

  it('exits 1 on a failure, 2 on a bad option, and --json prints no file text', async () => {
    const t = setup();
    t.good();
    t.put('audit.log', 'open youtube\n');
    const out: string[] = [];
    expect(await runMacChecksCli(['--json'], { out: (l) => out.push(l), env: t.env })).toBe(1);
    expect(out.join('\n')).not.toContain('youtube');
    expect(JSON.parse(out[0]!).fail).toBe(1);
    const err: string[] = [];
    expect(await runMacChecksCli(['--days'], { err: (l) => err.push(l), env: t.env })).toBe(2);
  });
});
