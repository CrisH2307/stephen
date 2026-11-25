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

const green = [{ name: 'linux', conclusion: 'SUCCESS' }, { name: 'macos', conclusion: 'SUCCESS' }];
const approve = { author: { login: 'CrisH2307' }, body: `**Independent review: approve.** Reviewed ${SHA.slice(0, 7)}.` };

function run(pr: Record<string, unknown>, arg = '42') {
  const dir = mkdtempSync(join(tmpdir(), 'merge-to-qa-'));
  dirs.push(dir);
  const view = { baseRefName: 'qa', state: 'OPEN', title: 'fix: thing', headRefOid: SHA, statusCheckRollup: green, comments: [], labels: [{ name: 'merge-ready' }], ...pr };
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

describe('scripts/merge-to-qa.sh', () => {
  it('merges a green PR to qa, pinned to the head commit', () => {
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
    expect(run({ statusCheckRollup: [green[0], { name: 'macos', conclusion: 'FAILURE' }] }).merged).toBeNull();
    expect(run({ statusCheckRollup: [...green, { name: 'macos', conclusion: '' }] }).merged).toBeNull();
  });

  it('refuses a [DEV REVIEW] PR without the approve comment from CrisH2307', () => {
    const title = '[DEV REVIEW] voice: thing';
    expect(run({ title }).merged).toBeNull();
    expect(run({ title, comments: [{ author: { login: 'someone' }, body: approve.body }] }).merged).toBeNull();
    expect(run({ title, comments: [{ author: { login: 'CrisH2307' }, body: 'I said **Independent review: approve.**' }] }).merged).toBeNull();
    expect(run({ title, comments: [{ author: { login: 'CrisH2307' }, body: '**Independent review: approve.** Reviewed 1234567.' }] }).merged).toBeNull();
    expect(run({ title, comments: [approve] }).code).toBe(0);
  });

  it('refuses a bad PR argument before calling gh', () => {
    const r = run({}, '42; gh pr merge 1');
    expect(r.code).toBe(2);
    expect(r.merged).toBeNull();
  });
});
