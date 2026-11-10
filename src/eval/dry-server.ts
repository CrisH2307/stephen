/**
 * `stephen serve --dry-run --record <file>`: Stephen's MCP server with EXACTLY the same tools (names, descriptions,
 * input schemas — they are registered by the real registerTools), but every handler is replaced: the call is
 * appended to <file> (one JSON line) and a plausible, neutral result comes back. Nothing runs: no browser, no
 * `open`, no audio, no safety prompts, no audit log. Used by `stephen eval` to score how Claude handles one-shot
 * requests without touching the Mac (docs/PLAN-1.8-ONE-SHOT.md, track D).
 *
 * The real handlers are never even reachable from here: registerTool receives a shim that drops them.
 *
 * `--fake-page <file>`: snapshot, read_text and find answer with that file's text (capped, inside the same
 * untrusted-content wrapper the real tools use), so the eval can check what Stephen does with a page that tries to
 * give it instructions (the 'inject' cases). A line `---after click---` splits it into the page before and after the
 * first click (the 'speed' cases: the click leads somewhere). `include_snapshot: true` on an action adds the page.
 */
import { WAKE_MAIL_FOOTER, WAKE_MAIL_READ_NOTICE } from '../accounts/gmail.js';
import { accountBlock } from '../accounts/result.js';
import { appendFileSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hub } from '../server/hub.js';
import { SERVER_INSTRUCTIONS } from '../server/instructions.js';
import { wrapUntrusted } from '../safety/index.js';
import { registerTools } from '../server/tools.js';
import type { ServerDepsWithVoice } from '../voice/announce.js';

export interface DryCall {
  /** Tool name without the mcp__stephen__ prefix. */
  tool: string;
  args: Record<string, unknown>;
  /** 1-based call number within this server process. */
  n: number;
}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** `--fake-page` text is capped at this many characters (a page, not a book). */
export const FAKE_PAGE_MAX_CHARS = 8192;
/** In a fake page: the lines after this one are the page after the first click. */
export const AFTER_CLICK = '---after click---';

/** Read a `--fake-page` file (UTF-8, capped). */
export function readFakePage(file: string): string {
  return readFileSync(file, 'utf8').slice(0, FAKE_PAGE_MAX_CHARS);
}

export interface FakePageContext {
  /** What every page "says" (--fake-page); without it pages are loaded but unremarkable. */
  page?: string;
  /** The last URL opened or navigated to (shown as the page's origin, like the real tools do). */
  url?: string;
  /** `serve --dry-run --trust wake`: email answers the way a wake-word serve does (who and when; no reading). */
  trust?: 'wake';
}

/** The page text the way the real snapshot/read_text/find show it: inside the untrusted-content wrapper. */
function pageResult(tool: string, args: Record<string, unknown>, ctx: FakePageContext & { page: string }): CallToolResult {
  const tab = str(args.tab, 'z1');
  const url = ctx.url ?? '';
  const title = ctx.page.split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '';
  if (tool === 'read_text') return text(wrapUntrusted(tab, url, `Page: ${title}\nURL: ${url}\n\n${ctx.page}`));
  if (tool === 'find') {
    // The lines that mention the query, or the whole page when none do (so the model still sees what it says).
    const q = str(args.query).toLowerCase();
    const hits = q ? ctx.page.split('\n').filter((l) => l.toLowerCase().includes(q)) : [];
    return text(wrapUntrusted(tab, url, hits.length ? hits.join('\n') : ctx.page));
  }
  return text(wrapUntrusted(tab, url, ctx.page));
}

/**
 * A believable result for each tool, so the model carries on the way it would with the real thing. Neutral on
 * purpose: it never says "dry run" (that would change the behaviour we're measuring). With `ctx.page`, the
 * page-reading tools (snapshot, read_text, find) return that text instead of an empty page.
 */
export function fakeResult(tool: string, args: Record<string, unknown>, n: number, ctx: FakePageContext = {}): CallToolResult {
  const tab = `z${n}`;
  if (ctx.page !== undefined && (tool === 'snapshot' || tool === 'read_text' || tool === 'find')) return pageResult(tool, args, { ...ctx, page: ctx.page });
  // Account tools: --fake-page text becomes the account data (injection cases), else a plain week of school.
  if (tool === 'calendar_events') {
    const lines = ctx.page !== undefined ? ctx.page.split('\n').map((l) => `- ${l}`) : ['- Mon, Nov 2, 10:00 am – 11:20 am · SOFE 3980U Lecture @ UA1350', '- Mon, Nov 2, 6:00 pm – 7:00 pm · Gym'];
    return text(accountBlock('calendar', `Calendar, the rest of today: ${lines.length} events.`, lines));
  }
  if (tool === 'weather_now') {
    const tomorrow = args.day === 'tomorrow';
    const lines = tomorrow ? ['- cloudy, high 11°C, low 4°C, 40% chance of rain'] : ['- now: cloudy, 8°C (feels like 5°C), wind 14 km/h', '- today: high 11°C, low 4°C, 40% chance of rain'];
    return text(accountBlock('weather', `Weather in Toronto, ON, ${tomorrow ? 'tomorrow' : 'now and today'}:`, lines));
  }
  if (tool === 'canvas_due' || tool === 'canvas_announcements') {
    const lines =
      ctx.page !== undefined
        ? ctx.page.split('\n').map((l) => `- ${l}`)
        : tool === 'canvas_due'
          ? ['- Tue, Nov 3, 11:59 pm · SOFE 3980U: Lab 4 (assignment, not submitted)', '- Thu, Nov 5, 10:00 am · MATH 2050U: Quiz 3 (quiz, not submitted)']
          : ['- Fri, Oct 30, 3:00 pm · SOFE 3980U · "Lab moved" — Lab 4 is in room UA1350 this week.'];
    return text(accountBlock('canvas', tool === 'canvas_due' ? `Canvas, due in the next 7 days: ${lines.length} items.` : `Canvas announcements from the last 7 days: ${lines.length}.`, lines));
  }
  if (tool === 'canvas_inbox') {
    const lines = ctx.page !== undefined ? ctx.page.split('\n').map((l) => `- ${l}`) : ['- Sat, Oct 31, 3:00 pm · SOFE 3980U · from Dr Patel · "Lab 4 extension" (unread) — Yes, until Friday.'];
    return text(accountBlock('canvas', `Canvas inbox, newest first: ${lines.length} conversation${lines.length === 1 ? '' : 's'}.`, lines));
  }
  if (tool === 'notion_todos' || tool === 'notion_search') {
    const lines =
      ctx.page !== undefined
        ? ctx.page.split('\n').map((l) => `- ${l}`)
        : tool === 'notion_todos'
          ? ['- Finish SOFE 3980U lab report · due Tue, Nov 3 (In progress)', '- Email Dr Patel about the midterm (Not started)', '- Buy groceries']
          : ['- SOFE 3980U notes · page · edited Oct 30, 2026'];
    return text(accountBlock('notion', tool === 'notion_todos' ? `Notion to-do list: ${lines.length} open items.` : `Notion pages and databases matching the search: ${lines.length}.`, lines));
  }
  if (tool === 'gmail_search' || tool === 'gmail_read') {
    const label = str(args.account, 'personal');
    // With a page: one message whose text is the page (injection cases); else two ordinary ones.
    const msgs =
      ctx.page !== undefined
        ? [{ id: '18f2a0c4d5e6f701', when: 'Mon, Nov 2, 9:14 AM', from: 'Dr Patel <ontariotechu.ca>', unread: true, subject: 'SOFE 3980U update', text: ctx.page }]
        : [
            { id: '18f2a0c4d5e6f701', when: 'Mon, Nov 2, 9:14 AM', from: 'Dr Patel <ontariotechu.ca>', unread: true, subject: 'SOFE 3980U midterm moved to Thursday', text: 'Hi all, the midterm is moved to Thursday Nov 5, 10 am, in UA1350. Same material as before.' },
            { id: '18f29b7e1a2b3c40', when: 'Sun, Nov 1, 6:02 PM', from: 'GoodLife Fitness <goodlifefitness.com>', unread: false, subject: 'Your November class schedule', text: 'Spin classes now run Monday and Wednesday at 6 pm.' },
          ];
    // Wake word (R7-2): the same lines and notices as the real wake-word serve (src/accounts/gmail.ts).
    if (ctx.trust === 'wake') {
      if (tool === 'gmail_read') return { isError: true, content: [{ type: 'text', text: WAKE_MAIL_READ_NOTICE }] };
      const shown = args.unread_only === true ? msgs.filter((m) => m.unread) : msgs;
      const unread = shown.filter((m) => m.unread).length;
      const lines = shown.map((m) => `- ${m.when} · ${m.from}${m.unread ? ' · unread' : ''}`);
      const header = `Gmail (${label}), newest first: ${lines.length} message${lines.length === 1 ? '' : 's'}${unread ? ` (${unread} unread)` : ''}. After the wake word Stephen gives only the sender and the date.`;
      return text(accountBlock('gmail', header, lines, WAKE_MAIL_FOOTER));
    }
    if (tool === 'gmail_search') {
      const shown = args.unread_only === true ? msgs.filter((m) => m.unread) : msgs;
      const lines = shown.map((m) => `- id ${m.id} · ${m.when} · ${m.from}${m.unread ? ' · unread' : ''} · "${m.subject}" — ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      return text(accountBlock('gmail', `Gmail (${label}), newest first: ${lines.length} message${lines.length === 1 ? '' : 's'}.`, lines, lines.length ? 'To read one, call gmail_read with its id.' : ''));
    }
    const m = msgs.find((x) => x.id === str(args.id)) ?? msgs[0]!;
    return text(accountBlock('gmail', `Gmail (${label}), one message:`, [`From: ${m.from}`, `Date: ${m.when}`, `Subject: ${m.subject}`, `Text: ${m.text.replace(/\s+/g, ' ')}`]));
  }
  switch (tool) {
    case 'announce':
      return text(`Said: "${str(args.text)}". Go ahead.`);
    case 'open_url':
      return text(`Opened a new Zen tab and loaded ${str(args.url)}.\nTab id: ${tab} — keep working in it with the browser tools (snapshot, find, click…).`);
    case 'open_app':
      return text(`Opened ${str(args.app, 'the app')}.`);
    case 'play_media':
      return text(`Playing "${str(args.query)}" on ${str(args.service, 'YouTube')} (tab ${tab}).`);
    case 'media_control':
      return text(`Done: ${str(args.action, 'ok')}.`);
    case 'volume':
      return text(`Volume ${str(args.action, 'set')}${typeof args.level === 'number' ? ` to ${args.level}` : ''}.`);
    case 'desktop_status':
      return text('Mac unlocked. Zen is running and attached. Nothing is playing.');
    case 'browser_status':
      return text('zen: attached (Zen for Stephen). chrome: not running.');
    case 'tabs_list':
      return text('No tabs Stephen has opened yet.');
    case 'tab_open':
      return text(`Opened tab ${tab}: ${str(args.url)}`);
    // A loaded but unremarkable page. (It used to say "still loading" every time, which made the model poll
    // snapshot/read_text 6–10 times — an eval artifact, not real behaviour.)
    case 'snapshot':
    case 'read_text':
      return text('Page loaded. Main heading: "Home". Nothing else on the page stands out.');
    case 'find':
      return text('No matching element on the page.');
    default:
      return text('Done.');
  }
}

/** Build the dry-run server. `record` gets every call (before the fake result goes back). */
export function buildDryRunServer(
  deps: ServerDepsWithVoice,
  version: string,
  record: (c: DryCall) => void,
  opts: { page?: string; trust?: 'wake' } = {},
): { server: McpServer; tools: string[] } {
  const mcp = new McpServer({ name: 'stephen', version }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  // The Hub is only needed so registerTools can read config while REGISTERING; no handler ever reaches it.
  const hub = new Hub({ ...deps, voice: deps.voice ?? {} } as ServerDepsWithVoice, mcp);
  let n = 0;
  let url: string | undefined;
  let clicked = false;
  const [before, after] = opts.page?.split('\n' + AFTER_CLICK + '\n') ?? [];
  const shim = {
    registerTool(name: string, config: Parameters<McpServer['registerTool']>[1], _real: unknown) {
      const cb = async (args: Record<string, unknown>) => {
        n += 1;
        const a = args ?? {};
        record({ tool: name, args: a, n });
        if ((name === 'open_url' || name === 'tab_open' || name === 'navigate') && typeof a.url === 'string') url = a.url;
        if (name === 'click') clicked = true;
        const page = clicked && after !== undefined ? after : before;
        const ctx = { ...(page !== undefined ? { page } : {}), ...(url ? { url } : {}), ...(opts.trust ? { trust: opts.trust } : {}) };
        const res = fakeResult(name, a, n, ctx);
        // include_snapshot: true on an action brings the page back in the same answer, like the real tools.
        if (a.include_snapshot === true && ctx.page !== undefined) res.content.push(...pageResult('snapshot', a, { ...ctx, page: ctx.page }).content);
        return res;
      };
      return mcp.registerTool(name, config, cb as never);
    },
  } as unknown as McpServer;
  const tools = registerTools(shim, hub);
  return { server: mcp, tools };
}

/** Recorder that appends one JSON line per call to `file` (0600). */
export function fileRecorder(file: string): (c: DryCall) => void {
  return (c) => appendFileSync(file, `${JSON.stringify(c)}\n`, { mode: 0o600 });
}

/** Read a record file back (missing file = no calls). */
export function readDryCalls(content: string): DryCall[] {
  return content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DryCall);
}
