/**
 * The `history` section of config.json (docs/PLAN-1.9-MEMORY-DASHBOARD.md sections 9 and 12.2):
 * `{ "retentionDays": 1 }`. Default 1 (a one-day trial), allowed 0 to 30; 0 = history off (nothing is written,
 * existing day files are deleted on the next purge).
 */
import { z } from 'zod';

export const DEFAULT_HISTORY_RETENTION_DAYS = 1;
export const MAX_HISTORY_RETENTION_DAYS = 30;

const HistoryConfigSchema = z.strictObject({
  retentionDays: z.number().int().min(0).max(MAX_HISTORY_RETENTION_DAYS).optional(),
});

export interface HistoryConfig {
  retentionDays: number;
}

export class HistoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryConfigError';
  }
}

function describe(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      if (i.code === 'unrecognized_keys') return `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"history.${k}"`).join(', ')}`;
      const key = i.path.map(String).join('.');
      return `"history${key ? `.${key}` : ''}": ${i.message}`;
    })
    .join('; ');
}

/** Validate the raw `history` section (null values mean "use the default"). Throws HistoryConfigError. */
export function parseHistoryConfig(raw: unknown): HistoryConfig {
  const obj: Record<string, unknown> = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new HistoryConfigError('"history" must be an object');
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v !== null && v !== undefined) obj[k] = v;
  }
  const r = HistoryConfigSchema.safeParse(obj);
  if (!r.success) throw new HistoryConfigError(`Invalid history config: ${describe(r.error)}`);
  return { retentionDays: r.data.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS };
}
