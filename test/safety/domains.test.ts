import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BLOCKED_DOMAINS,
  BUILTIN_SENSITIVE_DOMAINS,
  compilePatterns,
  findMatch,
  hostMatches,
  normalizeHost,
  parsePattern,
  parseUrl,
  registrableDomain,
  urlMatches,
} from '../../src/safety/domains.js';

const sensitive = compilePatterns(BUILTIN_SENSITIVE_DOMAINS);
const blocked = compilePatterns(BUILTIN_BLOCKED_DOMAINS);
const isSensitive = (url: string): boolean => {
  const u = parseUrl(url);
  return !!u && !!findMatch(u, sensitive);
};
const isBlocked = (url: string): boolean => {
  const u = parseUrl(url);
  return !!u && !!findMatch(u, blocked);
};

describe('normalizeHost', () => {
  it.each([
    ['MAIL.Google.COM', 'mail.google.com'],
    ['mail.google.com.', 'mail.google.com'],
    ['paypal.com..', 'paypal.com'],
    ['  example.org  ', 'example.org'],
    ['pаypal.com', 'xn--pypal-4ve.com'], // Cyrillic а
    ['bücher.de', 'xn--bcher-kva.de'],
    ['paypal。com', 'paypal.com'], // ideographic full stop maps to '.'
    ['', ''],
  ])('%s → %s', (input, out) => {
    expect(normalizeHost(input)).toBe(out);
  });
});

describe('registrableDomain', () => {
  it.each([
    ['mail.google.com', 'google.com'],
    ['google.com', 'google.com'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['co.uk', 'co.uk'],
    ['a.b.c.example.co.uk', 'example.co.uk'],
    ['www.cra-arc.gc.ca', 'cra-arc.gc.ca'],
    ['servicecanada.gc.ca', 'servicecanada.gc.ca'],
    ['shop.example.com.au', 'example.com.au'],
    ['alice.github.io', 'alice.github.io'],
    ['www.alice.github.io', 'alice.github.io'],
    ['MAIL.GOOGLE.COM.', 'google.com'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
  ])('%s → %s', (host, out) => {
    expect(registrableDomain(host)).toBe(out);
  });
});

describe('hostMatches', () => {
  it('domain pattern matches itself and subdomains', () => {
    expect(hostMatches('paypal.com', 'paypal.com')).toBe(true);
    expect(hostMatches('www.paypal.com', 'paypal.com')).toBe(true);
    expect(hostMatches('a.b.paypal.com', 'PayPal.com.')).toBe(true);
  });
  it('*.domain matches subdomains only', () => {
    expect(hostMatches('www.paypal.com', '*.paypal.com')).toBe(true);
    expect(hostMatches('paypal.com', '*.paypal.com')).toBe(false);
  });
  it('rejects lookalikes and suffix tricks', () => {
    expect(hostMatches('paypal.com.evil.com', 'paypal.com')).toBe(false);
    expect(hostMatches('evil-paypal.com', 'paypal.com')).toBe(false);
    expect(hostMatches('evilpaypal.com', 'paypal.com')).toBe(false);
    expect(hostMatches('xn--pypal-4ve.com', 'paypal.com')).toBe(false);
    expect(hostMatches('pаypal.com', 'paypal.com')).toBe(false); // raw homoglyph normalizes to punycode
  });
  it('normalizes the host side (trailing dot, case)', () => {
    expect(hostMatches('PAYPAL.COM.', 'paypal.com')).toBe(true);
    expect(hostMatches('Mail.Google.Com.', 'mail.google.com')).toBe(true);
  });
  it('ignores the path part of a pattern', () => {
    expect(hostMatches('github.com', 'github.com/settings')).toBe(true);
  });
  it('invalid patterns never match', () => {
    expect(parsePattern('')).toBeNull();
    expect(parsePattern('*')).toBeNull();
    expect(hostMatches('x.com', 'foo.*')).toBe(false);
  });
});

describe('path-aware patterns', () => {
  const gh = parsePattern('github.com/settings')!;
  it('matches path prefix on a segment boundary', () => {
    expect(urlMatches(parseUrl('https://github.com/settings')!, gh)).toBe(true);
    expect(urlMatches(parseUrl('https://github.com/settings/emails')!, gh)).toBe(true);
    expect(urlMatches(parseUrl('https://github.com/settings?tab=1')!, gh)).toBe(true);
    expect(urlMatches(parseUrl('https://github.com/SETTINGS/keys')!, gh)).toBe(true);
    expect(urlMatches(parseUrl('https://github.com/settingsfoo')!, gh)).toBe(false);
    expect(urlMatches(parseUrl('https://github.com/anthropics/settings')!, gh)).toBe(false);
  });
  it('sees through percent-encoding and doubled slashes', () => {
    expect(urlMatches(parseUrl('https://github.com/%73ettings/keys')!, gh)).toBe(true);
    expect(urlMatches(parseUrl('https://github.com//settings')!, gh)).toBe(true);
  });
  it('Gmail settings hash with a wildcard segment', () => {
    expect(isSensitive('https://mail.google.com/mail/u/0/#settings/fwdandpop')).toBe(true);
    expect(isSensitive('https://mail.google.com/mail/u/1/#settings')).toBe(true);
    expect(isSensitive('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(isSensitive('https://mail.google.com/mail/u/0/#search/settings')).toBe(false);
  });
  it('Keeper vault path is blocked but the marketing site is not', () => {
    expect(isBlocked('https://keepersecurity.com/vault/#')).toBe(true);
    expect(isBlocked('https://keepersecurity.com/pricing')).toBe(false);
  });
});

describe('built-in lists', () => {
  it.each([
    'https://my.1password.com/vaults',
    'https://start.1password.ca/',
    'https://lastpass.com/vault',
    'https://www.lastpass.com/',
    'https://vault.bitwarden.com/#/vault',
    'https://vault.bitwarden.eu/',
    'https://pass.proton.me/',
    'https://passwords.google.com/',
    'https://app.dashlane.com/',
  ])('blocked: %s', (url) => {
    expect(isBlocked(url)).toBe(true);
  });

  it.each(['https://bitwarden.com/', 'https://proton.me/mail', 'https://google.com/', 'https://dashlane.com/'])(
    'not blocked: %s',
    (url) => {
      expect(isBlocked(url)).toBe(false);
    },
  );

  it.each([
    'https://www.paypal.com/myaccount',
    'https://PAYPAL.COM./signin',
    'https://dashboard.stripe.com/payments',
    'https://secure.chase.com/',
    'https://www1.royalbank.rbcroyalbank.com/',
    'https://easyweb.td.com/',
    'https://my.wealthsimple.com/',
    'https://www.canada.ca/en/revenue-agency.html',
    'https://www.cra-arc.gc.ca/',
    'https://www.tax.service.gov.uk/',
    'https://accounts.google.com/signin',
    'https://myaccount.google.com/security',
    'https://appleid.apple.com/',
    'https://github.com/settings/tokens',
    'https://example.bank/',
  ])('sensitive: %s', (url) => {
    expect(isSensitive(url)).toBe(true);
  });

  it.each([
    'https://paypal.com.evil.com/',
    'https://evil-paypal.com/',
    'https://xn--pypal-4ve.com/',
    'https://pаypal.com/', // Cyrillic а → punycode, not paypal
    'https://stripe.com/docs',
    'https://github.com/anthropics/claude-code',
    'https://mail.google.com/mail/u/0/#inbox',
    'https://example.com/?u=paypal.com',
    'https://paypal.com@evil.com/',
  ])('not sensitive: %s', (url) => {
    expect(isSensitive(url)).toBe(false);
  });
});

describe('parseUrl', () => {
  it('classifies blob: by its inner URL', () => {
    const u = parseUrl('blob:https://www.paypal.com/123')!;
    expect(u.isWeb).toBe(true);
    expect(u.host).toBe('www.paypal.com');
  });
  it('non-web schemes have no host', () => {
    expect(parseUrl('chrome://settings')!.isWeb).toBe(false);
    expect(parseUrl('about:blank')!.host).toBe('');
  });
  it('unparsable → null', () => {
    expect(parseUrl('not a url')).toBeNull();
    expect(parseUrl('example.com')).toBeNull();
  });
});
