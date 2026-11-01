/**
 * The "desktop" section of config.json (src/config.ts passes it through raw; it is validated here).
 *
 *   "desktop": { "enabled": true, "allowedApps": ["Steam", "com.valvesoftware.steam"], "blockedApps": ["Music"], "reuseTabs": "site" }
 *
 * `null` for a key means "use the default", like everywhere else in config.json.
 */
import { z } from 'zod';
import { HubError } from '../errors.js';

export interface DesktopConfig {
  /** Register open_app / open_url / desktop_status. Default true. */
  enabled: boolean;
  /** Extra apps (display names or bundle ids) that open without asking. Never overrides the built-in hard block. */
  allowedApps: string[];
  /** Extra apps (display names or bundle ids) that are always refused. */
  blockedApps: string[];
  /**
   * Opening a page in an attached browser (open_url, play_media, tab_open) reuses a tab instead of adding one:
   * "site" (default) = a tab with the same page is focused, else a tab on the same site is navigated;
   * "exact" = only a tab already showing that exact page is focused; "never" = always a new tab.
   */
  reuseTabs: ReuseTabs;
}

export const REUSE_TABS = ['site', 'exact', 'never'] as const;
export type ReuseTabs = (typeof REUSE_TABS)[number];

export const MAX_APP_ENTRIES = 200;

const appList = z
  .array(
    z
      .string()
      .trim()
      .min(1, 'entries must be non-empty app names or bundle ids')
      .max(200, 'entries must be at most 200 characters')
      .regex(/^[^\u0000-\u001f\u007f]*$/, 'entries must not contain control characters'),
    { error: 'must be a list of app names or bundle ids, e.g. ["Steam", "com.valvesoftware.steam"]' },
  )
  .max(MAX_APP_ENTRIES, `at most ${MAX_APP_ENTRIES} entries`)
  .nullish();

const DesktopConfigSchema = z.strictObject({
  enabled: z.boolean({ error: 'must be true or false' }).nullish(),
  allowedApps: appList,
  blockedApps: appList,
  reuseTabs: z.enum(REUSE_TABS, { error: 'must be "site", "exact" or "never"' }).nullish(),
});

/** Validate the raw `desktop` section and apply defaults. Throws HubError('INVALID_ARG') with every problem listed. */
export function parseDesktopConfig(raw: unknown): DesktopConfig {
  const r = DesktopConfigSchema.safeParse(raw ?? {});
  if (!r.success) {
    const problems = r.error.issues
      .map((i) => {
        const key = ['desktop', ...i.path.map(String)].join('.');
        if (i.code === 'unrecognized_keys') {
          return `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"desktop.${k}"`).join(', ')} (allowed: enabled, allowedApps, blockedApps, reuseTabs)`;
        }
        return `"${key}": ${i.message}`;
      })
      .join('; ');
    throw new HubError('INVALID_ARG', `Invalid "desktop" section in config.json: ${problems}`);
  }
  const d = r.data;
  return {
    enabled: d.enabled ?? true,
    allowedApps: [...(d.allowedApps ?? [])],
    blockedApps: [...(d.blockedApps ?? [])],
    reuseTabs: d.reuseTabs ?? 'site',
  };
}
