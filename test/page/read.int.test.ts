import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageEngine as pe } from '../../src/page/index.js';
import { PROTOCOLS } from '../helpers/chromium.js';
import { closeEnv, refIn, setupEnv, type Env } from './helpers.js';

const TAB = 'z1';

describe.each(PROTOCOLS)('page engine find/readText/describe over %s', (protocol) => {
  let env: Env;
  beforeAll(async () => {
    env = await setupEnv(protocol);
  });
  afterAll(async () => {
    await closeEnv(env);
  });

  it('find ranks exact > prefix > contains and returns usable refs', async () => {
    const page = await env.browser.newPage();
    await page.setContent(`
      <main><h1>Editor</h1>
        <button id="a">Autosave settings</button>
        <button id="b">Save draft</button>
        <button id="c">Save</button>
        <p>Remember to save often.</p>
      </main>`);
    const m = await pe.find(page, TAB, 'save', 10);
    expect(m.map((x) => x.name)).toEqual(['Save', 'Save draft', 'Autosave settings', 'Remember to save often.']);
    expect(m[0]).toMatchObject({ role: 'button', context: 'main › heading "Editor"' });
    expect(m[0]?.ref).toMatch(/^z1:e\d+$/);
    expect(m[3]?.role).toBe('paragraph');
    const info = await pe.describe(page, m[0]?.ref as string);
    expect(info.idAttr).toBe('c');
    expect(await pe.find(page, TAB, 'save', 2)).toHaveLength(2);
    expect(await pe.find(page, TAB, 'no such thing', 5)).toEqual([]);
    await page.close();
  });

  it('find matches placeholder/label/role and reports landmark + form + heading context', async () => {
    const page = await env.open('login.html');
    const signIn = await pe.find(page, TAB, 'sign in', 10);
    expect(signIn[0]).toMatchObject({ role: 'button', name: 'Sign in', context: 'main › form "Sign in" › heading "Sign in"' });
    expect(signIn.some((x) => x.role === 'heading' && x.name === 'Sign in')).toBe(true);
    // the form itself is dropped: its match comes from its descendants
    expect(signIn.some((x) => x.role === 'form')).toBe(false);
    const tfa = await pe.find(page, TAB, '2FA token', 5);
    expect(tfa[0]).toMatchObject({ role: 'textbox', name: 'Two-factor token' }); // via placeholder
    const cvc = await pe.find(page, TAB, 'cvc', 5);
    expect(cvc[0]).toMatchObject({ role: 'textbox', name: 'CVC', context: 'main › form "Payment" › heading "Sign in"' });
    const boxes = await pe.find(page, TAB, 'checkbox', 5);
    expect(boxes[0]).toMatchObject({ role: 'checkbox', name: 'Remember me' });
    await page.close();
  });

  it('find searches inside iframes and scoped text candidates', async () => {
    const page = await env.open('frames.html');
    const m = await pe.find(page, TAB, 'cross link', 5);
    expect(m[0]).toMatchObject({ role: 'link', name: 'Cross link' });
    expect(m[0]?.ref).toMatch(/^z1:f\d+e\d+$/);
    expect(m[0]?.context).toBe(`iframe "${new URL(env.fx.b).host}"`);
    await pe.click(page, m[0]?.ref as string);
    // The cross-site iframe runs in another renderer process: the click's mousedown and our reads reach it on
    // separate channels, so its text can change after click() returns (CI run 44955033934, #109). Wait for it.
    await pe.waitFor(page, { text: 'cross clicked', timeoutMs: 3000 });
    const cross = page.frames().find((f) => f.url().includes('/frame-cross.html'));
    expect(await cross?.evaluate(() => document.getElementById('out')?.textContent)).toBe('cross clicked');
    const t = await pe.find(page, TAB, 'same-origin child', 5);
    expect(t[0]).toMatchObject({ role: 'paragraph', name: 'Same-origin child frame text' });
    await page.close();
  });

  it('readText extracts the article: headings, list items, no chrome/script/hidden', async () => {
    const page = await env.open('article.html');
    const r = await pe.readText(page, { maxChars: 20000 });
    expect(r.title).toBe('How tides work');
    expect(r.url).toBe(`${env.fx.a}/article.html`);
    expect(r.truncated).toBe(false);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('# How tides work');
    expect(lines).toContain('## Key factors');
    expect(lines).toContain("- The Moon's gravity");
    expect(lines).toContain("- Earth's rotation");
    expect(r.text).toContain('Tides are the rise and fall of sea levels');
    for (const bad of ['NAVTEXT', 'ASIDETEXT', 'FOOTERTEXT', 'SCRIPTTEXT', 'STYLETEXT', 'HIDDENTEXT', 'Home']) {
      expect(r.text).not.toContain(bad);
    }
    expect(r.text).not.toMatch(/ {2}/);
    const short = await pe.readText(page, { maxChars: 150 });
    expect(short.truncated).toBe(true);
    expect(short.text.length).toBeLessThanOrEqual(150);
    expect(short.text).toMatch(/\[truncated at 150 chars/);
    await page.close();
  });

  it('readText falls back to body, honours scope, and includes visible iframes', async () => {
    const page = await env.open('frames.html');
    const r = await pe.readText(page, { maxChars: 20000 });
    expect(r.text).toContain('# Parent');
    expect(r.text).toContain('Same-origin child frame text');
    expect(r.text).toContain('Cross-origin frame text');
    expect(r.text).toContain(`[iframe ${new URL(env.fx.b).host}]`);
    const art = await env.open('article.html');
    const s = await pe.snapshot(art, TAB, { filter: 'all', maxChars: 20000 });
    const list = refIn(s.text, /- list \[ref=/);
    const scoped = await pe.readText(art, { scope: list, maxChars: 20000 });
    expect(scoped.text).toBe("- The Moon's gravity\n- The Sun's gravity\n- Earth's rotation");
    await page.close();
    await art.close();
  });

  it('describe returns live ElementInfo for submit buttons, links, secret fields', async () => {
    const page = await env.open('login.html');
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    const signin = await pe.describe(page, refIn(s.text, /button "Sign in"/));
    expect(signin).toMatchObject({
      role: 'button',
      name: 'Sign in',
      tag: 'button',
      inputType: null,
      text: 'Sign in',
      href: null,
      isEditable: false,
      isDisabled: false,
      isSubmit: true,
      inForm: true,
      formAction: `${env.fx.a}/session`,
      frameUrl: `${env.fx.a}/login.html`,
      idAttr: 'signin',
    });
    const pay = await pe.describe(page, refIn(s.text, /button "Pay now"/));
    expect(pay).toMatchObject({ tag: 'input', inputType: 'submit', text: 'Pay now', isSubmit: true, inForm: true, formAction: 'https://pay.example.com/charge' });
    const loose = await pe.describe(page, refIn(s.text, /button "Not in a form"/));
    expect(loose).toMatchObject({ isSubmit: false, inForm: false, formAction: null });
    const link = await pe.describe(page, refIn(s.text, /link "Need help\?"/));
    expect(link).toMatchObject({ role: 'link', href: `${env.fx.a}/help/signin`, inForm: false });
    const pw = await pe.describe(page, refIn(s.text, /textbox "Password"/));
    expect(pw).toMatchObject({
      role: 'textbox',
      name: 'Password',
      inputType: 'password',
      autocomplete: 'current-password',
      nameAttr: 'pw',
      idAttr: 'pw',
      labelText: 'Password',
      text: null,
      isEditable: true,
      inForm: true,
    });
    const tfa = await pe.describe(page, refIn(s.text, /textbox "Two-factor token"/));
    expect(tfa).toMatchObject({ placeholder: '2FA token', labelText: 'Two-factor token', ariaLabel: null });
    const cb = await pe.describe(page, refIn(s.text, /checkbox "Remember me"/));
    expect(cb).toMatchObject({ role: 'checkbox', inputType: 'checkbox', isEditable: false });
    await page.close();
  });

  it('describe reports disabled and contenteditable state', async () => {
    const page = await env.browser.newPage();
    await page.setContent(`
      <form action="/x"><button disabled>Off</button><button type="button">Plain</button>
        <div contenteditable="true" aria-label="Notes">hi</div></form>
      <div role="button" aria-disabled="true" tabindex="0">Fake</div>`);
    const s = await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 });
    expect(s.text).toMatch(/button "Off" \[ref=[^\]]+\] disabled/);
    expect(await pe.describe(page, refIn(s.text, /button "Off"/))).toMatchObject({ isDisabled: true, isSubmit: true });
    expect(await pe.describe(page, refIn(s.text, /button "Plain"/))).toMatchObject({ isSubmit: false, inForm: true });
    expect(await pe.describe(page, refIn(s.text, /button "Fake"/))).toMatchObject({ isDisabled: true, tag: 'div' });
    expect(await pe.describe(page, refIn(s.text, /textbox "Notes"/))).toMatchObject({ role: 'textbox', isEditable: true, text: null, inForm: true });
    await page.close();
  });
});
