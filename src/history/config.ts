/**
 * The `history` section of config.json (docs/PLAN-1.9-MEMORY-DASHBOARD.md sections 9 and 12.2):
 * `{ "retentionDays": 7 }`. Default 7 (ADR-007, owner answer Q6), allowed 0 to 30; 0 = history off (nothing is written,
 * existing day files are deleted on the next purge).
 */
import { z } from 'zod';
import { ConfigError } from '../lib/errors.js';
import { unknownKeyPaths } from '../config.js';

export const DEFAULT_HISTORY_RETENTION_DAYS = 7;
export const MAX_HISTORY_RETENTION_DAYS = 30;

const HistoryConfigSchema = z.object({
  retentionDays: z.number().int().min(0).max(MAX_HISTORY_RETENTION_DAYS).optional(),
});

export interface HistoryConfig {
  retentionDays: number;
}

export class HistoryConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryConfigError';
  }
}

function describe(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const key = i.path.map(String).join('.');
      return `"history${key ? `.${key}` : ''}": ${i.message}`;
    })
    .join('; ');
}

/** Validate the raw `history` section (null values mean "use the default"). Throws HistoryConfigError. */
export function parseHistoryConfig(raw: unknown, unknownKeys?: string[]): HistoryConfig {
  const obj: Record<string, unknown> = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new HistoryConfigError('"history" must be an object');
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v !== null && v !== undefined) obj[k] = v;
  }
  const r = HistoryConfigSchema.safeParse(obj);
  if (!r.success) throw new HistoryConfigError(`Invalid history config: ${describe(r.error)}`);
  unknownKeys?.push(...unknownKeyPaths(obj, r.data, 'history'));
  return { retentionDays: r.data.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS };
}
