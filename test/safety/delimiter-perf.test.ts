/**
 * T2: the untrusted-tag check must run in linear time. A page can send a huge whitespace run after "<"; the old
 * pattern retried every split of that run, so 200,000 spaces took about 14 seconds. The bound is generous for CI:
 * linear code takes a few ms, quadratic code takes seconds.
 */
import { describe, expect, it } from 'vitest';
import { escapeUntrustedTags } from '../../src/safety/text.js';

const BOUND_MS = 200;

function timed(s: string): { ms: number; out: string } {
  const t = performance.now();
  const out = escapeUntrustedTags(s);
  return { ms: performance.now() - t, out };
}

describe('T2: escapeUntrustedTags runs in linear time', () => {
  it.each([
    ['200,000 spaces after "<"', '<' + ' '.repeat(200_000)],
    ['100,000 "< " pairs', '< '.repeat(100_000)],
    ['200,000 invisible characters after "<"', '<' + '​'.repeat(200_000)],
    ['200,000 slashes after "<"', '<' + '/'.repeat(200_000)],
    ['spaces, a slash, then spaces', '<' + ' '.repeat(100_000) + '/' + ' '.repeat(100_000)],
  ])('%s stays under the bound and is left alone', (_name, s) => {
    const { ms, out } = timed(s);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out).toBe(s);
  });

  it('a real tag after a long whitespace run is still escaped', () => {
    const s = '<' + ' '.repeat(100_000) + '/' + ' '.repeat(100_000) + 'untrusted_web_content>';
    const { ms, out } = timed(s);
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.startsWith('&lt;')).toBe(true);
  });
});
