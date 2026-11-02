/**
 * What `accounts.status` shows in the Stephen window: for each account, connected / not set / turned off, where the
 * secret was found (Keychain or .env, never the value) and a one-line hint. No network calls. Built on lookupSecret
 * and parseAccountsConfig; a missing or broken "accounts" config is tolerated (the problem goes in `note`).
 */
import { AccountsConfigError, parseAccountsConfig, type AccountsConfig } from '../accounts/config.js';
import { lookupGmailToken, lookupSecret, type SecretDeps, type SecretName } from '../accounts/secrets.js';

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
  gmail: 'Connect it with: stephen connect gmail <label> (the refresh token goes in the Keychain)',
} as const;

export async function accountsStatus(rawAccounts: unknown, deps: SecretDeps = {}): Promise<AccountsStatus> {
  let note: string | undefined;
  let cfg: AccountsConfig;
  try {
    cfg = parseAccountsConfig(rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts) ? rawAccounts : {});
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
  const gmailOn = cfg.enabled && cfg.gmail.enabled;
  for (const [i, label] of cfg.gmail.accounts.entries()) {
    const r = gmailOn ? await lookupGmailToken(label, deps) : null;
    rows.push({ id: `gmail:${i + 1}`, name: 'Gmail', state: !gmailOn ? 'off' : r?.value ? 'connected' : 'not_set', source: r?.value ? r.source : null, detail: label, hint: ACCOUNT_HINTS.gmail });
  }
  return { accounts: rows, ...(note ? { note } : {}) };
}
