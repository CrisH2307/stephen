import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../../src/errors.js';
import { normalizeUrl } from '../../src/server/index.js';
import type { ActionRequest } from '../../src/types.js';
import { FakePage, allow, deny, setup, textOf } from './fakes.js';

vi.mock('../../src/safety/index.js', () => import('./safety-mock.js'));

const EXPECTED_TOOLS = [
  'browser_status',
  'browser_connect',
  'tabs_list',
  'tab_open',
  'tab_focus',
  'tab_close',
  'navigate',
  'history',
  'snapshot',
  'find',
  'read_text',
  'screenshot',
  'click',
  'hover',
  'type',
  'fill_form',
  'select_option',
  'press_key',
  'scroll',
  'wait_for',
  'upload_file',
  'handle_dialog',
  'recent_actions',
  // Stephen desktop actions (src/desktop), registered by default (desktop.enabled).
  'open_app',
  'open_url',
  'play_media',
  'desktop_status',
];

describe('server surface', () => {
  it('lists every tool with annotations; evaluate is absent by default', async () => {
    const h = await setup();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(names).not.toContain('evaluate');

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['browser_status', 'tabs_list', 'snapshot', 'find', 'read_text', 'screenshot', 'wait_for', 'recent_actions']) {
      expect(byName[n]!.annotations?.readOnlyHint, n).toBe(true);
    }
    for (const n of ['click', 'type', 'fill_form', 'select_option', 'press_key', 'upload_file', 'handle_dialog', 'tab_close']) {
      expect(byName[n]!.annotations?.destructiveHint, n).toBe(true);
      expect(byName[n]!.annotations?.readOnlyHint, n).toBe(false);
    }
    for (const n of ['navigate', 'tab_open', 'hover', 'scroll', 'history']) {
      expect(byName[n]!.annotations?.destructiveHint, n).toBe(false);
    }
    for (const t of tools) {
      expect(t.annotations?.openWorldHint, t.name).toBe(t.name !== 'recent_actions' && t.name !== 'desktop_status');
      expect(t.description!.length, t.name).toBeGreaterThan(60);
    }
    // Every mutating tool requires intent.
    for (const n of ['tab_open', 'tab_close', 'navigate', 'history', 'click', 'type', 'fill_form', 'select_option', 'press_key', 'upload_file', 'handle_dialog']) {
      expect(byName[n]!.inputSchema.required, n).toContain('intent');
    }
  });

  it('registers evaluate only when safety.allowEvaluate', async () => {
    const h = await setup({ overrides: { safety: { allowEvaluate: true } } });
    const { tools } = await h.client.listTools();
    const ev = tools.find((t) => t.name === 'evaluate');
    expect(ev?.annotations?.destructiveHint).toBe(true);

    h.gate.decide = () => allow(['evaluate']);
    const res = await h.call('evaluate', { tab: 'z1', expression: 'document.title', intent: 'check title' });
    expect(res.isError).toBeFalsy();
    expect(h.gate.checks.at(-1)).toMatchObject({ kind: 'evaluate', text: 'document.title' });
    expect(textOf(res)).toContain('<untrusted_web_content source="z1"');
    expect(textOf(res)).toContain('"evaluated": "document.title"');
  });

  it('identifies as Stephen and sends workflow + safety instructions', async () => {
    const h = await setup();
    expect(h.client.getServerVersion()?.name).toBe('stephen');
    const ins = h.client.getInstructions() ?? '';
    for (const s of ['browser_status', 'z1:e12', 'untrusted_web_content', 'stale', 'approve', 'Passwords']) {
      expect(ins).toContain(s);
    }
    // introduces the assistant as Stephen, with Claude (the model) as the AI behind it
    expect(ins).toMatch(/^Stephen is the user's Mac assistant, and you are the AI behind it/);
    expect(ins).not.toContain('browser-hub');
  });

  it('creates safety lazily on the first tool call, once', async () => {
    const h = await setup();
    expect(h.safetyFactory).not.toHaveBeenCalled();
    await h.call('browser_status');
    await h.call('tabs_list');
    expect(h.safetyFactory).toHaveBeenCalledTimes(1);
    expect(h.safetyFactory.mock.calls[0]![0]).toBe(h.cfg);
  });
});

describe('reads', () => {
  it('snapshot is gated as a read, wrapped as untrusted, and noted', async () => {
    const h = await setup();
    const res = await h.call('snapshot', { tab: 'z1' });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text.startsWith('<untrusted_web_content source="z1" origin="https://mail.example.com/inbox">')).toBe(true);
    expect(text).toContain('[ref=z1:e1]');
    expect(h.gate.checks[0]).toMatchObject({ kind: 'read', tool: 'snapshot', tab: 'z1', browser: 'zen', pageUrl: 'https://mail.example.com/inbox' });
    expect(h.gate.reads).toEqual(['https://mail.example.com/inbox']);
    expect(h.engine.snapshot).toHaveBeenCalledWith(expect.anything(), 'z1', { filter: 'interactive', maxChars: 20000 });
  });

  it('a denied read never touches the page', async () => {
    const h = await setup();
    h.gate.decide = () => deny('This site is blocked by Stephen policy.');
    const res = await h.call('read_text', { tab: 'z1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('This site is blocked by Stephen policy.');
    expect(h.engine.readText).not.toHaveBeenCalled();
    expect(h.gate.reads).toEqual([]);
  });

  it('find returns refs with context, wrapped', async () => {
    const h = await setup();
    const res = await h.call('find', { tab: 'z1', query: 'send' });
    expect(textOf(res)).toContain('1 match for "send" in z1');
    expect(textOf(res)).toContain('button "Send" [ref=z1:e1] — in form "Compose"');
    expect(textOf(res)).toContain('<untrusted_web_content');
    expect(h.engine.find).toHaveBeenCalledWith(expect.anything(), 'z1', 'send', 15);
    expect(h.gate.reads).toHaveLength(1);
  });

  it('read_text wraps title, url and text', async () => {
    const h = await setup();
    const res = await h.call('read_text', { tab: 'z1', max_chars: 5000 });
    const text = textOf(res);
    expect(text).toContain('Page: Inbox – Mail\nURL: https://mail.example.com/inbox\n\nHello world');
    expect(text).toMatch(/^<untrusted_web_content/);
    expect(h.engine.readText).toHaveBeenCalledWith(expect.anything(), { maxChars: 5000 });
  });

  it('save_to_file writes a 0600 file and returns its path plus a preview', async () => {
    const h = await setup();
    const big = `${'A'.repeat(1400)}MIDDLE${'B'.repeat(3000)}TAIL_MARKER`;
    h.engine.snapshot.mockResolvedValueOnce({ text: big, url: 'https://mail.example.com/inbox', title: 't', refCount: 0, hiddenOmitted: 0, truncated: false });
    const res = await h.call('snapshot', { tab: 'z1', save_to_file: true });
    const text = textOf(res);
    const m = /Saved the full snapshot output \(\d+ chars\) to (\S+)/.exec(text);
    expect(m).not.toBeNull();
    const path = m![1]!;
    expect(path.startsWith(h.cfg.output.saveDir)).toBe(true);
    expect(path).toMatch(/-z1-snapshot\.txt$/);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = readFileSync(path, 'utf8');
    expect(saved).toContain('TAIL_MARKER');
    expect(saved).toMatch(/^<untrusted_web_content/);
    expect(text).toContain('MIDDLE');
    expect(text).not.toContain('TAIL_MARKER');
    expect(text.length).toBeLessThan(2200);
    // The engine was asked for the full output, not the inline cap.
    expect(h.engine.snapshot.mock.calls[0]![2].maxChars).toBeGreaterThan(100_000);
  });

  it('screenshot returns image content at scale 0.5 by default', async () => {
    const h = await setup();
    const res = await h.call('screenshot', { tab: 'z1' });
    const img = res.content[0] as { type: string; data: string; mimeType: string };
    expect(img.type).toBe('image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    expect(h.engine.screenshot).toHaveBeenCalledWith(expect.anything(), { scale: 0.5 });
    expect(textOf(res)).toContain('Screenshot of z1');
    expect(h.gate.reads).toEqual(['https://mail.example.com/inbox']);
  });

  it('rejects a scope ref from another tab', async () => {
    const h = await setup();
    const res = await h.call('snapshot', { tab: 'z1', scope: 'z2:e3' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('WRONG_TAB');
  });
});

describe('actions', () => {
  it('a denied click performs no action and returns the gate message', async () => {
    const h = await setup();
    h.gate.decide = () => deny('Refused: the user declined clicking "Send".');
    const res = await h.call('click', { target: 'z1:e4', intent: 'send the reply' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Refused: the user declined clicking "Send".');
    expect(h.engine.click).not.toHaveBeenCalled();
    expect(h.audit.entries).toEqual([]); // the gate itself records the denial
    expect(h.gate.checks[0]).toMatchObject({
      kind: 'click',
      tool: 'click',
      tab: 'z1',
      browser: 'zen',
      intent: 'send the reply',
      element: expect.objectContaining({ ref: 'z1:e4', name: 'Send' }),
    });
  });

  it('an allowed click acts, audits and reports the new page', async () => {
    const h = await setup();
    h.engine.click.mockImplementationOnce(async (page) => {
      const p = page as unknown as FakePage;
      p.currentUrl = 'https://mail.example.com/sent';
      p.currentTitle = 'Sent – Mail';
    });
    const res = await h.call('click', { target: 'z1:e4', intent: 'send the reply', include_snapshot: true });
    const text = textOf(res);
    expect(text).toContain('Clicked z1:e4 in z1.\n<untrusted_web_content source="z1" origin="https://mail.example.com/sent">');
    // Page-derived facts (element label, title) are only ever inside the untrusted block.
    expect(text).toContain('element: button "Send"\npage now: "Sent – Mail" https://mail.example.com/sent</untrusted_web_content>');
    expect(text.split('<untrusted_web_content')[0]).not.toContain('Send');
    expect(text).toContain('refs from earlier snapshots are now stale');
    expect(text).toContain('<untrusted_web_content source="z1" origin="https://mail.example.com/sent">');
    expect(h.engine.click).toHaveBeenCalledWith(expect.anything(), 'z1:e4', {});
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({
      tool: 'click',
      tab: 'z1',
      kind: 'click',
      element: 'button "Send"',
      urlBefore: 'https://mail.example.com/inbox',
      urlAfter: 'https://mail.example.com/sent',
      outcome: 'ok',
      intent: 'send the reply',
    });
  });

  // Review #2 finding 8: a page-layer error's message is shown inside the untrusted block (it may quote the page).
  it('stale-ref errors keep their code; the page-layer message is wrapped as untrusted', async () => {
    const h = await setup();
    h.engine.describe.mockRejectedValueOnce(new HubError('STALE_REF', 'Ref z1:e9 no longer exists — re-run snapshot.'));
    const res = await h.call('click', { target: 'z1:e9', intent: 'open it' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^STALE_REF: .*\n<untrusted_web_content source="page-error"[^>]*>Ref z1:e9 no longer exists — re-run snapshot\.<\/untrusted_web_content>$/s);
    expect(h.gate.checks).toEqual([]);
  });

  it('malformed refs and unknown tabs give actionable errors', async () => {
    const h = await setup();
    expect(textOf(await h.call('click', { target: 'Send button', intent: 'x' }))).toContain('BAD_REF');
    expect(textOf(await h.call('click', { target: 'z7:e1', intent: 'x' }))).toContain('TAB_NOT_FOUND');
  });

  it('unexpected errors are one line (no stack) and audited as errors', async () => {
    const h = await setup();
    const err = new Error('Node is detached from document');
    err.stack = 'Error: Node is detached from document\n    at secret/path.js:1:1';
    h.engine.click.mockRejectedValueOnce(err);
    const res = await h.call('click', { target: 'z1:e4', intent: 'x' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('>Node is detached from document</untrusted_web_content>');
    expect(textOf(res)).not.toContain('secret/path');
    expect(h.audit.entries[0]).toMatchObject({ outcome: 'error', error: 'Node is detached from document' });
  });

  // Updated in review #1: submit's Enter is now a SEPARATE press check (focus 'element'), not `key` on the type request.
  it('type redacts the value in audit and result; submit is checked together with the text (key Enter)', async () => {
    const h = await setup({ elements: { 'z1:e5': { role: 'textbox', name: 'Subject', tag: 'input', inputType: 'text', isEditable: true } } });
    const res = await h.call('type', { target: 'z1:e5', text: 'Quarterly report', intent: 'set subject', clear: true, submit: true });
    expect(textOf(res)).toContain('Typed [16 chars] "Quarterly …" into z1:e5 and pressed Enter in z1.');
    expect(textOf(res)).toContain('element: textbox "Subject"');
    expect(h.gate.checks).toHaveLength(1);
    expect(h.gate.checks[0]).toMatchObject({ kind: 'type', text: 'Quarterly report', key: 'Enter', element: expect.objectContaining({ ref: 'z1:e5' }) });
    expect(h.engine.type).toHaveBeenCalledWith(expect.anything(), 'z1:e5', 'Quarterly report', { clear: true, submit: true });
    expect(JSON.stringify(h.audit.entries)).not.toContain('Quarterly report');
  });

  it('fill_form aborts entirely if any field is denied', async () => {
    const h = await setup({
      elements: {
        'z1:e1': { role: 'textbox', name: 'Email', tag: 'input', inputType: 'email', isEditable: true },
        'z1:e2': { role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', isEditable: true },
        'z1:e3': { role: 'textbox', name: 'Name', tag: 'input', inputType: 'text', isEditable: true },
      },
    });
    h.gate.decide = (req: ActionRequest) =>
      req.element?.inputType === 'password' ? deny('Passwords are typed by the user. Ask them to enter it.') : allow();
    const res = await h.call('fill_form', {
      fields: [
        { target: 'z1:e1', value: 'a@b.c' },
        { target: 'z1:e2', value: 'hunter2' },
        { target: 'z1:e3', value: 'Cris' },
      ],
      intent: 'sign up',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Nothing was typed — field 2 of 3 (z1:e2) was refused: Passwords are typed by the user');
    expect(h.engine.type).not.toHaveBeenCalled();
    expect(h.engine.describe).toHaveBeenCalledTimes(3);
    expect(h.gate.checks).toHaveLength(2);
  });

  it('fill_form types each field with clear=true and selects <select> fields', async () => {
    const h = await setup({
      elements: {
        'z1:e1': { role: 'textbox', name: 'Title', tag: 'input', inputType: 'text', isEditable: true },
        'z1:e2': { role: 'combobox', name: 'Priority', tag: 'select', isEditable: true },
      },
    });
    const res = await h.call('fill_form', {
      fields: [
        { target: 'z1:e1', value: 'Fix bug' },
        { target: 'z1:e2', value: 'High' },
      ],
      intent: 'file the ticket',
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Filled 2 fields in z1');
    expect(h.engine.type).toHaveBeenCalledWith(expect.anything(), 'z1:e1', 'Fix bug', { clear: true });
    expect(h.engine.selectOption).toHaveBeenCalledWith(expect.anything(), 'z1:e2', ['High']);
    expect(h.gate.checks.map((c) => c.kind)).toEqual(['type', 'select']);
    expect(h.audit.entries).toHaveLength(2);
  });

  it('fill_form refuses fields from different tabs', async () => {
    const h = await setup();
    const res = await h.call('fill_form', { fields: [{ target: 'z1:e1', value: 'a' }, { target: 'c1:e1', value: 'b' }], intent: 'x' });
    expect(textOf(res)).toContain('same tab');
  });

  it('navigate normalizes the URL and waits for DOMContentLoaded', async () => {
    const h = await setup();
    const res = await h.call('navigate', { tab: 'z1', url: 'example.com/docs', intent: 'open the docs' });
    expect(res.isError).toBeFalsy();
    expect(h.page.gotoCalls).toEqual([['https://example.com/docs', { waitUntil: 'domcontentloaded', timeout: 30000 }]]);
    expect(h.gate.checks[0]).toMatchObject({ kind: 'navigate', targetUrl: 'https://example.com/docs', pageUrl: 'https://mail.example.com/inbox' });
    expect(textOf(res)).toContain('Navigated to https://example.com/docs in z1.\n<untrusted_web_content');
    expect(textOf(res)).toContain('page now: "Title of https://example.com/docs" https://example.com/docs');
    expect(h.audit.entries[0]).toMatchObject({ urlAfter: 'https://example.com/docs', outcome: 'ok' });
  });

  it('tab_open gates before opening and navigates the new tab', async () => {
    const h = await setup();
    h.gate.decide = (req) => (req.targetUrl?.includes('bank') ? deny('Blocked.') : allow());
    const denied = await h.call('tab_open', { browser: 'chrome', url: 'mybank.example', intent: 'check balance' });
    expect(denied.isError).toBe(true);
    expect(h.manager.pages.has('c1')).toBe(false);

    const res = await h.call('tab_open', { url: 'calendar.example.com', intent: 'check my calendar' });
    expect(textOf(res)).toContain('Opened z2 in zen and loaded https://calendar.example.com/');
    expect(h.gate.checks.at(-1)).toMatchObject({ kind: 'tab_open', browser: 'zen', targetUrl: 'https://calendar.example.com/' });
  });

  it('history back reports the resulting page', async () => {
    const h = await setup();
    await h.call('navigate', { tab: 'z1', url: 'https://a.example', intent: 'x' });
    const res = await h.call('history', { tab: 'z1', action: 'back', intent: 'go back to inbox' });
    expect(textOf(res)).toContain('Went back in z1.');
    expect(h.page.currentUrl).toBe('https://mail.example.com/inbox');
  });

  it('recent_actions formats the audit log compactly', async () => {
    const h = await setup();
    await h.call('click', { target: 'z1:e4', intent: 'send the reply' });
    const res = await h.call('recent_actions', { limit: 5 });
    expect(textOf(res)).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d click z1 button "Send" mail\.example\.com → ok — "send the reply"/);
  });

  it('browser_status lists browsers, tabs and settings', async () => {
    const h = await setup();
    const text = textOf(await h.call('browser_status'));
    expect(text).toContain('- chrome: not connected (will use the real profile) · cdp');
    expect(text).toContain('- zen: connected · agent profile · webDriverBiDi · zen/1.0');
    expect(text).toContain('- z1 "Inbox – Mail" https://mail.example.com/inbox');
    expect(text).toContain('confirm: auto');
    expect(text).toContain(h.cfg.auditLogPath);
  });

  it('browser_status / browser_connect say Zen is attach-only (the default); the instructions say not to loop', async () => {
    const h = await setup();
    h.manager.modes.zen = 'real';
    const status = textOf(await h.call('browser_status'));
    expect(status).toContain('Zen: attach-only (uses your open Zen; never launches one)');
    const res = await h.call('browser_connect', { browser: 'zen' });
    expect(h.manager.connectCalls).toEqual([['zen', 'real']]);
    expect(textOf(res)).toContain('Zen: attach-only (uses your open Zen; never launches one)');
    h.manager.connected.zen = false;
    expect(textOf(await h.call('browser_status'))).toContain("- zen: not connected (will attach to the user's open Zen, real profile)");
    const ins = h.client.getInstructions() ?? '';
    expect(ins).toContain('"Zen for Stephen" app');
    expect(ins).toMatch(/do not retry in a loop/);
    expect(ins).toMatch(/tab_open for a new tab in their Zen/);
  });

  it('browser_connect zen mode "agent" is refused when Zen is attach-only (it would start a separate Zen)', async () => {
    const h = await setup();
    const res = await h.call('browser_connect', { browser: 'zen', mode: 'agent' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/DENIED.*attach-only.*never starts a separate Zen window/s);
    expect(h.manager.connectCalls).toEqual([]);
    // the separate agent profile (launch: auto) still connects as before, and status does not claim attach-only
    const agent = await setup({ overrides: { zen: { mode: 'agent', launch: 'auto' } } });
    await agent.call('browser_connect', { browser: 'zen', mode: 'agent' });
    expect(agent.manager.connectCalls).toEqual([['zen', 'agent']]);
    expect(textOf(await agent.call('browser_status'))).not.toContain('attach-only');
  });

  it('browser_connect passes the mode through', async () => {
    const h = await setup();
    const res = await h.call('browser_connect', { browser: 'chrome', mode: 'agent' });
    expect(h.manager.connectCalls).toEqual([['chrome', 'agent']]);
    expect(textOf(res)).toContain('Connected to chrome');
  });

  it('upload_file checks files exist and passes absolute paths to the gate', async () => {
    const h = await setup({ elements: { 'z1:e8': { role: 'button', name: 'Attach', tag: 'input', inputType: 'file' } } });
    const missing = await h.call('upload_file', { target: 'z1:e8', paths: ['/nope/x.pdf'], intent: 'attach' });
    expect(textOf(missing)).toContain('File not found');
    const f = join(h.tmp, 'report.pdf');
    writeFileSync(f, 'pdf');
    const res = await h.call('upload_file', { target: 'z1:e8', paths: [f], intent: 'attach the report' });
    expect(h.gate.checks.at(-1)).toMatchObject({ kind: 'upload', files: [f] });
    expect(h.engine.uploadFile).toHaveBeenCalledWith(expect.anything(), 'z1:e8', [f]);
    expect(textOf(res)).toContain('Attached "report.pdf" to z1:e8 in z1.');
    expect(textOf(res)).toContain('element: button "Attach"');
  });
});

describe('dialogs', () => {
  it('reports a confirm dialog opened by an action, blocks the tab, and handle_dialog resolves it', async () => {
    const h = await setup();
    let dialog: ReturnType<FakePage['emitDialog']> | undefined;
    h.engine.click.mockImplementationOnce(async (page) => {
      dialog = (page as unknown as FakePage).emitDialog('confirm', 'Delete 3 messages?');
      return new Promise<void>(() => {}); // a real click hangs while a dialog is open
    });
    const res = await h.call('click', { target: 'z1:e4', intent: 'delete the drafts' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Clicked z1:e4 in z1 — then a confirm dialog opened on z1');
    expect(textOf(res)).toContain('Delete 3 messages?');

    const blocked = await h.call('snapshot', { tab: 'z1' });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain('A confirm dialog is open on z1');
    expect(textOf(blocked)).toContain('handle_dialog');
    expect(h.engine.snapshot).not.toHaveBeenCalled();

    const handled = await h.call('handle_dialog', { tab: 'z1', accept: true, intent: 'confirm deleting drafts' });
    expect(handled.isError).toBeFalsy();
    expect(textOf(handled)).toContain('Accepted the confirm dialog in z1');
    expect(dialog!.accepted).toBe(true);
    expect(h.gate.checks.at(-1)).toMatchObject({
      kind: 'dialog',
      dialog: { type: 'confirm', message: 'Delete 3 messages?', accept: true },
    });

    const again = await h.call('handle_dialog', { tab: 'z1', accept: false, intent: 'x' });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('NO_DIALOG');
  });

  it('a denied dialog accept leaves the dialog pending; dismiss is never gated', async () => {
    const h = await setup();
    await h.call('tabs_list'); // attach listeners
    await h.call('snapshot', { tab: 'z1' });
    const d = h.page.emitDialog('beforeunload', 'Leave site?');
    h.gate.decide = (req) => (req.kind === 'dialog' ? deny('The user said no.') : allow());
    const res = await h.call('handle_dialog', { tab: 'z1', accept: true, intent: 'leave' });
    expect(textOf(res)).toBe('The user said no.');
    expect(d.accepted).toBeNull();
    const checks = h.gate.checks.length;
    const dismissed = await h.call('handle_dialog', { tab: 'z1', accept: false, intent: 'stay' });
    expect(dismissed.isError).toBeFalsy();
    expect(d.dismissed).toBe(true);
    expect(h.gate.checks.length).toBe(checks);
  });

  it('alerts are auto-accepted and reported in the next result', async () => {
    const h = await setup();
    let alert: ReturnType<FakePage['emitDialog']> | undefined;
    h.engine.click.mockImplementationOnce(async (page) => {
      alert = (page as unknown as FakePage).emitDialog('alert', 'Saved!');
    });
    const res = await h.call('click', { target: 'z1:e4', intent: 'save' });
    expect(alert!.accepted).toBe(true);
    expect(textOf(res)).toContain('The page showed an alert (auto-accepted):');
    expect(textOf(res)).toContain('Saved!');
    expect(h.page.listenerCount('dialog')).toBe(1);
  });
});

describe('elicitation wiring', () => {
  it('client WITH elicitation: elicit sends elicitation/create and maps approve', async () => {
    const answers = [
      { action: 'accept' as const, content: { approve: true } },
      { action: 'accept' as const, content: { approve: false } },
      { action: 'decline' as const },
      { action: 'cancel' as const },
    ];
    const h = await setup({ elicitation: true, onElicit: () => answers.shift()! });
    h.gate.decide = async (req) => {
      const r = await h.safety.deps!.elicit!({ title: `Stephen wants to click "${req.element?.name}" on mail.example.com`, body: 'Claude says: send the reply' });
      return r === 'accept' ? { ...allow(), confirmation: 'approved' } : deny(`Not done: the user answered ${r}.`);
    };

    const ok = await h.call('click', { target: 'z1:e4', intent: 'send the reply' });
    expect(ok.isError).toBeFalsy();
    expect(h.engine.click).toHaveBeenCalledTimes(1);
    expect(h.elicitRequests[0]).toMatchObject({
      message: 'Stephen wants to click "Send" on mail.example.com\n\nClaude says: send the reply',
      requestedSchema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Allow this action?', default: false } },
        required: ['approve'],
      },
    });
    expect(h.audit.entries[0]).toMatchObject({ confirmation: 'approved', outcome: 'ok' });

    expect(textOf(await h.call('click', { target: 'z1:e4', intent: 'x' }))).toBe('Not done: the user answered decline.');
    expect(textOf(await h.call('click', { target: 'z1:e4', intent: 'x' }))).toBe('Not done: the user answered decline.');
    expect(textOf(await h.call('click', { target: 'z1:e4', intent: 'x' }))).toBe('Not done: the user answered cancel.');
    expect(h.engine.click).toHaveBeenCalledTimes(1);
  });

  it('client WITHOUT elicitation: elicit is undefined', async () => {
    const h = await setup();
    await h.call('browser_status');
    expect(h.safetyFactory).toHaveBeenCalledTimes(1);
    expect(h.safety.deps?.elicit).toBeUndefined();
    expect(textOf(await h.call('browser_status'))).toContain('in-chat approval not available');
  });
});

describe('normalizeUrl', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['  https://x.org/a?b=1 ', 'https://x.org/a?b=1'],
    ['http://plain.test', 'http://plain.test/'],
    ['localhost:3000/app', 'http://localhost:3000/app'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['//cdn.example.com/x', 'https://cdn.example.com/x'],
    ['about:blank', 'about:blank'],
    ['mail.google.com/mail/u/0/#inbox', 'https://mail.google.com/mail/u/0/#inbox'],
  ])('%s → %s', (input, out) => {
    expect(normalizeUrl(input)).toBe(out);
  });

  it('rejects javascript: and garbage', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/not allowed/);
    expect(() => normalizeUrl('   ')).toThrow(/empty/);
    expect(() => normalizeUrl('http://')).toThrow(/not a valid URL/);
  });
});
