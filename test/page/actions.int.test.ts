import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHubError } from '../../src/errors.js';
import { pageEngine as pe } from '../../src/page/index.js';
import { PROTOCOLS } from '../helpers/chromium.js';
import { closeEnv, pngDims, refIn, setupEnv, type Env } from './helpers.js';

const TAB = 'z1';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isHubError(e) ? e.code : `non-hub: ${String(e)}`;
  }
  return 'no error';
}

async function snap(page: Page): Promise<string> {
  return (await pe.snapshot(page, TAB, { filter: 'interactive', maxChars: 20000 })).text;
}

const val = (page: Page, id: string): Promise<string> =>
  page.evaluate((i) => (document.getElementById(i) as HTMLInputElement).value, id);

describe.each(PROTOCOLS)('page engine actions over %s', (protocol) => {
  let env: Env;
  let tmp: string;
  beforeAll(async () => {
    env = await setupEnv(protocol);
    tmp = await mkdtemp(join(tmpdir(), 'bh-page-'));
  });
  afterAll(async () => {
    await closeEnv(env);
    await rm(tmp, { recursive: true, force: true });
  });

  it('describes the focused element, in the page and inside an iframe', async () => {
    const page = await env.open('controls.html');
    expect(await pe.describeFocused(page, TAB)).toBeNull();
    await page.focus('#bio');
    const bio = await pe.describeFocused(page, TAB);
    expect(bio?.tag).toBe('textarea');
    expect(bio?.name).toBe('Bio');
    // The ref it hands out is a normal, usable ref.
    expect((await pe.describe(page, bio!.ref)).tag).toBe('textarea');
    await page.close();

    const framed = await env.open('frames.html');
    await snap(framed); // registers child frames
    const child = framed.frames().find((f) => f.url().includes('frame-child'));
    expect(child).toBeTruthy();
    await child!.focus('#childinput');
    const inFrame = await pe.describeFocused(framed, TAB);
    expect(inFrame?.name).toBe('Child input');
    expect(inFrame?.ref).toMatch(/^z1:f\d+e\d+$/);
    await framed.close();
  });

  it('types: append, clear+replace, submit, textarea, non-ASCII', async () => {
    const page = await env.open('controls.html');
    const s = await snap(page);
    const name = refIn(s, /textbox "Full name"/);
    await pe.type(page, name, ' more');
    expect(await val(page, 'name')).toBe('Old value more');
    await pe.type(page, name, 'Ada Lovelace', { clear: true });
    expect(await val(page, 'name')).toBe('Ada Lovelace');
    await pe.type(page, name, 'Café ✓', { clear: true, submit: true });
    expect(await val(page, 'name')).toBe('Café ✓');
    await page.waitForFunction(() => document.title.startsWith('submitted:'));
    expect(await page.title()).toBe('submitted:Café ✓');
    const bio = refIn(s, /textbox "Bio"/);
    await pe.type(page, bio, 'line one', { clear: true });
    expect(await val(page, 'bio')).toBe('line one');
    await page.close();
  });

  it('types into contenteditable (append and clear)', async () => {
    const page = await env.open('controls.html');
    const notes = refIn(await snap(page), /textbox "Notes"/);
    await pe.type(page, notes, ' world');
    expect(await page.evaluate(() => document.getElementById('ce')?.textContent)).toBe('Hello world');
    await pe.type(page, notes, 'Fresh start', { clear: true });
    expect(await page.evaluate(() => document.getElementById('ce')?.textContent)).toBe('Fresh start');
    await page.close();
  });

  it('refuses to type into non-editable things', async () => {
    const page = await env.open('controls.html');
    const s = await snap(page);
    expect(await code(pe.type(page, refIn(s, /button "Double me"/), 'x'))).toBe('NOT_EDITABLE');
    expect(await code(pe.type(page, refIn(s, /textbox "Read only"/), 'x'))).toBe('NOT_EDITABLE');
    expect(await code(pe.type(page, refIn(s, /combobox "Country"/), 'x'))).toBe('NOT_EDITABLE');
    expect(await val(page, 'ro')).toBe('fixed');
    await page.close();
  });

  it('selects options by visible label or value, single and multiple', async () => {
    const page = await env.open('controls.html');
    const s = await snap(page);
    const country = refIn(s, /combobox "Country"/);
    expect(await pe.selectOption(page, country, ['Canada'])).toEqual(['ca']);
    expect(await page.evaluate(() => (window as unknown as { changed: number }).changed)).toBe(1);
    expect(await pe.selectOption(page, country, ['us'])).toEqual(['us']);
    expect(await pe.selectOption(page, country, ['mexico'])).toEqual(['mx']); // case-insensitive label
    expect(await val(page, 'country')).toBe('mx');
    expect(await pe.selectOption(page, refIn(s, /listbox "Languages"/), ['English', 'de'])).toEqual(['en', 'de']);
    expect(await code(pe.selectOption(page, country, ['Atlantis']))).toBe('INVALID_ARG');
    const custom = refIn(s, /combobox "Custom dropdown"/);
    try {
      await pe.selectOption(page, custom, ['x']);
      expect.unreachable();
    } catch (e) {
      expect(isHubError(e) && e.code).toBe('INVALID_ARG');
      expect((e as Error).message).toMatch(/Click it/);
    }
    const after = await snap(page);
    expect(after).toMatch(/combobox "Country" \[ref=[^\]]+\] value="Mexico"/);
    await page.close();
  });

  it('clicks: double, right, hover', async () => {
    const page = await env.open('controls.html');
    const s = await snap(page);
    const dbl = refIn(s, /button "Double me"/);
    await pe.click(page, dbl, { double: true });
    await pe.click(page, dbl, { button: 'right' });
    await pe.hover(page, refIn(s, /button "Hover me"/));
    const ds = await page.evaluate(() => ({
      dbl: document.getElementById('dbl')?.dataset['dbl'],
      ctx: document.getElementById('dbl')?.dataset['ctx'],
      hov: document.getElementById('hov')?.dataset['hovered'],
    }));
    expect(ds).toEqual({ dbl: 'yes', ctx: 'yes', hov: 'yes' });
    await page.close();
  });

  it('presses keys and combos with modifiers released afterwards', async () => {
    const page = await env.open('controls.html');
    await pe.click(page, refIn(await snap(page), /textbox "Key log"/));
    await pe.pressKey(page, 'Control+Shift+K');
    await pe.pressKey(page, 'Meta+a');
    await pe.pressKey(page, 'Enter');
    await pe.pressKey(page, 'esc');
    await pe.pressKey(page, 'x');
    const log = await page.evaluate(() => (window as unknown as { keylog: string[] }).keylog);
    expect(log).toEqual([
      'Control+Control',
      'Control+Shift+Shift',
      'Control+Shift+K',
      'Meta+Meta',
      'Meta+a',
      'Enter',
      'Escape',
      'x',
    ]);
    // select-all (Control+A, or Cmd+A on a Mac where Control+A means line start), then replace by typing
    await page.evaluate(() => {
      (document.getElementById('keys') as HTMLInputElement).value = 'abc';
    });
    await pe.pressKey(page, 'ControlOrMeta+A');
    await page.keyboard.type('z');
    expect(await val(page, 'keys')).toBe('z');
    expect(await code(pe.pressKey(page, 'Hyper+Q'))).toBe('INVALID_ARG');
    expect(await code(pe.pressKey(page, 'NoSuchKey'))).toBe('INVALID_ARG');
    await page.close();
  });

  it('scrolls the window and scrollable elements', async () => {
    const page = await env.open('controls.html');
    await pe.scroll(page, { direction: 'down', amount: 500 });
    expect(await page.evaluate(() => window.scrollY)).toBe(500);
    await pe.scroll(page, { direction: 'up', amount: 200 });
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    const [m] = await pe.find(page, TAB, 'scroll content', 1);
    expect(m).toBeDefined();
    await pe.scroll(page, { ref: m?.ref as string, direction: 'down', amount: 100 });
    await pe.scroll(page, { ref: m?.ref as string, direction: 'right', amount: 40 });
    expect(await page.evaluate(() => [document.getElementById('box')?.scrollTop, document.getElementById('box')?.scrollLeft])).toEqual([100, 40]);
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    expect(await code(pe.scroll(page, { ref: 'z1:e9999', direction: 'down', amount: 100 }))).toBe('STALE_REF');
    await page.close();
  });

  it('waits for text to appear / disappear and times out', async () => {
    const page = await env.open('controls.html');
    await page.evaluate(() => {
      setTimeout(() => {
        (document.getElementById('status') as HTMLElement).textContent = 'Upload   complete';
      }, 400);
    });
    const t0 = Date.now();
    await pe.waitFor(page, { text: 'upload complete', timeoutMs: 5000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    await pe.waitFor(page, { textGone: 'Idle', timeoutMs: 1000 });
    const t1 = Date.now();
    try {
      await pe.waitFor(page, { text: 'never shows up', timeoutMs: 700 });
      expect.unreachable();
    } catch (e) {
      expect(isHubError(e) && e.code).toBe('TIMEOUT');
    }
    expect(Date.now() - t1).toBeLessThan(3000);
    // text inside a child frame counts too
    const fr = await env.open('frames.html');
    await pe.waitFor(fr, { text: 'Cross-origin frame text', timeoutMs: 3000 });
    await page.close();
    await fr.close();
  });

  it('screenshots at scale in both protocols (viewport, full page, element)', async () => {
    const page = await env.open('controls.html');
    const full = pngDims(await pe.screenshot(page, { scale: 1 }));
    expect(full).toEqual({ width: 1280, height: 900 });
    expect(pngDims(await pe.screenshot(page, { scale: 0.5 }))).toEqual({ width: 640, height: 450 });
    expect(pngDims(await pe.screenshot(page, { scale: 0.1 }))).toEqual({ width: 128, height: 90 });
    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    const fp = pngDims(await pe.screenshot(page, { fullPage: true, scale: 0.25 }));
    expect(fp.width).toBe(320);
    expect(Math.abs(fp.height - Math.round(docH * 0.25))).toBeLessThanOrEqual(1);
    const btn = refIn(await snap(page), /button "Double me"/);
    const box = await page.evaluate(() => {
      const r = document.getElementById('dbl')!.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const el = pngDims(await pe.screenshot(page, { ref: btn, scale: 1 }));
    expect(Math.abs(el.width - box.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(el.height - box.h)).toBeLessThanOrEqual(2);
    const half = pngDims(await pe.screenshot(page, { ref: btn, scale: 0.5 }));
    expect(Math.abs(half.width - el.width / 2)).toBeLessThanOrEqual(1);
    await page.close();
  });

  it('uploads files to visible and visually-hidden file inputs', async () => {
    const page = await env.open('controls.html');
    const s = await snap(page);
    const f1 = join(tmp, 'resume.txt');
    const f2 = join(tmp, 'photo.txt');
    await writeFile(f1, 'cv');
    await writeFile(f2, 'img');
    await pe.uploadFile(page, refIn(s, /button "Resume" .*type=file/), [f1]);
    expect(await page.evaluate(() => (document.getElementById('file') as HTMLInputElement).files?.[0]?.name)).toBe('resume.txt');
    await pe.uploadFile(page, refIn(s, /button "Attach photos" .*type=file hidden/), [f1, f2]);
    expect(
      await page.evaluate(() => Array.from((document.getElementById('hiddenfile') as HTMLInputElement).files ?? []).map((f) => f.name)),
    ).toEqual(['resume.txt', 'photo.txt']);
    expect(await code(pe.uploadFile(page, refIn(s, /button "Resume"/), [f1, f2]))).toBe('INVALID_ARG'); // not multiple
    expect(await code(pe.uploadFile(page, refIn(s, /button "Double me"/), [f1]))).toBe('INVALID_ARG');
    expect(await code(pe.uploadFile(page, refIn(s, /button "Resume"/), [join(tmp, 'missing.txt')]))).toBe('INVALID_ARG');
    await page.close();
  });

  it('times out instead of hanging when the page is blocked', async () => {
    const page = await env.open('controls.html');
    const s = await snap(page);
    const ref = refIn(s, /button "Double me"/);
    // A busy page main thread: evaluate cannot run until the loop ends (~20 s); we give up at 15 s.
    void page.evaluate(() => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        /* spin */
      }
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    expect(await code(pe.describe(page, ref))).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(17_000);
    await page.close().catch(() => undefined);
  }, 40_000);
});
