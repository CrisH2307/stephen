import { describe, expect, it } from 'vitest';
import { commandSteps, MAX_CHAT_STEPS, MAX_STEP_CHARS } from '../../src/app/steps.js';
import type { AuditEntry } from '../../src/types.js';

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, s)).toISOString();
const T0 = Date.parse(at(10));
const T1 = Date.parse(at(20));

describe('commandSteps (the action chain under a reply)', () => {
  it('lists audit actions inside the command, oldest first, refusals and failures in words, then other tools', () => {
    const audit: AuditEntry[] = [
      { ts: at(15), tool: 'click', kind: 'click', element: 'button "Send"', outcome: 'denied', verdict: 'confirm' },
      { ts: at(12), tool: 'type', kind: 'type', element: 'textbox "Search"', outcome: 'ok' },
      { ts: at(13), tool: 'click', kind: 'click', element: 'link "Hai Phan"', outcome: 'error' },
      { ts: at(2), tool: 'click', kind: 'click', element: 'link "earlier command"', outcome: 'ok' },
    ];
    const calls = [
      { tool: 'type', isError: false, ms: 5 },
      { tool: 'gmail_search', isError: false, ms: 900 },
      { tool: 'weather_now', isError: true, ms: 10 },
    ];
    expect(commandSteps(audit, calls, T0, T1)).toEqual([
      { text: 'type textbox "Search"', status: 'ok' },
      { text: 'Tried click link "Hai Phan", it failed', status: 'failed' },
      { text: 'Refused: click button "Send". you did not allow it', status: 'refused' },
      { text: 'Used gmail_search', status: 'ok' },
      { text: 'Used weather_now', status: 'failed' },
    ]);
  });

  it('caps the count and the length of each line', () => {
    const calls = Array.from({ length: 60 }, () => ({ tool: 'x'.repeat(64), isError: false, ms: 1 }));
    const audit: AuditEntry[] = [{ ts: at(11), tool: 'click', kind: 'click', element: 'y'.repeat(500), outcome: 'ok' }];
    const steps = commandSteps(audit, calls, T0, T1);
    expect(steps).toHaveLength(MAX_CHAT_STEPS);
    expect(steps.every((s) => [...s.text].length <= MAX_STEP_CHARS)).toBe(true);
  });

  it('with a command id: the id adds this command\'s late entries and never hides an entry inside the time window', () => {
    const audit: AuditEntry[] = [
      { ts: at(12), tool: 'click', kind: 'click', element: 'button "Mine"', outcome: 'ok', cmd: 'h_00000000000000aa' },
      { ts: at(13), tool: 'click', kind: 'click', element: 'button "Other command"', outcome: 'ok', cmd: 'h_00000000000000bb' },
      { ts: at(14), tool: 'type', kind: 'type', element: 'textbox "No id"', outcome: 'ok' },
      { ts: at(50), tool: 'click', kind: 'click', element: 'button "Mine, late"', outcome: 'ok', cmd: 'h_00000000000000aa' },
      { ts: at(51), tool: 'click', kind: 'click', element: 'button "No id, outside"', outcome: 'ok' },
    ];
    expect(commandSteps(audit, [], T0, T1, 'h_00000000000000aa').map((s) => s.text)).toEqual(['click button "Mine"', 'click button "Other command"', 'type textbox "No id"', 'click button "Mine, late"']);
    expect(commandSteps(audit, [], T0, T1).map((s) => s.text)).toEqual(['click button "Mine"', 'click button "Other command"', 'type textbox "No id"']);
  });

  it('nothing ran: no steps', () => {
    expect(commandSteps([], [], T0, T1)).toEqual([]);
  });
});
