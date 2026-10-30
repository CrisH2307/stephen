import { describe, expect, it } from 'vitest';
import { compileLists, evaluate, privateReadOf } from '../../src/safety/policy.js';
import { button, el, req, safetyCfg, state } from './fixtures.js';

const NOW = 1_000_000_000;
const gmailRead = { host: 'mail.google.com', scope: 'mail.google.com', at: NOW - 60_000 };

describe('allow', () => {
  it('ordinary click on a neutral button', () => {
    const d = evaluate(req({ element: button('Next') }), state());
    expect(d).toEqual({ verdict: 'allow', risk: 'medium', rules: [], reason: 'No safety rule applies.' });
  });
  it('read / scroll / hover are low risk', () => {
    expect(evaluate(req({ kind: 'read' }), state()).risk).toBe('low');
    expect(evaluate(req({ kind: 'scroll' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'hover', element: button('Delete') }), state()).verdict).toBe('allow');
  });
  it('navigate to a normal site', () => {
    const d = evaluate(req({ kind: 'navigate', targetUrl: 'https://news.ycombinator.com/' }), state());
    expect(d.verdict).toBe('allow');
  });
  it('tab_open with about:blank', () => {
    expect(evaluate(req({ kind: 'tab_open', pageUrl: 'about:blank', targetUrl: 'about:blank' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'tab_open', pageUrl: 'about:blank' }), state()).verdict).toBe('allow');
  });
});

describe('blocked-url', () => {
  it.each([
    'chrome://settings/passwords',
    'chrome-extension://abc/popup.html',
    'about:config',
    'about:logins',
    'file:///Users/me/.ssh/id_rsa',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'view-source:https://example.com',
    'devtools://devtools/bundled/inspector.html',
    'moz-extension://x/y',
    'resource://gre/modules',
    'x-apple.systempreferences:com.apple.preference.security',
    'ftp://example.com/',
    'https://my.1password.com/',
    'https://vault.bitwarden.com/#/vault',
    'https://LASTPASS.com./vault',
    'not a url',
  ])('navigate to %s is denied', (target) => {
    const d = evaluate(req({ kind: 'navigate', targetUrl: target }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toContain('blocked-url');
    expect(d.risk).toBe('high');
  });

  it('message says off-limits and to ask the user', () => {
    const d = evaluate(req({ kind: 'tab_open', pageUrl: 'about:blank', targetUrl: 'https://my.1password.com/' }), state());
    expect(d.reason).toMatch(/off-limits/);
    expect(d.reason).toMatch(/Ask the user to do this themselves/);
  });

  it.each(['chrome://newtab/', 'about:newtab', 'file:///tmp/x.html', 'https://my.1password.com/vaults'])(
    'any action or read on %s is denied',
    (pageUrl) => {
      for (const kind of ['read', 'click', 'scroll', 'hover', 'type'] as const) {
        const d = evaluate(req({ kind, pageUrl, element: el({ frameUrl: pageUrl }), text: 'x' }), state());
        expect(d.verdict, kind).toBe('deny');
        expect(d.rules).toContain('blocked-url');
      }
    },
  );

  it('navigating away from a blocked page and closing it are allowed', () => {
    const pageUrl = 'chrome://newtab/';
    expect(evaluate(req({ kind: 'navigate', pageUrl, targetUrl: 'https://example.com' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'tab_close', pageUrl }), state()).verdict).toBe('allow');
    expect(
      evaluate(req({ kind: 'dialog', pageUrl, dialog: { type: 'confirm', message: '', accept: false } }), state()).verdict,
    ).toBe('allow');
  });

  it('about:blank and about:srcdoc pages are fine', () => {
    expect(evaluate(req({ kind: 'read', pageUrl: 'about:blank' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'click', element: button('Next', { frameUrl: 'about:srcdoc' }) }), state()).verdict).toBe('allow');
  });

  it('a blocked iframe inside an ordinary page is denied', () => {
    const d = evaluate(req({ kind: 'click', element: button('Next', { frameUrl: 'https://my.1password.com/embed' }) }), state());
    expect(d.verdict).toBe('deny');
  });

  it('clicking a link into a blocked site is denied; javascript: links are judged by the page', () => {
    const toVault = button('Open vault', { role: 'link', tag: 'a', href: 'https://vault.bitwarden.com/' });
    expect(evaluate(req({ element: toVault }), state()).verdict).toBe('deny');
    const jsLink = button('More', { role: 'link', tag: 'a', href: 'javascript:void(0)' });
    expect(evaluate(req({ element: jsLink }), state()).verdict).toBe('allow');
  });

  it('user blockedDomains merge with the built-ins', () => {
    const safety = safetyCfg({ blockedDomains: ['corp-secrets.example', '*.internal.test'] });
    const s = state({ safety });
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://wiki.corp-secrets.example/' }), s).verdict).toBe('deny');
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://a.internal.test/' }), s).verdict).toBe('deny');
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://internal.test/' }), s).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://my.1password.com/' }), s).verdict).toBe('deny');
  });

  it('an unparsable page URL fails closed', () => {
    expect(evaluate(req({ kind: 'click', pageUrl: '', element: button('Next', { frameUrl: '' }) }), state()).verdict).toBe('deny');
  });
});

describe('missing-element', () => {
  it.each(['click', 'type', 'select', 'upload'] as const)('%s without element facts is denied', (kind) => {
    const d = evaluate(req({ kind, text: 'x' }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toContain('missing-element');
  });
});

describe('secret-field', () => {
  const pw = el({ inputType: 'password', name: 'Password' });
  it.each(['type', 'select', 'upload'] as const)('%s into a password field is denied', (kind) => {
    const d = evaluate(req({ kind, element: pw, text: 'hunter2', files: ['/tmp/a'] }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toContain('secret-field');
    expect(d.reason).toBe(
      'That field holds a password/one-time code/payment detail. Stephen never types these — ask the user to enter it themselves.',
    );
  });
  it('fill_form (type) into a card-number field in a Stripe frame is denied', () => {
    const card = el({ name: 'Card', frameUrl: 'https://js.stripe.com/v3/inner.html' });
    const d = evaluate(req({ kind: 'type', tool: 'fill_form', element: card, text: '4242424242424242', pageUrl: 'https://shop.example/checkout' }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toContain('secret-field');
  });
  it('typing even an empty string (clear) into a secret field is denied', () => {
    expect(evaluate(req({ kind: 'type', element: pw, text: '' }), state()).verdict).toBe('deny');
  });
  it('pressing a character or pasting into a focused secret field is denied; Enter only asks (submits the login form)', () => {
    expect(evaluate(req({ kind: 'press', key: 'a', element: pw, focus: 'element' }), state()).verdict).toBe('deny');
    expect(evaluate(req({ kind: 'press', key: 'Meta+V', element: pw, focus: 'element' }), state()).verdict).toBe('deny');
    expect(evaluate(req({ kind: 'press', key: 'Enter', element: pw, focus: 'element' }), state()).verdict).toBe('confirm');
    expect(evaluate(req({ kind: 'press', key: 'ArrowLeft', element: pw, focus: 'element' }), state()).verdict).toBe('allow');
  });
  it('clicking a password field (to focus it) is allowed', () => {
    expect(evaluate(req({ kind: 'click', element: pw }), state()).verdict).toBe('allow');
  });
  it('secret-field deny beats a confirm rule on a sensitive page', () => {
    const d = evaluate(req({ kind: 'type', pageUrl: 'https://www.paypal.com/signin', element: pw, text: 'x' }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(expect.arrayContaining(['secret-field', 'sensitive-domain']));
    expect(d.reason).not.toMatch(/sensitive-sites/);
  });
});

describe('evaluate rule', () => {
  it('denied when allowEvaluate is false', () => {
    const d = evaluate(req({ kind: 'evaluate', text: 'document.title' }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['evaluate-disabled']);
  });
  it('confirm when allowEvaluate is true', () => {
    const d = evaluate(req({ kind: 'evaluate', text: 'document.title' }), state({ safety: safetyCfg({ allowEvaluate: true }) }));
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['evaluate']);
    expect(d.risk).toBe('high');
  });
});

describe('rate-limit', () => {
  const safety = safetyCfg({ maxActionsPerMinute: 3 });
  it('denies when the window already holds max mutating actions', () => {
    const times = [NOW - 50_000, NOW - 20_000, NOW - 1_000];
    const d = evaluate(req({ element: button('Next') }), state({ safety, mutationTimes: times }));
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['rate-limit']);
    expect(d.reason).toMatch(/Wait about 10 s/);
  });
  it('allows once old actions slide out of the 60 s window', () => {
    const times = [NOW - 60_000, NOW - 20_000, NOW - 1_000];
    expect(evaluate(req({ element: button('Next') }), state({ safety, mutationTimes: times })).verdict).toBe('allow');
  });
  it('never limits reads', () => {
    const times = [NOW - 3, NOW - 2, NOW - 1];
    expect(evaluate(req({ kind: 'read' }), state({ safety, mutationTimes: times })).verdict).toBe('allow');
  });
  it('review #2 #6: hover and scroll count toward the limit (page scripts see them); untainted they are otherwise allowed', () => {
    const times = [NOW - 3, NOW - 2, NOW - 1];
    for (const kind of ['scroll', 'hover'] as const) {
      expect(evaluate(req({ kind, element: button('x') }), state({ safety, mutationTimes: times })).rules).toEqual(['rate-limit']);
      expect(evaluate(req({ kind, element: button('x') }), state({ safety, mutationTimes: [NOW - 1] })).verdict).toBe('allow');
    }
    // still not "mutations" for the sensitive-site rule
    const bank = 'https://www.chase.com/accounts';
    expect(evaluate(req({ kind: 'scroll', pageUrl: bank }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'hover', pageUrl: bank, element: button('Menu', { frameUrl: bank }) }), state()).verdict).toBe('allow');
  });
});

describe('sensitive-domain', () => {
  it('navigate / tab_open to a sensitive site → confirm (medium)', () => {
    for (const kind of ['navigate', 'tab_open'] as const) {
      const d = evaluate(req({ kind, targetUrl: 'https://www.chase.com/' }), state());
      expect(d.verdict).toBe('confirm');
      expect(d.rules).toEqual(['sensitive-domain']);
      expect(d.risk).toBe('medium');
      expect(d.reason).toMatch(/www\.chase\.com/);
    }
  });
  it('trailing-dot and uppercase hosts are still sensitive', () => {
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://WWW.PAYPAL.COM./' }), state()).verdict).toBe('confirm');
  });
  it('homoglyph and lookalike hosts are not treated as the real site', () => {
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://xn--pypal-4ve.com/' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://paypal.com.evil.com/' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://evil-paypal.com/' }), state()).verdict).toBe('allow');
  });
  it('every mutation on a sensitive page → confirm; reads/scroll/hover do not', () => {
    const pageUrl = 'https://myaccount.google.com/security';
    for (const r of [
      req({ kind: 'click', pageUrl, element: button('Next', { frameUrl: pageUrl }) }),
      req({ kind: 'type', pageUrl, element: el({ frameUrl: pageUrl }), text: 'x' }),
      req({ kind: 'press', pageUrl, key: 'ArrowDown' }),
      req({ kind: 'dialog', pageUrl, dialog: { type: 'alert', message: 'hi', accept: true } }),
    ]) {
      const d = evaluate(r, state());
      expect(d.verdict, r.kind).toBe('confirm');
      expect(d.rules).toContain('sensitive-domain');
    }
    for (const kind of ['read', 'scroll', 'hover'] as const) {
      expect(evaluate(req({ kind, pageUrl, element: button('x', { frameUrl: pageUrl }) }), state()).verdict).toBe('allow');
    }
  });
  it('path-scoped: github.com/settings is sensitive, a repo page is not', () => {
    const click = (pageUrl: string) => evaluate(req({ pageUrl, element: button('Next', { frameUrl: pageUrl }) }), state()).verdict;
    expect(click('https://github.com/settings/tokens')).toBe('confirm');
    expect(click('https://github.com/anthropics/repo')).toBe('allow');
  });
  it('clicking a link into a sensitive site → confirm', () => {
    const link = button('My bank', { role: 'link', tag: 'a', href: 'https://www.td.com/ca/en/personal-banking' });
    const d = evaluate(req({ element: link }), state());
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['sensitive-domain']);
  });
  it('user sensitiveDomains merge with the built-ins', () => {
    const s = state({ safety: safetyCfg({ sensitiveDomains: ['payroll.example.com'] }) });
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://payroll.example.com/x' }), s).verdict).toBe('confirm');
    expect(evaluate(req({ kind: 'navigate', targetUrl: 'https://www.chase.com/' }), s).verdict).toBe('confirm');
  });
});

describe('high-risk-click', () => {
  it('confirms a Send button with a readable reason', () => {
    const d = evaluate(req({ pageUrl: 'https://mail.google.com/mail/u/0/#inbox', element: button('Send', { frameUrl: 'https://mail.google.com/mail/u/0/#inbox' }) }), state());
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['high-risk-click']);
    // review #2 #8: the reason (returned to the model unwrapped) names the element by role + ref, never its label
    expect(d.reason).toBe('Clicking button z1:e1 looks like it will send.');
    expect(d.risk).toBe('high');
  });
  it('confirms any submit control', () => {
    const d = evaluate(req({ element: button('Go', { isSubmit: true, inForm: true }) }), state());
    expect(d.verdict).toBe('confirm');
    expect(d.reason).toMatch(/submits a form/);
  });
  it('a "Post" button is high risk; a "Postal code" textbox click is not', () => {
    expect(evaluate(req({ element: button('Post') }), state()).verdict).toBe('confirm');
    expect(evaluate(req({ element: el({ name: 'Postal code' }) }), state()).verdict).toBe('allow');
  });
  it('sanitizes bidi/control characters from page-supplied names in the reason', () => {
    const d = evaluate(req({ element: button('Send‮\u0007evil') }), state());
    expect(d.reason).not.toMatch(/[‮\u0007]/);
  });
});

describe('high-risk-key', () => {
  it.each(['Meta+Enter', 'Control+Enter', 'Control+NumpadEnter'])('%s → confirm (any focus)', (key) => {
    for (const f of [{ focus: 'none' as const }, { focus: 'element' as const, element: el({ tag: 'div', role: 'textbox' }) }]) {
      const d = evaluate(req({ kind: 'press', key, ...f }), state());
      expect(d.verdict).toBe('confirm');
      expect(d.rules).toEqual(['high-risk-key']);
    }
  });
  it('plain Enter with nothing focused → allow (low)', () => {
    const d = evaluate(req({ kind: 'press', key: 'Enter', focus: 'none' }), state());
    expect(d.verdict).toBe('allow');
    expect(d.risk).toBe('low');
  });
  it('Enter into a message editor (contenteditable/textarea) → confirm; Shift+Enter (newline) → allow', () => {
    const composer = el({ tag: 'div', role: 'textbox', name: 'Message', isEditable: true });
    expect(evaluate(req({ kind: 'press', key: 'Enter', element: composer, focus: 'element' }), state()).verdict).toBe('confirm');
    expect(evaluate(req({ kind: 'type', key: 'Enter', element: composer, text: 'hi' }), state()).rules).toContain('high-risk-key');
    expect(evaluate(req({ kind: 'press', key: 'Shift+Enter', element: composer, focus: 'element' }), state()).verdict).toBe('allow');
  });
  it('#4: Enter in a single-line form field → confirm (GitHub "type the repo name to delete" + Enter)', () => {
    const gh = el({ name: 'Type repo name to confirm', inForm: true, frameUrl: 'https://github.com/me/repo/settings' });
    for (const key of ['Enter', 'NumpadEnter', 'Return']) {
      const d = evaluate(req({ kind: 'press', key, element: gh, focus: 'element', pageUrl: 'https://github.com/me/repo' }), state());
      expect(d.verdict, key).toBe('confirm');
      expect(d.rules).toContain('high-risk-key');
      expect(d.reason).toMatch(/submits the form/);
    }
    // type … submit=true is sent as {kind:'type', key:'Enter'}
    expect(evaluate(req({ kind: 'type', key: 'Enter', element: gh, text: 'me/repo' }), state()).verdict).toBe('confirm');
    // a line break inside typed text into a single-line field would be the same Enter → refused outright
    const d = evaluate(req({ kind: 'type', element: gh, text: 'me/repo\n' }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['control-in-text']);
    expect(d.reason).toMatch(/submit: true/);
    // …while line breaks in a message body are just text (the page engine inserts them as text)
    const body = el({ tag: 'div', inputType: null, role: 'textbox', name: 'Message Body' });
    expect(evaluate(req({ kind: 'type', element: body, text: 'Hi Bob,\n\nThanks!\tCheers' }), state()).verdict).toBe('allow');
  });
  it('Enter in a search box stays frictionless', () => {
    const search = el({ tag: 'input', name: 'Search' });
    expect(evaluate(req({ kind: 'type', key: 'Enter', element: search, text: 'cats' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'press', key: 'Enter', element: el({ inputType: 'search' }), focus: 'element' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'press', key: 'Enter', element: el({ role: 'searchbox', inputType: 'text' }), focus: 'element' }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'press', key: 'Enter', element: el({ placeholder: 'Rechercher dans les messages' }), focus: 'element' }), state()).verdict).toBe('allow');
  });
  it('Enter / Space on a focused "Send" button is a click on it', () => {
    const send = button('Send', { isSubmit: true, inForm: true });
    for (const key of ['Enter', 'Space', ' ']) {
      const d = evaluate(req({ kind: 'press', key, element: send, focus: 'element' }), state());
      expect(d.verdict, key).toBe('confirm');
      expect(d.rules).toContain('high-risk-click');
    }
    expect(evaluate(req({ kind: 'press', key: 'Enter', element: button('Next'), focus: 'element' }), state()).verdict).toBe('allow');
  });
});

describe('#3 key presses and focus', () => {
  const pw = el({ inputType: 'password', name: 'Password' });
  const otp = el({ name: 'Verification code', autocomplete: 'one-time-code' });
  it.each(['a', 'A', 'KeyA', 'Shift+KeyA', 'Digit1', 'Numpad1', 'Space', ' ', 'Semicolon', 'NumpadAdd', 'Alt+KeyA', 'é', '#', 'Meta+V', 'Control+V', 'Shift+Insert', 'Control+Shift+V'])(
    '%s into a focused password / OTP field → deny',
    (key) => {
      for (const element of [pw, otp]) {
        const d = evaluate(req({ kind: 'press', key, element, focus: 'element' }), state());
        expect(d.verdict).toBe('deny');
        expect(d.rules).toContain('secret-field');
      }
    },
  );
  it.each(['Meta+A', 'Control+C', 'ArrowLeft', 'Escape', 'Backspace', 'Tab'])('%s in a password field is not text → not secret-field', (key) => {
    expect(evaluate(req({ kind: 'press', key, element: pw, focus: 'element' }), state()).rules).not.toContain('secret-field');
  });
  it.each(['a', 'KeyA', 'Digit1', 'Numpad1', 'Space', 'Meta+V', 'Enter', 'NumpadEnter', 'Meta+Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete'])(
    'focus unknown (or not reported) + %s → deny, tell the model to click the field first',
    (key) => {
      for (const extra of [{ focus: 'unknown' as const }, {}, { element: el() }, { focus: 'element' as const }]) {
        const d = evaluate(req({ kind: 'press', key, ...extra }), state());
        expect(d.verdict).toBe('deny');
        expect(d.rules).toContain('focus-unknown');
        expect(d.reason).toMatch(/Click the field/);
      }
    },
  );
  it.each(['ArrowDown', 'PageDown', 'Escape', 'Home', 'End', 'Meta+A', 'F5'])('focus unknown + navigation key %s → allow', (key) => {
    expect(evaluate(req({ kind: 'press', key, focus: 'unknown' }), state()).verdict).toBe('allow');
  });
  it('type text with a Tab into a single-line field (would jump into the next field) → deny', () => {
    const d = evaluate(req({ kind: 'type', element: el({ name: 'Email' }), text: 'me@x.com\thunter2' }), state());
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['control-in-text']);
  });
});

describe('#12 destructive single-key shortcuts', () => {
  const row = button('Conversation from Bob', { role: 'row', tag: 'tr' });
  it.each(['Delete', 'Backspace', 'Shift+Delete', 'Meta+Backspace', '#', 'Shift+3', 'Shift+Digit3', '!', 'Shift+1'])(
    'focus none / non-text element + %s → confirm',
    (key) => {
      for (const extra of [{ focus: 'none' as const }, { focus: 'element' as const, element: row }]) {
        const d = evaluate(req({ kind: 'press', key, pageUrl: 'https://mail.google.com/mail/u/0/#inbox', ...extra }), state());
        expect(d.verdict, key).toBe('confirm');
        expect(d.rules).toEqual(['destructive-shortcut']);
      }
    },
  );
  it.each(['j', 'k', 'e', 'Shift+I', 'ArrowDown', 'PageDown', 'Home', 'End', 'Escape', 'Tab', 'c', '/', '?'])(
    'focus none + %s (navigation / reversible) → allow',
    (key) => {
      expect(evaluate(req({ kind: 'press', key, focus: 'none' }), state()).verdict).toBe('allow');
    },
  );
  it('Delete / Backspace / # inside a text field are just editing', () => {
    const field = el({ name: 'Subject' });
    for (const key of ['Delete', 'Backspace', '#', '!']) {
      expect(evaluate(req({ kind: 'press', key, element: field, focus: 'element' }), state()).verdict, key).toBe('allow');
    }
  });
});

describe('upload', () => {
  it('always confirm', () => {
    const d = evaluate(req({ kind: 'upload', element: el({ inputType: 'file' }), files: ['/Users/me/a.pdf', '/Users/me/b.png'] }), state());
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['upload']);
    expect(d.reason).toMatch(/2 local files/);
  });
});

describe('dialog-accept', () => {
  it.each(['confirm', 'beforeunload', 'prompt', 'something-new'])('accepting %s → confirm', (type) => {
    const d = evaluate(req({ kind: 'dialog', dialog: { type, message: 'Leave?', accept: true } }), state());
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['dialog-accept']);
  });
  it('accepting an alert / dismissing anything → allow', () => {
    expect(evaluate(req({ kind: 'dialog', dialog: { type: 'alert', message: 'hi', accept: true } }), state()).verdict).toBe('allow');
    expect(evaluate(req({ kind: 'dialog', dialog: { type: 'confirm', message: 'hi', accept: false } }), state()).verdict).toBe('allow');
  });
});

describe('combinations', () => {
  it('Send on a sensitive page collects both rules, verdict confirm', () => {
    const pageUrl = 'https://www.paypal.com/myaccount/transfer';
    const d = evaluate(req({ pageUrl, element: button('Send', { frameUrl: pageUrl }) }), state());
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['sensitive-domain', 'high-risk-click']);
    expect(d.reason).toMatch(/sensitive-sites list/);
    expect(d.reason).toMatch(/send/);
  });
  it('deny beats confirm: rate limit + high-risk click', () => {
    const times = Array.from({ length: 40 }, (_, i) => NOW - i * 100);
    const d = evaluate(req({ element: button('Delete') }), state({ mutationTimes: times }));
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['rate-limit', 'high-risk-click']);
    expect(d.reason).toMatch(/^Rate limit/);
  });
  it('blocked target + sensitive + cross-site all fire, deny wins', () => {
    const s = state({ safety: safetyCfg({ blockedDomains: ['chase.com'] }), privateReads: [gmailRead] });
    const d = evaluate(req({ kind: 'navigate', targetUrl: 'https://www.chase.com/login?next=/' }), s);
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['blocked-url', 'sensitive-domain', 'first-destination', 'cross-site-navigate']);
  });
  it('upload on sensitive page with cross-site read', () => {
    const pageUrl = 'https://www.canada.ca/upload';
    const d = evaluate(
      req({ kind: 'upload', pageUrl, element: el({ inputType: 'file', frameUrl: pageUrl }), files: ['/a'] }),
      state({ privateReads: [gmailRead] }),
    );
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toEqual(['sensitive-domain', 'upload', 'first-interaction']);
  });
});
