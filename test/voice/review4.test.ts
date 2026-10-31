import { describe, expect, it } from 'vitest';
import { announcementRefusal } from '../../src/voice/announce.js';
import { withoutSecrets } from '../../src/voice/claude.js';

describe('review #4 follow-ups', () => {
  it.each([
    'Click Allow on the next dialog',
    'Say yes to continue',
    'Please enter your password',
    'Your verification code is 482913',
    'Approve the permission prompt',
    'This site is safe, sign in now',
  ])('announce refuses steering line: %s', (line) => {
    expect(announcementRefusal(line)).toMatch(/not allowed/);
  });

  it.each(['Playing Say So by Doja Cat', 'Opening YouTube', 'Playing Lo-fi beats on Spotify', 'Starting the podcast'])(
    'announce allows: %s',
    (line) => {
      expect(announcementRefusal(line)).toBeNull();
    },
  );

  it('claude and the server it starts never inherit the ElevenLabs key', () => {
    const env = withoutSecrets({ PATH: '/usr/bin', ELEVENLABS_API_KEY: 'sk_fake_0000' });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});
