/** F14: release notes for one version from CHANGELOG.md, plain text for friends (scripts/release-notes.mjs). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { plain, releaseNotes, secretHits, sheet, testTotals } from '../../scripts/release-notes.mjs';

const ROOT = resolve(__dirname, '../..');
const SAMPLE = `# Changelog

## Unreleased

## 0.2.0 (2026-12-03)

### Added
- **Report a problem** in the menu bar: copies the report and opens [GitHub's form](https://github.com/x/y/issues/new/choose).
- \`stephen data export\` moves your memory
  and timers to a new Mac.

### Fixed
* A failed job says why in plain words.

## 0.1.9 (2026-11-26)

### Fixed
- Older fix.
`;

describe('release notes (F14)', () => {
  it('one version, plain words: headings named for people, no Markdown, wrapped bullets joined, the next version left out', () => {
    expect(releaseNotes(SAMPLE, '0.2.0')).toBe(
      [
        'Stephen 0.2.0 (2026-12-03)',
        '',
        'New:',
        "- Report a problem in the menu bar: copies the report and opens GitHub's form.",
        '- stephen data export moves your memory and timers to a new Mac.',
        '',
        'Fixed:',
        '- A failed job says why in plain words.',
      ].join('\n'),
    );
  });

  it('a version that is missing or empty gives null; 0.1 never matches 0.1.9', () => {
    expect(releaseNotes(SAMPLE, '0.3.0')).toBeNull();
    expect(releaseNotes(SAMPLE, 'Unreleased')).toBeNull();
    expect(releaseNotes(SAMPLE, '0.1')).toBeNull();
    expect(releaseNotes(SAMPLE, '0.1.9')).toContain('- Older fix.');
  });

  it('plain() drops images, keeps link words, strips code, bold and italic marks, and keeps snake_case and 2*3*4', () => {
    expect(plain('![x](a.png) see [the guide](https://e.x) and `code` **now**')).toBe('see the guide and code now');
    expect(plain('*really* fast, _very_ calm, a snake_case_name, 2*3*4')).toBe('really fast, very calm, a snake_case_name, 2*3*4');
  });

  it('a heading with no bullets is left out (no label alone)', () => {
    const md = '## 1.0.0 (2026-12-10)\n\n### Added\n\n### Fixed\n- One fix.\n';
    expect(releaseNotes(md, '1.0.0')).toBe('Stephen 1.0.0 (2026-12-10)\n\nFixed:\n- One fix.');
  });

  it('the CLI prints the notes, and fails with a plain reason when the version is missing', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'notes-')), 'CHANGELOG.md');
    writeFileSync(f, SAMPLE);
    const ok = spawnSync(process.execPath, [join(ROOT, 'scripts/release-notes.mjs'), '0.2.0', f], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^Stephen 0\.2\.0/);
    const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/release-notes.mjs'), '9.9.9', f], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('has no notes for 9.9.9');
    const none = spawnSync(process.execPath, [join(ROOT, 'scripts/release-notes.mjs')], { encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('Usage:');
  });
});

describe('release number sheet (--sheet, checklist steps 4 and 9)', () => {
  const SHA = 'a'.repeat(40);
  const fake = (over: Record<string, { code: number; out: string }> = {}) => (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (over[key]) return over[key];
    if (key.startsWith('git rev-parse')) return { code: 0, out: `${SHA}\n` };
    if (key === 'npx vitest run') return { code: 0, out: '\x1b[2m Tests \x1b[22m 4566 passed | 6 skipped | 3 todo (4575)\n' };
    if (key.includes('--name-only')) return { code: 0, out: 'a.ts\nb.ts\n' };
    return { code: 0, out: '' };
  };

  it('prints one stable block when all is green', () => {
    const { ok, text } = sheet(fake());
    expect(ok).toBe(true);
    expect(text).toBe(
      [
        'Release number sheet (checklist steps 4 and 9)',
        `Commit: ${SHA} (same as origin/qa)`,
        'Build: pass',
        'Typecheck: pass',
        'Tests: 4566 passed, 0 failed, 6 skipped',
        'Files changed origin/main..origin/qa: 2',
        'Secrets scan: clean',
        'Result: ready for the Mac steps',
      ].join('\n'),
    );
  });

  it('is not ready on a failed test, a failed build, a missing totals line or a commit that is not qa', () => {
    expect(sheet(fake({ 'npx vitest run': { code: 1, out: ' Tests  2 failed | 10 passed (12)\n' } })).ok).toBe(false);
    expect(sheet(fake({ 'npm run build': { code: 1, out: '' } })).text).toContain('Build: FAIL');
    expect(sheet(fake({ 'npx vitest run': { code: 1, out: 'crash' } })).text).toContain('Tests: FAIL (no totals line)');
    const other = sheet(fake({ 'git rev-parse HEAD': { code: 0, out: 'b'.repeat(40) } }));
    expect(other.ok).toBe(false);
    expect(other.text).toContain('NOT origin/qa');
  });

  it('is not ready when the fetch fails, and fetches before reading any ref', () => {
    const r = sheet(fake({ 'git fetch origin main qa': { code: 1, out: 'fatal: unable to access' } }));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Fetch origin: FAIL');
    const calls: string[] = [];
    const f = fake();
    sheet((cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(' ')}`), f(cmd, args)));
    expect(calls[0]).toBe('git fetch origin main qa');
  });

  it('is not ready when either git diff fails, and never says the scan is clean', () => {
    const bad = { code: 128, out: "fatal: ambiguous argument 'origin/main..origin/qa'\n" };
    const NAMES = 'git diff --name-only origin/main..origin/qa';
    const DIFF = 'git -c core.quotePath=false diff -U0 --no-renames origin/main..origin/qa';
    const both = sheet(fake({ [NAMES]: bad, [DIFF]: bad }));
    expect(both.ok).toBe(false);
    expect(both.text).toContain('Secrets scan: FAIL (git diff failed)');
    expect(both.text).not.toContain('clean');
    expect(both.text).toContain('Result: NOT ready');
    const scan = sheet(fake({ [DIFF]: bad }));
    expect(scan.ok).toBe(false);
    expect(scan.text).toContain('Secrets scan: FAIL (git diff failed)');
    const names = sheet(fake({ [NAMES]: bad }));
    expect(names.ok).toBe(false);
    expect(names.text).toContain('Files changed origin/main..origin/qa: FAIL (git diff failed)');
  });

  it('is not ready when git rev-parse fails, even with the same fatal line twice', () => {
    const bad = { code: 128, out: 'fatal: not a git repository\n' };
    const r = sheet(fake({ 'git rev-parse HEAD': bad, 'git rev-parse origin/qa': bad }));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Commit: FAIL');
    expect(r.text).not.toContain('same as origin/qa');
  });

  it('names the file and line of a secret shape, never the secret, and flags .env files', () => {
    const key = `sk-${'x'.repeat(24)}`;
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '+++ b/a.ts',
      '@@ -0,0 +1,3 @@',
      '+ok',
      '++++ b/fake-header.ts',
      `+const k = '${key}';`,
      'diff --git a/.env b/.env',
      '+++ b/.env',
      '@@ -0,0 +1 @@',
      '+X=1',
      'diff --git a/.env.example b/.env.example',
      '+++ b/.env.example',
    ].join('\n');
    expect(secretHits(diff)).toEqual(['a.ts:3', '.env (env file)']);
    const text = sheet(fake({ 'git -c core.quotePath=false diff -U0 --no-renames origin/main..origin/qa': { code: 0, out: diff } })).text;
    expect(text).toContain('Secrets scan: FAIL, check a.ts:3, .env (env file)');
    expect(text).not.toContain(key);
  });

  it('keeps hits under the right file for a path with a space or a non-ASCII letter', () => {
    const key = `sk-${'y'.repeat(24)}`;
    const diff = [
      'diff --git a/my notes.md b/my notes.md',
      '+++ b/my notes.md\t',
      '@@ -0,0 +1 @@',
      `+${key}`,
      'diff --git a/caf\u00e9.md b/caf\u00e9.md',
      '+++ b/caf\u00e9.md',
      '@@ -0,0 +1,2 @@',
      '+ok',
      `+${key}`,
    ].join('\n');
    expect(secretHits(diff)).toEqual(['my notes.md:1', 'caf\u00e9.md:2']);
  });

  it('finds Stripe live keys and Google API keys', () => {
    const one = (text: string) => secretHits(`+++ b/k.ts\n@@ -0,0 +1 @@\n+${text}`);
    expect(one(`sk_live_${'a'.repeat(24)}`)).toEqual(['k.ts:1']);
    expect(one(`rk_live_${'b'.repeat(24)}`)).toEqual(['k.ts:1']);
    expect(one(`AIza${'c'.repeat(35)}`)).toEqual(['k.ts:1']);
    expect(one('sk_test_short and AIza too short')).toEqual([]);
  });

  it('reads vitest totals with or without colors, from the last Tests line', () => {
    expect(testTotals('      Tests  1 failed | 9 passed | 2 skipped (12)')).toEqual({ found: true, passed: 9, failed: 1, skipped: 2 });
    expect(testTotals('Tests for the parser: 3 passed earlier\n      Tests  4 passed (4)').passed).toBe(4);
    expect(testTotals('nothing').found).toBe(false);
  });
});
