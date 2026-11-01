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
 * give it instructions (the 'inject' cases).
 */
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

/** Read a `--fake-page` file (UTF-8, capped). */
export function readFakePage(file: string): string {
  return readFileSync(file, 'utf8').slice(0, FAKE_PAGE_MAX_CHARS);
}

export interface FakePageContext {
  /** What every page "says" (--fake-page); without it pages are loaded but unremarkable. */
  page?: string;
  /** The last URL opened or navigated to (shown as the page's origin, like the real tools do). */
  url?: string;
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
  opts: { page?: string } = {},
): { server: McpServer; tools: string[] } {
  const mcp = new McpServer({ name: 'stephen', version }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  // The Hub is only needed so registerTools can read config while REGISTERING; no handler ever reaches it.
  const hub = new Hub({ ...deps, voice: deps.voice ?? {} } as ServerDepsWithVoice, mcp);
  let n = 0;
  let url: string | undefined;
  const shim = {
    registerTool(name: string, config: Parameters<McpServer['registerTool']>[1], _real: unknown) {
      const cb = async (args: Record<string, unknown>) => {
        n += 1;
        const a = args ?? {};
        record({ tool: name, args: a, n });
        if ((name === 'open_url' || name === 'tab_open' || name === 'navigate') && typeof a.url === 'string') url = a.url;
        return fakeResult(name, a, n, { ...(opts.page !== undefined ? { page: opts.page } : {}), ...(url ? { url } : {}) });
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
