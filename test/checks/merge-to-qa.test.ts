import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/merge-to-qa.sh with a fake `gh` first on PATH: `pr view` prints a fixture, `api` prints the changed files
// (one JSON object per line), `pr merge` logs its arguments.
const SCRIPT = resolve('scripts/merge-to-qa.sh');
const SHA = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-01-02T00:00:00Z';
// One check run of a workflow. Times are used to pick the latest run.
const check = (name: string, conclusion: string, at = T1, workflowName = 'ci') =>
  ({ name, workflowName, conclusion, startedAt: at, completedAt: conclusion ? at : null });
const green = [check('linux', 'SUCCESS'), check('macos', 'SUCCESS')];
const docs = [{ filename: 'docs/ordinary.md', status: 'modified' }];

function run(pr: Record<string, unknown>, arg = '42', files: Record<string, unknown>[] = docs) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-to-qa-'));
  dirs.push(dir);
  const view = {
    baseRefName: 'qa', state: 'OPEN', title: 'docs: thing', headRefOid: SHA, statusCheckRollup: green,
    labels: [{ name: 'merge-ready' }], isCrossRepository: false, ...pr,
  };
  writeFileSync(join(dir, 'view.json'), JSON.stringify(view));
  writeFileSync(join(dir, 'files.jsonl'), files.map((f) => JSON.stringify(f)).join('\n') + '\n');
  writeFileSync(join(dir, 'gh'), `#!/bin/bash
if [ "$1" = "api" ]; then cat "${dir}/files.jsonl"; exit 0; fi
if [ "$2" = "view" ]; then cat "${dir}/view.json"; exit 0; fi
if [ "$2" = "merge" ]; then echo "$@" > "${dir}/merged"; exit 0; fi
exit 9
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const r = spawnSync('bash', [SCRIPT, arg], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  const mergedFile = join(dir, 'merged');
  return { code: r.status, err: r.stderr, merged: existsSync(mergedFile) ? readFileSync(mergedFile, 'utf8').trim() : null };
}

const files = (...paths: string[]) => paths.map((filename) => ({ filename, status: 'modified' }));

describe('scripts/merge-to-qa.sh', () => {
  it('merges a docs-only green PR to qa, pinned to the head commit', () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.merged).toBe(`pr merge 42 --merge --match-head-commit ${SHA}`);
  });

  it('merges a mixed-case docs path and a top-level markdown file', () => {
    expect(run({}, '42', files('docs/Plan.md', 'site/index.html', 'README.md')).code).toBe(0);
  });

  it('refuses a PR whose base is main', () => {
    const r = run({ baseRefName: 'main' });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('not qa');
    expect(r.merged).toBeNull();
  });

  it('refuses a PR without the merge-ready label', () => {
    expect(run({ labels: [] }).merged).toBeNull();
    expect(run({ labels: [{ name: 'wip' }] }).merged).toBeNull();
    expect(run({ labels: [{ name: 'merge-ready' }] }).code).toBe(0);
  });

  it('refuses a closed PR', () => {
    expect(run({ state: 'MERGED' }).merged).toBeNull();
  });

  it('refuses when a check is missing, failed or still running', () => {
    expect(run({ statusCheckRollup: [green[0]] }).merged).toBeNull();
    expect(run({ statusCheckRollup: [green[0], check('macos', 'FAILURE')] }).merged).toBeNull();
    expect(run({ statusCheckRollup: [green[0], check('macos', '', T2)] }).merged).toBeNull();
  });

  it('refuses a rename from a code path into docs, using previous_filename', () => {
    const r = run({}, '42', [{ filename: 'docs/gate.ts', previous_filename: 'src/safety/gate.ts', status: 'renamed' }]);
    expect(r.merged).toBeNull();
    expect(r.err).toContain('src/safety/gate.ts is not a docs file. Cris merges it by hand.');
  });

  it.each([
    'src/lib/fs.ts',
    'test/safety/x.test.ts',
    '.npmrc',
    'tsconfig.json',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/agent-loop.md',
    'docs/release-checklist.md',
    'site/appcast.xml',
    '.github/workflows/ci.yml',
    '.claude/settings.json',
    'Docs/../src/x.ts',
    'SRC/Safety/gate.ts',
    'notes.txt',
    'docs/sub/../../package.json',
  ])('refuses %s', (path) => {
    const r = run({}, '42', files('docs/ok.md', path));
    expect(r.merged).toBeNull();
    expect(r.err).toContain(`${path} is not a docs file. Cris merges it by hand.`);
  });

  it('refuses a PR tagged [DEV REVIEW]', () => {
    const r = run({ title: '[DEV REVIEW] docs: thing' });
    expect(r.merged).toBeNull();
    expect(r.err).toContain('[DEV REVIEW]');
  });

  it('refuses a cross-repository PR', () => {
    const r = run({ isCrossRepository: true });
    expect(r.merged).toBeNull();
    expect(r.err).toContain('fork');
  });

  it('refuses a PR with no changed files', () => {
    expect(run({}, '42', []).merged).toBeNull();
  });

  it('does not count a linux or macos check from another workflow', () => {
    const r = run({ statusCheckRollup: [check('linux', 'SUCCESS', T1, 'other'), green[1]] });
    expect(r.merged).toBeNull();
    expect(r.err).toContain('linux');
  });

  it('merges when the newest run is green after an older failed rerun', () => {
    const r = run({ statusCheckRollup: [check('linux', 'FAILURE', T1), check('linux', 'SUCCESS', T2), green[1]] });
    expect(r.code).toBe(0);
  });

  it('refuses when the newest run failed after an older green run', () => {
    expect(run({ statusCheckRollup: [check('linux', 'SUCCESS', T1), check('linux', 'FAILURE', T2), green[1]] }).merged).toBeNull();
  });

  it('refuses at 3000 changed files and merges at 2999', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `docs/f${i}.md`, status: 'added' }));
    expect(run({}, '42', many(2999)).code).toBe(0);
    const r = run({}, '42', many(3000));
    expect(r.merged).toBeNull();
    expect(r.err).toContain('3000 files');
  });

  it('refuses a bad PR argument before calling gh', () => {
    const r = run({}, '42; gh pr merge 1');
    expect(r.code).toBe(2);
    expect(r.merged).toBeNull();
  });
});
