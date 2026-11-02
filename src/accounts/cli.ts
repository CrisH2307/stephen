/**
 * `stephen accounts` — which account secrets Stephen can find (never their values), and
 * `stephen accounts test canvas|calendar|notion` — one real read-only call each (e.g. how many items are due this week).
 */
import { loadConfig } from '../config.js';
import { calendarFeed, formatInstances, instancesBetween, ownerZone, parseIcs, rangeWindow } from './calendar.js';
import { CanvasClient, DEFAULT_CANVAS_URL, formatDue } from './canvas.js';
import { ApiClient } from './http.js';
import { NO_TODO_DATABASE, NotionClient } from './notion.js';
import { field } from './result.js';
import { parseAccountsConfig } from './config.js';
import { lookupSecret, SECRET_SPECS, type SecretDeps, type SecretName } from './secrets.js';

export const ACCOUNTS_HELP = `stephen accounts              Show which account secrets Stephen finds (Keychain or .env; never the values)
stephen accounts test canvas  Read your Canvas once: your name and what's due in the next 7 days
stephen accounts test calendar  Read your Google Calendar feed once: events in the next 7 days
stephen accounts test notion  Read your Notion to-do database once: how many open to-dos`;

export interface AccountsCliEnv {
  out?: (l: string) => void;
  err?: (l: string) => void;
  secrets?: SecretDeps;
  accounts?: unknown;
  /** Tests only. */
  allowLoopbackHttp?: boolean;
  /** Tests only: a fake Notion server. */
  notionOrigin?: string;
}

export async function runAccountsCli(argv: string[], e: AccountsCliEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  if (argv[0] === '--help' || argv[0] === 'help') {
    out(ACCOUNTS_HELP);
    return 0;
  }
  if (argv.length === 0 || argv[0] === 'status') {
    for (const name of Object.keys(SECRET_SPECS) as SecretName[]) {
      const r = await lookupSecret(name, e.secrets);
      out(`${name.padEnd(13)} ${r.source ? `found (${r.source})` : 'not set'}${r.notes.length ? ` — ${r.notes.join('; ')}` : ''}`);
    }
    return 0;
  }
  if (argv[0] === 'test' && argv[1] === 'canvas' && argv.length === 2) {
    let cfg;
    try {
      cfg = parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts);
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
    const token = await lookupSecret('canvas-token', e.secrets);
    if (!token.value) {
      err(`No Canvas token found. Put CANVAS_API=<token> in Stephen's .env (chmod 600) or the Keychain item "stephen-canvas".${token.notes.length ? ` (${token.notes.join('; ')})` : ''}`);
      return 1;
    }
    const url = cfg.canvas.url ?? (await lookupSecret('canvas-url', e.secrets)).value ?? DEFAULT_CANVAS_URL;
    try {
      const c = new CanvasClient({ origin: url, token: token.value, ...(e.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
      const name = await c.whoAmI();
      const now = new Date();
      const { items } = await c.plannerItems(now, new Date(now.getTime() + 7 * 24 * 3600 * 1000));
      const due = formatDue(items, cfg.timeZone ? { timeZone: cfg.timeZone } : {});
      out(`Canvas OK at ${c.api.origin} (token from ${token.source}). Signed in as ${name}.`);
      out(`Due in the next 7 days: ${due.lines.length} (${due.done} already done).`);
      for (const l of due.lines.slice(0, 10)) out(`  ${l}`);
      return 0;
    } catch (x) {
      err(`Canvas test failed: ${(x as Error).message}`);
      return 1;
    }
  }
  if (argv[0] === 'test' && argv[1] === 'calendar' && argv.length === 2) {
    let zone: string;
    try {
      zone = ownerZone(parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts).timeZone);
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
    const feed = await lookupSecret('calendar-ics', e.secrets);
    if (!feed.value) {
      err('No calendar address found. Put GOOGLE_CALENDAR_ICS=<"Secret address in iCal format"> in Stephen\'s .env (chmod 600) or the Keychain item "stephen-calendar-ics".');
      return 1;
    }
    try {
      const where = calendarFeed(feed.value);
      const api = new ApiClient({ origin: where.origin, timeoutMs: 15_000, ...(e.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
      const text = await api.getText(where.path);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('that address did not return a calendar');
      const events = parseIcs(text, zone);
      const w = rangeWindow('week', Date.now(), zone);
      const lines = formatInstances(instancesBetween(events, w.start, w.end, zone), zone, field);
      out(`Calendar OK at ${api.origin} (address from ${feed.source}, zone ${zone}). ${events.length} events in the feed.`);
      out(`Next 7 days: ${lines.length}.`);
      for (const l of lines.slice(0, 10)) out(`  ${l}`);
      return 0;
    } catch (x) {
      err(`Calendar test failed: ${(x as Error).message}`);
      return 1;
    }
  }
  if (argv[0] === 'test' && argv[1] === 'notion' && argv.length === 2) {
    let cfg;
    try {
      cfg = parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts);
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
    const token = await lookupSecret('notion-token', e.secrets);
    if (!token.value) {
      err(`No Notion token found. Put NOTION_API=<internal integration token> in Stephen's .env (chmod 600) or the Keychain item "stephen-notion", and share the to-do database with the integration.${token.notes.length ? ` (${token.notes.join('; ')})` : ''}`);
      return 1;
    }
    try {
      const c = new NotionClient({ token: token.value, ...(e.notionOrigin ? { origin: e.notionOrigin } : {}), ...(e.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
      const r = await c.todos(cfg.notion.todoDatabase, cfg.timeZone ? { timeZone: cfg.timeZone } : {});
      if (!r) {
        err(NO_TODO_DATABASE);
        return 1;
      }
      out(`Notion OK (token from ${token.source}). To-do database: "${field(r.title, 80)}"${r.picked ? ' (picked by its name; set accounts.notion.todoDatabase to choose another)' : ''}.`);
      out(`Open to-dos: ${r.lines.length}${r.truncated ? '+' : ''}.`);
      return 0;
    } catch (x) {
      err(`Notion test failed: ${(x as Error).message}`);
      return 1;
    }
  }
  err(`Unknown accounts command.\n\n${ACCOUNTS_HELP}`);
  return 2;
}
