import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elementSummary, MAX_PRIVATE_SCOPES, redactedArgs, SafetyGate } from '../../src/safety/gate.js';
import { createSafety } from '../../src/safety/index.js';
import type { AuditEntry, ConfirmOutcome, IAuditLog } from '../../src/types.js';
import { button, el, FakeConfirmer, req, resolvedConfig, safetyCfg } from './fixtures.js';

class MemAudit implements IAuditLog {
  entries: AuditEntry[] = [];
  async append(e: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    this.entries.push({ ...e, ts: e.ts ?? 'now' });
  }
  async recent(limit: number): Promise<AuditEntry[]> {
    return this.entries.slice(-limit).reverse();
  }
}

function setup(answer: ConfirmOutcome = 'approved', safety = safetyCfg(), kind = 'fake') {
  let t = 1_000_000;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const audit = new MemAudit();
  const confirmer = new FakeConfirmer(answer, kind);
  const gate = new SafetyGate({ safety, confirmer, audit, now: clock.now });
  return { gate, audit, confirmer, clock };
}

describe('SafetyGate.check', () => {
  it('allow: no confirmation, audit entry with element summary and redacted text', async () => {
    const { gate, audit, confirmer } = setup();
    const r = await gate.check(req({ kind: 'type', tool: 'type', element: el({ name: 'Subject' }), text: 'Quarterly numbers attached' }));
    expect(r).toMatchObject({ allowed: true, confirmation: 'not-needed', message: '' });
    expect(confirmer.prompts).toHaveLength(0);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      tool: 'type',
      kind: 'type',
      browser: 'zen',
      tab: 'z1',
      urlBefore: 'https://example.com/page',
      element: 'textbox "Subject"',
      verdict: 'allow',
      confirmation: 'not-needed',
      outcome: 'ok',
      intent: 'test intent',
      args: { text: '[26 chars] "Quarterly…"', rules: [] },
    });
  });

  it('deny: message says what was blocked and why; no confirmer call; audit outcome denied', async () => {
    const { gate, audit, confirmer } = setup();
    const r = await gate.check(req({ kind: 'type', element: el({ inputType: 'password', name: 'Password' }), text: 'hunter2' }));
    expect(r.allowed).toBe(false);
    expect(r.decision.verdict).toBe('deny');
    expect(r.confirmation).toBe('not-needed');
    // review #2 #8: the element is named by role + ref, never by its page-supplied label
    expect(r.message).toMatch(/^Blocked by browser-hub safety policy — did not type into textbox z1:e1 on example\.com\./);
    expect(r.message).not.toContain('Password');
    expect(r.message).toMatch(/ask the user to enter it themselves/);
    expect(confirmer.prompts).toHaveLength(0);
    expect(audit.entries[0]).toMatchObject({ verdict: 'deny', outcome: 'denied', args: { text: '[redacted, 7 chars]' } });
    expect(JSON.stringify(audit.entries)).not.toContain('hunter2');
  });

  it('confirm + approved → allowed, prompt built from live facts', async () => {
    const { gate, audit, confirmer } = setup('approved');
    const r = await gate.check(req({ element: button('Send'), intent: 'send it' }));
    expect(r).toMatchObject({ allowed: true, confirmation: 'approved', message: '' });
    expect(confirmer.prompts[0]!.title).toBe('example.com — Claude wants to click a button');
    expect(confirmer.prompts[0]!.body).toContain('Element label: «Send»');
    expect(audit.entries[0]).toMatchObject({ verdict: 'confirm', confirmation: 'approved', outcome: 'ok', risk: 'high' });
  });

  it('confirm + declined → not allowed, user-declined message without workarounds', async () => {
    const { gate, audit } = setup('declined');
    const r = await gate.check(req({ element: button('Delete forever') }));
    expect(r.allowed).toBe(false);
    expect(r.confirmation).toBe('declined');
    expect(r.message).toBe('The user declined: did not click button z1:e1 on example.com. Do not retry this action; ask the user how they want to proceed.');
    expect(audit.entries[0]).toMatchObject({ outcome: 'denied', confirmation: 'declined' });
  });

  it("confirm with safety.confirm='deny' → explains the config", async () => {
    const { gate } = setup('declined', safetyCfg({ confirm: 'deny' }), 'deny');
    const r = await gate.check(req({ element: button('Send') }));
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/safety\.confirm = "deny"/);
    expect(r.message).toMatch(/Ask the user to do this step themselves/);
  });

  it('confirm + unavailable → DENIED with how to configure a channel', async () => {
    const { gate, audit } = setup('unavailable');
    const r = await gate.check(req({ element: button('Send') }));
    expect(r.allowed).toBe(false);
    expect(r.confirmation).toBe('unavailable');
    expect(r.message).toMatch(/no confirmation channel is available, so it was denied/);
    expect(r.message).toMatch(/elicitation/);
    expect(r.message).toMatch(/"confirm": "auto"/);
    expect(audit.entries[0]).toMatchObject({ outcome: 'denied', confirmation: 'unavailable' });
  });

  it('a throwing confirmer counts as unavailable (denied)', async () => {
    const audit = new MemAudit();
    const gate = new SafetyGate({
      safety: safetyCfg(),
      audit,
      confirmer: {
        kind: 'x',
        confirm: async () => {
          throw new Error('boom');
        },
      },
    });
    const r = await gate.check(req({ element: button('Send') }));
    expect(r).toMatchObject({ allowed: false, confirmation: 'unavailable' });
  });

  it('read decisions are not audited; other kinds are', async () => {
    const { gate, audit } = setup();
    await gate.check(req({ kind: 'read' }));
    await gate.check(req({ kind: 'scroll' }));
    expect(audit.entries.map((e) => e.kind)).toEqual(['scroll']);
  });

  it('audit failures do not break the gate', async () => {
    const errors: unknown[] = [];
    const gate = new SafetyGate({
      safety: safetyCfg(),
      confirmer: new FakeConfirmer('approved'),
      audit: {
        append: async () => {
          throw new Error('disk full');
        },
        recent: async () => [],
      },
      onAuditError: (e) => errors.push(e),
    });
    expect((await gate.check(req({ element: button('Next') }))).allowed).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('rate limiting through the gate', () => {
  it('counts only allowed actions (reads are free), with a sliding window', async () => {
    const { gate, clock } = setup('declined', safetyCfg({ maxActionsPerMinute: 4 }));
    // declined confirmations and reads don't count; a scroll does (review #2 #6)
    await gate.check(req({ element: button('Send') }));
    await gate.check(req({ kind: 'read' }));
    expect((await gate.check(req({ kind: 'scroll' }))).allowed).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect((await gate.check(req({ element: button('Next') }))).allowed).toBe(true);
      clock.advance(10_000);
    }
    const r = await gate.check(req({ element: button('Next') }));
    expect(r.allowed).toBe(false);
    expect(r.decision.rules).toEqual(['rate-limit']);
    expect(r.message).toMatch(/4 actions/); // 3 clicks + the scroll
    expect(r.message).toMatch(/Wait about 30 s/);
    // denied attempt didn't extend the window
    clock.advance(30_001); // the scroll (oldest) slides out
    expect((await gate.check(req({ element: button('Next') }))).allowed).toBe(true);
  });
});

describe('cross-site typing through the gate', () => {
  const typeEvil = req({ kind: 'type', pageUrl: 'https://evil.example/', element: el({ frameUrl: 'https://evil.example/' }), text: 'otp 123456' });

  it('noteRead(mail) arms the rule and it never expires within the session', async () => {
    const { gate, clock, confirmer } = setup('declined');
    expect(gate.evaluate(typeEvil).verdict).toBe('allow');
    gate.noteRead('https://mail.google.com/mail/u/0/#inbox');
    clock.advance(29 * 60_000);
    const r = await gate.check(typeEvil);
    expect(r.allowed).toBe(false);
    expect(r.decision.rules).toEqual(['cross-site-typing', 'first-interaction']);
    expect(confirmer.prompts[0]!.body).toContain('Text to type: (10 chars) «otp 123456»');
    clock.advance(7 * 24 * 3600_000);
    expect(gate.evaluate(typeEvil).verdict).toBe('confirm');
    expect(gate.taintedHosts()).toEqual(['mail.google.com']);
  });

  it('#1 end-to-end: read Gmail, then the reviewer exfil URLs all ask; a bare origin does not', async () => {
    const { gate, confirmer } = setup('declined');
    gate.noteRead('https://mail.google.com/mail/u/0/#inbox/FMfcg');
    for (const targetUrl of [
      'https://script.google.com/macros/s/ATTACKER/exec?d=Quarterly+numbers',
      'https://www.google.com/url?q=https://evil.example/?d=secret',
    ]) {
      const r = await gate.check(req({ kind: 'navigate', pageUrl: 'https://mail.google.com/mail/u/0/', targetUrl }));
      expect(r.allowed, targetUrl).toBe(false);
      expect(r.decision.rules).toContain('cross-site-navigate');
    }
    expect(confirmer.prompts[0]!.body).toContain('Destination (full URL): https://script.google.com/macros/s/ATTACKER/exec?d=Quarterly+numbers');
    const doc = req({ kind: 'type', pageUrl: 'https://docs.google.com/document/d/ATTACKER/edit', element: el({ tag: 'div', inputType: null, frameUrl: 'https://docs.google.com/document/d/ATTACKER/edit' }), text: 'mail' });
    expect((await gate.check(doc)).allowed).toBe(false);
    expect((await gate.check(req({ kind: 'navigate', targetUrl: 'https://ycombinator.com/' }))).allowed).toBe(true);
  });

  it('residual gap: a short path / sub-domain to a new host after a private read asks once; approval trusts the host', async () => {
    const declined = setup('declined');
    declined.gate.noteRead('https://mail.google.com/mail/u/0/#inbox');
    for (const targetUrl of ['https://evil.com/482913', 'https://482913.evil.com/']) {
      const r = await declined.gate.check(req({ kind: 'navigate', pageUrl: 'https://mail.google.com/mail/u/0/', targetUrl }));
      expect(r.allowed, targetUrl).toBe(false);
      expect(r.decision.rules).toEqual(['first-destination']);
    }
    expect(declined.confirmer.prompts[0]!.title).toMatch(/Allow it to visit evil\.com for the rest of this session\?/);

    const approved = setup('approved');
    approved.gate.noteRead('https://mail.google.com/mail/u/0/#inbox');
    const nav = (targetUrl: string) => req({ kind: 'navigate', pageUrl: 'https://mail.google.com/mail/u/0/', targetUrl });
    expect((await approved.gate.check(nav('https://github.com/anthropics/claude-code'))).allowed).toBe(true);
    expect(approved.confirmer.prompts).toHaveLength(1);
    // trusted now: more short paths on github.com don't ask again…
    expect((await approved.gate.check(nav('https://github.com/anthropics/claude-code/issues'))).decision.verdict).toBe('allow');
    // …but data-carrying URLs still do (the data-budget rule ignores trust)
    expect((await approved.gate.check(nav('https://github.com/search?q=482913'))).decision.rules).toContain('cross-site-navigate');
  });

  it('remembers at most MAX_PRIVATE_SCOPES scopes, keeping the taint armed', () => {
    const { gate } = setup();
    for (let i = 0; i < MAX_PRIVATE_SCOPES + 10; i++) gate.noteRead(`https://docs.google.com/document/d/doc${i}/edit`);
    expect(gate.evaluate(typeEvil).verdict).toBe('confirm');
    // the most recent doc is still a known scope… but other docs differ, so typing there asks too
    const typeDoc = req({ kind: 'type', pageUrl: 'https://docs.google.com/document/d/doc0/edit', element: el({ frameUrl: 'https://docs.google.com/document/d/doc0/edit' }), text: 'x' });
    expect(gate.evaluate(typeDoc).verdict).toBe('confirm');
  });

  it('#6: evaluate longer than 2000 chars is denied (never truncated); ≤2000 asks with the full code', async () => {
    const { gate, confirmer } = setup('approved', safetyCfg({ allowEvaluate: true }));
    const long = await gate.check(req({ kind: 'evaluate', text: `1/*${'x'.repeat(2000)}*/` }));
    expect(long.allowed).toBe(false);
    expect(long.decision.rules).toEqual(['evaluate-too-long']);
    expect(confirmer.prompts).toHaveLength(0);
    const code = `${'1;'.repeat(999)}2`;
    expect(code.length).toBe(1999);
    expect((await gate.check(req({ kind: 'evaluate', text: code }))).allowed).toBe(true);
    expect(confirmer.prompts[0]!.body).toContain(code);
  });

  it('reading a neutral site does not arm it', () => {
    const { gate } = setup();
    gate.noteRead('https://news.ycombinator.com/');
    expect(gate.evaluate(typeEvil).verdict).toBe('allow');
  });

  it('an allowed read check of a mail page also arms it', async () => {
    const { gate } = setup();
    await gate.check(req({ kind: 'read', pageUrl: 'https://outlook.office.com/mail/inbox' }));
    expect(gate.evaluate(typeEvil).rules).toEqual(['cross-site-typing', 'first-interaction']);
  });

});

describe('helpers', () => {
  it('elementSummary never includes values', () => {
    expect(elementSummary(button('Send'))).toBe('button "Send"');
    expect(elementSummary(el({ name: '' }))).toBe('textbox');
  });
  it('redactedArgs', () => {
    expect(redactedArgs(req({ kind: 'navigate', targetUrl: 'https://x.test/' }))).toEqual({ url: 'https://x.test/' });
    expect(redactedArgs(req({ kind: 'navigate', targetUrl: 'https://x.test/reset?token=abc#t' }))).toEqual({ url: 'https://x.test/reset?…#…' });
    expect(redactedArgs(req({ kind: 'evaluate', text: 'document.title' }))).toEqual({ expression: '[14 chars, sha256:a37bf3152178]' });
    expect(redactedArgs(req({ kind: 'dialog', text: 'my secret answer', dialog: { type: 'prompt', message: 'm', accept: true } })).prompt_text).toMatch(
      /^\[16 chars, sha256:[0-9a-f]{12}\]$/,
    );
    expect(redactedArgs(req({ kind: 'dialog', dialog: { type: 'prompt', message: 'm', accept: true } }))).toEqual({
      dialog: { type: 'prompt', accept: true },
    });
  });
});

describe('createSafety', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bh-safety-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('wires gate + audit to cfg.auditLogPath', async () => {
    const cfg = resolvedConfig(dir);
    const { gate, audit } = createSafety(cfg, { confirmer: new FakeConfirmer('approved') });
    expect((await gate.check(req({ element: button('Send') }))).allowed).toBe(true);
    const recent = await audit.recent(5);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ element: 'button "Send"', confirmation: 'approved' });
    expect(statSync(cfg.auditLogPath).mode & 0o777).toBe(0o600);
    expect(gate.isSecretField(el({ inputType: 'password' }))).toBe(true);
  });

  it('auto mode on Linux without elicit denies confirm-level actions', async () => {
    const { gate } = createSafety(resolvedConfig(dir), { platform: 'linux' });
    const r = await gate.check(req({ element: button('Send') }));
    expect(r).toMatchObject({ allowed: false, confirmation: 'unavailable' });
  });

  it('auto mode uses the elicit fn when provided', async () => {
    const asked: string[] = [];
    const { gate } = createSafety(resolvedConfig(dir), {
      platform: 'linux',
      elicit: async (p) => {
        asked.push(p.title);
        return 'accept';
      },
    });
    expect((await gate.check(req({ element: button('Send') }))).allowed).toBe(true);
    expect(asked).toEqual(['example.com — Claude wants to click a button']);
  });

  it('injected clock drives the rate limit', async () => {
    let t = 0;
    const { gate } = createSafety(resolvedConfig(dir, { maxActionsPerMinute: 1 }), {
      confirmer: new FakeConfirmer('approved'),
      now: () => t,
    });
    expect((await gate.check(req({ element: button('Next') }))).allowed).toBe(true);
    expect((await gate.check(req({ element: button('Next') }))).allowed).toBe(false);
    t += 60_000;
    expect((await gate.check(req({ element: button('Next') }))).allowed).toBe(true);
  });
});
