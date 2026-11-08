import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccountRow } from '../../src/app/accounts-status.js';
import { PERMISSION_COLUMNS, PERMISSIONS, personalSummary } from '../../src/app/personal.js';

const row = (id: string, name: string, state: AccountRow['state']): AccountRow => ({ id, name, state, source: null, hint: '' });

describe('personalSummary (personal.summary, UI-PLAN v3.1 section 7)', () => {
  it('about: only the shown fields; the home address stays out of the window', () => {
    const p = personalSummary({ aboutMe: { name: 'Cris', home: '1 Secret St', notes: ['I like lofi'] }, accounts: { accounts: [] }, jobsOn: true, timeZone: 'America/Toronto' });
    expect(p.about).toEqual({ name: 'Cris', notes: ['I like lofi'], timeZone: 'America/Toronto' });
    expect(JSON.stringify(p)).not.toContain('Secret St');
    expect(personalSummary({ aboutMe: null, accounts: { accounts: [] }, jobsOn: true }).about.timeZone).toBeTruthy();
  });

  it('routines: ready, needs setup (named), off when jobs are off; any connected Gmail counts', () => {
    const accounts = [row('calendar', 'Calendar', 'connected'), row('canvas', 'Canvas', 'not_set'), row('weather', 'Weather', 'connected'), row('gmail:1', 'Gmail', 'connected')];
    const r = Object.fromEntries(personalSummary({ aboutMe: null, accounts: { accounts, note: 'bad config' }, jobsOn: false }).routines.map((x) => [x.id, x]));
    expect(r.briefing).toMatchObject({ state: 'needs_setup', missing: ['Canvas'] });
    expect(r.inboxes).toMatchObject({ state: 'needs_setup', missing: ['Canvas'] });
    expect(r.music?.state).toBe('ready');
    expect(r.jobs?.state).toBe('off');
    expect(personalSummary({ aboutMe: null, accounts: { accounts: [] }, jobsOn: true }).routines.find((x) => x.id === 'inboxes')?.missing).toEqual(['Gmail', 'Canvas']);
  });

  it('permission table: one cell per column; phone never sends; trusted and wake-word sending asks', () => {
    for (const r of PERMISSIONS) expect(r.cells).toHaveLength(PERMISSION_COLUMNS.length);
    const send = PERMISSIONS.find((r) => r.action === 'Send or submit')!;
    expect(send.cells.map((c) => c.level)).toEqual(['asks', 'asks', 'never']);
    expect(PERMISSIONS.map((r) => r.action)).toEqual(['Read', 'Open pages', 'Type and click', 'Send or submit']);
  });

  it('every cell cites a rule that exists in the code it names (one source of truth stays honest)', () => {
    const policy = readFileSync('src/safety/policy.ts', 'utf8');
    // "(policy: a, b)" and "(blocked-url)" name rule ids from the header table of src/safety/policy.ts.
    const ids = (rule: string) => [
      ...[...rule.matchAll(/\(policy: ([^)]+)\)/g)].flatMap((m) => m[1]!.split(', ')),
      ...[...rule.matchAll(/\(([a-z]+(?:-[a-z]+)+)\)/g)].map((m) => m[1]!),
    ];
    const cited = new Set(PERMISSIONS.flatMap((r) => r.cells.flatMap((c) => ids(c.rule))));
    expect(cited.size).toBeGreaterThan(5);
    for (const id of cited) expect(policy, id).toMatch(new RegExp(`^ \\*   ${id} +(deny|confirm)`, 'm'));
    // The phone column's "declined" comes from the phone's serve flags.
    expect(readFileSync('src/voice/claude.ts', 'utf8')).toContain("'--confirm', trust === 'phone' ? 'deny' : 'app'");
    for (const r of PERMISSIONS) for (const c of r.cells) expect(c.rule.length).toBeGreaterThan(10);
  });
});
