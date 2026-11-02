/**
 * `"accounts"` in config.json (phase 2a). Everything is optional:
 *   { "enabled": true, "timeZone": "America/Toronto", "canvas": { "enabled": true, "url": "https://learn.ontariotechu.ca" } }
 * Tokens are NEVER here (Keychain or the repo's .env, see secrets.ts).
 */
import { z } from 'zod';
import { checkOrigin } from './http.js';

const service = z.object({ enabled: z.boolean().default(true) }).strict();

const schema = z
  .object({
    enabled: z.boolean().default(true),
    /** IANA zone for dates in results; default: the Mac's. */
    timeZone: z.string().min(1).max(64).optional(),
    canvas: service.extend({ url: z.string().min(1).max(200).optional() }).strict().default({ enabled: true }),
    calendar: service.default({ enabled: true }),
  })
  .strict();

export type AccountsConfig = z.infer<typeof schema>;

export class AccountsConfigError extends Error {}

export function parseAccountsConfig(raw: unknown): AccountsConfig {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new AccountsConfigError(`config.json "accounts": ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const c = r.data;
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
  return c;
}
