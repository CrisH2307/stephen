/**
 * `"accounts"` in config.json (phase 2a). Everything is optional:
 *   { "enabled": true, "timeZone": "America/Toronto", "canvas": { "enabled": true, "url": "https://learn.ontariotechu.ca" },
 *     "notion": { "enabled": true, "todoDatabase": "<32 hex id>" },
 *     "gmail": { "enabled": true, "clientId": "<Google OAuth desktop client id>", "accounts": ["personal", "personal2"] } }
 * Tokens are NEVER here (Keychain or the repo's .env, see secrets.ts).
 */
import { z } from 'zod';
import { checkOrigin } from './http.js';
import { DEFAULT_WEATHER } from './weather.js';
import { normalizeNotionId } from './notion.js';
import { GMAIL_LABEL_RE } from './secrets.js';
import { ConfigError } from '../lib/errors.js';
import { unknownKeyPaths } from '../config.js';

const service = z.object({ enabled: z.boolean().default(true) });

const schema = z
  .object({
    enabled: z.boolean().default(true),
    /** IANA zone for dates in results; default: the Mac's. */
    timeZone: z.string().min(1).max(64).optional(),
    canvas: service.extend({ url: z.string().min(1).max(200).optional() }).default({ enabled: true }),
    calendar: service.default({ enabled: true }),
    /** Where the weather tool looks (Open-Meteo, no key). Default Toronto. */
    weather: service
      .extend({
        latitude: z.number().min(-90).max(90).default(DEFAULT_WEATHER.latitude),
        longitude: z.number().min(-180).max(180).default(DEFAULT_WEATHER.longitude),
        label: z.string().min(1).max(60).default(DEFAULT_WEATHER.label),
      })
      .default({ enabled: true, ...DEFAULT_WEATHER }),
    /** todoDatabase: the to-do database id (32 hex, dashes optional); unset = the first shared database titled like "To-do"/"Tasks". */
    notion: service.extend({ todoDatabase: z.string().min(1).max(64).optional() }).default({ enabled: true }),
    /**
     * clientId: the owner's Google Cloud OAuth client (Desktop app); not a secret. accounts: the connected labels in
     * order (the first is the default), added by `stephen connect gmail <label>`. Refresh tokens: Keychain only.
     */
    gmail: service
      .extend({
        clientId: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/, 'must look like a Google OAuth client id').optional(),
        accounts: z.array(z.string().regex(GMAIL_LABEL_RE, 'a label is 1 to 32 of a-z, 0-9, _ and -')).max(10).default([]),
      })
      .default({ enabled: true, accounts: [] }),
  });

export type AccountsConfig = z.infer<typeof schema>;

export class AccountsConfigError extends ConfigError {}

/** Validate the raw "accounts" section. Unknown keys are dropped and listed in `unknownKeys` (names only, for doctor). */
export function parseAccountsConfig(raw: unknown, unknownKeys?: string[]): AccountsConfig {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new AccountsConfigError(`config.json "accounts": ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const c = r.data;
  unknownKeys?.push(...unknownKeyPaths(raw ?? {}, c, 'accounts'));
  if (c.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: c.timeZone });
    } catch {
      throw new AccountsConfigError(`config.json "accounts": timeZone "${c.timeZone}" is not a known time zone`);
    }
  }
  if (c.canvas.url) {
    try {
      checkOrigin(c.canvas.url);
    } catch (e) {
      throw new AccountsConfigError(`config.json "accounts": canvas.url ${(e as Error).message}`);
    }
  }
  if (c.notion.todoDatabase !== undefined) {
    const id = normalizeNotionId(c.notion.todoDatabase);
    if (!id) throw new AccountsConfigError('config.json "accounts": notion.todoDatabase must be a Notion database id (32 hex characters, dashes optional)');
    c.notion.todoDatabase = id;
  }
  c.gmail.accounts = [...new Set(c.gmail.accounts)];
  return c;
}
