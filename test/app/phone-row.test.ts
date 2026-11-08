import { describe, expect, it } from 'vitest';
import { phoneAccountRow } from '../../src/app/accounts-status.js';

describe('Accounts tab: the phone link row', () => {
  it('on / off / not signed in, with the sign-in date and the next step; never a secret', () => {
    expect(phoneAccountRow({ on: true, loggedIn: true, expiresAt: '2026-12-01T00:00:00Z' })).toEqual({
      id: 'phone', name: 'Phone link', state: 'connected', source: null, detail: 'On · Signed in until 2026-12-01',
      hint: 'Turn it on with: stephen phone on (Ctrl-C or stephen phone off ends it)',
    });
    expect(phoneAccountRow({ on: false, loggedIn: true, expiresAt: null })).toMatchObject({ state: 'off', detail: 'Off · Signed in' });
    expect(phoneAccountRow({ on: false, loggedIn: false, expiresAt: null })).toMatchObject({ state: 'not_set', detail: 'Off · Not signed in', hint: expect.stringMatching(/stephen phone login/) });
  });
});
