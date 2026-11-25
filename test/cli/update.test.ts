/** `stephen update`: order, dirty tree refused, non-fast-forward refused, helper message. Nothing real runs. */
import { describe, expect, it } from 'vitest';
import { runUpdate, type RunResult } from '../../src/update.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

function harness(over: Record<string, RunResult | RunResult[]> = {}, versions = ['0.1.0', '0.1.1']) {
  const calls: string[] = [];
  const out: string[] = [];
  const heads = ['aaa1111', 'bbb2222'];
  let headReads = 0;
  const vers = [...versions];
  const deps = {
    cliPath: '/s/dist/cli.js',
    version: () => vers.shift() ?? versions.at(-1)!,
    log: (l: string) => out.push(l),
    run: async (cmd: string, args: string[]) => {
      const k = cmd.endsWith('node') || cmd.includes('/node') ? `node ${args.slice(1).join(' ')}` : `${cmd} ${args.join(' ')}`;
      calls.push(k);
      if (k in over) {
        const v = over[k]!;
        return Array.isArray(v) ? v.shift()! : v;
      }
      if (k === 'git rev-parse --short HEAD') return ok(heads[Math.min(headReads++, 1)]);
      if (k === 'git rev-parse --abbrev-ref HEAD') return ok('main');
      return ok();
    },
  };
  return { deps, calls, text: () => out.join('\n') };
}

describe('stephen update', () => {
  it('runs pull, install, build, helper in order and prints both versions and the way back', async () => {
    const h = harness();
    expect(await runUpdate(h.deps)).toBe(0);
    expect(h.calls).toEqual([
      'git rev-parse --short HEAD',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain --untracked-files=no',
      'git pull --ff-only',
      'git rev-parse --short HEAD',
      'npm install',
      'npm run build',
      'node install-helper',
    ]);
    const t = h.text();
    expect(t).toContain('Stephen 0.1.0 (aaa1111) to 0.1.1 (bbb2222)');
    expect(t).toContain('git checkout aaa1111');
    expect(t).toContain('Going back');
    expect(t).toContain('git checkout main');
  });

  it('refuses a dirty tree and runs nothing after the status check', async () => {
    const h = harness({ 'git status --porcelain --untracked-files=no': ok(' M src/cli.ts\n') });
    expect(await runUpdate(h.deps)).toBe(1);
    expect(h.calls).not.toContain('git pull --ff-only');
    expect(h.text()).toContain('You changed files');
  });

  it('refuses a detached HEAD and a folder that is not a git checkout', async () => {
    const det = harness({ 'git rev-parse --abbrev-ref HEAD': ok('HEAD') });
    expect(await runUpdate(det.deps)).toBe(1);
    expect(det.calls).not.toContain('git pull --ff-only');
    const nogit = harness({ 'git rev-parse --short HEAD': fail('fatal: not a git repository') });
    expect(await runUpdate(nogit.deps)).toBe(1);
    expect(nogit.calls).toEqual(['git rev-parse --short HEAD']);
  });

  it('a non-fast-forward pull stops, changes nothing, and never resets', async () => {
    const h = harness({ 'git pull --ff-only': fail('fatal: Not possible to fast-forward, aborting.') });
    expect(await runUpdate(h.deps)).toBe(1);
    expect(h.calls).not.toContain('npm install');
    expect(h.calls.some((c) => /reset|checkout|--force|-f\b/.test(c))).toBe(false);
    expect(h.text()).toContain('Not possible to fast-forward');
  });

  it('already up to date: stops after the pull with exit 0', async () => {
    const h = harness({ 'git rev-parse --short HEAD': [ok('aaa1111'), ok('aaa1111')] });
    expect(await runUpdate(h.deps)).toBe(0);
    expect(h.calls).not.toContain('npm install');
    expect(h.text()).toContain('Already up to date');
  });

  it('stops at the first failing step and names the commit to go back to', async () => {
    const bi = harness({ 'npm install': fail('ERESOLVE') });
    expect(await runUpdate(bi.deps)).toBe(1);
    expect(bi.calls).not.toContain('npm run build');
    expect(bi.text()).toContain('git checkout aaa1111');

    const bb = harness({ 'npm run build': fail('TS2322') });
    expect(await runUpdate(bb.deps)).toBe(1);
    expect(bb.calls.some((c) => c.startsWith('node'))).toBe(false);

    const bh = harness({ 'node install-helper': fail('swiftc failed') });
    expect(await runUpdate(bh.deps)).toBe(1);
    expect(bh.text()).toContain('git checkout aaa1111');
  });

  it('helper rebuilt: says Input Monitoring must be clicked again', async () => {
    const h = harness({ 'node install-helper': ok('Built Stephen Helper.app') });
    await runUpdate(h.deps);
    expect(h.text()).toContain('The helper was rebuilt');
    expect(h.text()).toContain('Input Monitoring');
  });

  it('helper unchanged ("Nothing changed"): says permissions are kept', async () => {
    const h = harness({ 'node install-helper': ok('Nothing changed, so the build was skipped.') });
    await runUpdate(h.deps);
    expect(h.text()).toContain('permissions are kept');
    expect(h.text()).not.toContain('The helper was rebuilt');
  });
});
