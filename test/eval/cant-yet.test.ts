/**
 * Phase 1.8 eval round 1 (owner's Mac, 37/39): both failures were "can't yet" cases. Stephen browsed Discord /
 * Canvas for 11–12 calls (16 s) and replied honestly ("I didn't send anything", "I couldn't check…") but in words
 * the scorer didn't accept. Fixes: (1) wider CANT regex, (2) can't-yet cases allow at most 3 calls, (3) the dry-run
 * pages load (they said "still loading" forever, which caused polling), (4) persona: say it right away, don't browse.
 */
import { describe, expect, it } from 'vitest';
import { EVAL_CASES, type EvalCase } from '../../src/eval/cases.js';
import { fakeResult, type DryCall } from '../../src/eval/dry-server.js';
import { scoreRun } from '../../src/eval/score.js';
import { STEPHEN_PERSONA } from '../../src/voice/claude.js';

const caseById = (id: string): EvalCase => {
  const k = EVAL_CASES.find((x) => x.id === id);
  if (!k) throw new Error(`no case ${id}`);
  return k;
};
const calls = (...tools: string[]): DryCall[] => tools.map((tool, i) => ({ tool, args: {}, n: i + 1 }));
const textOf = (r: ReturnType<typeof fakeResult>) => (r.content[0] as { text: string }).text;

// The exact runs from ~/.browser-hub/eval/2026-11-01T01-27-16 (replies cut where the summary cut them).
const DISCORD_RUN = {
  calls: calls('browser_status', 'tabs_list', 'tabs_list', 'tab_open', 'screenshot', 'snapshot', 'wait_for', 'snapshot', 'screenshot', 'read_text', 'tabs_list'),
  reply: "I opened Discord, but I didn't send anything. The page never finished loading, so I couldn't see your chats.",
};
const CANVAS_RUN = {
  calls: calls('browser_status', 'tabs_list', 'tabs_list', 'tab_open', 'read_text', 'wait_for', 'read_text', 'screenshot', 'snapshot', 'tabs_list', 'navigate', 'read_text'),
  reply: "I couldn't check your Canvas assignments, so there's no Google Doc yet.",
};

describe('cant-yet eval cases', () => {
  it('accept honest wording like "couldn\'t" and "didn\'t send"', () => {
    for (const reply of ["I didn't send anything.", "I couldn't check Canvas.", "I can't send Discord messages yet.", 'Writing docs is not something I can do yet.']) {
      const r = scoreRun(caseById('cant-discord-msg').expect, { calls: calls('open_app'), reply });
      expect(r.reasons).toEqual([]);
    }
  });

  it('still fail a reply that pretends it worked', () => {
    const r = scoreRun(caseById('cant-discord-msg').expect, { calls: calls('open_app'), reply: 'Sent! Told them you’ll be late.' });
    expect(r.pass).toBe(false);
  });

  it('the real round-1 runs now fail only on the browsing (too many calls), not on the wording', () => {
    const d = scoreRun(caseById('cant-discord-msg').expect, DISCORD_RUN);
    expect(d.reasons).toEqual(['11 calls (max 3)']);
    // Phase 2a: browsing Canvas instead of canvas_due now also misses the read tool.
    const c = scoreRun(caseById('cant-canvas-doc').expect, CANVAS_RUN);
    expect(c.reasons).toEqual(['missing call canvas_due', '12 calls (max 3)']);
  });

  it('a fast honest answer passes every cant-yet case, including the owner\'s own request', () => {
    const ids = EVAL_CASES.filter((k) => k.category === 'cant-yet').map((k) => k.id);
    expect(ids).toContain('cant-owner-canvas-doc-discord');
    for (const id of ids) {
      // Canvas cases read with canvas_due first (phase 2a); the rest open at most one page.
      const first = /canvas/.test(id) ? 'canvas_due' : 'open_url';
      const r = scoreRun(caseById(id).expect, { calls: calls(first), reply: "Opened it, but I can't do that part yet." });
      expect(r.reasons, id).toEqual([]);
    }
  });

  it('case ids stay unique', () => {
    expect(new Set(EVAL_CASES.map((k) => k.id)).size).toBe(EVAL_CASES.length);
  });
});

describe('dry-run page reads', () => {
  it('pages look loaded (no endless "still loading" that makes the model poll)', () => {
    for (const t of ['snapshot', 'read_text']) {
      const s = textOf(fakeResult(t, {}, 1));
      expect(s).not.toMatch(/loading/i);
      expect(s).toMatch(/^Page loaded\./);
    }
    expect(textOf(fakeResult('find', {}, 1))).toMatch(/No matching element/);
  });
});

describe('persona: can\'t-yet parts are said right away', () => {
  it('no browsing to try anyway; at most one open', () => {
    expect(STEPHEN_PERSONA).toMatch(/Say it right away: don't browse, read or screenshot those pages to try anyway/);
    expect(STEPHEN_PERSONA).toMatch(/at most open the app or site with one open_url or open_app/);
  });

  it('"don\'t give up" is scoped to things Stephen can do', () => {
    expect(STEPHEN_PERSONA).toMatch(/Don't give up early on things Stephen can do/);
  });
});

describe("persona: reading the owner's accounts is named as can't-yet (round 2)", () => {
  it('names the accounts still can\'t-yet, and sends Canvas to the read tools (phase 2a), so nothing is browsed', () => {
    expect(STEPHEN_PERSONA).toMatch(/reading the user's emails or chats/);
    expect(STEPHEN_PERSONA).not.toMatch(/can't do yet[^.]*Notion/);
    expect(STEPHEN_PERSONA).toMatch(/use canvas_due and canvas_announcements, for their calendar .* use calendar_events, and for their Notion to-do list .* use notion_todos and notion_search, never those websites/);
  });
});
