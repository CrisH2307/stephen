/**
 * Owner-only CLI (in src/connect/ because it writes config.json; review 7, R7-8). Loaded on demand by src/cli.ts.
 * `stephen accounts` — which account secrets Stephen can find (never their values) and which Gmail labels are connected, and
 * `stephen accounts test canvas|calendar|notion|weather` — one real read-only call each (e.g. how many items are due this week).
 */
import { configFilePath, loadConfig } from '../config.js';
import { updateConfigSection } from '../config-write.js';
import { calendarFeed, formatInstances, instancesBetween, ownerZone, parseIcs, rangeWindow } from '../accounts/calendar.js';
import { CANVAS_URL_MISSING, CanvasClient, formatDue } from '../accounts/canvas.js';
import { ApiClient } from '../accounts/http.js';
import { NO_TODO_DATABASE, NotionClient } from '../accounts/notion.js';
import { field } from '../accounts/result.js';
import { parseAccountsConfig } from '../accounts/config.js';
import { WEATHER_ORIGIN, fetchWeather, formatWeather } from '../accounts/weather.js';
import { checkSecretValue, lookupGmailToken, lookupSecret, SECRET_SPECS, type SecretDeps, type SecretName } from '../accounts/secrets.js';
import { keychainAccount } from '../lib/keychain.js';
import { keychainStore } from './keychain-write.js';
import { readSecretFromStdin } from './voice-key.js';

export const ACCOUNTS_HELP = `stephen accounts              Show which account secrets Stephen finds (Keychain or .env; never the values)
stephen accounts set <name>   Store one in the Keychain (hidden prompt, or piped: pbpaste | stephen accounts set <name>)
                              <name>: ${Object.keys(SECRET_SPECS).join(', ')}
stephen accounts test canvas  Read your Canvas once: your name and what's due in the next 7 days
stephen accounts test calendar  Read your Google Calendar feed once: events in the next 7 days
stephen accounts test notion  Read your Notion to-do database once: how many open to-dos
stephen accounts weather      Show the place the weather tool uses (a built-in default until you set yours)
stephen accounts weather set <latitude> <longitude> [label…]  Save your place in config.json (e.g. set 43.9 -78.9 Oshawa, ON)
stephen accounts test weather  Read the weather once for that place
stephen connect gmail <label>  Sign in to a Gmail account once (read-only; label like "personal"; needs accounts.gmail.clientId)
stephen disconnect gmail <label>  Forget that Gmail account (Keychain item and config entry)`;

export interface AccountsCliEnv {
  out?: (l: string) => void;
  err?: (l: string) => void;
  secrets?: SecretDeps;
  accounts?: unknown;
  /** Tests only. */
  allowLoopbackHttp?: boolean;
  /** Tests only: a fake Open-Meteo origin (needs allowLoopbackHttp). */
  weatherOrigin?: string;
  /** Tests only: the config.json to read and write (default: Stephen's). */
  configPath?: string;
  /** Reads a secret (default: hidden prompt on a TTY, else all of stdin). */
  readSecret?: (prompt: string) => Promise<string>;
  /** Stores it (default: the Keychain item of that secret). Returns an error message, or null. */
  store?: (service: string, label: string, value: string) => Promise<string | null>;
  /** Tests only: a fake Notion server. */
  notionOrigin?: string;
}

/** Change the `"accounts"` section of config.json (src/config-write.ts). Used by `accounts weather set` and `stephen connect|disconnect gmail`. */
export function updateAccountsConfig(file: string, change: (accounts: Record<string, unknown>) => Record<string, unknown>): void {
  updateConfigSection(file, 'accounts', change);
}

/** A sub-object of `accounts` ({} when absent or not an object). */
export const section = (accounts: Record<string, unknown>, name: string): Record<string, unknown> => {
  const v = accounts[name];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

/** Set `accounts.weather` in config.json. */
function saveWeatherPlace(file: string, place: { latitude: number; longitude: number; label: string }): void {
  updateAccountsConfig(file, (accounts) => ({ ...accounts, weather: { ...section(accounts, 'weather'), ...place } }));
}

export async function runAccountsCli(argv: string[], e: AccountsCliEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  if (argv[0] === '--help' || argv[0] === 'help') {
    out(ACCOUNTS_HELP);
    return 0;
  }
  if (argv[0] === 'set') {
    const name = argv[1] as SecretName;
    if (argv.length !== 2 || !(name in SECRET_SPECS)) {
      err(`Usage: stephen accounts set <name>, where <name> is one of: ${Object.keys(SECRET_SPECS).join(', ')}`);
      return 2;
    }
    const value = (await (e.readSecret ?? readSecretFromStdin)(`${name} (input hidden): `)).trim();
    const bad = checkSecretValue(name, value);
    if (bad) {
      err(`Not stored: ${bad}.`);
      return 1;
    }
    const service = SECRET_SPECS[name].keychain;
    const fail = await (e.store ?? ((s, l, v) => keychainStore(s, l, v, { user: keychainAccount({}) })))(service, `Stephen ${name}`, value);
    if (fail) {
      err(fail);
      return 1;
    }
    out(`Stored ${name} in the Keychain (${service}). Keychain wins over .env, so you can now delete its line from .env.`);
    return 0;
  }
  if (argv.length === 0 || argv[0] === 'status') {
    for (const name of Object.keys(SECRET_SPECS) as SecretName[]) {
      const r = await lookupSecret(name, e.secrets);
      out(`${name.padEnd(13)} ${r.source ? `found (${r.source})` : 'not set'}${r.notes.length ? ` — ${r.notes.join('; ')}` : ''}`);
    }
    let gmail;
    try {
      gmail = parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts).gmail;
    } catch (x) {
      err((x as Error).message);
      return 0;
    }
    const states: string[] = [];
    for (const label of gmail.accounts) states.push(`${label} (${(await lookupGmailToken(label, e.secrets)).value ? 'connected' : 'not in the Keychain: run stephen connect gmail ' + label})`);
    out(`gmail         ${states.length ? states.join(', ') : 'no accounts (run stephen connect gmail <label>)'}; client id ${gmail.clientId ? 'set' : 'not set (accounts.gmail.clientId)'}`);
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
    const url = cfg.canvas.url ?? (await lookupSecret('canvas-url', e.secrets)).value;
    if (!url) {
      err(CANVAS_URL_MISSING);
      return 1;
    }
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
  if (argv[0] === 'weather' && argv.length === 1) {
    try {
      const w = parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts).weather;
      out(`Weather place: ${w.label} (${w.latitude}, ${w.longitude})${w.enabled ? '' : ' — the weather tool is turned off in config.json'}.`);
      out('Change it with: stephen accounts weather set <latitude> <longitude> [label]');
      return 0;
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
  }
  if (argv[0] === 'weather' && argv[1] === 'set') {
    const latitude = Number(argv[2]);
    const longitude = Number(argv[3]);
    const label = argv.slice(4).join(' ').trim();
    if (argv.length < 4 || argv[2] === '' || argv[3] === '' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      err('Usage: stephen accounts weather set <latitude> <longitude> [label…]   e.g. weather set 40.7128 -74.0060 New York, NY');
      return 2;
    }
    const place = { latitude, longitude, label: label || `${latitude}, ${longitude}` };
    try {
      parseAccountsConfig({ weather: place }); // range and length checks, same as at startup
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
    const file = e.configPath ?? configFilePath();
    try {
      saveWeatherPlace(file, place);
    } catch (x) {
      err(`Could not update ${file}: ${(x as Error).message}`);
      return 1;
    }
    out(`Saved: ${place.label} (${latitude}, ${longitude}) in ${file}. Restart Stephen to use it.`);
    return 0;
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
  if (argv[0] === 'test' && argv[1] === 'weather' && argv.length === 2) {
    let cfg;
    try {
      cfg = parseAccountsConfig(e.accounts !== undefined ? e.accounts : loadConfig().accounts);
    } catch (x) {
      err((x as Error).message);
      return 2;
    }
    try {
      const api = new ApiClient({ origin: e.allowLoopbackHttp && e.weatherOrigin ? e.weatherOrigin : WEATHER_ORIGIN, ...(e.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
      const w = await fetchWeather(api, cfg.weather, 'today', cfg.timeZone);
      const f = formatWeather(w, cfg.weather, 'today');
      out(`Weather OK at ${api.origin}.`);
      out(f.header);
      for (const l of f.lines) out(`  ${l}`);
      return 0;
    } catch (x) {
      err(`Weather test failed: ${(x as Error).message}`);
      return 1;
    }
  }
  err(`Unknown accounts command.\n\n${ACCOUNTS_HELP}`);
  return 2;
}
