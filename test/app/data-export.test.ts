/**
 * R20: `stephen data export` and `stephen data import`. Temp homes only, the B10 fixtures (test/fixtures/v0.1) as the
 * last release's files, a fake listener and a fake config key check.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportData, importData, type ImportDeps, WHAT_IS_INSIDE } from '../../src/app/data-export.js';
import { MemoryStore } from '../../src/memory/store.js';
import { TimerStore } from '../../src/timers/store.js';

const FIX = resolve(__dirname, '../fixtures/v0.1');
const tmp = mkdtempSync(join(tmpdir(), 'stephen-r20-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name = 'd') => join(tmp, `${name}${++n}`);
const mode = (p: string) => statSync(p).mode & 0o777;

/** A home holding the v0.1 files, 0600 in a 0700 folder as Stephen writes them. */
function v01Home(): { home: string; configPath: string } {
  const home = fresh('home');
  mkdirSync(join(home, 'history'), { recursive: true, mode: 0o700 });
  const put = (f: string, to: string) => (copyFileSync(join(FIX, f), join(home, to)), chmodSync(join(home, to), 0o600));
  put('settings.json', 'config.json');
  put('memory.json', 'memory.json');
  put('timers.json', 'timers.json');
  put('history.jsonl', 'history/2026-11-25.jsonl');
  writeFileSync(join(home, '.env'), 'CANVAS_API=12345~SECRETSECRETSECRET\n', { mode: 0o600 });
  return { home, configPath: join(home, 'config.json') };
}

function deps(home: string, configPath: string, o: Partial<ImportDeps> = {}): ImportDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    home,
    configPath,
    version: '0.2.0-test',
    now: () => new Date(Date.UTC(2026, 10, 26)),
    configSecretKeys: async () => [],
    listenerAnswers: async () => false,
    ask: null,
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    lines,
    ...o,
  };
}

/** Every file under a folder, relative path → text. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${rel}${name}/`);
      else out[`${rel}${name}`] = readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

describe('stephen data export (R20)', () => {
  it('writes a new 0700 folder with 0600 files, a manifest, and no .env or secret', async () => {
    const { home, configPath } = v01Home();
    const dest = fresh('export');
    const d = deps(home, configPath);
    expect(await exportData(dest, { history: true }, d)).toBe(0);
    expect(mode(dest)).toBe(0o700);
    expect(mode(join(dest, 'history'))).toBe(0o700);
    const files = tree(dest);
    expect(Object.keys(files)).toEqual(['config.json', 'history/2026-11-25.jsonl', 'manifest.json', 'memory.json', 'timers.json']);
    for (const f of Object.keys(files)) expect(mode(join(dest, f))).toBe(0o600);
    expect(Object.values(files).join('\n')).not.toMatch(/SECRET|CANVAS_API/);
    const m = JSON.parse(files['manifest.json']!);
    expect(m).toMatchObject({ format: 1, stephenVersion: '0.2.0-test', createdAt: '2026-11-26T00:00:00.000Z', whatIsInside: WHAT_IS_INSIDE });
    expect(m.contents.join(' ')).toMatch(/memory item.*timer.*history/);
    expect(d.lines.join('\n')).toContain('only you can open it');
  });

  it('history only with --history', async () => {
    const { home, configPath } = v01Home();
    const dest = fresh('export');
    expect(await exportData(dest, { history: false }, deps(home, configPath))).toBe(0);
    expect(existsSync(join(dest, 'history'))).toBe(false);
  });

  it('never writes into an existing folder', async () => {
    const { home, configPath } = v01Home();
    const dest = fresh('export');
    mkdirSync(dest);
    const d = deps(home, configPath);
    expect(await exportData(dest, { history: true }, d)).toBe(1);
    expect(readdirSync(dest)).toEqual([]);
    expect(d.lines.join()).toMatch(/already exists/);
  });

  it('a secret-looking config key refuses the export, and the name is not shown', async () => {
    const { home, configPath } = v01Home();
    const dest = fresh('export');
    const d = deps(home, configPath, { configSecretKeys: async () => ['openaiApiKey'] });
    expect(await exportData(dest, { history: false }, d)).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(d.lines.join()).toMatch(/looks like a secret/);
    expect(d.lines.join()).not.toContain('openaiApiKey');
  });

  it('a linked memory file refuses the export', async () => {
    const { home, configPath } = v01Home();
    rmSync(join(home, 'memory.json'));
    symlinkSync(join(FIX, 'memory.json'), join(home, 'memory.json'));
    const dest = fresh('export');
    const d = deps(home, configPath);
    expect(await exportData(dest, { history: false }, d)).toBe(1);
    expect(d.lines.join()).toMatch(/memory\.json is a link/);
  });

  it('a "home" setting is left out of the export, and it says so', async () => {
    const { home, configPath } = v01Home();
    writeFileSync(configPath, JSON.stringify({ home: '/Users/someone/.stephen', memory: { enabled: true } }), { mode: 0o600 });
    const dest = fresh('export');
    const d = deps(home, configPath);
    expect(await exportData(dest, { history: false }, d)).toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf8'))).toEqual({ memory: { enabled: true } });
    expect(d.lines.join('\n')).toMatch(/"home" folder setting was left out/);
  });
});

describe('stephen data import (R20)', () => {
  async function exported(history = true): Promise<string> {
    const { home, configPath } = v01Home();
    const dest = fresh('export');
    expect(await exportData(dest, { history }, deps(home, configPath))).toBe(0);
    return dest;
  }
  const emptyHome = () => {
    const home = fresh('target');
    mkdirSync(home, { mode: 0o700 });
    return { home, configPath: join(home, 'config.json') };
  };

  it('round trip from the last release files: the stores read back the same items, 0600', async () => {
    const src = await exported();
    const { home, configPath } = emptyHome();
    const d = deps(home, configPath);
    expect(await importData(src, { yes: true, config: true }, d)).toBe(0);
    const before = new MemoryStore({ home: join(src) }).listSync();
    expect(new MemoryStore({ home }).listSync()).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
    expect(new TimerStore({ home }).list()).toEqual(new TimerStore({ home: src }).list());
    expect(readFileSync(join(home, 'history/2026-11-25.jsonl'), 'utf8')).toBe(readFileSync(join(src, 'history/2026-11-25.jsonl'), 'utf8'));
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(JSON.parse(readFileSync(join(FIX, 'settings.json'), 'utf8')));
    for (const f of ['config.json', 'memory.json', 'timers.json', 'history/2026-11-25.jsonl']) expect(mode(join(home, f))).toBe(0o600);
    expect(d.lines.join('\n')).toMatch(/This replaces[\s\S]*memory item/);
  });

  it('refuses while Stephen runs, and changes nothing', async () => {
    const src = await exported();
    const { home, configPath } = emptyHome();
    const d = deps(home, configPath, { listenerAnswers: async () => true });
    expect(await importData(src, { yes: true, config: true }, d)).toBe(1);
    expect(readdirSync(home)).toEqual([]);
    expect(d.lines.join()).toMatch(/Stephen is running/);
  });

  it.each([
    ['a corrupt memory file', (s: string) => writeFileSync(join(s, 'memory.json'), '{"version":1,"items":[{"id":"bad"}]}')],
    ['memory text that looks like a secret', (s: string) => {
      const m = JSON.parse(readFileSync(join(s, 'memory.json'), 'utf8'));
      m.items[0].text = 'my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
      writeFileSync(join(s, 'memory.json'), JSON.stringify(m));
    }],
    ['a broken history line', (s: string) => writeFileSync(join(s, 'history/2026-11-25.jsonl'), 'not json\n')],
    ['a timers file that is not JSON', (s: string) => writeFileSync(join(s, 'timers.json'), '{')],
    ['a linked timers file', (s: string) => (rmSync(join(s, 'timers.json')), symlinkSync(join(FIX, 'timers.json'), join(s, 'timers.json')))],
    ['a config with a home folder', (s: string) => writeFileSync(join(s, 'config.json'), '{"home":"/tmp/x"}')],
    ['a config that does not load', (s: string) => writeFileSync(join(s, 'config.json'), '{"chrome":{"mode":"sideways"}}')],
  ])('%s refuses the whole import, and nothing changes', async (_name, spoil) => {
    const src = await exported();
    spoil(src);
    const { home, configPath } = emptyHome();
    writeFileSync(join(home, 'memory.json'), 'before', { mode: 0o600 });
    const d = deps(home, configPath);
    expect(await importData(src, { yes: true, config: true }, d)).toBe(1);
    expect(readdirSync(home)).toEqual(['memory.json']);
    expect(readFileSync(join(home, 'memory.json'), 'utf8')).toBe('before');
    expect(d.lines.join()).toMatch(/Nothing was changed/);
  });

  it('a linked export folder, or a folder without a manifest, is refused', async () => {
    const src = await exported();
    const link = fresh('link');
    symlinkSync(src, link);
    const { home, configPath } = emptyHome();
    expect(await importData(link, { yes: true, config: true }, deps(home, configPath))).toBe(1);
    const plain = fresh('plain');
    mkdirSync(plain);
    const d = deps(home, configPath);
    expect(await importData(plain, { yes: true, config: true }, d)).toBe(1);
    expect(d.lines.join()).toMatch(/not a Stephen export/);
    expect(readdirSync(home)).toEqual([]);
  });

  it('a newer export format is refused', async () => {
    const src = await exported();
    const m = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ ...m, format: 2 }));
    const { home, configPath } = emptyHome();
    const d = deps(home, configPath);
    expect(await importData(src, { yes: true, config: true }, d)).toBe(1);
    expect(d.lines.join()).toMatch(/format 2/);
  });

  it('settings come in only with --config; without it the current config.json stays', async () => {
    const src = await exported();
    const { home, configPath } = emptyHome();
    writeFileSync(configPath, '{"memory":{"enabled":false}}', { mode: 0o600 });
    const d = deps(home, configPath);
    expect(await importData(src, { yes: true, config: false }, d)).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe('{"memory":{"enabled":false}}');
    expect(existsSync(join(home, 'memory.json'))).toBe(true);
    expect(d.lines.join('\n')).toMatch(/not imported \(add --config/);
  });

  it('a config that loosens a safety setting is named before the question, and "n" writes nothing', async () => {
    const src = await exported();
    writeFileSync(join(src, 'config.json'), JSON.stringify({ chrome: { mode: 'agent' }, memory: { enabled: true }, safety: { allowEvaluate: true } }));
    const { home, configPath } = emptyHome();
    writeFileSync(configPath, JSON.stringify({ chrome: { mode: 'agent' }, memory: { enabled: true }, safety: { blockedDomains: ['bank.example'] } }), { mode: 0o600 });
    const before = readFileSync(configPath, 'utf8');
    let askedAfter = -1;
    const d = deps(home, configPath, { ask: async () => ((askedAfter = d.lines.length), 'n') });
    expect(await importData(src, { yes: false, config: true }, d)).toBe(0);
    const shown = d.lines.slice(0, askedAfter).join('\n');
    expect(shown).toMatch(/Settings that change[\s\S]*safety\.allowEvaluate \(new\)[\s\S]*safety\.blockedDomains \(removed\)/);
    expect(shown).not.toContain('bank.example'); // names only, never values
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(existsSync(join(home, 'memory.json'))).toBe(false);
  });

  it('asks first: no means nothing changes; no terminal needs --yes', async () => {
    const src = await exported();
    const { home, configPath } = emptyHome();
    const no = deps(home, configPath, { ask: async () => 'n' });
    expect(await importData(src, { yes: false, config: true }, no)).toBe(0);
    expect(readdirSync(home)).toEqual([]);
    const noTty = deps(home, configPath);
    expect(await importData(src, { yes: false, config: true }, noTty)).toBe(1);
    expect(noTty.lines.join()).toMatch(/--yes/);
    const yes = deps(home, configPath, { ask: async () => 'y' });
    expect(await importData(src, { yes: false, config: true }, yes)).toBe(0);
    expect(existsSync(join(home, 'memory.json'))).toBe(true);
    expect(dirname(configPath)).toBe(home);
  });
});
