/** B5: other user accounts on a Mac, by count only (src/lib/other-users.ts). */
import { describe, expect, it } from 'vitest';
import { otherUserCount, sharedMacReason } from '../../src/lib/other-users.js';

const DSCL = ['_spotlight 89', 'daemon 1', 'nobody -2', 'root 0', 'Guest 201', 'me 501', 'alexandra 502', 'sam 503', '_hidden 600', ''].join('\n');
const list = (stdout: string, code: number | null = 0) => async () => ({ code, stdout });

describe('otherUserCount', () => {
  it('counts login accounts (uid 501 and up, no _ service accounts), not this one', async () => {
    expect(await otherUserCount('darwin', list(DSCL), 501)).toBe(2);
    expect(await otherUserCount('darwin', list('root 0\nme 501\n'), 501)).toBe(0);
  });
  it('a list that cannot be read is null (callers fail closed)', async () => {
    expect(await otherUserCount('darwin', list('', 1), 501)).toBeNull();
    expect(await otherUserCount('darwin', list('', null), 501)).toBeNull();
  });
  it('not macOS: 0, and dscl is never run', async () => {
    let ran = false;
    expect(await otherUserCount('linux', async () => ((ran = true), { code: 0, stdout: DSCL }), 501)).toBe(0);
    expect(ran).toBe(false);
  });
});

describe('sharedMacReason', () => {
  it('names a count and never an account name', () => {
    const r = sharedMacReason(2);
    expect(r).toContain('This Mac has 2 other user accounts');
    expect(r).toContain('Chrome');
    expect(r).not.toMatch(/alexandra|sam\b/);
    expect(sharedMacReason(1)).toContain('1 other user account,');
    expect(sharedMacReason(null)).toContain("couldn't check");
  });
});
