/**
 * `stephen accounts` — which account secrets Stephen can find (never their values), and
 * `stephen accounts test canvas` — a real read-only call (your name + how many items are due this week).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFilePath, loadConfig } from '../config.js';
import { calendarFeed, formatInstances, instancesBetween, ownerZone, parseIcs, rangeWindow } from './calendar.js';
import { CanvasClient, DEFAULT_CANVAS_URL, formatDue } from './canvas.js';
import { ApiClient } from './http.js';
import { field } from './result.js';
import { parseAccountsConfig } from './config.js';
import { WEATHER_ORIGIN, fetchWeather, formatWeather } from './weather.js';
import { lookupSecret, SECRET_SPECS, type SecretDeps, type SecretName } from './secrets.js';

export const ACCOUNTS_HELP = `stephen accounts              Show which account secrets Stephen finds (Keychain or .env; never the values)
stephen accounts test canvas  Read your Canvas once: your name and what's due in the next 7 days
stephen accounts test calendar  Read your Google Calendar feed once: events in the next 7 days
stephen accounts weather      Show the place the weather tool uses (default Toronto, ON)
stephen accounts weather set <latitude> <longitude> [label…]  Save your place in config.json (e.g. set 43.9 -78.9 Oshawa, ON)
stephen accounts test weather  Read the weather once for that place`;

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
}

/** Set `accounts.weather` in config.json, keeping everything else (and comments are not supported: it is plain JSON). */
function saveWeatherPlace(file: string, place: { latitude: number; longitude: number; label: string }): void {
  let root: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.json is not a JSON object');
    root = parsed as Record<string, unknown>;
  }
  const accounts = root.accounts && typeof root.accounts === 'object' && !Array.isArray(root.accounts) ? (root.accounts as Record<string, unknown>) : {};
  const old = accounts.weather && typeof accounts.weather === 'object' ? (accounts.weather as Record<string, unknown>) : {};
  root.accounts = { ...accounts, weather: { ...old, ...place } };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
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
      err('Usage: stephen accounts weather set <latitude> <longitude> [label…]   e.g. weather set 43.6532 -79.3832 Toronto, ON');
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
