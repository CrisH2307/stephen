/** B9: a PR touching a safety path needs [DEV REVIEW] in its title (scripts/safety-paths.mjs, safety-paths.yml). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { SAFETY_PATHS, safetyFiles, safetyProblem } from '../../scripts/safety-paths.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

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
    expect(safetyProblem('docs: x', ['docs/README.md', 'src/jobs/cli.ts'])).toBeNull();
  });

  it('folders match by prefix, files only exactly', () => {
    expect(safetyFiles(['src/safety/text.ts', 'src/safetyish.ts', 'src/memory/store.ts', 'src/memory/store.ts.bak', '.github/workflows/new.yml'])).toEqual([
      'src/safety/text.ts',
      'src/memory/store.ts',
      '.github/workflows/new.yml',
    ]);
  });

  it('every listed path exists, so a rename cannot drop a file from the check', () => {
    expect((SAFETY_PATHS as string[]).filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  it('the workflow runs the script on title edits too, and the title comes in through env: only', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/safety-paths.yml'), 'utf8');
    expect(wf).toMatch(/types: \[opened, synchronize, reopened, edited\]/);
    expect(wf).toContain('TITLE: ${{ github.event.pull_request.title }}');
    expect(wf).toContain('run: node scripts/safety-paths.mjs');
    expect(wf).not.toMatch(/^\s*pull_request_target:/m);
  });
});
