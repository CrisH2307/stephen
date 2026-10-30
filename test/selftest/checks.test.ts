/**
 * Unit tests for the selftest check script against a scripted fake of the MCP tool surface.
 * (The real thing runs in selftest.int.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { pngSize, refFor, runChecks, type CheckResult, type ToolResult } from '../../src/selftest/checks.js';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });

function tinyPng(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

type Handler = (args: Record<string, unknown>) => ToolResult | undefined;

/** A well-behaved Stephen: everything works and every safety rule holds. `over` replaces single tools. */
function fakeHub(over: Record<string, Handler> = {}) {
  const hits: string[] = [];
  const submissions: string[] = [];
  const st = { page: 'blank', name: '', notes: '', color: '', extras: false };
  const snapshots: Record<string, () => string> = {
    form: () =>
      [
        '- main',
        `  - textbox "Full name" [ref=c1:e1]${st.name ? ` value="${st.name}"` : ''}`,
        `  - textbox "Notes" [ref=c1:e2]${st.notes ? ` value="${st.notes.replace('\n', '\\n')}"` : ''}`,
        `  - combobox "Color" [ref=c1:e3]`,
        `  - checkbox "Include extra details" [ref=c1:e4]${st.extras ? ' checked' : ''}`,
        '  - textbox "Password" [ref=c1:e5]',
        '  - button "Send" [ref=c1:e6]',
      ].join('\n'),
    overlay: () => '- button "Continue to next step" [ref=c1:e10]',
    frames: () => '- button "Parent button" [ref=c1:e12]\n- iframe "localhost"\n  - button "Frame button" [ref=c1:f1e1]',
  };
  const titles: Record<string, string> = { form: 'Selftest form', overlay: 'Selftest overlay', frames: 'Selftest frames' };
  const base: Record<string, Handler> = {
    browser_connect: () => ok('Connected to chrome (agent profile, Chrome/1).'),
    tab_open: () => ok('Opened new blank tab c1 in chrome.'),
    navigate: (a) => {
      st.page = String(a.url).split('/').pop()!;
      return ok(`Navigated to ${String(a.url)} in c1.\npage now: "${titles[st.page]}"`);
    },
    snapshot: () => ok(snapshots[st.page]?.() ?? ''),
    find: () => ok('1 match:\n- button "Send" [ref=c1:e6]'),
    type: (a) => {
      if (a.target === 'c1:e5') return err('DENIED: password field');
      if (a.target === 'c1:e1') st.name = String(a.text);
      if (a.target === 'c1:e2') st.notes = String(a.text);
      return ok('Typed.');
    },
    select_option: () => {
      st.color = 'green';
      return ok('Selected "Green" in c1:e3.\nselected: "green"');
    },
    click: (a) => {
      if (a.target === 'c1:e4') st.extras = !st.extras;
      else if (a.target === 'c1:e6') return err('Not performed: needs the user\'s confirmation (safety.confirm = "deny").');
      else if (a.target === 'c1:e10') return err('OBSCURED: covered by div');
      else if (a.target === 'c1:f1e1') hits.push('frame-button');
      else if (a.target === 'c1:e12' && st.page !== 'frames') return err('STALE_REF: c1:e12 is gone');
      return ok('Clicked.');
    },
    read_text: () =>
      ok(`Echo: name=${st.name} | notes=${st.notes.replace(/\n/g, '[NL]')} | color=${st.color} | extras=${st.extras ? 'yes' : 'no'}`),
    screenshot: () => ({ content: [{ type: 'image', mimeType: 'image/png', data: tinyPng(640, 400).toString('base64') }] }),
    press_key: () => ok('Pressed Escape.'),
  };
  const calls: string[] = [];
  return {
    calls,
    hits,
    submissions,
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      const r = (over[name] ?? base[name])?.(args) ?? base[name]?.(args);
      if (!r) throw new Error(`unexpected tool ${name}`);
      return r;
    },
    fixtures: {
      a: 'http://127.0.0.1:1',
      b: 'http://localhost:2',
      submissions: () => [...submissions],
      hits: () => [...hits],
      waitForHit: async (what: string) => hits.includes(what),
    },
  };
}

async function run(hub: ReturnType<typeof fakeHub>, connectHint?: (m: string) => string) {
  const seen: CheckResult[] = [];
  const results = await runChecks({
    browser: 'chrome',
    call: hub.call,
    fixtures: hub.fixtures,
    onResult: (r) => seen.push(r),
    quietMs: 1,
    ...(connectHint ? { connectHint } : {}),
  });
  expect(seen).toEqual(results);
  return results;
}

const statuses = (rs: CheckResult[]) => Object.fromEntries(rs.map((r) => [r.id, r.status]));

describe('runChecks', () => {
  it('passes all 15 checks against a well-behaved hub, in order', async () => {
    const rs = await run(fakeHub());
    expect(rs.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(rs.filter((r) => r.status !== 'pass')).toEqual([]);
    expect(rs[12]!.detail).toBe('640×400 PNG, 1 KB');
    expect(rs[14]!.detail).toBe('c1:e12 → STALE_REF');
  });

  it('a failed connect fails check 1 with the hint and skips the rest', async () => {
    const hub = fakeHub({ browser_connect: () => err('NOT_CONNECTED: Zen was not found at /x') });
    const rs = await run(hub, (m) => `hint for: ${m.slice(0, 13)}`);
    expect(rs[0]).toMatchObject({ status: 'fail', hint: 'hint for: NOT_CONNECTED' });
    expect(rs.slice(1).every((r) => r.status === 'skip')).toBe(true);
    expect(hub.calls).toEqual(['browser_connect']);
  });

  it('refuses to accept a non-agent connection', async () => {
    const rs = await run(fakeHub({ browser_connect: () => ok('Connected to chrome (real profile, Chrome/1).') }));
    expect(rs[0]).toMatchObject({ status: 'fail' });
    expect(rs[0]!.hint).toMatch(/safety rule did not hold/);
  });

  it('fails check 9 if the password field accepts text', async () => {
    const rs = await run(fakeHub({ type: () => ok('Typed.') }));
    expect(rs[8]).toMatchObject({ status: 'fail', detail: 'typing into the password field was ALLOWED' });
    expect(rs[8]!.hint).toMatch(/safety rule did not hold/);
  });

  it('fails check 10 if the server received a submission, even when the tool reported an error', async () => {
    const hub = fakeHub();
    const real = hub.call;
    hub.call = async (name, args) => {
      if (name === 'click' && args.target === 'c1:e6') {
        hub.submissions.push('fullname=Ada');
        return err('weird');
      }
      return real(name, args);
    };
    const rs = await run(hub);
    expect(rs[9]).toMatchObject({ status: 'fail', detail: 'the server received 1 submission(s)' });
    expect(rs[9]!.hint).toMatch(/safety rule did not hold/);
  });

  it('fails check 11 if a covered button is clicked, and check 15 if an old ref still works', async () => {
    const rs = await run(fakeHub({ click: (a) => (a.target === 'c1:e10' || a.target === 'c1:e12' ? ok('Clicked.') : undefined) }));
    expect(statuses(rs)).toMatchObject({ 11: 'fail', 15: 'fail', 12: 'pass' });
    expect(rs[14]!.detail).toMatch(/was accepted/);
  });

  it('skips dependent checks when the form page cannot be read', async () => {
    const rs = await run(fakeHub({ snapshot: () => err('TIMEOUT: snapshot') }));
    expect(statuses(rs)).toMatchObject({ 1: 'pass', 2: 'pass', 3: 'fail', 4: 'skip', 5: 'skip', 9: 'skip', 10: 'skip', 11: 'fail', 13: 'pass', 14: 'pass' });
  });
});

describe('helpers', () => {
  it('refFor finds the ref on the line with the label', () => {
    expect(refFor('- textbox "A" [ref=z1:e1]\n- button "Send" [ref=z1:f2e7] focused', 'button "Send"')).toBe('z1:f2e7');
    expect(refFor('- button "Send"', 'button "Send"')).toBeNull();
  });
  it('pngSize validates the signature and reads IHDR', () => {
    expect(pngSize(tinyPng(3, 4))).toEqual({ width: 3, height: 4 });
    expect(pngSize(Buffer.from('GIF89a................................'))).toBeNull();
  });
});
