import { describe, expect, it } from 'vitest';
import { parseServeArgs } from '../../src/serve-args.js';

describe('serve --confirm (voice listener forces the macOS dialog)', () => {
  it('accepts only the strict values', () => {
    expect(parseServeArgs([])).toEqual({});
    expect(parseServeArgs(['--confirm', 'dialog'])).toEqual({ confirm: 'dialog' });
    expect(parseServeArgs(['--confirm=deny'])).toEqual({ confirm: 'deny' });
  });
  it('R9-2: accepts "app" (Ask box, then the dialog: still a human click)', () => {
    expect(parseServeArgs(['--confirm', 'app'])).toEqual({ confirm: 'app' });
  });
  it('never lets a flag weaken confirmation', () => {
    for (const bad of [['--confirm', 'auto'], ['--confirm', 'elicit'], ['--confirm', 'none'], ['--confirm'], ['--yolo']]) {
      expect('error' in parseServeArgs(bad), bad.join(' ')).toBe(true);
    }
  });
});

describe('serve --trust wake (review 7, R7-2: a wake-word conversation)', () => {
  it('R7-2: only "wake" is accepted, once; it goes with the voice flags and with --dry-run', () => {
    expect(parseServeArgs(['--trust', 'wake'])).toEqual({ trust: 'wake' });
    expect(parseServeArgs(['--trust=wake'])).toEqual({ trust: 'wake' });
    expect(parseServeArgs(['--confirm', 'dialog', '--voice', '--trust', 'wake'])).toEqual({ confirm: 'dialog', voice: true, trust: 'wake' });
    expect(parseServeArgs(['--dry-run', '--record', '/tmp/r.jsonl', '--trust', 'wake'])).toEqual({ trust: 'wake', dryRun: { record: '/tmp/r.jsonl' } });
    for (const bad of [['--trust'], ['--trust', 'trusted'], ['--trust', 'full'], ['--trust', 'WAKE'], ['--trust=']]) {
      expect(parseServeArgs(bad), bad.join(' ')).toEqual({ error: '--trust must be "wake"' });
    }
    expect(parseServeArgs(['--trust', 'wake', '--trust', 'wake'])).toEqual({ error: '--trust given twice' });
  });
});
