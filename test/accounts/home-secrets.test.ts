/** docs/PLAN-WORK-SPLIT.md §12: secrets live in the Keychain or the home folder's .env, not the repo. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_ENV_FILE, defaultEnvFiles, lookupSecret } from '../../src/accounts/secrets.js';
import { repoPersonalFiles } from '../../src/cli.js';
import { runAccountsCli } from '../../src/connect/accounts-cli.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stephen-home-secrets-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('where .env is read', () => {
  it('the home folder first, then the repo (legacy)', () => {
    expect(defaultEnvFiles({ STEPHEN_HOME: join(tmp, 'h') })).toEqual([join(tmp, 'h', '.env'), DEFAULT_ENV_FILE]);
  });

  it('an explicit envFile is the only file read (tests and callers keep full control)', async () => {
    const f = join(tmp, 'only.env');
    writeFileSync(f, 'NOTION_API=ntn_1234567890abcdef\n');
    chmodSync(f, 0o600);
    const noKeychain = { exec: async () => ({ code: 44, stdout: '', stderr: '' }) };
    expect(await lookupSecret('notion-token', { envFile: f, ...noKeychain })).toMatchObject({ value: 'ntn_1234567890abcdef', source: '.env' });
  });
});

describe('stephen accounts set <name>', () => {
  const run = async (argv: string[], value = 'ntn_1234567890abcdef', fail: string | null = null) => {
    const out: string[] = [];
    const stored: [string, string, string][] = [];
    const code = await runAccountsCli(argv, {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      readSecret: async () => value,
      store: async (s, l, v) => (stored.push([s, l, v]), fail),
    });
    return { code, text: out.join('\n'), stored };
  };

  it('stores the value under that secret\'s Keychain item and never prints it', async () => {
    const r = await run(['set', 'notion-token']);
    expect(r.code).toBe(0);
    expect(r.stored).toEqual([['stephen-notion', 'Stephen notion-token', 'ntn_1234567890abcdef']]);
    expect(r.text).toMatch(/Stored notion-token in the Keychain \(stephen-notion\)/);
    expect(r.text).not.toContain('ntn_1234567890abcdef');
  });

  it('refuses unknown names and bad values; nothing is stored', async () => {
    expect((await run(['set', 'bank-password'])).code).toBe(2);
    const bad = await run(['set', 'calendar-ics'], 'not-a-url-at-all');
    expect(bad.code).toBe(1);
    expect(bad.stored).toEqual([]);
  });
});

describe('doctor: personal files in the repo', () => {
  it('a repo .env, and a repo config.json that is not a link to the home one, are flagged', () => {
    const repo = join(tmp, 'repo');
    const home = join(tmp, 'home');
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{}');
    expect(repoPersonalFiles(repo, home)).toEqual([]);
    symlinkSync(join(home, 'config.json'), join(repo, 'config.json'));
    expect(repoPersonalFiles(repo, home)).toEqual([]); // the owner's link is fine
    rmSync(join(repo, 'config.json'));
    writeFileSync(join(repo, 'config.json'), '{}');
    writeFileSync(join(repo, '.env'), 'X=1');
    expect(repoPersonalFiles(repo, home).map((w) => w.label)).toEqual(['Secrets outside the repo', 'Repo config.json']);
  });
});
