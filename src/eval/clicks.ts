/**
 * `stephen eval-clicks`: how often a click does what it should, measured through the REAL tool pipeline.
 *
 * A headless Chrome (temporary profile, never the owner's) is attached to the real MCP server (buildServer: tools,
 * hub, safety gate, page engine) over an in-memory transport. Each case is a local fixture page that reproduces one
 * known failure cause; a scripted "model" makes the calls Claude would make (tab_open, find, click) and the page
 * itself reports what was really clicked. Every case runs N times (default 20); failures are logged by cause.
 *
 * It only measures: nothing here changes how clicks work. ROADMAP P1.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadConfig } from '../config.js';
import { BrowserManager } from '../drivers/index.js';
import { pageEngine } from '../page/index.js';
import { createSafety } from '../safety/index.js';
import { buildServer } from '../server/index.js';
import type { BrowserDriver, BrowserName } from '../types.js';

/** The failure causes ROADMAP P1 names, plus 'other' for anything unexpected. */
export type Cause = 'stale ref' | 'element covered' | 'page still loading' | 'wrong element' | 'autoplay blocked' | 'tab not focused' | 'other';

export class CaseFailure extends Error {
  constructor(
    override readonly cause: Cause,
    message: string,
  ) {
    super(message);
  }
}

/** What a case script can do: the model's tool calls, plus a read of what the page recorded. */
export interface Agent {
  /** tab_open with a fresh tab for this fixture; returns the tab id. */
  open(path: string): Promise<string>;
  /** find; matches as { role, name, ref }. */
  find(tab: string, query: string): Promise<Array<{ role: string; name: string; ref: string }>>;
  /** click; never throws for a tool error (returns { ok: false, text }). */
  click(tab: string, ref: string): Promise<{ ok: boolean; text: string }>;
  call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
  /** What the fixture page recorded (window.__r), read by the harness, not the model. */
  result(tab: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export interface ClickCase {
  id: string;
  /** The cause this case reproduces. */
  cause: Cause;
  what: string;
  run(a: Agent): Promise<void>;
}

// ───────────────────────────── fixture pages ─────────────────────────────

const DONE_JS = `window.__r='';function done(w){if(!window.__r)window.__r=w;}`;

function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><script>${DONE_JS}</script>${head}
<style>body{font-family:system-ui,sans-serif;margin:24px}button{font-size:16px;padding:8px 16px}</style></head><body>${body}</body></html>`;
}

/** A tiny in-page "player": a generated tone in an <audio>, a YouTube-style Play (k) / Pause (k) button. */
const PLAYER_JS = `
function tone(){var r=8000,n=r*30,b=new ArrayBuffer(44+n),v=new DataView(b),s=function(o,t){for(var i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));};
s(0,'RIFF');v.setUint32(4,36+n,true);s(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
v.setUint32(24,r,true);v.setUint32(28,r,true);v.setUint16(32,1,true);v.setUint16(34,8,true);s(36,'data');v.setUint32(40,n,true);
for(var i=0;i<n;i++)v.setUint8(44+i,128+Math.round(40*Math.sin(i/4)));return URL.createObjectURL(new Blob([b],{type:'audio/wav'}));}
var au=new Audio(tone());au.loop=true;
function label(){var b=document.getElementById('pp');b.textContent=au.paused?'Play (k)':'Pause (k)';b.setAttribute('aria-label',b.textContent);}
au.onplay=au.onpause=function(){label();window.__r=au.paused?'paused':'playing';};
function toggle(){if(au.paused){au.play().catch(function(){window.__r='blocked';});}else au.pause();}`;

export const CLICK_PAGES: Record<string, string> = {
  // The button is re-rendered (same label, new node) 300 ms after load, like a framework hydrating the page.
  'stale-ref': page(
    'Draft',
    `<h1>Draft</h1><div id="slot"><button onclick="done('target')">Save draft</button></div>
<script>addEventListener('load',function(){setTimeout(function(){var s=document.getElementById('slot');
s.innerHTML='<button>Save draft</button>';s.firstChild.onclick=function(){done('target');};},300);});</script>`,
  ),
  // A "Loading…" veil covers the page and fades away 700 ms after load.
  'covered-overlay': page(
    'Checkout',
    `<h1>Checkout</h1><button onclick="done('target')">Continue</button>
<div id="veil" onclick="done('veil')" style="position:fixed;inset:0;background:rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center">Loading…</div>
<script>addEventListener('load',function(){setTimeout(function(){document.getElementById('veil').remove();},700);});</script>`,
  ),
  // A cookie banner covers the button until it is accepted. Correct: OBSCURED, accept, click again.
  'cookie-banner': page(
    'News',
    `<h1>News</h1><div style="height:700px"></div><button onclick="done('target')">Read more</button>
<div id="cb" style="position:fixed;left:0;right:0;bottom:0;height:260px;background:#223;color:#fff;padding:16px">We use cookies.
<button onclick="document.getElementById('cb').remove()">Dismiss</button></div>`,
  ),
  // The button is there from the start, but its handler arrives with a slow script (the page is still loading).
  'still-loading': page(
    'Shop',
    `<h1>Shop</h1><button id="add">Add to cart</button><script async src="/slow.js?ms=1200"></script>`,
  ),
  // Two "Play" buttons: a mini-player parked off screen (first in the page) and the real one.
  'duplicate-label': page(
    'Video',
    `<div style="position:fixed;left:-600px;bottom:0;width:300px"><button onclick="done('mini player')">Play</button></div>
<main><h1>Video</h1><div style="width:640px;height:360px;background:#000"></div><button onclick="done('target')">Play</button></main>`,
  ),
  // The page tries to autoplay; the browser blocks sound without a user gesture.
  'autoplay-blocked': page(
    'Watch',
    `<h1>Watch</h1><button id="pp" onclick="toggle()">Play (k)</button>`,
    `<script>${PLAYER_JS}addEventListener('load',function(){label();au.play().catch(function(){window.__r='blocked';});});</script>`,
  ),
  // Like a real player, it only starts while the tab is visible; the case clicks it from a background tab.
  'background-tab': page(
    'Watch later',
    `<h1>Watch later</h1><button id="pp" onclick="if(document.visibilityState==='visible')toggle();else window.__r='hidden';">Play (k)</button>`,
    `<script>${PLAYER_JS}addEventListener('load',label);</script>`,
  ),
};

const SLOW_JS = `document.getElementById('add').onclick=function(){done('target');};`;

// ───────────────────────────── cases ─────────────────────────────

function firstButton(m: Array<{ role: string; name: string; ref: string }>, name: RegExp): string | null {
  return m.find((x) => x.role === 'button' && name.test(x.name))?.ref ?? null;
}

/** Click and fail with the cause the tool error points to. */
async function mustClick(a: Agent, tab: string, ref: string, fallback: Cause): Promise<void> {
  const r = await a.click(tab, ref);
  if (r.ok) return;
  throw new CaseFailure(causeOf(r.text, fallback), firstLine(r.text));
}

export function causeOf(text: string, fallback: Cause): Cause {
  if (/stale|no longer|disappeared|STALE_REF/i.test(text)) return 'stale ref';
  if (/covered by|OBSCURED|no visible area/i.test(text)) return 'element covered';
  return fallback;
}

async function expectResult(a: Agent, tab: string, want: string, cause: Cause, waitMs = 1500): Promise<void> {
  const until = Date.now() + waitMs;
  let got = '';
  for (;;) {
    got = await a.result(tab);
    if (got === want) return;
    if (got && got !== 'paused') break;
    if (Date.now() >= until) break;
    await a.sleep(100);
  }
  throw new CaseFailure(cause, got ? `the page recorded "${got}" instead of "${want}"` : 'the click had no effect');
}

async function findButton(a: Agent, tab: string, query: string, name: RegExp, cause: Cause): Promise<string> {
  const ref = firstButton(await a.find(tab, query), name);
  if (!ref) throw new CaseFailure(cause, `find "${query}" returned no matching button`);
  return ref;
}

export const CLICK_CASES: readonly ClickCase[] = [
  {
    id: 'stale-ref',
    cause: 'stale ref',
    what: 'button re-rendered after find (hydration)',
    run: async (a) => {
      const tab = await a.open('stale-ref');
      const ref = await findButton(a, tab, 'Save draft', /^save draft$/i, 'other');
      await a.sleep(600); // the model thinking
      await mustClick(a, tab, ref, 'stale ref');
      await expectResult(a, tab, 'target', 'stale ref');
    },
  },
  {
    id: 'covered-overlay',
    cause: 'element covered',
    what: 'loading veil over the page for 700 ms',
    run: async (a) => {
      const tab = await a.open('covered-overlay');
      const ref = await findButton(a, tab, 'Continue', /^continue$/i, 'other');
      await mustClick(a, tab, ref, 'element covered');
      await expectResult(a, tab, 'target', 'element covered');
    },
  },
  {
    id: 'cookie-banner',
    cause: 'element covered',
    what: 'cookie banner: OBSCURED, accept, click again',
    run: async (a) => {
      const tab = await a.open('cookie-banner');
      const ref = await findButton(a, tab, 'Read more', /^read more$/i, 'other');
      const first = await a.click(tab, ref);
      if (first.ok) {
        // Nothing may be clicked through the banner.
        await expectResult(a, tab, 'target', 'element covered');
        return;
      }
      if (causeOf(first.text, 'other') !== 'element covered') throw new CaseFailure(causeOf(first.text, 'other'), firstLine(first.text));
      await mustClick(a, tab, await findButton(a, tab, 'Dismiss', /^dismiss$/i, 'element covered'), 'element covered');
      await mustClick(a, tab, ref, 'element covered');
      await expectResult(a, tab, 'target', 'element covered');
    },
  },
  {
    id: 'still-loading',
    cause: 'page still loading',
    what: 'handler arrives with a slow script (1.2 s)',
    run: async (a) => {
      const tab = await a.open('still-loading');
      const ref = await findButton(a, tab, 'Add to cart', /^add to cart$/i, 'page still loading');
      await mustClick(a, tab, ref, 'page still loading');
      await expectResult(a, tab, 'target', 'page still loading');
    },
  },
  {
    id: 'duplicate-label',
    cause: 'wrong element',
    what: 'two "Play" buttons, one off screen',
    run: async (a) => {
      const tab = await a.open('duplicate-label');
      const ref = await findButton(a, tab, 'Play', /^play$/i, 'other');
      await mustClick(a, tab, ref, 'wrong element');
      await expectResult(a, tab, 'target', 'wrong element');
    },
  },
  {
    id: 'autoplay-blocked',
    cause: 'autoplay blocked',
    what: 'autoplay refused; press the Play button (play_media steps)',
    run: async (a) => {
      const tab = await a.open('autoplay-blocked');
      await a.sleep(300);
      if (await a.result(tab) === 'playing') return;
      await mustClick(a, tab, await findButton(a, tab, 'play', /^play \(k\)$/i, 'autoplay blocked'), 'autoplay blocked');
      await expectResult(a, tab, 'playing', 'autoplay blocked');
    },
  },
  {
    id: 'background-tab',
    cause: 'tab not focused',
    what: 'Play clicked while another tab is in front',
    run: async (a) => {
      const tab = await a.open('background-tab');
      const ref = await findButton(a, tab, 'play', /^play \(k\)$/i, 'other');
      await a.open('stale-ref'); // the user (or Stephen) opened something else in front
      await mustClick(a, tab, ref, 'tab not focused');
      await expectResult(a, tab, 'playing', 'tab not focused');
    },
  },
];

/** The real YouTube flow (play_media): needs the network, so it is opt-in (STEPHEN_EVAL_YOUTUBE=1). */
export const YOUTUBE_CASE: ClickCase = {
  id: 'youtube',
  cause: 'other',
  what: 'play_media "One Call Away Charlie Puth" (network)',
  run: async (a) => {
    const r = await a.call('play_media', { query: 'One Call Away Charlie Puth', browser: 'chrome', intent: 'eval: play a song' });
    if (!r.ok) throw new CaseFailure(causeOf(r.text, 'other'), firstLine(r.text));
    const tab = /tab (c\d+)/.exec(r.text)?.[1];
    if (!tab) throw new CaseFailure('other', `no tab in: ${firstLine(r.text)}`);
    try {
      await expectResult(a, tab, 'playing', /paused|press/i.test(r.text) ? 'autoplay blocked' : 'other', 5000);
    } catch (e) {
      // Keep play_media's own note ("it may be paused: …"): it says which step failed.
      const note = /\(([^)]*(?:paused|press|play button)[^)]*)\)/i.exec(firstLine(r.text))?.[1];
      if (e instanceof CaseFailure && note) throw new CaseFailure(e.cause, `${e.message}; play_media: ${note.slice(0, 160)}`);
      throw e;
    }
  },
};

// ───────────────────────────── harness ─────────────────────────────

export interface CaseReport {
  id: string;
  what: string;
  passed: number;
  runs: number;
  failures: Array<{ run: number; cause: Cause; detail: string }>;
}

export interface ClickEvalOptions {
  runs: number;
  cases: readonly ClickCase[];
  /** Chrome binary (default: STEPHEN_TEST_CHROME, else the configured chrome.executablePath). */
  executablePath?: string;
  /** Extra browser flags (tests on Linux pass @sparticuz/chromium's). */
  args?: string[];
  log?: (line: string) => void;
}

/** Serves CLICK_PAGES on 127.0.0.1 (plus /slow.js?ms=N, delayed). */
async function startPages(): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/slow.js') {
      const ms = Math.min(5000, Number(u.searchParams.get('ms')) || 0);
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end(SLOW_JS), ms);
      return;
    }
    const html = CLICK_PAGES[u.pathname.slice(1)];
    if (!html) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return { origin: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, server };
}

/** A BrowserDriver that hands the hub an already launched browser. */
function fixedDriver(name: BrowserName, browser: Browser | null): BrowserDriver {
  return {
    name,
    protocol: name === 'chrome' ? 'cdp' : 'webDriverBiDi',
    connect: async () => {
      if (!browser) throw new Error(`${name} is not part of the click eval`);
      return browser;
    },
    current: () => browser,
    status: () => ({ name, connected: !!browser, mode: browser ? 'agent' : null, protocol: name === 'chrome' ? 'cdp' : 'webDriverBiDi', version: null, detail: 'click eval' }),
    disconnect: async () => undefined,
  };
}

/** One fresh Stephen session (server, hub, gate, tab registry) on the shared browser: no state carries between runs. */
async function openSession(cfg: ReturnType<typeof loadConfig>, browser: Browser, origin: string): Promise<{ agent: Agent; close(): Promise<void> }> {
  const manager = new BrowserManager(cfg, { chrome: fixedDriver('chrome', browser), zen: fixedDriver('zen', null) });
  const mcp = buildServer({ cfg, manager, engine: pageEngine, safetyFactory: createSafety });
  const client = new Client({ name: 'stephen-eval-clicks', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  await client.connect(ct);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    return { ok: !r.isError, text: r.content.map((x) => x.text ?? '').join('\n') };
  };
  const agent: Agent = {
    call,
    async open(path) {
      const r = await call('tab_open', { url: `${origin}/${path}`, new_tab: true, browser: 'chrome', intent: 'eval: open the test page' });
      const tab = /\b(c\d+)\b/.exec(r.text)?.[1];
      if (!r.ok || !tab) throw new CaseFailure('other', `tab_open failed: ${firstLine(r.text)}`);
      return tab;
    },
    async find(tab, query) {
      const r = await call('find', { tab, query });
      const out: Array<{ role: string; name: string; ref: string }> = [];
      for (const m of r.text.matchAll(/^- (\S+) "((?:[^"\\]|\\.)*)" \[ref=([^\]]+)\]/gm)) out.push({ role: m[1]!, name: m[2]!, ref: m[3]! });
      return out;
    },
    click: (tab, ref) => call('click', { target: ref, intent: 'eval: click the button' }),
    async result(tab) {
      const p: Page = await manager.getPage(tab);
      // Fixtures set window.__r; on YouTube the <video> element says whether it plays.
      const r = await p
        .evaluate(() => {
          const w = (window as unknown as { __r?: unknown }).__r;
          if (typeof w === 'string') return w;
          const v = document.querySelector('video');
          return v ? (!v.paused && v.currentTime > 0 ? 'playing' : 'paused') : '';
        })
        .catch(() => '');
      return String(r);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return {
    agent,
    close: async () => {
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    },
  };
}

export async function runClickEval(opts: ClickEvalOptions): Promise<CaseReport[]> {
  const log = opts.log ?? (() => undefined);
  const home = await mkdtemp(join(tmpdir(), 'stephen-eval-clicks-'));
  const cfg = loadConfig(
    { defaultBrowser: 'chrome', safety: { confirm: 'deny', maxActionsPerMinute: 10_000 } },
    { ...process.env, STEPHEN_HOME: home },
  );
  const executablePath = opts.executablePath ?? process.env.STEPHEN_TEST_CHROME ?? cfg.chrome.executablePath;
  const { origin, server } = await startPages();
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // Like the owner's browsers: sound needs a user gesture.
      args: ['--autoplay-policy=user-gesture-required', ...(opts.args ?? [])],
      defaultViewport: { width: 1280, height: 900 },
    });
    const reports: CaseReport[] = [];
    for (const k of opts.cases) {
      const rep: CaseReport = { id: k.id, what: k.what, passed: 0, runs: opts.runs, failures: [] };
      for (let i = 1; i <= opts.runs; i++) {
        const s = await openSession(cfg, browser, origin);
        try {
          await k.run(s.agent);
          rep.passed++;
        } catch (e) {
          const f = e instanceof CaseFailure ? e : new CaseFailure('other', firstLine(e instanceof Error ? e.message : String(e)));
          rep.failures.push({ run: i, cause: f.cause, detail: f.message });
        } finally {
          await s.close();
          // Close every tab this run opened (harness housekeeping, not part of the measured flow).
          for (const p of await browser.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => undefined);
        }
      }
      log(`${k.id.padEnd(18)} ${rep.passed}/${rep.runs}`);
      reports.push(rep);
    }
    return reports;
  } finally {
    await browser?.close().catch(() => undefined);
    server.close();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Table (case, x/N, what) and the failure log grouped by cause. */
export function formatClickReport(reports: readonly CaseReport[]): string {
  const lines = ['case               pass    what', ...reports.map((r) => `${r.id.padEnd(18)} ${`${r.passed}/${r.runs}`.padEnd(7)} ${r.what}`)];
  const byCause = new Map<Cause, Map<string, number>>();
  for (const r of reports) {
    for (const f of r.failures) {
      const m = byCause.get(f.cause) ?? new Map<string, number>();
      const key = `${r.id}: ${f.detail.replace(/\b[cz]\d+:(?:f\d+)?e\d+\b/g, '<ref>')}`;
      m.set(key, (m.get(key) ?? 0) + 1);
      byCause.set(f.cause, m);
    }
  }
  lines.push('', byCause.size ? 'Failures by cause:' : 'No failures.');
  for (const [cause, m] of byCause) {
    lines.push(`  ${cause} (${[...m.values()].reduce((s, n) => s + n, 0)})`);
    for (const [k, n] of m) lines.push(`    ${n}x ${k}`);
  }
  return lines.join('\n');
}

export const EVAL_CLICKS_HELP = `stephen eval-clicks — measure click reliability on local test pages (nothing touches your browsers)

  --runs <1-100>   runs per case (default 20)
  --only <text>    only cases whose id contains <text>
  --youtube        also run the real YouTube flow (play_media; needs the network). Same as STEPHEN_EVAL_YOUTUBE=1.

Starts a headless Chrome with a temporary profile (STEPHEN_TEST_CHROME overrides the binary) and drives Stephen's
real tools (tab_open, find, click, play_media) against fixture pages that reproduce each failure cause.`;

export async function runClickEvalCli(argv: string[], out: (l: string) => void = (l) => console.log(l)): Promise<number> {
  let runs = 20;
  let only = '';
  let youtube = process.env.STEPHEN_EVAL_YOUTUBE === '1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return out(EVAL_CLICKS_HELP), 0;
    if (a === '--runs') runs = Number(argv[++i]);
    else if (a === '--only') only = argv[++i] ?? '';
    else if (a === '--youtube') youtube = true;
    else return out(`Unknown option "${a}".\n\n${EVAL_CLICKS_HELP}`), 2;
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) return out('--runs must be 1-100'), 2;
  const cases = [...CLICK_CASES, ...(youtube ? [YOUTUBE_CASE] : [])].filter((k) => k.id.includes(only));
  if (!cases.length) return out(`No case matches "${only}".`), 2;
  out(`Running ${cases.length} case${cases.length === 1 ? '' : 's'} x ${runs} in a headless Chrome…`);
  const reports = await runClickEval({ runs, cases, log: out });
  out('');
  out(formatClickReport(reports));
  return reports.every((r) => r.passed === r.runs) ? 0 : 1;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').slice(0, 200);
}
