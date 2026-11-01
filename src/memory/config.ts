/** The `memory` section of config.json (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 9). */
import { z } from 'zod';
import { MAX_MEMORY_ITEMS } from './store.js';

const MemoryConfigSchema = z.strictObject({
  /** Use saved memories and the "remember …" / "forget …" voice commands. */
  enabled: z.boolean().default(true),
  /** A "remember …" said after the wake word (not push-to-talk) asks in a dialog first: a video can say it too. */
  confirmWakeWord: z.boolean().default(true),
  /** Most items kept (at most 30). */
  maxItems: z.number().int().min(1).max(MAX_MEMORY_ITEMS).default(MAX_MEMORY_ITEMS),
});

export type MemoryConfig = z.output<typeof MemoryConfigSchema>;

export class MemoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConfigError';
  }
}

function describe(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      if (i.code === 'unrecognized_keys') return `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"memory.${k}"`).join(', ')}`;
      const key = i.path.map(String).join('.');
      return `"memory${key ? `.${key}` : ''}": ${i.message}`;
    })
    .join('; ');
}

/** Validate the raw `memory` section (null values mean "use the default"). Throws MemoryConfigError. */
export function parseMemoryConfig(raw: unknown): MemoryConfig {
  const obj: Record<string, unknown> = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new MemoryConfigError('"memory" must be an object');
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v !== null && v !== undefined) obj[k] = v;
  }
  const r = MemoryConfigSchema.safeParse(obj);
  if (!r.success) throw new MemoryConfigError(`Invalid memory config: ${describe(r.error)}`);
  return r.data;
}
