/** #202 A10: one never-throwing execFile, and the zen-launcher mapping on top of it. */
import { describe, expect, it } from 'vitest';
import { execNoThrow, firstLine } from '../../src/lib/process.js';
import { defaultRun } from '../../src/zen-launcher.js';

describe('execNoThrow', () => {
  it('gives exit code 0 and stdout on success', async () => {
    const r = await execNoThrow(process.execPath, ['-e', 'process.stdout.write("hi")'], 10_000);
    expect(r).toMatchObject({ code: 0, stdout: 'hi', error: null });
  });

  it('gives the numeric exit code and stderr on failure', async () => {
    const r = await execNoThrow(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'], 10_000);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('bad');
  });

  it('never rejects when the program is missing: code null, ENOENT', async () => {
    const r = await execNoThrow('/no/such/program-202', [], 10_000);
    expect(r.code).toBeNull();
    expect(r.error?.code).toBe('ENOENT');
  });
});

describe('firstLine', () => {
  it('returns the first non-blank line, skipping blank lines before it', () => {
    expect(firstLine('\n\n  boom\nmore\n')).toBe('boom');
    expect(firstLine('  \n  ')).toBe('');
    expect(firstLine('')).toBe('');
  });
});

describe('zen-launcher defaultRun', () => {
  it('reports a missing program as code 127 with the error message', async () => {
    const r = await defaultRun('/no/such/program-202', [], 10_000);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('ENOENT');
  });
});
