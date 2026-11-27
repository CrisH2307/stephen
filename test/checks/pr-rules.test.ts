/** AGENTS.md rules as a CI check: no dashes added, Cris's commits, tagged new deps (scripts/pr-rules.mjs, pr-rules.yml). */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { CRIS, DASH_DATA, GITHUB_MERGE, badCommits, dashLines, newDeps, prProblems } from '../../scripts/pr-rules.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const EM = '\u2014';
const EN = '\u2013';

describe('pr rules check', () => {
  it('rule 1: an added line with an em or en dash is named by file and line; removed and context lines are not', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +10,3 @@',
      `-old ${EM} line`,
      '+clean line',
      `+say ${EM} this`,
      `+range 1${EN}2`,
      'diff --git a/docs/b.md b/docs/b.md',
      '--- /dev/null',
      '+++ b/docs/b.md',
      '@@ -0,0 +1 @@',
      `+a ${EN} b`,
    ].join('\n');
    expect(dashLines(diff)).toEqual(['src/a.ts:11', 'src/a.ts:12', 'docs/b.md:1']);
  });

  it('rule 1: files where the dash is data are skipped, a hyphen is fine, a deleted file adds nothing', () => {
    const add = (f: string, text: string) => `+++ b/${f}\n@@ -0,0 +1 @@\n+${text}`;
    expect(dashLines(add('src/safety/text.ts', `map ${EM}`))).toEqual([]);
    expect(dashLines(add('test/safety/text.test.ts', `x ${EN}`))).toEqual([]);
    expect(dashLines(add('test/fixtures/page.html', `x ${EM}`))).toEqual([]);
    expect(dashLines(add('src/safety/gate.ts', `x ${EM}`))).toEqual(['src/safety/gate.ts:1']);
    expect(dashLines(add('src/a.ts', 'well-known - fine'))).toEqual([]);
    expect(dashLines(`--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x ${EM}`)).toEqual([]);
    expect(DASH_DATA).toContain('test/fixtures/');
  });

  it('rule 2: Cris authors; committer is Cris or the GitHub merge button; anything else is named by short sha', () => {
    const log = [
      `${'a'.repeat(40)}\t${CRIS}\t${CRIS}`,
      `${'b'.repeat(40)}\t${CRIS}\t${GITHUB_MERGE}`,
      `${'c'.repeat(40)}\tClaude <noreply@anthropic.com>\t${CRIS}`,
      `${'d'.repeat(40)}\t${CRIS}\tsomeone <me@host.local>`,
      `${'e'.repeat(40)}\t${GITHUB_MERGE}\t${GITHUB_MERGE}`,
    ].join('\n');
    expect(badCommits(log)).toEqual(['c'.repeat(12), 'd'.repeat(12), 'e'.repeat(12)]);
    expect(badCommits('')).toEqual([]);
  });

  it('rule 3: only new names count, in dependencies and devDependencies; a version bump is not new', () => {
    const old = { dependencies: { a: '1' }, devDependencies: { b: '1' } };
    expect(newDeps(old, { dependencies: { a: '2' }, devDependencies: { b: '1' } })).toEqual([]);
    expect(newDeps(old, { dependencies: { a: '1', z: '1' }, devDependencies: { b: '1', c: '1' } })).toEqual(['c', 'z']);
    expect(newDeps({}, { scripts: { x: 'y' } })).toEqual([]);
  });

  it('messages: each rule names what failed and never prints the title; the tag only excuses rule 3', () => {
    const title = 'secret-looking title';
    const all = prProblems({ title, dashes: ['src/a.ts:3'], commits: ['abc123'], deps: ['left-pad'] }).join('\n');
    expect(all).toContain('Rule 1');
    expect(all).toContain('  src/a.ts:3');
    expect(all).toContain('Rule 2');
    expect(all).toContain('  abc123');
    expect(all).toContain('Rule 3');
    expect(all).toContain('  left-pad');
    expect(all).not.toContain(title);
    const tagged = prProblems({ title: '[DEV REVIEW] deps', dashes: ['src/a.ts:3'], commits: [], deps: ['left-pad'] }).join('\n');
    expect(tagged).toContain('Rule 1');
    expect(tagged).not.toContain('Rule 3');
    expect(prProblems({ title, dashes: [], commits: [], deps: [] })).toEqual([]);
  });

  it('end to end: a PR into qa fails on a dash and a foreign commit; into main only rule 3 runs', () => {
    const d = mkdtempSync(join(tmpdir(), 'pr-rules-'));
    const git = (env: Record<string, string>, ...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: d, ...env } });
    const [name, email] = [CRIS.split(' <')[0], CRIS.slice(CRIS.indexOf('<') + 1, -1)];
    const cris = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const other = { GIT_AUTHOR_NAME: 'Bot', GIT_AUTHOR_EMAIL: 'bot@example.com', GIT_COMMITTER_NAME: 'Bot', GIT_COMMITTER_EMAIL: 'bot@example.com' };
    try {
      git(cris, 'init', '-q');
      writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }));
      git(cris, 'add', '.');
      git(cris, 'commit', '-qm', 'base');
      const base = git(cris, 'rev-parse', 'HEAD').trim();
      writeFileSync(join(d, 'a.md'), `one ${EM} two\n`);
      git(other, 'add', '.');
      git(other, 'commit', '-qm', 'change');
      writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { a: '1', b: '1' } }));
      git(cris, 'commit', '-qam', 'dep');
      const head = git(cris, 'rev-parse', 'HEAD').trim();
      const run = (title: string, ref: string) =>
        spawnSync(process.execPath, [join(ROOT, 'scripts/pr-rules.mjs')], { cwd: d, env: { PATH: process.env.PATH, TITLE: title, BASE_SHA: base, HEAD_SHA: head, BASE_REF: ref }, encoding: 'utf8' });
      const qa = run('feat: x', 'qa');
      expect(qa.status).toBe(1);
      expect(qa.stdout).toContain('  a.md:1');
      expect(qa.stdout).toContain('Rule 2');
      expect(qa.stdout).toContain('  b');
      expect(qa.stdout).not.toContain('bot@example.com');
      expect(run('feat: x', 'main').status).toBe(1);
      expect(run('[DEV REVIEW] release', 'main').status).toBe(0);
      expect(spawnSync(process.execPath, [join(ROOT, 'scripts/pr-rules.mjs')], { cwd: d, env: { PATH: process.env.PATH, BASE_SHA: 'HEAD', HEAD_SHA: head }, encoding: 'utf8' }).status).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('the workflow runs on title edits, takes title and shas through env: only, and needs full history', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/pr-rules.yml'), 'utf8');
    expect(wf).toMatch(/types: \[opened, synchronize, reopened, edited\]/);
    expect(wf).toContain('TITLE: ${{ github.event.pull_request.title }}');
    expect(wf).toContain('fetch-depth: 0');
    expect(wf).toContain('run: node scripts/pr-rules.mjs');
    expect(wf).not.toMatch(/run:.*\$\{\{/);
    expect(wf).not.toMatch(/^\s*pull_request_target:/m);
  });
});
