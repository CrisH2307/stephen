import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commandSteps, MAX_CHAT_STEPS, MAX_STEP_CHARS, readCommandSteps, STEPS_AUDIT_WAIT_MS, type ChatStep } from '../../src/app/steps.js';
import { HistoryStore } from '../../src/history/store.js';
import type { AuditEntry } from '../../src/types.js';
import type { CommandReport } from '../../src/voice/assistant.js';
import { finishCommand, historyRecorder } from '../../src/voice/command-log.js';

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
      { text: 'Tried weather_now, it failed', status: 'failed' },
    ]);
  });

  it('R10a-3 a failed tool-log call reads "Tried X, it failed", not "Used X"', () => {
    expect(commandSteps([], [{ tool: 'gmail_search', isError: true, ms: 5 }], T0, T1)).toEqual([{ text: 'Tried gmail_search, it failed', status: 'failed' }]);
  });

  it('caps the count and the length of each line', () => {
    const calls = Array.from({ length: 60 }, () => ({ tool: 'x'.repeat(64), isError: false, ms: 1 }));
    const audit: AuditEntry[] = [{ ts: at(11), tool: 'click', kind: 'click', element: 'y'.repeat(500), outcome: 'ok' }];
    const steps = commandSteps(audit, calls, T0, T1);
    expect(steps).toHaveLength(MAX_CHAT_STEPS);
    expect(steps.every((s) => [...s.text].length <= MAX_STEP_CHARS)).toBe(true);
  });

  it('with a command id: the id adds this command\'s late entries and hides another command\'s', () => {
    const audit: AuditEntry[] = [
      { ts: at(12), tool: 'click', kind: 'click', element: 'button "Mine"', outcome: 'ok', cmd: 'h_00000000000000aa' },
      { ts: at(13), tool: 'click', kind: 'click', element: 'button "Other command"', outcome: 'ok', cmd: 'h_00000000000000bb' },
      { ts: at(14), tool: 'type', kind: 'type', element: 'textbox "No id"', outcome: 'ok' },
      { ts: at(50), tool: 'click', kind: 'click', element: 'button "Mine, late"', outcome: 'ok', cmd: 'h_00000000000000aa' },
      { ts: at(51), tool: 'click', kind: 'click', element: 'button "No id, outside"', outcome: 'ok' },
    ];
    expect(commandSteps(audit, [], T0, T1, 'h_00000000000000aa').map((s) => s.text)).toEqual(['click button "Mine"', 'type textbox "No id"', 'click button "Mine, late"']);
    expect(commandSteps(audit, [], T0, T1).map((s) => s.text)).toEqual(['click button "Mine"', 'click button "Other command"', 'type textbox "No id"']);
  });

  it('with a command id: drops entries labelled with another valid id, keeps unlabelled ones and its own out-of-window ones', () => {
    const A = 'h_aaaaaaaaaaaaaaaa';
    const audit: AuditEntry[] = [
      { ts: at(12), tool: 'click', kind: 'click', element: 'button "Send"', outcome: 'denied', cmd: 'h_bbbbbbbbbbbbbbbb' },
      { ts: at(13), tool: 'navigate', kind: 'navigate', element: 'page', outcome: 'ok' },
      { ts: at(40), tool: 'click', kind: 'click', element: 'button "Mine, late"', outcome: 'ok', cmd: A },
    ];
    expect(commandSteps(audit, [], T0, T1, A).map((s) => s.text)).toEqual(['navigate page', 'click button "Mine, late"']);
  });

  it('nothing ran: no steps', () => {
    expect(commandSteps([], [], T0, T1)).toEqual([]);
  });
});

describe('readCommandSteps (one audit read, R10a-9 bound)', () => {
  const calls = [{ tool: 'gmail_search', isError: false, ms: 5 }];
  const end = Date.now();

  it('a fast read gives the steps; no steps at all gives undefined', async () => {
    expect(await readCommandSteps({ recent: async () => [] }, calls, 'h_1', 900, end)).toEqual([{ text: 'Used gmail_search', status: 'ok' }]);
    expect(await readCommandSteps({ recent: async () => [] }, [], 'h_1', 900, end)).toBeUndefined();
  });

  it('a failed read (rejected or thrown) gives undefined, not the tool lines alone', async () => {
    expect(await readCommandSteps({ recent: () => Promise.reject(new Error('EACCES')) }, calls, 'h_1', 900, end)).toBeUndefined();
    expect(
      await readCommandSteps(
        {
          recent: () => {
            throw new Error('sync');
          },
        },
        calls,
        'h_1',
        900,
        end,
      ),
    ).toBeUndefined();
  });

  it('a read slower than the bound gives undefined, with no unhandled error when it lands late', async () => {
    let release!: (e: AuditEntry[]) => void;
    const t0 = Date.now();
    const steps = await readCommandSteps({ recent: () => new Promise((r) => (release = r)) }, calls, 'h_1', 900, end);
    expect(steps).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(STEPS_AUDIT_WAIT_MS - 20);
    release([]);
  });
});

describe('finishCommand (ADR-007 point 6: steps built before the history append)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stephen-finish-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let n = 0;
  const report = (id: string): CommandReport => ({ id, result: 'ok', outcome: 'ok', source: 'app', said: 'search my mail', reply: 'Done.', ranClaude: true, followUp: false, ms: 900, turns: 1, route: 'model', replyMs: 0, conv: 'c_0123456789abcdef' });
  function wire(audit: { recent(limit: number): Promise<AuditEntry[]> }) {
    const history = new HistoryStore({ home: join(tmp, `h${++n}`), retentionDays: 7 });
    const sent: { id: string; steps?: ChatStep[] }[] = [];
    let endings = 0;
    const app = { commandEnding: () => void endings++, commandDone: (r: CommandReport, _t: string[], steps?: ChatStep[]) => void sent.push({ id: r.id, ...(steps ? { steps } : {}) }) };
    const record = historyRecorder(history, () => [{ tool: 'next_command_tool', isError: false, ms: 1 }], () => {});
    return { audit, history, sent, app, record, endings: () => endings };
  }
  const calls = [{ tool: 'gmail_search', isError: false, ms: 800 }];

  it('the steps stored on the history line equal the steps sent in chat.done for the same command id', async () => {
    const w = wire({ recent: async () => [{ ts: new Date().toISOString(), tool: 'click', kind: 'click', element: 'button "Send"', outcome: 'denied', verdict: 'confirm', cmd: 'h_same' }] });
    await finishCommand(report('h_same'), calls, { audit: w.audit, record: w.record, app: w.app });
    const [line] = w.history.list();
    expect(line!.id).toBe('h_same');
    expect(line!.conv).toBe('c_0123456789abcdef');
    expect(line!.steps).toEqual([
      { text: 'Refused: click button "Send". you did not allow it', status: 'refused' },
      { text: 'Used gmail_search', status: 'ok' },
    ]);
    expect(w.sent).toEqual([{ id: 'h_same', steps: line!.steps }]);
    // The tools are the ones captured when the command ended, not whatever the runner holds by now.
    expect(line!.tools.map((t) => t.tool)).toEqual(['gmail_search']);
    expect(w.endings()).toBe(1);
  });

  it('never rejects: commandEnding and commandDone throw, the history line is still written and the error logged', async () => {
    const w = wire({ recent: async () => [] });
    const logged: string[] = [];
    const app = {
      commandEnding: () => {
        throw new Error('end failed');
      },
      commandDone: () => {
        throw new Error('push failed');
      },
    };
    await expect(finishCommand(report('h_throw'), calls, { audit: w.audit, record: w.record, app, log: (l) => logged.push(l) })).resolves.toBeUndefined();
    expect(w.history.list().map((e) => e.id)).toEqual(['h_throw']);
    expect(logged).toEqual(['Note: could not record the command (end failed).', 'Note: could not record the command (push failed).']);
  });

  it('with a failing audit read, neither the history line nor chat.done has steps', async () => {
    const w = wire({ recent: () => Promise.reject(new Error('EIO')) });
    await finishCommand(report('h_fail'), calls, { audit: w.audit, record: w.record, app: w.app });
    const [line] = w.history.list();
    expect(line!.id).toBe('h_fail');
    expect(line).not.toHaveProperty('steps');
    expect(w.sent).toEqual([{ id: 'h_fail' }]);
  });
});
