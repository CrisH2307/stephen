import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/merge-to-qa.sh with a fake `gh` first on PATH: `pr view` prints a fixture, `pr merge` logs its arguments.
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
const ordinary = [{ path: 'src/ordinary.ts' }];

function run(pr: Record<string, unknown>, arg = '42') {
  const dir = mkdtempSync(join(tmpdir(), 'merge-to-qa-'));
  dirs.push(dir);
  const view = {
    baseRefName: 'qa', state: 'OPEN', title: 'fix: thing', headRefOid: SHA, statusCheckRollup: green,
    labels: [{ name: 'merge-ready' }], isCrossRepository: false, changedFiles: ordinary.length, files: ordinary,
    ...pr,
  };
  writeFileSync(join(dir, 'view.json'), JSON.stringify(view));
  writeFileSync(join(dir, 'gh'), `#!/bin/bash
if [ "$2" = "view" ]; then cat "${dir}/view.json"; exit 0; fi
if [ "$2" = "merge" ]; then echo "$@" > "${dir}/merged"; exit 0; fi
exit 9
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const r = spawnSync('bash', [SCRIPT, arg], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  const mergedFile = join(dir, 'merged');
  return { code: r.status, err: r.stderr, merged: existsSync(mergedFile) ? readFileSync(mergedFile, 'utf8').trim() : null };
}

const touching = (...paths: string[]) => ({ changedFiles: paths.length, files: paths.map((path) => ({ path })) });

describe('scripts/merge-to-qa.sh', () => {
  it('merges an ordinary green PR to qa, pinned to the head commit', () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.merged).toBe(`pr merge 42 --merge --match-head-commit ${SHA}`);
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

  it('refuses a PR that touches a workflow file', () => {
    const r = run(touching('src/a.ts', '.github/workflows/ci.yml'));
    expect(r.merged).toBeNull();
    expect(r.err).toContain('this PR touches .github/workflows/ci.yml. Cris merges it by hand.');
  });

  it('refuses a PR that touches a safety path', () => {
    const r = run(touching('src/safety/gate.ts'));
    expect(r.merged).toBeNull();
    expect(r.err).toContain('src/safety/gate.ts');
  });

  it('refuses a PR that touches the merge script itself', () => {
    expect(run(touching('scripts/merge-to-qa.sh')).merged).toBeNull();
  });

  it('refuses a PR that touches the other protected paths and globs', () => {
    for (const path of ['helper/AppConfirm.swift', 'src/memory/store.ts', 'src/replay/recorder.ts',
      'src/app/server.ts', 'package-lock.json', 'vitest.config.mts', 'test/global-setup.ts', 'docs/RELEASE-CHECKLIST.md']) {
      expect(run(touching(path)).merged, path).toBeNull();
    }
  });

  it('merges a PR whose paths only look like protected ones', () => {
    expect(run(touching('src/safety-notes.md', 'src/app/client.ts')).code).toBe(0);
  });

  it('refuses a [DEV REVIEW] PR, even with an approve comment', () => {
    const r = run({ title: '[DEV REVIEW] voice: thing', comments: [{ author: { login: 'CrisH2307' }, body: '**Independent review: approve.** Reviewed aaaaaaa.' }] });
    expect(r.merged).toBeNull();
    expect(r.err).toContain('[DEV REVIEW]');
  });

  it('refuses a cross-repository PR', () => {
    const r = run({ isCrossRepository: true });
    expect(r.merged).toBeNull();
    expect(r.err).toContain('fork');
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

  it('merges a PR with 99 changed files and refuses 100', () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/file${i}.ts` }));
    expect(run({ changedFiles: 99, files: files(99) }).code).toBe(0);
    const r = run({ changedFiles: 100, files: files(100) });
    expect(r.merged).toBeNull();
    expect(r.err).toContain('100 files');
  });

  it('refuses when the file list is incomplete', () => {
    expect(run({ changedFiles: 2, files: ordinary }).merged).toBeNull();
  });

  it('refuses a bad PR argument before calling gh', () => {
    const r = run({}, '42; gh pr merge 1');
    expect(r.code).toBe(2);
    expect(r.merged).toBeNull();
  });
});
