import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHubError } from '../../src/errors.js';
import { pageEngine as pe } from '../../src/page/index.js';
import { PROTOCOLS } from '../helpers/chromium.js';
import { closeEnv, refIn, setupEnv, type Env } from './helpers.js';

const TAB = 'z1';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isHubError(e) ? e.code : `non-hub: ${String(e)}`;
  }
  return 'no error';
}

describe.each(PROTOCOLS)('page engine snapshot over %s', (protocol) => {
  let env: Env;
  beforeAll(async () => {
    env = await setupEnv(protocol);
  });
  afterAll(async () => {
    await closeEnv(env);
  });

  it('renders the §3.2 format with header, indented tree and summary', async () => {
    const page = await env.open('login.html');
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    const lines = s.text.split('\n');
    expect(lines[0]).toBe('Page: Sign in – Example Bank');
    expect(lines[1]).toBe(`URL: ${env.fx.a}/login.html`);
    expect(s.title).toBe('Sign in – Example Bank');
    expect(s.url).toBe(`${env.fx.a}/login.html`);
    expect(lines.at(-1)).toMatch(/^\[\d+ refs\]$/);
    expect(s.text).toContain('\n  - form "Sign in" [ref=z1:e');
    expect(s.text).toMatch(/\n {4}- checkbox "Remember me" \[ref=z1:e\d+\] checked\n/);
    expect(s.text).toMatch(/\n {4}- button "Pay now" \[ref=z1:e\d+\]\n/);
    expect(s.text).toMatch(/- link "Need help\?" \[ref=z1:e\d+\]/);
    for (const l of lines.slice(2, -1)) expect(l).toMatch(/^( {2})*- \S/);
    expect(s.refCount).toBe((s.text.match(/\[ref=/g) ?? []).length);
    expect(s.truncated).toBe(false);
    await page.close();
  });

  it('redacts password, OTP, 2FA and card values but shows ordinary values', async () => {
    const page = await env.open('login.html');
    await page.evaluate(() => {
      const set = (id: string, v: string): void => {
        (document.getElementById(id) as HTMLInputElement).value = v;
      };
      set('email', 'me@example.com');
      set('pw', 'Sup3rSecret!');
      set('otp', '481516');
      set('tfa', '234234');
      set('cc', '4111111111111111');
      set('cvc', '737');
    });
    for (const filter of ['interactive', 'all'] as const) {
      const s = await pe.snapshot(page, TAB, { filter, maxChars: 20000 });
      for (const secret of ['Sup3rSecret!', '481516', '234234', '4111111111111111', '737']) {
        expect(s.text).not.toContain(secret);
      }
      expect(s.text).toMatch(/textbox "Password" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s.text).toMatch(/textbox "Verification code" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s.text).toMatch(/textbox "Two-factor token" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s.text).toMatch(/textbox "Card number" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s.text).toMatch(/textbox "CVC" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s.text).toContain('value="me@example.com"');
      expect(s.text).toContain('value="Daily card"');
    }
    await page.close();
  });

  it('handles a Gmail-like app: role=button divs, JS-clickable rows, shadow DOM, contenteditable', async () => {
    const page = await env.open('gmail.html');
    let s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(s.text).toMatch(/- navigation "Mail folders" \[ref=/);
    expect(s.text).toMatch(/- button "Compose" \[ref=/);
    expect(s.text).toMatch(/- link "Inbox 3" \[ref=/);
    expect(s.text).toMatch(/- button "Alice — Lunch on Friday\?" \[ref=/); // jsaction + cursor:pointer
    expect(s.text).toMatch(/- button "Bob — Quarterly report" \[ref=/); // tabindex=0 + cursor:pointer
    expect(s.text).toMatch(/- button "Archive all" \[ref=/); // onclick
    expect(s.text).toMatch(/- navigation "Toolbar" \[ref=[^\]]+\]\n\s+- button "Mark as read" \[ref=/); // open shadow root
    expect(s.text).not.toContain('Message Body'); // dialog is hidden
    await pe.click(page, refIn(s.text, /button "Compose"/));
    s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(s.text).toMatch(/- dialog "New Message" \[ref=[^\]]+\]\n\s+- textbox "To recipients"/);
    const body = refIn(s.text, /textbox "Message Body"/);
    await pe.type(page, body, 'Hi Alice, see you Friday');
    s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(s.text).toMatch(/textbox "Message Body" \[ref=[^\]]+\] focused value="Hi Alice, see you Friday"/);
    await pe.click(page, refIn(s.text, /button "Send"/));
    expect(await page.title()).toBe('sent:Hi Alice, see you Friday');
    await pe.click(page, refIn(s.text, /button "Mark as read"/));
    expect(await page.evaluate(() => document.body.dataset['marked'])).toBe('yes');
    await pe.click(page, refIn(s.text, /button "Archive all"/));
    expect(await page.evaluate(() => (document.getElementById('clicky') as HTMLElement).dataset['clicked'])).toBe('yes');
    await page.close();
  });

  it('omits and counts hidden prompt-injection text in every read path', async () => {
    const page = await env.open('hidden.html');
    for (const filter of ['interactive', 'all'] as const) {
      const s = await pe.snapshot(page, TAB, { filter, maxChars: 20000 });
      expect(s.text).not.toContain('INJECT');
      expect(s.text).not.toContain('Hidden opacity button');
      expect(s.hiddenOmitted).toBeGreaterThanOrEqual(11);
      expect(s.text).toMatch(new RegExp(`· ${s.hiddenOmitted} hidden elements omitted\\]$`));
      expect(s.text).toMatch(/- button "Save" \[ref=/); // 0px span dropped from the name
    }
    const all = await pe.snapshot(page, TAB, { filter: 'all', maxChars: 20000 });
    expect(all.text).toContain('paragraph "Visible description of the product."');
    expect(all.text).toContain('text "White on black is fine"');
    const rt = await pe.readText(page, { maxChars: 20000 });
    expect(rt.text).toContain('Visible description of the product.');
    expect(rt.text).not.toContain('INJECT');
    expect(await pe.find(page, TAB, 'INJECT', 20)).toEqual([]);
    await page.close();
  });

  it('keeps refs stable across snapshots; renamed or removed elements go stale', async () => {
    const page = await env.open('login.html');
    const a = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    const b = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(b.text).toBe(a.text);
    // 'all' and find reuse the same refs for the same elements.
    const all = await pe.snapshot(page, TAB, { filter: 'all', maxChars: 20000 });
    const help = refIn(a.text, /link "Need help\?"/);
    expect(refIn(all.text, /link "Need help\?"/)).toBe(help);
    expect((await pe.find(page, TAB, 'need help', 5))[0]?.ref).toBe(help);

    const loose = refIn(a.text, /button "Not in a form"/);
    await page.evaluate(() => {
      (document.getElementById('loose') as HTMLElement).textContent = 'Renamed';
    });
    const c = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    const renamed = refIn(c.text, /button "Renamed"/);
    expect(renamed).not.toBe(loose);
    expect(await code(pe.describe(page, loose))).toBe('STALE_REF');
    expect(refIn(c.text, /link "Need help\?"/)).toBe(help);

    await page.evaluate(() => document.getElementById('help')?.remove());
    try {
      await pe.describe(page, help);
      expect.unreachable();
    } catch (e) {
      expect(isHubError(e) && e.code).toBe('STALE_REF');
      expect((e as Error).message).toBe(`Element ${help} is gone (page changed). Run snapshot again and use a fresh ref.`);
    }
    expect(await code(pe.click(page, help))).toBe('STALE_REF');
    // Unknown numbers, unknown frames and malformed refs.
    expect(await code(pe.describe(page, 'z1:e9999'))).toBe('STALE_REF');
    expect(await code(pe.describe(page, 'z1:f42e1'))).toBe('STALE_REF');
    expect(await code(pe.describe(page, 'nonsense'))).toBe('BAD_REF');
    // After navigation the old document's refs are gone.
    await page.reload();
    expect(await code(pe.describe(page, renamed))).toBe('STALE_REF');
    await page.close();
  });

  it('scopes to a ref subtree and rejects scopes from other tabs', async () => {
    const page = await env.open('login.html');
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    const pay = refIn(s.text, /form "Payment"/);
    const scoped = await pe.snapshot(page, TAB, { filter: 'interactive', scope: pay, maxChars: 20000 });
    expect(scoped.text).toContain('textbox "Card number"');
    expect(scoped.text).toContain('button "Pay now"');
    expect(scoped.text).not.toContain('Password');
    expect(scoped.text).not.toContain('Need help');
    expect(scoped.text).toMatch(/^Page: Sign in – Example Bank\nURL: /);
    expect(await code(pe.snapshot(page, 'z2', { filter: 'interactive', scope: pay, maxChars: 20000 }))).toBe('WRONG_TAB');
    await page.evaluate(() => document.getElementById('pay')?.remove());
    expect(await code(pe.snapshot(page, TAB, { filter: 'interactive', scope: pay, maxChars: 20000 }))).toBe('STALE_REF');
    await page.close();
  });

  it('truncates at a line boundary within maxChars and says so', async () => {
    const page = await env.open('article.html');
    const full = await pe.snapshot(page, TAB, { filter: 'all', maxChars: 20000 });
    const s = await pe.snapshot(page, TAB, { filter: 'all', maxChars: 400 });
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(400);
    const lines = s.text.split('\n');
    // The walk stops once the output budget is spent (review #2 finding 15), so hidden elements
    // further down the page are no longer counted.
    expect(lines.at(-1)).toMatch(/^\[\d+ refs?(?: · \d+ hidden elements? omitted)? · truncated at 400 chars — use find or a scope ref\]$/);
    for (const l of lines.slice(2, -1)) expect(full.text.split('\n')).toContain(l);
    expect(s.refCount).toBe((s.text.match(/\[ref=/g) ?? []).length);
    expect(s.refCount).toBeLessThan(full.refCount);
    await page.close();
  });

  it('walks same-origin and cross-origin iframes, skipping hidden and empty ones', async () => {
    const page = await env.open('frames.html');
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 4);
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    const hostA = new URL(env.fx.a).host;
    const hostB = new URL(env.fx.b).host;
    expect(s.text).toMatch(new RegExp(`- iframe "${hostA.replace('.', '\\.')}" \\[ref=z1:e\\d+\\]\\n {2}- button "Child button" \\[ref=z1:f\\d+e\\d+\\]`));
    expect(s.text).toMatch(new RegExp(`- iframe "${hostB}" \\[ref=z1:e\\d+\\]\\n {2}- link "Cross link" \\[ref=z1:f\\d+e\\d+\\]`));
    expect(s.text).toMatch(/textbox "Cross password" \[ref=z1:f\d+e\d+\] value=\[redacted\]/);
    expect(s.text).not.toContain('hunter2');
    expect((s.text.match(/- iframe /g) ?? []).length).toBe(2); // hidden + blank frames skipped
    expect(s.hiddenOmitted).toBeGreaterThanOrEqual(1);
    // Frame indices are stable across snapshots.
    const s2 = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(s2.text).toBe(s.text);
    // Scope into a child frame element.
    const all = await pe.snapshot(page, TAB, { filter: 'all', maxChars: 20000 });
    expect(all.text).toContain('paragraph "Cross-origin frame text"');
    await page.close();
  });

  it('acts inside same-origin and cross-origin iframes by ref', async () => {
    const page = await env.open('frames.html');
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    await pe.click(page, refIn(s.text, /button "Child button"/));
    await pe.type(page, refIn(s.text, /textbox "Child input"/), 'inside frame');
    await pe.click(page, refIn(s.text, /link "Cross link"/));
    const same = page.frames().find((f) => f.url().endsWith('/frame-child.html') && f !== page.mainFrame());
    const cross = page.frames().find((f) => f.url().includes('/frame-cross.html'));
    expect(await same?.evaluate(() => document.getElementById('out')?.textContent)).toBe('child clicked');
    expect(await same?.evaluate(() => (document.getElementById('childinput') as HTMLInputElement).value)).toBe('inside frame');
    expect(await cross?.evaluate(() => document.getElementById('out')?.textContent)).toBe('cross clicked');
    const info = await pe.describe(page, refIn(s.text, /textbox "Cross password"/));
    expect(info.inputType).toBe('password');
    expect(info.frameUrl).toBe(`${env.fx.b}/frame-cross.html#done`);
    await page.close();
  });

  it('shows an empty-state hint when nothing interactive is visible', async () => {
    const page = await env.browser.newPage();
    await page.setContent('<p>Just text</p>');
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(s.text).toContain('(no interactive elements visible');
    expect(s.refCount).toBe(0);
    await page.close();
  });
});
