/**
 * What `personal.summary` shows on the Personal page (UI-PLAN v3.1 section 7). Read-only: nothing here writes.
 *  - about: the owner's own voice.aboutMe (name, school, work, notes) and the listener's time zone. The home address
 *    stays out of the window: the persona needs it, no page shows it (settings.get leaves it out too).
 *  - routines: what Stephen can do on request and what each needs, with a state from the accounts.status rows.
 *    The window lists the accounts themselves with accounts.status, so they are not repeated here.
 *  - permissions: PERMISSIONS below, the one description of the safety rules the window shows. Each cell cites the
 *    rule it comes from; test/app/personal.test.ts checks every cited policy rule id exists in src/safety/policy.ts.
 * Memory is not here: the window lists it with the existing memory.list request.
 */
import type { AboutMe } from '../voice/config.js';
import type { AccountRow, AccountsStatus } from './accounts-status.js';

export type PermissionLevel = 'allowed' | 'asks' | 'never';

export interface PermissionCell {
  level: PermissionLevel;
  /** Why, in the owner's words, with the rule it comes from. */
  rule: string;
}

export interface PermissionRow {
  action: string;
  /** One per PERMISSION_COLUMNS entry. */
  cells: PermissionCell[];
}

/** How the command started: F5 is trusted, the wake word and the phone are not (src/voice/assistant.ts trustOf). */
export const PERMISSION_COLUMNS = ['F5', 'Hey Stephen', 'Phone'];

const ALLOWED_PAGES = 'Allowed. Sensitive sites and data-carrying links after a private read ask first (policy: sensitive-domain, cross-site-navigate); blocked sites never open (blocked-url).';
const ALLOWED_INPUT = 'Allowed. Buttons like Send or Delete, sensitive pages and a new site after private data ask first (policy: high-risk-click, sensitive-domain, first-interaction, cross-site-typing); never into password fields (secret-field).';
const ASKS_SEND = 'Always asks you in the Ask box or a dialog; a spoken yes never counts (policy: high-risk-click, high-risk-key).';
const PHONE_DECLINES = 'nobody is at the Mac to answer, so anything that would ask is declined (serve --confirm deny, src/voice/claude.ts).';

export const PERMISSIONS: PermissionRow[] = [
  {
    action: 'Read',
    cells: [
      { level: 'allowed', rule: 'Allowed. Pages, Canvas, Calendar, Notion and email in full (trusted).' },
      { level: 'allowed', rule: 'Allowed. Email shows only who and when, no message bodies (serve --trust wake, REVIEW-7 R7-2).' },
      { level: 'allowed', rule: 'Allowed. Wake-word data rules and no memory (ADR-005, REVIEW-8 R8-8).' },
    ],
  },
  {
    action: 'Open pages',
    cells: [
      { level: 'allowed', rule: ALLOWED_PAGES },
      { level: 'allowed', rule: ALLOWED_PAGES },
      { level: 'allowed', rule: `Allowed, but ${PHONE_DECLINES}` },
    ],
  },
  {
    action: 'Type and click',
    cells: [
      { level: 'allowed', rule: ALLOWED_INPUT },
      { level: 'allowed', rule: ALLOWED_INPUT },
      { level: 'allowed', rule: `Allowed, but ${PHONE_DECLINES}` },
    ],
  },
  {
    action: 'Send or submit',
    cells: [
      { level: 'asks', rule: ASKS_SEND },
      { level: 'asks', rule: ASKS_SEND },
      { level: 'never', rule: `Never: ${PHONE_DECLINES}` },
    ],
  },
];

export type RoutineState = 'ready' | 'needs_setup' | 'off';

export interface Routine {
  id: string;
  name: string;
  /** What it uses, for the row's detail line ("Calendar, Canvas, Weather"). */
  uses: string;
  /** What to say to run it. */
  say: string;
  state: RoutineState;
  /** Names of the accounts it still needs (needs_setup only). */
  missing?: string[];
}

/** id → the account ids it reads (accounts.status ids; 'gmail' matches any gmail:<n>). Empty = nothing to set up. */
const ROUTINES: { id: string; name: string; uses: string; say: string; needs: string[] }[] = [
  // The persona's briefing line (src/voice/claude.ts): calendar_events, canvas_due, weather_now in one step.
  { id: 'briefing', name: 'Morning briefing', uses: 'Calendar, Canvas, Weather', say: "What's my day?", needs: ['calendar', 'canvas', 'weather'] },
  { id: 'music', name: 'Play music', uses: 'Zen or Chrome', say: 'Play some lofi', needs: [] },
  { id: 'jobs', name: 'Background jobs', uses: 'A folder in Stephen Jobs', say: 'Start a job to …', needs: [] },
  { id: 'inboxes', name: 'Read inboxes', uses: 'Gmail, Canvas', say: 'Any new email?', needs: ['gmail', 'canvas'] },
];

function routines(accounts: AccountRow[], jobsOn: boolean): Routine[] {
  return ROUTINES.map(({ needs, ...r }) => {
    if (r.id === 'jobs' && !jobsOn) return { ...r, state: 'off' };
    const missing = needs
      .filter((n) => !accounts.some((a) => (a.id === n || a.id.startsWith(`${n}:`)) && a.state === 'connected'))
      .map((n) => accounts.find((a) => a.id === n || a.id.startsWith(`${n}:`))?.name ?? n.charAt(0).toUpperCase() + n.slice(1));
    return missing.length ? { ...r, state: 'needs_setup', missing } : { ...r, state: 'ready' };
  });
}

export interface PersonalSummary {
  about: { name?: string; school?: string; work?: string; notes: string[]; timeZone: string };
  routines: Routine[];
  permissions: { columns: string[]; rows: PermissionRow[] };
}

export function personalSummary(o: { aboutMe: AboutMe | null | undefined; accounts: AccountsStatus; jobsOn: boolean; timeZone?: string }): PersonalSummary {
  const a = o.aboutMe ?? {};
  return {
    about: {
      ...(a.name ? { name: a.name } : {}),
      ...(a.school ? { school: a.school } : {}),
      ...(a.work ? { work: a.work } : {}),
      notes: [...(a.notes ?? [])],
      timeZone: o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    routines: routines(o.accounts.accounts, o.jobsOn),
    permissions: { columns: PERMISSION_COLUMNS, rows: PERMISSIONS },
  };
}
