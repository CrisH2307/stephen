// Integration contract between server and gate: `type` with submit=true is ONE request with key 'Enter'.
import { describe, expect, it } from 'vitest';
import { SafetyGate } from '../../src/safety/gate.js';
import type { AuditEntry, IAuditLog } from '../../src/types.js';
import { el, FakeConfirmer, req, safetyCfg } from './fixtures.js';

class MemAudit implements IAuditLog {
  entries: AuditEntry[] = [];
  async append(e: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    this.entries.push({ ...e, ts: e.ts ?? 'now' });
  }
  async recent(limit: number): Promise<AuditEntry[]> {
    return this.entries.slice(-limit).reverse();
  }
}

function gate() {
  const confirmer = new FakeConfirmer('declined');
  return { g: new SafetyGate({ safety: safetyCfg(), confirmer, audit: new MemAudit(), now: () => 0 }), confirmer };
}

describe('type with submit (key Enter on the type request)', () => {
  it('asks once, showing the text, for a single-line form field — and a decline means nothing happens', async () => {
    const { g, confirmer } = gate();
    const r = await g.check(
      req({ kind: 'type', tool: 'type', key: 'Enter', text: 'my-repo', element: el({ name: 'Repository name', inForm: true }) }),
    );
    expect(r.decision.verdict).toBe('confirm');
    expect(r.allowed).toBe(false);
    expect(confirmer.prompts).toHaveLength(1);
    expect(confirmer.prompts[0]!.body).toContain('my-repo');
  });

  it('asks for Enter in a chat composer (contenteditable)', () => {
    const { g } = gate();
    const d = g.evaluate(
      req({ kind: 'type', tool: 'type', key: 'Enter', text: 'hi', element: el({ name: 'Message', tag: 'div', role: 'textbox', inputType: null }) }),
    );
    expect(d.verdict).toBe('confirm');
  });

  it('the same text without submit is not a confirmation on an ordinary field', () => {
    const { g } = gate();
    const d = g.evaluate(req({ kind: 'type', tool: 'type', text: 'my-repo', element: el({ name: 'Repository name', inForm: true }) }));
    expect(d.verdict).toBe('allow');
  });
});

describe('review #2 verification follow-ups', () => {
  it('#13 residue: the audit log keeps typed text as a length only — never a preview', async () => {
    const { sanitizeEntry } = await import('../../src/safety/audit.js');
    const e = sanitizeEntry({ ts: 't', tool: 'type', outcome: 'error', args: { text: 'MyBankPassword2026', values: ['hunter2'], fields: [{ value: '[18 chars] "MyBankPas…"' }] } });
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/MyBank|hunter/);
    expect(e.args).toEqual({ text: '[18 chars]', values: ['[7 chars]'], fields: [{ value: '[18 chars]' }] });
  });

  it('N2: a trust prompt states what allowing means', async () => {
    const audit = new MemAudit();
    const confirmer = new FakeConfirmer('declined');
    const g = new SafetyGate({ safety: safetyCfg(), confirmer, audit, now: () => 0 });
    g.noteRead('https://mail.google.com/mail/u/0/#inbox');
    await g.check(req({ kind: 'click', tool: 'click', pageUrl: 'https://evil.example/', element: el({ role: 'button', tag: 'button', name: 'More', inputType: null, frameUrl: 'https://evil.example/' }) }));
    expect(confirmer.prompts[0]!.title).toMatch(/Allow it to interact with evil\.example/);
    expect(confirmer.prompts[0]!.body).toMatch(/If you allow: pages on evil\.example will see every click, key press, hover and scroll/);
  });
});
