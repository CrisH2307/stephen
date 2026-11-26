/** F14: release notes for one version from CHANGELOG.md, plain text for friends (scripts/release-notes.mjs). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { plain, releaseNotes } from '../../scripts/release-notes.mjs';

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

  it('plain() drops images, keeps link words, strips code and bold marks', () => {
    expect(plain('![x](a.png) see [the guide](https://e.x) and `code` **now**')).toBe('see the guide and code now');
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
  });
});
