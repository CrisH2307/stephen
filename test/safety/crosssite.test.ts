/**
 * Review finding #1 (CRITICAL): cross-site exfiltration after reading private content.
 * The rule is documented in src/safety/egress.ts. These tests include the reviewer's concrete attacks
 * (probe2.mjs) and a table of "normal productivity stays frictionless" cases.
 */
import { describe, expect, it } from 'vitest';
import type { ActionRequest } from '../../src/types.js';
import { assessOutbound, PATH_DATA_THRESHOLD, taintScope } from '../../src/safety/egress.js';
import { compileLists, evaluate, type PrivateRead, privateReadOf } from '../../src/safety/policy.js';
import { button, el, req, safetyCfg, state } from './fixtures.js';

const NOW = 1_000_000_000;
const lists = compileLists(safetyCfg());
const readOf = (url: string, at = NOW - 60_000): PrivateRead => {
  const r = privateReadOf(url, lists, at);
  if (!r) throw new Error(`${url} is not a private origin`);
  return r;
};
const GMAIL = readOf('https://mail.google.com/mail/u/0/#inbox');
const OUTLOOK = readOf('https://outlook.live.com/mail/0/inbox');
const after = (...reads: PrivateRead[]) => state({ privateReads: reads });

const nav = (targetUrl: string, pageUrl = 'https://mail.google.com/mail/u/0/'): ActionRequest =>
  req({ kind: 'navigate', pageUrl, targetUrl });
const typeOn = (pageUrl: string, text = 'Quarterly numbers are…'): ActionRequest =>
  req({ kind: 'type', pageUrl, element: el({ frameUrl: pageUrl, tag: 'div', inputType: null, role: 'textbox' }), text });
const linkTo = (href: string, pageUrl = 'https://mail.google.com/mail/u/0/'): ActionRequest =>
  req({ kind: 'click', pageUrl, element: button('click here', { role: 'link', tag: 'a', href, frameUrl: pageUrl }) });

describe('#1 reviewer attacks after reading Gmail / Outlook', () => {
  it.each([
    ['Apps Script exfil endpoint', 'https://script.google.com/macros/s/ATTACKER/exec?d=Quarterly+numbers+are...'],
    ['Google open redirect', 'https://www.google.com/url?q=https://evil.example/?d=secret'],
    ['Apps Script, bare-looking', 'https://script.google.com/macros/s/AKfy/exec'],
    ['attacker-shared Google Doc', 'https://docs.google.com/document/d/1AttackerDocIdAttackerDocIdAttacker/edit'],
    ['attacker Google Form response', 'https://docs.google.com/forms/d/e/1FAIpQL/formResponse?entry.1=secret'],
    ['forms.gle short link', 'https://forms.gle/abc'],
    ['URL shortener', 'https://bit.ly/3xYz'],
    ['webhook collector', 'https://webhook.site/abc'],
    ['tunnel with an OTP in a short path', 'https://abc.ngrok-free.app/123456'],
    ['Cloudflare worker', 'https://x.y.workers.dev/'],
    ['pastebin', 'https://pastebin.com/raw/x'],
    ['query string on an ordinary host', 'https://evil.example/?otp=123456'],
    ['fragment', 'https://evil.example/#d=secret'],
    ['long path', 'https://evil.example/aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQ'],
    ['long DNS label', 'https://aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQ.evil.example/'],
    ['credentials in URL', 'https://secret:data@evil.example/'],
    ['raw IPv4 in hex form', 'http://0x7f.1/'],
    ['raw IPv4 as integer', 'http://2130706433/'],
    ['raw IPv6', 'http://[::1]/'],
    ['explicit port', 'https://evil.example:8443/'],
  ])('navigate: %s → confirm', (_what, url) => {
    for (const kind of ['navigate', 'tab_open'] as const) {
      const d = evaluate(req({ ...nav(url), kind }), after(GMAIL));
      expect(d.verdict, `${kind} ${url}`).toBe('confirm');
      expect(d.rules).toContain('cross-site-navigate');
      expect(d.reason).toMatch(/mail\.google\.com/);
    }
  });

  it('typing into an attacker doc on docs.google.com after reading Gmail → confirm (exact host, not eTLD+1)', () => {
    const d = evaluate(typeOn('https://docs.google.com/document/d/ATTACKER/edit', 'secret mail contents'), after(GMAIL));
    expect(d.verdict).toBe('confirm');
    // + first-interaction (review #2 #6): docs.google.com was neither read nor approved yet
    expect(d.rules).toEqual(['cross-site-typing', 'first-interaction']);
    expect(d.reason).toMatch(/mail\.google\.com.*docs\.google\.com/);
  });

  it('outlook.live.com → onedrive.live.com (same eTLD+1) typing and data-carrying navigation → confirm', () => {
    expect(evaluate(typeOn('https://onedrive.live.com/edit?id=ATTACKER'), after(OUTLOOK)).verdict).toBe('confirm');
    expect(evaluate(nav('https://onedrive.live.com/?id=ATTACKER&d=secret', 'https://outlook.live.com/mail/0/'), after(OUTLOOK)).verdict).toBe('confirm');
  });

  it('link clicks are checked like navigation', () => {
    const d = evaluate(linkTo('https://evil.example/?d=secret'), after(GMAIL));
    expect(d.verdict).toBe('confirm');
    expect([...d.rules].sort()).toEqual(['cross-site-navigate', 'first-destination']);
    expect(d.reason).toMatch(/link to evil\.example can carry data: it carries a query string/);
    expect(evaluate(linkTo('https://www.google.com/url?q=https://evil.example'), after(GMAIL)).verdict).toBe('confirm');
    // Enter on a focused link is the same click
    const focusedLink = button('here', { role: 'link', tag: 'a', href: 'https://evil.example/?d=x' });
    expect(evaluate(req({ kind: 'press', key: 'Enter', focus: 'element', element: focusedLink }), after(GMAIL)).rules).toContain('cross-site-navigate');
  });

  it('a form submit to another host (formAction) → confirm with both rules', () => {
    const page = 'https://evil.example/form';
    const submit = button('Go', { isSubmit: true, inForm: true, formAction: 'https://collector.example/save', frameUrl: page });
    const d = evaluate(req({ kind: 'click', pageUrl: page, element: submit }), after(GMAIL));
    expect([...d.rules].sort()).toEqual(['cross-site-navigate', 'first-destination', 'first-interaction', 'high-risk-click']);
    expect(d.reason).toMatch(/submits a form, which sends the form fields/);
    // Enter in one of its text fields submits it too
    const field = el({ name: 'q', inForm: true, formAction: 'https://collector.example/save', frameUrl: page });
    const e = evaluate(req({ kind: 'press', key: 'Enter', pageUrl: page, focus: 'element', element: field }), after(GMAIL));
    expect(e.rules).toEqual(expect.arrayContaining(['high-risk-key', 'cross-site-navigate']));
  });

  it('open endpoints confirm even on a host that was itself read (attacker Google Form after reading a Doc)', () => {
    const doc = readOf('https://docs.google.com/document/d/MYDOC/edit');
    const d = evaluate(nav('https://docs.google.com/forms/d/e/X/formResponse?entry.1=data', 'https://docs.google.com/document/d/MYDOC/edit'), after(doc));
    expect(d.verdict).toBe('confirm');
    expect(d.reason).toMatch(/redirect \/ form \/ data-collection endpoint/);
  });

  it('typing into a DIFFERENT Google Doc / GitHub repo than the one read → confirm; the same one → allow', () => {
    const doc = readOf('https://docs.google.com/document/d/MYDOC/edit');
    expect(evaluate(typeOn('https://docs.google.com/document/d/ATTACKER/edit'), after(doc)).verdict).toBe('confirm');
    expect(evaluate(typeOn('https://docs.google.com/document/u/0/d/MYDOC/edit#heading=h.1'), after(doc)).verdict).toBe('allow');
    const repo = readOf('https://github.com/me/private-repo/blob/main/secrets.md');
    expect(evaluate(typeOn('https://github.com/attacker/bait/issues/new'), after(repo)).verdict).toBe('confirm');
    expect(evaluate(typeOn('https://github.com/me/private-repo/issues/new'), after(repo)).verdict).toBe('allow');
  });

  it('host comparison is exact after normalization (case, trailing dot, punycode)', () => {
    expect(evaluate(typeOn('https://MAIL.GOOGLE.COM./mail/u/0/#inbox?compose=new'), after(GMAIL)).verdict).toBe('allow');
    expect(evaluate(typeOn('https://mаil.google.com/'), after(GMAIL)).verdict).toBe('confirm'); // Cyrillic а
    expect(evaluate(typeOn('https://mail.google.com.evil.example/'), after(GMAIL)).verdict).toBe('confirm');
  });

  it('an evil iframe inside the mail page counts as another site', () => {
    const r = req({ kind: 'type', pageUrl: 'https://mail.google.com/mail/u/0/', element: el({ frameUrl: 'https://evil.example/embed' }), text: 'x' });
    expect(evaluate(r, after(GMAIL)).rules).toContain('cross-site-typing');
  });

  it('select, text-producing keys, paste and prompt() text count as text entry; non-text keys do not', () => {
    const page = 'https://evil.example/';
    const field = el({ frameUrl: page });
    const s = after(GMAIL);
    expect(evaluate(req({ kind: 'select', pageUrl: page, element: field, text: 'opt' }), s).verdict).toBe('confirm');
    for (const key of ['a', 'KeyA', 'Digit1', 'Meta+V']) {
      expect(evaluate(req({ kind: 'press', pageUrl: page, key, focus: 'element', element: field }), s).rules, key).toContain('cross-site-typing');
    }
    // review #2 #4: with nothing (or a button) focused, the characters still reach the page's key listeners
    expect(evaluate(req({ kind: 'press', pageUrl: page, key: 'a', focus: 'none' }), s).rules).toContain('cross-site-typing');
    expect(evaluate(req({ kind: 'press', pageUrl: page, key: 'ArrowDown', focus: 'element', element: field }), s).rules).not.toContain('cross-site-typing');
    const dlg = req({ kind: 'dialog', pageUrl: page, text: 'secret', dialog: { type: 'prompt', message: 'Name?', accept: true } });
    expect([...evaluate(dlg, s).rules].sort()).toEqual(['cross-site-typing', 'dialog-accept', 'first-interaction']);
  });

  it('reading a bank then typing into Gmail also fires (bank → mail exfiltration)', () => {
    const bank = readOf('https://secure.chase.com/web/auth/dashboard');
    expect(evaluate(typeOn('https://mail.google.com/mail/u/0/#inbox?compose=new'), after(bank)).rules).toContain('cross-site-typing');
  });

  it('the taint does not expire within the session', () => {
    const old = { ...GMAIL, at: NOW - 10 * 24 * 3600_000 };
    expect(evaluate(typeOn('https://evil.example/'), after(old)).verdict).toBe('confirm');
  });

  it('disabled by confirmCrossSiteTyping=false; empty text never fires', () => {
    const off = state({ safety: safetyCfg({ confirmCrossSiteTyping: false }), privateReads: [GMAIL] });
    expect(evaluate(typeOn('https://evil.example/'), off).verdict).toBe('allow');
    expect(evaluate(nav('https://evil.example/?d=1'), off).verdict).toBe('allow');
    expect(evaluate(typeOn('https://evil.example/', ''), after(GMAIL)).rules).not.toContain('cross-site-typing');
  });
});

describe('normal productivity stays frictionless', () => {
  it.each<[string, ActionRequest, PrivateRead[], 'allow' | 'confirm']>([
    ['bare origin after Gmail', nav('https://ycombinator.com/'), [GMAIL], 'allow'],
    ['www bare origin after Gmail', nav('https://www.wikipedia.org/'), [GMAIL], 'allow'],
    // Residual-gap fix (evil.com/482913, 482913.evil.com): after a private read, any path or sub-domain to a
    // host neither read nor approved asks ONCE; approval trusts the host for the session (tests below).
    ['short path after Gmail asks once per new host (trade-off)', nav('https://github.com/anthropics/claude-code'), [GMAIL], 'confirm'],
    ['sub-domain front page after Gmail asks once per new host (trade-off)', nav('https://news.ycombinator.com/'), [GMAIL], 'confirm'],
    ['Wikipedia article after Gmail asks once per new host (trade-off)', nav('https://en.wikipedia.org/wiki/Toronto'), [GMAIL], 'confirm'],
    ['same host, any URL', nav('https://mail.google.com/mail/u/0/#search/from%3Abob'), [GMAIL], 'allow'],
    ['link to a news front page', linkTo('https://www.nytimes.com/'), [GMAIL], 'allow'],
    ['replying in Gmail (same host typing)', typeOn('https://mail.google.com/mail/u/0/#inbox?compose=new', 'Thanks Bob!'), [GMAIL], 'allow'],
    ['no private read: search', nav('https://www.google.com/search?q=weather+toronto', 'https://example.com/'), [], 'allow'],
    ['no private read: typing anywhere', typeOn('https://evil.example/'), [], 'allow'],
    ['no private read: tracking link', linkTo('https://shop.example/p?utm_source=x', 'https://example.com/'), [], 'allow'],
    // Documented trade-off (egress.ts): we keep no content, so any query string to another host asks once.
    ['search after reading Gmail asks once (trade-off)', nav('https://www.google.com/search?q=weather'), [GMAIL], 'confirm'],
    ['tracking link inside an email asks once (trade-off)', linkTo('https://shop.example/p?utm_source=mail'), [GMAIL], 'confirm'],
    // review #2: working inside the app that was read stays free…
    ['clicking/scrolling/keys in Gmail after reading Gmail', req({ pageUrl: 'https://mail.google.com/mail/u/0/', element: button('Archive', { frameUrl: 'https://mail.google.com/mail/u/0/' }) }), [GMAIL], 'allow'],
    ['scrolling Gmail', req({ kind: 'scroll', pageUrl: 'https://mail.google.com/mail/u/0/' }), [GMAIL], 'allow'],
    ['Gmail shortcut key', req({ kind: 'press', pageUrl: 'https://mail.google.com/mail/u/0/', key: 'j', focus: 'none' }), [GMAIL], 'allow'],
    ['editing the same Notion page that was read', typeOn('https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef'), [readOf('https://www.notion.so/Plan-0123456789abcdef0123456789abcdef')], 'allow'],
    // …NEW friction (review #2 #6, documented): the first interaction on each other site after a private read asks once
    ['first click on another site after reading Gmail asks once (trade-off)', req({ pageUrl: 'https://news.ycombinator.com/', element: button('More', { frameUrl: 'https://news.ycombinator.com/' }) }), [GMAIL], 'confirm'],
    ['first scroll on another site after reading Gmail asks once (trade-off)', req({ kind: 'scroll', pageUrl: 'https://en.wikipedia.org/wiki/Toronto' }), [GMAIL], 'confirm'],
    // …and (review #2 #3) writing into a different document of the same collaborative app asks each time
    ['posting a summary of channel A into channel B asks (trade-off)', typeOn('https://app.slack.com/client/T1/C0B'), [readOf('https://app.slack.com/client/T1/C0A')], 'confirm'],
  ])('%s → %s', (_what, r, reads, verdict) => {
    expect(evaluate(r, after(...reads)).verdict).toBe(verdict);
  });

  it('after the user approves a host once, interacting there is free for the session', () => {
    const hn = 'https://news.ycombinator.com/';
    const s = state({ privateReads: [GMAIL], trustedHosts: ['news.ycombinator.com'] });
    for (const r of [
      req({ pageUrl: hn, element: button('More', { frameUrl: hn }) }),
      req({ kind: 'scroll', pageUrl: hn }),
      req({ kind: 'hover', pageUrl: hn, element: button('x', { frameUrl: hn }) }),
      req({ kind: 'navigate', pageUrl: hn, targetUrl: 'https://news.ycombinator.com/newest' }),
    ]) {
      expect(evaluate(r, s).verdict, r.kind).toBe('allow');
    }
  });
});

describe('private origins arm the taint', () => {
  it.each([
    'https://mail.google.com/mail/u/0/',
    'https://drive.google.com/drive/my-drive',
    'https://docs.google.com/spreadsheets/d/abc/edit',
    'https://calendar.google.com/calendar/u/0/r',
    'https://www.notion.so/me/Plans-123',
    'https://app.slack.com/client/T1/C1',
    'https://acme.slack.com/archives/C1',
    'https://teams.microsoft.com/_#/conversations',
    'https://acme-my.sharepoint.com/personal/me/Documents',
    'https://onedrive.live.com/?id=root',
    'https://www.dropbox.com/home',
    'https://www.icloud.com/notes',
    'https://mail.proton.me/u/0/inbox',
    'https://drive.proton.me/u/0/',
    'https://app.fastmail.com/mail/Inbox',
    'https://github.com/me/private-repo',
    'https://linear.app/acme/issue/ACM-1',
    'https://acme.atlassian.net/browse/ACM-1',
    'https://outlook.office.com/calendar/view/week',
    'https://www.chase.com/',
  ])('%s', (url) => {
    expect(privateReadOf(url, lists, 5)).not.toBeNull();
  });
  it.each(['https://news.ycombinator.com/', 'https://en.wikipedia.org/wiki/Toronto', 'https://www.google.com/search?q=x', 'about:blank', 'not a url'])(
    '%s does not',
    (url) => {
      expect(privateReadOf(url, lists, 5)).toBeNull();
    },
  );
  it("user sensitiveDomains arm it too", () => {
    const l = compileLists(safetyCfg({ sensitiveDomains: ['payroll.example.com'] }));
    expect(privateReadOf('https://payroll.example.com/me', l, 5)).toEqual({ host: 'payroll.example.com', scope: 'payroll.example.com', at: 5 });
  });
  it('records the exact host and the narrowed scope', () => {
    expect(privateReadOf('https://MAIL.google.com./mail/u/0/', lists, 5)).toEqual({ host: 'mail.google.com', scope: 'mail.google.com', at: 5 });
    expect(taintScope('https://docs.google.com/presentation/d/XYZ/edit')).toBe('docs.google.com/presentation/d/XYZ');
    expect(taintScope('https://github.com/Me/Repo/pull/1')).toBe('github.com/me/repo');
    expect(taintScope('https://github.com/settings/tokens')).toBe('github.com');
    expect(taintScope('javascript:1')).toBe('');
  });
});

describe('assessOutbound', () => {
  const open = lists.openEndpoints;
  it('path threshold is exact', () => {
    expect(assessOutbound(`https://x.example/${'a'.repeat(PATH_DATA_THRESHOLD)}`, open)!.dataReason).toBeNull();
    expect(assessOutbound(`https://x.example/${'a'.repeat(PATH_DATA_THRESHOLD + 1)}`, open)!.dataReason).toMatch(/path/);
    expect(assessOutbound('https://x.example/?', open)!.dataReason).toBeNull();
    expect(assessOutbound('https://x.example/#', open)!.dataReason).toBeNull();
  });
  it('non-web URLs are not outbound', () => {
    expect(assessOutbound('javascript:fetch(1)', open)).toBeNull();
    expect(assessOutbound('mailto:a@b.c', open)).toBeNull();
  });
  it('open endpoints are matched by host and path', () => {
    expect(assessOutbound('https://www.google.com/url?q=x', open)!.openEndpoint).toMatch(/google\.com\/url$/);
    expect(assessOutbound('https://www.google.com/urls', open)!.openEndpoint).toBeNull();
    expect(assessOutbound('https://airtable.com/appABC/shrXYZ', open)!.openEndpoint).not.toBeNull();
  });
});
