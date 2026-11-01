/** `stephen memory list | add | forget | clear` (src/memory/cli.ts). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MEMORY_USAGE, runMemoryCli, type MemoryCliEnv } from '../../src/memory/cli.js';
import { MEMORY_FILE, MemoryStore } from '../../src/memory/store.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-memory-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function harness(answers: string[] = []) {
  const home = mkdtempSync(join(tmp, `h${++n}-`));
  const store = new MemoryStore({ home, maxItems: 3, now: () => new Date('2026-11-01T12:00:00Z') });
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const env: MemoryCliEnv = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    prompt: async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
    store: () => store,
  };
  const run = (...argv: string[]) => runMemoryCli(argv, env);
  return { home, store, out, err, asked, run };
}

describe('stephen memory', () => {
  it('help and usage errors', async () => {
    const h = harness();
    expect(await h.run()).toBe(2);
    expect(h.err.join('\n')).toContain(MEMORY_USAGE);
    expect(await h.run('help')).toBe(0);
    expect(h.out.join('\n')).toContain('stephen memory forget <id>');
    expect(await h.run('wipe')).toBe(2);
    expect(h.err.at(-1)).toMatch(/Unknown memory command "wipe"/);
    expect(await h.run('add')).toBe(2);
    expect(await h.run('forget')).toBe(2);
    expect(await h.run('forget', 'm1', 'm2')).toBe(2);
    expect(await h.run('list', '--all')).toBe(2);
    expect(await h.run('clear', '--yes')).toBe(2);
  });

  it('add saves with source cli (joins words), list shows ids, forget removes', async () => {
    const h = harness();
    expect(await h.run('list')).toBe(0);
    expect(h.out.at(-1)).toMatch(/Nothing saved/);
    expect(await h.run('add', 'My prof is Dr. Patel')).toBe(0);
    expect(await h.run('add', 'my', 'gym', 'is', 'GoodLife')).toBe(0);
    expect(h.out.slice(-2)).toEqual(['Saved m1: My prof is Dr. Patel', 'Saved m2: my gym is GoodLife']);
    expect((await h.store.list()).map((i) => i.source)).toEqual(['cli', 'cli']);
    expect(await h.run('add', 'my gym is goodlife')).toBe(0);
    expect(h.out.at(-1)).toBe('Already saved as m2: my gym is GoodLife');

    h.out.length = 0;
    expect(await h.run('list')).toBe(0);
    expect(h.out).toEqual(['m1   My prof is Dr. Patel   (cli, 2026-11-01)', 'm2   my gym is GoodLife   (cli, 2026-11-01)', '2 of 3.']);

    expect(await h.run('forget', 'm1')).toBe(0);
    expect(h.out.at(-1)).toBe('Forgot m1: My prof is Dr. Patel');
    expect(await h.run('forget', 'm1')).toBe(1);
    expect(h.err.at(-1)).toMatch(/No memory "m1"/);
  });

  it('refusals print the reason and exit 1', async () => {
    const h = harness();
    expect(await h.run('add', 'my password is hunter2')).toBe(1);
    expect(h.err.at(-1)).toBe("I don't save passwords, codes or card numbers.");
    expect(await h.run('add', 'x'.repeat(201))).toBe(1);
    expect(h.err.at(-1)).toMatch(/too long/);
    for (const t of ['fact one here', 'fact two here', 'fact three here']) await h.run('add', t);
    expect(await h.run('add', 'fact four here')).toBe(1);
    expect(h.err.at(-1)).toMatch(/full/);
  });

  it('clear asks y/N: only y/yes clears', async () => {
    const h = harness(['', 'n', 'YES']);
    expect(await h.run('clear')).toBe(0);
    expect(h.out.at(-1)).toBe('Nothing to forget.');
    expect(h.asked).toEqual([]); // nothing to clear: no question
    await h.run('add', 'my gym is goodlife');
    await h.run('add', 'my prof is dr patel');
    expect(await h.run('clear')).toBe(1); // Enter = No
    expect(h.asked.at(-1)).toBe('Forget all 2 saved items? [y/N] ');
    expect(await h.run('clear')).toBe(1);
    expect(await h.store.list()).toHaveLength(2);
    expect(await h.run('clear')).toBe(0);
    expect(h.out.at(-1)).toBe('Forgot everything.');
    expect(await h.store.list()).toEqual([]);
  });

  it('an unreadable memory file is reported, not thrown', async () => {
    const h = harness();
    writeFileSync(join(h.home, MEMORY_FILE), '{bad', { mode: 0o600 });
    expect(await h.run('list')).toBe(1);
    expect(h.err.at(-1)).toMatch(/Can't read memory: .*not valid JSON/);
    expect(await h.run('add', 'my gym is goodlife')).toBe(1);
    expect(h.err.at(-1)).toMatch(/can't read my memory file/);
  });

  it('the default store uses STEPHEN_HOME, memory.maxItems and the audit log', async () => {
    const home = mkdtempSync(join(tmp, 'real-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { maxItems: 1 } }));
    const saved = { ...process.env };
    process.env.STEPHEN_HOME = home;
    delete process.env.STEPHEN_CONFIG;
    delete process.env.BROWSER_HUB_CONFIG;
    try {
      const out: string[] = [];
      const err: string[] = [];
      const env = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
      expect(await runMemoryCli(['add', 'my gym is goodlife'], env)).toBe(0);
      expect(await runMemoryCli(['add', 'my prof is dr patel'], env)).toBe(1);
      expect(err.at(-1)).toMatch(/full/);
      const audit = (await import('node:fs')).readFileSync(join(home, 'audit.log'), 'utf8');
      expect(audit).toContain('"tool":"memory"');
      expect(audit).not.toContain('goodlife');
      expect(audit).not.toContain('patel');
    } finally {
      process.env = saved;
    }
  });
});
