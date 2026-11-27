/** B9: a PR touching a safety path needs [DEV REVIEW] in its title (scripts/safety-paths.mjs, safety-paths.yml). */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { SAFETY_PATHS, safetyFiles, safetyProblem } from '../../scripts/safety-paths.mjs';
import { SAFETY_PATHS as LADDER_PATHS } from '../../src/telemetry/incident-ladder.js';

const ROOT = join(import.meta.dirname, '..', '..');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

describe('safety paths check', () => {
  it('a safety file without the tag fails and names the file; with the tag it passes', () => {
    const p = safetyProblem('jobs: tidy', ['README.md', 'src/safety/gate.ts']);
    expect(p).toContain('[DEV REVIEW]');
    expect(p).toContain('  src/safety/gate.ts');
    expect(p).not.toContain('README.md');
    expect(safetyProblem('[DEV REVIEW] jobs: tidy', ['src/safety/gate.ts'])).toBeNull();
    expect(safetyProblem('NEEDS_CRIS_REVIEW | [DEV REVIEW] ci: x', ['.github/workflows/ci.yml'])).toBeNull();
  });

  it('no safety file: passes without the tag', () => {
    expect(safetyProblem('docs: x', ['docs/README.md', 'src/voice/claude.ts'])).toBeNull();
  });

  it('folders match by prefix, files only exactly', () => {
    expect(safetyFiles(['src/safety/text.ts', 'src/safetyish.ts', 'src/lib/fs.ts', 'src/lib/fs.ts.bak', '.github/workflows/new.yml'])).toEqual([
      'src/safety/text.ts',
      'src/lib/fs.ts',
      '.github/workflows/new.yml',
    ]);
  });

  it.each([
    'src/memory/cli.ts',
    'src/memory/config.ts',
    'src/timers/notify.ts',
    'src/jobs/cli.ts',
    'src/jobs/config.ts',
    'src/jobs/finish.ts',
    'src/lib/owner-only.ts',
    'helper/AskBox.swift',
    'helper/Components/ChatThread.swift',
    'package.json',
  ])('%s is a safety path (whole memory, timer and job folders; Allow and Deny views; the owner-only check)', (f) => {
    expect(safetyFiles([f])).toEqual([f]);
  });

  it('the script is the one list: AGENT-LOOP.md points to it and names no path of its own', () => {
    const doc = readFileSync(join(ROOT, 'docs/AGENT-LOOP.md'), 'utf8');
    const section = doc.split('## Always Claude-only')[1]?.split('\n## ')[0] ?? '';
    expect(section).toContain('scripts/safety-paths.mjs');
    expect(section.match(/`(src|helper|\.github|docs)\/[^`]*`/g) ?? []).toEqual([]);
  });

  it('the incident ladder list is the same list as the script', () => {
    expect([...LADDER_PATHS]).toEqual(SAFETY_PATHS);
  });

  it.each(['src/app/data-export.ts', 'src/app/data-cli.ts'])('%s is a safety path (import writes memory, timers, config)', (f) => {
    expect(safetyFiles([f])).toEqual([f]);
  });

  it('every listed path exists, so a rename cannot drop a file from the check', () => {
    expect((SAFETY_PATHS as string[]).filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  it.each([
    ['moved out of src/safety/ (#386 review)', (d: string) => (mkdirSync(join(d, 'src/other'), { recursive: true }), git(d, 'mv', 'src/safety/gate.ts', 'src/other/gate.ts'))],
    ['deleted', (d: string) => git(d, 'rm', '-q', 'src/safety/gate.ts')],
  ])('end to end: a safety file %s without the tag fails', (_name, change) => {
    const d = mkdtempSync(join(tmpdir(), 'safety-paths-'));
    try {
      git(d, 'init', '-q');
      mkdirSync(join(d, 'src/safety'), { recursive: true });
      writeFileSync(join(d, 'src/safety/gate.ts'), 'export const gate = 1;\n'.repeat(20));
      git(d, 'add', '.');
      git(d, 'commit', '-qm', 'base');
      const base = git(d, 'rev-parse', 'HEAD').trim();
      change(d);
      git(d, 'commit', '-qm', 'change');
      const run = (title: string) => spawnSync(process.execPath, [join(ROOT, 'scripts/safety-paths.mjs')], { cwd: d, env: { PATH: process.env.PATH, TITLE: title, BASE: base }, encoding: 'utf8' });
      const bad = run('cleanup');
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('  src/safety/gate.ts');
      expect(run('[DEV REVIEW] cleanup').status).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('the workflow runs the script on title edits too, and the title comes in through env: only', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/safety-paths.yml'), 'utf8');
    expect(wf).toMatch(/types: \[opened, synchronize, reopened, edited\]/);
    expect(wf).toContain('TITLE: ${{ github.event.pull_request.title }}');
    expect(wf).toContain('run: node scripts/safety-paths.mjs');
    expect(wf).not.toMatch(/^\s*pull_request_target:/m);
  });
});
