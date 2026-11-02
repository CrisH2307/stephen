/**
 * What `accounts.status` shows in the Stephen window: for each account, connected / not set / turned off, where the
 * secret was found (Keychain or .env, never the value) and a one-line hint. No network calls. Built on lookupSecret
 * and parseAccountsConfig; a missing or broken "accounts" config is tolerated (the problem goes in `note`).
 */
import { AccountsConfigError, parseAccountsConfig, type AccountsConfig } from '../accounts/config.js';
import { lookupSecret, type SecretDeps, type SecretName } from '../accounts/secrets.js';

export type AccountState = 'connected' | 'not_set' | 'off';

export interface AccountRow {
  /** 'canvas' | 'calendar' | 'notion' | 'weather' | 'gmail:<n>' */
  id: string;
  name: string;
  state: AccountState;
  /** Where the secret was found; null when there is none (weather needs no secret) or it was not found. */
  source: 'keychain' | '.env' | null;
  /** Extra line, e.g. the weather place. Never a secret. */
  detail?: string;
  hint: string;
}

export interface AccountsStatus {
  accounts: AccountRow[];
  /** Why the config could not be used (defaults were shown instead). */
  note?: string;
}

export const ACCOUNT_HINTS = {
  canvas: 'Put CANVAS_API in .env (or the Keychain item stephen-canvas)',
  calendar: 'Put GOOGLE_CALENDAR_ICS (your secret iCal address) in .env',
  notion: 'Put NOTION_API in .env, then share your to-do database with the integration',
  weather: 'No key needed. Change the place with: stephen accounts weather set <lat> <lon> <label>',
  gmail: 'Gmail is not connected from the window yet',
} as const;

function gmailLabels(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const g = (raw as Record<string, unknown>).gmail;
  const list = g && typeof g === 'object' ? (g as Record<string, unknown>).accounts : undefined;
  if (!Array.isArray(list)) return [];
  const labels: string[] = [];
  for (const a of list.slice(0, 10)) {
    const obj = a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
    const label = typeof a === 'string' ? a : obj && typeof obj.label === 'string' ? obj.label : '';
    if (label.trim()) labels.push(label.trim().slice(0, 60));
  }
  return labels;
}

export async function accountsStatus(rawAccounts: unknown, deps: SecretDeps = {}): Promise<AccountsStatus> {
  let note: string | undefined;
  let cfg: AccountsConfig;
  // (gmail is not part of the accounts schema yet, which is strict: leave it out before parsing)
  const base = rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts) ? { ...(rawAccounts as Record<string, unknown>) } : {};
  delete base.gmail;
  try {
    cfg = parseAccountsConfig(base);
  } catch (e) {
    note = e instanceof AccountsConfigError ? e.message : 'could not read the accounts config';
    cfg = parseAccountsConfig({});
  }
  const row = async (id: 'canvas' | 'calendar' | 'notion', name: string, secret: SecretName, on: boolean, detail?: string): Promise<AccountRow> => {
    const hint = ACCOUNT_HINTS[id];
    if (!cfg.enabled || !on) return { id, name, state: 'off', source: null, hint };
    const r = await lookupSecret(secret, deps);
    return { id, name, state: r.value ? 'connected' : 'not_set', source: r.source, ...(detail ? { detail } : {}), hint };
  };
  const rows: AccountRow[] = [
    await row('canvas', 'Canvas', 'canvas-token', cfg.canvas.enabled),
    await row('calendar', 'Calendar', 'calendar-ics', cfg.calendar.enabled),
    await row('notion', 'Notion', 'notion-token', cfg.notion.enabled, cfg.notion.todoDatabase ? 'To-do database set' : undefined),
    {
      id: 'weather',
      name: 'Weather',
      state: cfg.enabled && cfg.weather.enabled ? 'connected' : 'off',
      source: null,
      detail: cfg.weather.label,
      hint: ACCOUNT_HINTS.weather,
    },
  ];
  gmailLabels(rawAccounts).forEach((label, i) => rows.push({ id: `gmail:${i + 1}`, name: 'Gmail', state: 'not_set', source: null, detail: label, hint: ACCOUNT_HINTS.gmail }));
  return { accounts: rows, ...(note ? { note } : {}) };
}
