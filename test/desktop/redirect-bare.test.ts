import { describe, expect, it } from 'vitest';
import { redirectSignals } from '../../src/desktop/url.js';

describe('review #3 verification #5: redirect targets without a scheme', () => {
  it.each([
    'https://attacker.example/go?u=//chase.com/',
    'https://attacker.example/go?u=chase.com',
    'https://attacker.example/go?next=www.chase.com/login',
    'https://attacker.example/go?u=%2F%2Fvault.bitwarden.com%2F',
    'https://attacker.example/go#to=chase.com',
  ])('%s asks', (url) => {
    expect(redirectSignals(url).length).toBeGreaterThan(0);
  });

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.google.com/search?q=weather+toronto',
    'https://example.com/?page=2&sort=new',
    'https://example.com/?ref=newsletter',
  ])('%s does not', (url) => {
    expect(redirectSignals(url)).toEqual([]);
  });
});
