/**
 * Regression tests for review #1 page-engine findings (#2, #3, #7, #8, #9, #10, #11, #13, #14),
 * reproduced from the reviewer's probes (live.mjs, live2.mjs, tab.mjs, speed.mjs). Every test runs
 * over CDP (Chrome) and WebDriver BiDi (the Zen code path).
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHubError } from '../../src/errors.js';
import { pageEngine as pe, pageTextOf, screenshotNote } from '../../src/page/index.js';
import { PROTOCOLS } from '../helpers/chromium.js';
import { closeEnv, pngDims, refIn, setupEnv, type Env } from './helpers.js';

const TAB = 'z1';

async function err(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return isHubError(e) ? { code: e.code, message: e.message } : { code: `non-hub`, message: String(e) };
  }
  return { code: 'no error', message: '' };
}

async function snap(page: Page, filter: 'interactive' | 'all' = 'interactive'): Promise<string> {
  return (await pe.snapshot(page, TAB, { filter, maxChars: 20000 })).text;
}

const val = (page: Page, id: string): Promise<string> =>
  page.evaluate((i) => (document.getElementById(i) as HTMLInputElement).value, id);

/** Every body line of a snapshot: "<indent>- <role>[ "name"][ [ref=…]][ states…]" with at most one ref. */
const LINE_RE = /^( {2})*- [a-z][a-z0-9-]*(?: "(?:[^"\\]|\\.)*")?(?: \[ref=z1:(?:f\d+)?e\d+\])?(?: [a-z]+(?:=(?:\d+|file|\[redacted\]|"(?:[^"\\]|\\.)*"))?| \(unreadable\))*$/;

describe.each(PROTOCOLS)('review #1 page-engine regressions over %s', (protocol) => {
  let env: Env;
  beforeAll(async () => {
    env = await setupEnv(protocol);
  });
  afterAll(async () => {
    await closeEnv(env);
  });

  // ───────────── #2 keystroke injection via type / fill_form ─────────────

  it('#2 rejects a newline into a single-line field instead of pressing Enter (no submit)', async () => {
    const page = await env.open('typing.html');
    const repo = refIn(await snap(page), /textbox "Repository name"/);
    const e = await err(pe.type(page, repo, 'myrepo\n'));
    expect(e.code).toBe('INVALID_ARG');
    expect(e.message).toMatch(/submit: true/);
    expect(await val(page, 'repo')).toBe('');
    expect(await err(pe.type(page, repo, 'myrepo\r\n'))).toMatchObject({ code: 'INVALID_ARG' });
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    await page.close();
  });

  it('#2 never turns a tab into a Tab key press (no typing into the next password field)', async () => {
    const page = await env.open('typing.html');
    const user = refIn(await snap(page), /textbox "Username"/);
    expect((await err(pe.type(page, user, 'me\thunter2'))).code).toBe('INVALID_ARG');
    expect(await val(page, 'user')).toBe('');
    expect(await val(page, 'pass')).toBe('');
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    await page.close();
  });

  it('#2 inserts newlines and tabs as text into a textarea: no key events, focus stays, no submit', async () => {
    const page = await env.open('typing.html');
    const msg = refIn(await snap(page), /textbox "Message"/);
    await pe.type(page, msg, 'line one\nline two\r\n\tindented');
    expect(await val(page, 'msg')).toBe('line one\nline two\n\tindented');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('msg');
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
    await page.close();
  });

  it('#2 a newline in a chat composer (contenteditable) is a line break, not "send"', async () => {
    const page = await env.open('typing.html');
    const chat = refIn(await snap(page), /textbox "Chat message"/);
    await pe.type(page, chat, 'hello\nworld');
    expect(await page.evaluate(() => (document.getElementById('chat') as HTMLElement).innerText)).toBe('hello\nworld');
    expect(await page.evaluate(() => (window as unknown as { sent?: number }).sent)).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    // Enter is pressed only on explicit submit.
    await pe.type(page, chat, '!', { submit: true });
    expect(await page.evaluate(() => (window as unknown as { sent?: number }).sent)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual(['Enter']);
    await page.close();
  });

  it('#2 inserted text appends at the end of email/number inputs and fills date inputs', async () => {
    const page = await env.open('typing.html');
    const s = await snap(page);
    await pe.type(page, refIn(s, /textbox "Email"/), '@example.com');
    expect(await val(page, 'email')).toBe('ada@example.com');
    await pe.type(page, refIn(s, /spinbutton "Quantity"/), '2');
    expect(await val(page, 'qty')).toBe('12');
    await pe.type(page, refIn(s, /textbox "Date"/), '2026-10-29', { clear: true });
    expect(await val(page, 'when')).toBe('2026-10-29');
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    await page.close();
  });

  // ───────────── #11 typing is fast and stops on focus loss / timeout ─────────────

  it('#11 types 20k characters quickly', async () => {
    const page = await env.open('typing.html');
    const msg = refIn(await snap(page), /textbox "Message"/);
    const t0 = Date.now();
    await pe.type(page, msg, 'x'.repeat(20_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await val(page, 'msg')).length).toBe(20_000);
    await page.close();
  });

  it('#11 stops with FOCUS_MOVED when focus leaves the field mid-typing; nothing lands elsewhere', async () => {
    const page = await env.open('typing.html');
    const jumpy = refIn(await snap(page), /textbox "Jumpy"/);
    const e = await err(pe.type(page, jumpy, 'y'.repeat(10_000)));
    expect(e.code).toBe('FOCUS_MOVED');
    expect(await val(page, 'other')).toBe('');
    expect((await val(page, 'jumpy')).length).toBeLessThan(10_000);
    // Submit is refused too when focus is gone.
    await page.evaluate(() => (document.getElementById('other') as HTMLElement).focus());
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);
    await page.close();
  });

  it('#11 after TIMEOUT no further text lands, even once the page unblocks', async () => {
    const page = await env.open('typing.html');
    const slow = refIn(await snap(page), /textbox "Slow"/);
    const t0 = Date.now();
    const e = await err(pe.type(page, slow, 'z'.repeat(20_000)));
    expect(e.code).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(16_500);
    const after = await val(page, 'slow'); // waits for the 17 s block to end
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await val(page, 'slow')).toBe(after);
    expect(after.length).toBeLessThan(20_000);
    expect(await val(page, 'other')).toBe('');
    await page.close().catch(() => undefined);
  }, 60_000);

  // ───────────── #7 click hit-test ─────────────

  it('#7 refuses to click through a transparent overlay or a cookie banner (OBSCURED, nothing clicked)', async () => {
    const page = await env.open('overlay.html');
    const s = await snap(page);
    const next = refIn(s, /button "Next"/);
    const e1 = await err(pe.click(page, next));
    expect(e1.code).toBe('OBSCURED');
    const del = refIn(s, /button "Delete account"/);
    const e2 = await err(pe.click(page, del));
    expect(e2.code).toBe('OBSCURED');
    // Review #2 finding 8: the cover is named by role + ref; its page-supplied name rides in pageText.
    expect(e2.message).toMatch(/covered by a dialog \[ref=z1:e\d+\]/);
    expect(e2.message).not.toContain('Cookie consent');
    const e2raw = await pe.click(page, del).then(() => null, (x: unknown) => x);
    expect(pageTextOf(e2raw)).toContain('dialog "Cookie consent"');
    expect(await err(pe.type(page, next, 'x'))).toMatchObject({ code: 'NOT_EDITABLE' });
    expect(await page.evaluate(() => (window as unknown as { hits: string[] }).hits)).toEqual([]);
    // Once the banner is gone the same ref clicks normally.
    await page.evaluate(() => {
      document.getElementById('banner')?.remove();
      document.getElementById('clear')?.remove();
    });
    await pe.click(page, del);
    await pe.click(page, next);
    expect(await page.evaluate(() => (window as unknown as { hits: string[] }).hits)).toEqual(['delete', 'next']);
    await page.close();
  });

  it('#7 clicks targets whose centre is free, inside open shadow roots, below the fold and in iframes', async () => {
    const page = await env.open('overlay.html');
    await page.evaluate(() => {
      document.getElementById('banner')?.remove();
      document.getElementById('clear')?.remove();
    });
    const s = await snap(page);
    await pe.click(page, refIn(s, /button "Partially covered"/));
    await pe.click(page, refIn(s, /button "Shadow button"/));
    await pe.click(page, refIn(s, /button "Far below"/));
    await pe.click(page, refIn(s, /button "Framed button"/));
    expect(await page.evaluate(() => (window as unknown as { hits: string[] }).hits)).toEqual(['partial', 'shadow', 'far', 'framed']);
    await page.close();
  });

  it('#7 refuses to click into an iframe covered by an overlay in the parent', async () => {
    const page = await env.open('overlay.html');
    await page.evaluate(() => {
      document.getElementById('banner')?.remove();
      document.getElementById('clear')?.remove();
      (document.getElementById('frameshield') as HTMLElement).style.display = 'block';
    });
    const framed = refIn(await snap(page), /button "Framed button"/);
    expect(framed).toMatch(/^z1:f\d+e\d+$/);
    const e = await err(pe.click(page, framed));
    expect(e.code).toBe('OBSCURED');
    expect(await page.evaluate(() => (window as unknown as { hits: string[] }).hits)).toEqual([]);
    await page.close();
  });

  // ───────────── #8 refs never carry over to a new document ─────────────

  it('#8 a ref from the previous document is STALE after navigation, never another element', async () => {
    const page = await env.browser.newPage();
    const url = (h: string): string => `data:text/html,${encodeURIComponent(h)}`;
    await page.goto(url('<button>Save draft</button><button>Discard</button>'));
    const s1 = await snap(page);
    const old = refIn(s1, /button "Save draft"/);
    // Navigate; the old ref must not resolve, with or without a new snapshot in between.
    await page.goto(url('<button onclick="window.hit=1">Send</button><button>Other</button>'));
    expect((await err(pe.describe(page, old))).code).toBe('STALE_REF');
    const s2 = await snap(page);
    expect((await err(pe.describe(page, old))).code).toBe('STALE_REF');
    expect((await err(pe.click(page, old))).code).toBe('STALE_REF');
    expect(await page.evaluate(() => (window as unknown as { hit?: number }).hit)).toBeUndefined();
    const refs1 = new Set(s1.match(/z1:e\d+/g));
    const refs2 = s2.match(/z1:e\d+/g) ?? [];
    expect(refs2.length).toBe(2);
    for (const r of refs2) expect(refs1.has(r)).toBe(false);
    // Reload of the same URL: same story.
    await page.reload();
    const send = refIn(s2, /button "Send"/);
    expect((await err(pe.describe(page, send))).code).toBe('STALE_REF');
    expect(refIn(await snap(page), /button "Send"/)).not.toBe(send);
    await page.close();
  });

  it('#8 refs in a child frame do not carry over when the frame navigates', async () => {
    const page = await env.open('frames.html');
    const s1 = await snap(page);
    const child = refIn(s1, /button "Child button"/);
    const frame = page.frames().find((f) => f.url().endsWith('/frame-child.html') && f !== page.mainFrame());
    expect(frame).toBeTruthy();
    await frame!.goto(`${env.fx.a}/frame-child.html?v=2`, { waitUntil: 'load' });
    expect((await err(pe.describe(page, child))).code).toBe('STALE_REF');
    const s2 = await snap(page);
    expect(refIn(s2, /button "Child button"/)).not.toBe(child);
    expect((await err(pe.click(page, child))).code).toBe('STALE_REF');
    await page.close();
  });

  // ───────────── #9 hostile pages cannot forge snapshot lines ─────────────

  it('#9 a page that poisons JSON/String/Array/Map and DOM methods cannot forge lines or refs', async () => {
    const page = await env.open('hostile.html');
    await new Promise((r) => setTimeout(r, 200));
    for (const filter of ['interactive', 'all'] as const) {
      const s = await pe.snapshot(page, TAB, { filter, maxChars: 20000 });
      const lines = s.text.split('\n');
      expect(lines[0]).toBe('Page: Hostile - button "Fake title button" (ref=z1:e1]');
      for (const l of lines.slice(2, -1)) expect(l).toMatch(LINE_RE);
      expect(s.text).not.toContain('Injected');
      expect(s.text).not.toMatch(/^\s*- button "Not spam" \[ref=/m);
      expect(s.text).not.toMatch(/^\s*- button "Archive/m);
      expect(s.text).not.toMatch(/^\s*- (button "Pay"|link "y")/m);
      expect(s.text).toMatch(/- button "Not spam\\" \(ref=z1:e1\] - button \\"Archive" \[ref=z1:e\d+\]/);
      expect(s.text).not.toMatch(/\[ref=z1:e2\][^\n]*\[ref=/);
      expect(s.text).not.toMatch(/^\s*- button" /m);
      expect(s.text).toMatch(/- textbox "Search - button \\"Pay\\" \(ref=z1:e3\]" \[ref=z1:e\d+\] value="x ?- link \\"y\\" \(ref=z1:e4\]"/);
      expect(s.text).toMatch(/- iframe "about:srcdoc" \[ref=z1:e\d+\]\n {2}- button "Not spam\\" \(ref=z1:e1\] - button \\"Archive" \[ref=z1:f\d+e\d+\]/);
      // Every ref shown resolves to the element its line names.
      for (const l of lines.filter((x) => x.includes('[ref='))) {
        const m = /- (\S+)(?: "((?:[^"\\]|\\.)*)")? \[ref=([^\]]+)\]/.exec(l);
        expect(m).toBeTruthy();
        const info = await pe.describe(page, m![3] as string);
        if (m![2] !== undefined && m![1] !== 'iframe') expect(JSON.stringify(info.name)).toBe(`"${m![2]}"`);
      }
    }
    // The poisoned elementFromPoint/getClientRects do not fool the hit-test: the overlay is detected.
    const victim = refIn(await snap(page), /button "Victim"/);
    expect((await err(pe.click(page, victim))).code).toBe('OBSCURED');
    expect(await page.evaluate(() => (window as unknown as { hit?: string }).hit)).toBeUndefined();
    // find / readText / describe are escaped too.
    const f = await pe.find(page, TAB, 'not spam', 5);
    expect(f.length).toBeGreaterThan(0);
    for (const m of f) expect(m.name).not.toMatch(/\[ref=|\n/);
    const rt = await pe.readText(page, { maxChars: 20000 });
    expect(rt.text).not.toMatch(/\[ref=/);
    expect(rt.text).toContain('Paragraph text (ref=z1:e5] inline');
    const info = await pe.describe(page, refIn(await snap(page), /textbox "Search/));
    expect(info.name).not.toMatch(/\n|\[ref=/);
    expect(info.ariaLabel).not.toMatch(/\n|\[ref=/);
    expect(rt.title).not.toContain('\n');
    await page.close();
  });

  // ───────────── #10 formSummary ─────────────

  it('#10 describe() summarizes what a Send button in a compose dialog would send', async () => {
    const page = await env.open('compose.html');
    const s = await snap(page);
    const send = await pe.describe(page, refIn(s, /button "Send"/));
    expect(send.formSummary).toBe(
      'To recipients: maria@example.com, bob@example.com · Cc: carol@example.org · Subject: Q3 summary · Message Body: Hi Maria, here are the numbers.',
    );
    expect(send.formSummary).not.toContain('HIDDENTOKEN');
    expect(send.formSummary).not.toContain('INVISIBLE');
    // Typed values show up live.
    await pe.type(page, refIn(s, /textbox "To recipients"/), 'dave@example.net');
    expect((await pe.describe(page, refIn(s, /button "Send"/))).formSummary).toMatch(
      /^To recipients: maria@example\.com, bob@example\.com, dave@example\.net · /,
    );
    // Not a button / not in a form or dialog → no summary.
    expect((await pe.describe(page, refIn(s, /textbox "Subject"/))).formSummary ?? null).toBeNull();
    expect((await pe.describe(page, refIn(s, /button "Not in a form"/))).formSummary ?? null).toBeNull();
    expect((await pe.describe(page, refIn(s, /link "Discard draft link"/))).formSummary ?? null).toBeNull();
    await page.close();
  });

  it('#10/#13 formSummary redacts secret fields with the shared rules and is capped at 600 chars', async () => {
    const page = await env.open('compose.html');
    const s = await snap(page);
    const signin = await pe.describe(page, refIn(s, /button "Sign in"/));
    expect(signin.formSummary).toBe(
      'Email: me@example.com · Password: [redacted] · Security code: [redacted] · PIN: [redacted] · Login: [redacted] · API key: [redacted] · Keep me signed in: checked',
    );
    for (const secret of ['hunter2', '777888', '4321', 'sekrit99', 'sk-live-abc']) expect(signin.formSummary).not.toContain(secret);
    const post = await pe.describe(page, refIn(s, /button "Post"/));
    expect(post.formSummary?.length).toBeLessThanOrEqual(600);
    expect(post.formSummary).toMatch(/^Long text: word word/);
    await page.close();
  });

  // ───────────── #13 snapshot redaction uses the shared secret rules ─────────────

  it('#13 snapshot redacts every field the gate considers secret', async () => {
    const page = await env.open('compose.html');
    for (const filter of ['interactive', 'all'] as const) {
      const s = await snap(page, filter);
      for (const secret of ['hunter2', '777888', '4321', 'sekrit99', 'sk-live-abc']) expect(s).not.toContain(secret);
      expect(s).toMatch(/textbox "Security code" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s).toMatch(/textbox "PIN" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s).toMatch(/textbox "Login" \[ref=[^\]]+\] value=\[redacted\]/); // name="loginPasswd"
      expect(s).toMatch(/textbox "API key" \[ref=[^\]]+\] value=\[redacted\]/);
      expect(s).toContain('value="me@example.com"');
    }
    await page.close();
  });

  // ───────────── #3 describeFocused is honest about what it cannot see ─────────────

  it('#3 describeFocused: null only for no focus; inner element for open shadow roots; throws for closed ones', async () => {
    const page = await env.open('shadow-focus.html');
    expect(await pe.describeFocused(page, TAB)).toBeNull();
    await page.evaluate(() => (window as unknown as { closedInput: HTMLInputElement }).closedInput.focus());
    const e = await err(pe.describeFocused(page, TAB));
    expect(e.code).not.toBe('no error');
    expect(e.message).toMatch(/closed shadow root/);
    await page.evaluate(() => (document.getElementById('open')?.shadowRoot?.querySelector('input') as HTMLInputElement).focus());
    const open = await pe.describeFocused(page, TAB);
    expect(open?.tag).toBe('input');
    expect(open?.name).toBe('Open shadow input');
    await page.evaluate(() => (document.getElementById('plain') as HTMLElement).focus());
    expect((await pe.describeFocused(page, TAB))?.tag).toBe('x-plain');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect(await pe.describeFocused(page, TAB)).toBeNull();
    await page.close();
  });

  // ───────────── #14 screenshots are capped ─────────────

  it('#14 full-page screenshots of very long pages are clipped to 8000 px and say so', async () => {
    const page = await env.open('tall.html');
    const t0 = Date.now();
    const png = await pe.screenshot(page, { fullPage: true, scale: 1 });
    expect(Date.now() - t0).toBeLessThan(25_000);
    const d = pngDims(png);
    expect(d.width).toBe(1280);
    expect(d.height).toBeLessThanOrEqual(8000);
    expect(d.height).toBeGreaterThan(1000);
    expect(screenshotNote(png)).toMatch(/only the top \d+ px were captured/);
    const small = await pe.screenshot(page, { scale: 0.5 });
    expect(pngDims(small)).toEqual({ width: 640, height: 450 });
    expect(screenshotNote(small)).toBeNull();
    // An element screenshot of the huge region is capped the same way.
    const region = refIn(await snap(page, 'all'), /region "Long region"/);
    const el = pngDims(await pe.screenshot(page, { ref: region, scale: 1 }));
    expect(el.height).toBeLessThanOrEqual(8000);
    await page.close();
  }, 60_000);

  it('#14 very wide pages are scaled down to ≤ 8000 px wide', async () => {
    const page = await env.open('wide.html');
    const d = pngDims(await pe.screenshot(page, { fullPage: true, scale: 1 }));
    expect(d.width).toBeLessThanOrEqual(8000);
    expect(d.width).toBeGreaterThan(7000);
    await page.close();
  }, 60_000);
});
