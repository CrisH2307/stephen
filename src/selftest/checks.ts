/**
 * The scripted selftest sequence (checks 1–15; 16 = disconnect & clean up is run by the orchestrator).
 *
 * Every step goes through the MCP tool surface — the same handlers, page engine, safety gate and
 * drivers Claude Code uses — and verifies its effect independently where it can (server-side
 * records from the fixture server, a fresh snapshot, or the decoded PNG).
 */
import type { BrowserName } from '../types.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  /** Wall time in ms (0 for skipped checks). */
  ms: number;
  /** What was observed (pass) or what went wrong (fail) / why it did not run (skip). */
  detail?: string;
  /** What the user can do about a failure. */
  hint?: string;
}

export const CHECK_NAMES: readonly string[] = [
  'connect & open tab',
  'navigate to fixture page',
  'snapshot has expected refs',
  'find "Send"',
  'type text field + textarea',
  'select option',
  'click checkbox',
  'read_text',
  'password field refused',
  '"Send" refused, nothing submitted',
  'covered button → OBSCURED',
  'iframe snapshot + click',
  'screenshot is a valid PNG',
  'press_key Escape allowed',
  'stale ref rejected',
  'disconnect & clean up',
];

export const DISCONNECT_CHECK_ID = 16;

/** Minimal MCP tool-call result shape the checks read. */
export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/** What the checks need from the fixture server. */
export interface FixtureView {
  a: string;
  b: string;
  submissions(): string[];
  hits(): string[];
  waitForHit(what: string, ms: number): Promise<boolean>;
}

export interface CheckEnv {
  browser: BrowserName;
  call: ToolCaller;
  fixtures: FixtureView;
  /** Called as each check finishes (live progress). */
  onResult?: (r: CheckResult) => void;
  /** Turns a failed connect into an actionable hint. */
  connectHint?: (message: string) => string | undefined;
  now?: () => number;
  /** How long to wait for page beacons that must NOT arrive (ms). Default 600. */
  quietMs?: number;
}

/**
 * Zen (Gecko) cannot yet dispatch mouse events into out-of-process (cross-site) iframes when
 * automated (Mozilla bug 1773393). Stephen does not weaken site isolation by default; the user
 * can opt in for the agent profile only.
 */
export const ZEN_IFRAME_HINT =
  'Zen could not deliver a click into a cross-site iframe (a known Gecko automation limitation with site isolation). ' +
  'If you need that, add "zen": {"extraPrefs": {"fission.webContentIsolationStrategy": 0}} to ~/.stephen/config.json, quit the agent Zen window, and re-run the selftest. ' +
  'This only affects the Stephen agent profile, but it weakens site isolation there (see docs/guide/ADVANCED-SETUP.md#zen-use-the-zen-you-already-have-open, paragraph "Zen and cross-site iframes").';

/** A check failed; `hint` tells the user what to do. */
export class CheckFailure extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CheckFailure';
  }
}

class SkipCheck extends Error {}

export const REPORT_HINT = 'Please report this with the output of `stephen selftest --json`.';
const SAFETY_HINT =
  'A safety rule did not hold. Do not let Claude use this browser through Stephen until this is fixed; ' + REPORT_HINT;

export function resultText(r: ToolResult): string {
  return r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The ref on the first snapshot line containing `label` (e.g. 'button "Send"'). */
export function refFor(snapshot: string, label: string): string | null {
  const line = snapshot.split('\n').find((l) => l.includes(label) && l.includes('[ref='));
  const m = line ? /\[ref=([^\]]+)\]/.exec(line) : null;
  return m ? m[1]! : null;
}

function lineFor(snapshot: string, label: string): string {
  return snapshot.split('\n').find((l) => l.includes(label) && l.includes('[ref=')) ?? '';
}

/** PNG signature + IHDR dimensions, or null if `buf` is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs checks 1–15 in order. Never throws: every problem becomes a FAIL (or a SKIP for checks that depend on it). */
export async function runChecks(env: CheckEnv): Promise<CheckResult[]> {
  const { call, fixtures: fx, browser } = env;
  const now = env.now ?? (() => performance.now());
  const quietMs = env.quietMs ?? 600;
  const results: CheckResult[] = [];

  // State shared between steps.
  let tab: string | undefined;
  let onForm = false;
  let snap = '';
  const refs: Record<string, string> = {};
  let parentRef: string | undefined;

  const needTab = () => {
    if (!tab) throw new SkipCheck('not run: no tab (check 1 failed)');
    return tab;
  };
  const needForm = () => {
    const t = needTab();
    if (!onForm || !refs.send) throw new SkipCheck('not run: the form page was not loaded/snapshotted (checks 2–3)');
    return t;
  };
  const ok = (r: ToolResult, what: string): string => {
    const t = resultText(r);
    if (r.isError) throw new CheckFailure(`${what} failed: ${oneLine(t, 400)}`);
    return t;
  };
  const snapshot = async (t: string): Promise<string> => ok(await call('snapshot', { tab: t }), 'snapshot');
  const navigate = async (t: string, path: string): Promise<string> =>
    ok(await call('navigate', { tab: t, url: `${fx.a}${path}`, intent: 'Stephen selftest: open a local test page' }), `navigate to ${path}`);
  const ref = (s: string, label: string): string => {
    const r = refFor(s, label);
    if (!r) throw new CheckFailure(`no ${label} in the snapshot:\n${s.slice(0, 1500)}`, REPORT_HINT);
    return r;
  };
  const noHit = async (what: string): Promise<void> => {
    if (await fx.waitForHit(what, quietMs)) throw new CheckFailure(`the page reported "${what}" — the action happened anyway`, SAFETY_HINT);
  };

  async function step(id: number, fn: () => Promise<string>, hint?: string): Promise<void> {
    const name = CHECK_NAMES[id - 1]!;
    const t0 = now();
    let r: CheckResult;
    try {
      const detail = await fn();
      r = { id, name, status: 'pass', ms: Math.round(now() - t0), detail };
    } catch (e) {
      if (e instanceof SkipCheck) {
        r = { id, name, status: 'skip', ms: 0, detail: e.message };
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        const h = e instanceof CheckFailure && e.hint ? e.hint : hint;
        r = { id, name, status: 'fail', ms: Math.round(now() - t0), detail: msg, ...(h ? { hint: h } : {}) };
      }
    }
    results.push(r);
    env.onResult?.(r);
  }

  // 1. connect & open tab
  await step(1, async () => {
    const c = await call('browser_connect', { browser, mode: 'agent', intent: 'Stephen selftest' });
    if (c.isError) {
      const msg = oneLine(resultText(c), 600);
      throw new CheckFailure(`browser_connect failed: ${msg}`, env.connectHint?.(msg));
    }
    const connected = resultText(c);
    if (!/agent profile/.test(connected)) throw new CheckFailure(`connected, but not in the agent profile: ${oneLine(connected)}`, SAFETY_HINT);
    const t = ok(await call('tab_open', { browser, intent: 'Stephen selftest: open a scratch tab' }), 'tab_open');
    const m = /\b([cz]\d+)\b/.exec(t);
    if (!m) throw new CheckFailure(`tab_open did not return a tab id: ${oneLine(t)}`, REPORT_HINT);
    tab = m[1]!;
    return `agent profile, tab ${tab}`;
  });

  // 2. navigate
  await step(
    2,
    async () => {
      const t = needTab();
      const out = await navigate(t, '/form');
      if (!out.includes('Selftest form')) throw new CheckFailure(`unexpected page after navigate: ${oneLine(out)}`);
      onForm = true;
      return `${fx.a}/form`;
    },
    'The browser could not load the local test page from 127.0.0.1. A proxy, VPN or security tool that intercepts localhost traffic can cause this.',
  );

  // 3. snapshot
  await step(
    3,
    async () => {
      const t = needTab();
      if (!onForm) throw new SkipCheck('not run: the form page did not load (check 2)');
      snap = await snapshot(t);
      const want: Record<string, string> = {
        name: 'textbox "Full name"',
        notes: 'textbox "Notes"',
        color: 'combobox "Color"',
        extras: 'checkbox "Include extra details"',
        password: 'textbox "Password"',
        send: 'button "Send"',
      };
      const missing: string[] = [];
      for (const [k, label] of Object.entries(want)) {
        const r = refFor(snap, label);
        if (r) refs[k] = r;
        else missing.push(label);
      }
      if (missing.length) throw new CheckFailure(`missing ${missing.join(', ')} in:\n${snap.slice(0, 1500)}`, REPORT_HINT);
      if (!lineFor(snap, 'textbox "Password"').includes('[redacted]') && /value=/.test(lineFor(snap, 'textbox "Password"'))) {
        throw new CheckFailure('the password field value was not redacted in the snapshot', SAFETY_HINT);
      }
      return `${Object.keys(want).length}/${Object.keys(want).length} expected refs (${(snap.match(/\[ref=/g) ?? []).length} total)`;
    },
    REPORT_HINT,
  );

  // 4. find
  await step(
    4,
    async () => {
      const t = needForm();
      const out = ok(await call('find', { tab: t, query: 'Send' }), 'find');
      const r = refFor(out, 'button "Send"');
      if (!r) throw new CheckFailure(`find did not return button "Send": ${oneLine(out, 400)}`);
      if (r !== refs.send) throw new CheckFailure(`find returned ${r} but the snapshot said ${refs.send} (refs must be stable)`);
      return `button "Send" → ${r}`;
    },
    REPORT_HINT,
  );

  // 5. type text field + textarea (with a newline)
  await step(
    5,
    async () => {
      const t = needForm();
      ok(await call('type', { target: refs.name, text: 'Ada Lovelace', intent: 'Stephen selftest: fill the name field' }), 'type (text field)');
      ok(
        await call('type', { target: refs.notes, text: 'line one\nline two', intent: 'Stephen selftest: fill the notes field' }),
        'type (textarea)',
      );
      const s = await snapshot(t);
      if (!lineFor(s, 'textbox "Full name"').includes('Ada Lovelace')) {
        throw new CheckFailure(`the name field does not show the typed text: ${lineFor(s, 'textbox "Full name"') || '(missing)'}`);
      }
      if (!lineFor(s, 'textbox "Notes"').includes('line one')) {
        throw new CheckFailure(`the notes field does not show the typed text: ${lineFor(s, 'textbox "Notes"') || '(missing)'}`);
      }
      return 'text field and textarea filled';
    },
    REPORT_HINT,
  );

  // 6. select option
  await step(
    6,
    async () => {
      needForm();
      const out = ok(
        await call('select_option', { target: refs.color, values: ['Green'], intent: 'Stephen selftest: choose a color' }),
        'select_option',
      );
      if (!/selected: "green"/.test(out)) throw new CheckFailure(`select_option did not report "green" as selected: ${oneLine(out)}`);
      return 'selected "Green"';
    },
    REPORT_HINT,
  );

  // 7. click checkbox
  await step(
    7,
    async () => {
      const t = needForm();
      ok(await call('click', { target: refs.extras, intent: 'Stephen selftest: tick the checkbox' }), 'click (checkbox)');
      const line = lineFor(await snapshot(t), 'checkbox "Include extra details"');
      if (!/\bchecked\b/.test(line)) throw new CheckFailure(`the checkbox is not checked after the click: ${line || '(missing)'}`);
      return 'checkbox checked';
    },
    REPORT_HINT,
  );

  // 8. read_text — the page's own echo of what it received
  await step(
    8,
    async () => {
      const t = needForm();
      const out = ok(await call('read_text', { tab: t }), 'read_text');
      const want = 'Echo: name=Ada Lovelace | notes=line one[NL]line two | color=green | extras=yes';
      if (!out.includes(want)) {
        const got = /Echo:[^\n]*/.exec(out)?.[0] ?? oneLine(out, 300);
        throw new CheckFailure(`expected "${want}", page shows "${got}"`);
      }
      return 'page text reflects every input (newline kept)';
    },
    REPORT_HINT,
  );

  // 9. password field refused
  await step(9, async () => {
    needForm();
    const r = await call('type', { target: refs.password, text: 'not-a-real-password', intent: 'Stephen selftest: try the password field' });
    if (!r.isError) throw new CheckFailure('typing into the password field was ALLOWED', SAFETY_HINT);
    await noHit('password-input');
    return 'refused, nothing typed';
  });

  // 10. "Send" refused (needs confirmation; confirm=deny) and nothing reached the server
  await step(10, async () => {
    needForm();
    const r = await call('click', { target: refs.send, intent: 'Stephen selftest: try to send the form' });
    await noHit('submit-event');
    const subs = fx.submissions();
    if (subs.length) throw new CheckFailure(`the server received ${subs.length} submission(s)`, SAFETY_HINT);
    if (!r.isError) throw new CheckFailure('clicking "Send" was ALLOWED without confirmation', SAFETY_HINT);
    return 'refused (needs confirmation; confirm=deny), server got 0 submissions';
  });

  // 11. overlay → OBSCURED, nothing clicked
  await step(
    11,
    async () => {
      const t = needTab();
      onForm = false;
      await navigate(t, '/overlay');
      const target = ref(await snapshot(t), 'button "Continue to next step"');
      const r = await call('click', { target, intent: 'Stephen selftest: click a covered button' });
      await noHit('covered-button');
      if (fx.hits().includes('overlay')) throw new CheckFailure('the click landed on the overlay', REPORT_HINT);
      if (!r.isError) throw new CheckFailure(`the click on a covered button was reported as done: ${oneLine(resultText(r))}`);
      if (!/OBSCURED/.test(resultText(r))) throw new CheckFailure(`expected OBSCURED, got: ${oneLine(resultText(r), 300)}`);
      return 'OBSCURED, nothing clicked';
    },
    REPORT_HINT,
  );

  // 12. iframe (cross-origin) snapshot + click
  await step(
    12,
    async () => {
      const t = needTab();
      await navigate(t, '/frames');
      let s = await snapshot(t);
      // The cross-origin frame can finish loading a moment after DOMContentLoaded of the parent.
      for (let i = 0; i < 10 && !refFor(s, 'button "Frame button"'); i++) {
        await sleep(300);
        s = await snapshot(t);
      }
      parentRef = refFor(s, 'button "Parent button"') ?? undefined;
      const target = ref(s, 'button "Frame button"');
      if (!/:f\d+e\d+$/.test(target)) throw new CheckFailure(`the frame button got a main-frame ref (${target})`, REPORT_HINT);
      ok(await call('click', { target, intent: 'Stephen selftest: click inside the iframe' }), 'click (iframe)');
      if (!(await fx.waitForHit('frame-button', 5000))) {
        throw new CheckFailure('the click inside the iframe did not reach the page', browser === 'zen' ? ZEN_IFRAME_HINT : REPORT_HINT);
      }
      return `cross-origin frame ref ${target} clicked`;
    },
    REPORT_HINT,
  );

  // 13. screenshot
  await step(
    13,
    async () => {
      const t = needTab();
      const r = await call('screenshot', { tab: t });
      if (r.isError) throw new CheckFailure(`screenshot failed: ${oneLine(resultText(r), 300)}`);
      const img = r.content.find((c) => c.type === 'image');
      if (!img?.data) throw new CheckFailure('no image in the screenshot result');
      if (img.mimeType !== 'image/png') throw new CheckFailure(`unexpected image type ${img.mimeType}`);
      const buf = Buffer.from(img.data, 'base64');
      const size = pngSize(buf);
      if (!size || size.width < 1 || size.height < 1) throw new CheckFailure('the image is not a valid PNG');
      return `${size.width}×${size.height} PNG, ${Math.max(1, Math.round(buf.length / 1024))} KB`;
    },
    REPORT_HINT,
  );

  // 14. press_key Escape
  await step(
    14,
    async () => {
      const t = needTab();
      ok(await call('press_key', { tab: t, key: 'Escape', intent: 'Stephen selftest: press Escape' }), 'press_key Escape');
      return 'allowed';
    },
    REPORT_HINT,
  );

  // 15. stale ref after navigation
  await step(15, async () => {
    const t = needTab();
    if (!parentRef) throw new SkipCheck('not run: no ref from the frames page (check 12)');
    await navigate(t, '/form');
    const r = await call('click', { target: parentRef, intent: 'Stephen selftest: use a ref from the previous page' });
    await noHit('parent-button');
    if (!r.isError) throw new CheckFailure(`a ref from the previous page was accepted: ${oneLine(resultText(r))}`, SAFETY_HINT);
    if (!/STALE_REF/.test(resultText(r))) throw new CheckFailure(`expected STALE_REF, got: ${oneLine(resultText(r), 300)}`, REPORT_HINT);
    return `${parentRef} → STALE_REF`;
  });

  return results;
}
