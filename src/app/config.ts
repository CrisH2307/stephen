/**
 * The `app` section of config.json (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 13): the Stephen window's socket.
 *   enabled       `stephen listen` serves <home>/run/app.sock (default true; false = no socket, the window can't connect)
 *   speakReplies  replies to typed chat are spoken too (default false: shown in the window only)
 */
import { z } from 'zod';
import { ConfigError } from '../lib/errors.js';

const AppConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  speakReplies: z.boolean().default(false),
});

export type AppConfig = z.output<typeof AppConfigSchema>;

export class AppConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigError';
  }
}

function describe(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      if (i.code === 'unrecognized_keys') return `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"app.${k}"`).join(', ')}`;
      const key = i.path.map(String).join('.');
      return `"app${key ? `.${key}` : ''}": ${i.message}`;
    })
    .join('; ');
}

/** Validate the raw `app` section (null values mean "use the default"). Throws AppConfigError. */
export function parseAppConfig(raw: unknown): AppConfig {
  const obj: Record<string, unknown> = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppConfigError('"app" must be an object');
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v !== null && v !== undefined) obj[k] = v;
  }
  const r = AppConfigSchema.safeParse(obj);
  if (!r.success) throw new AppConfigError(`Invalid app config: ${describe(r.error)}`);
  return r.data;
}
