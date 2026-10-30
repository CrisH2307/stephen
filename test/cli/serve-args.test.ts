import { describe, expect, it } from 'vitest';
import { parseServeArgs } from '../../src/serve-args.js';

describe('serve --confirm (voice listener forces the macOS dialog)', () => {
  it('accepts only the strict values', () => {
    expect(parseServeArgs([])).toEqual({});
    expect(parseServeArgs(['--confirm', 'dialog'])).toEqual({ confirm: 'dialog' });
    expect(parseServeArgs(['--confirm=deny'])).toEqual({ confirm: 'deny' });
  });
  it('never lets a flag weaken confirmation', () => {
    for (const bad of [['--confirm', 'auto'], ['--confirm', 'elicit'], ['--confirm', 'none'], ['--confirm'], ['--yolo']]) {
      expect('error' in parseServeArgs(bad), bad.join(' ')).toBe(true);
    }
  });
});
