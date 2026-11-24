/**
 * Every private read writes one redacted audit line: the tool, the trust tier and that it was private. Never the
 * URL, host, title or text (src/safety/audit.ts rules).
 * Siblings: both browsers (Zen z1, Chrome c1), both trust tiers (trusted = typed or F5, wake = wake word or phone),
 * page reads and Stephen's own account tools, a page with private frames (still one line), public pages (no line).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SafetyGate } from '../../src/safety/gate.js';
import { createSafety, type SafetyDeps } from '../../src/safety/index.js';
import type { AuditEntry, ResolvedConfig } from '../../src/types.js';
import { FakeAudit, FakeConfirmer, FakePage, setup } from '../server/fakes.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-private-read-audit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const SAFETY = loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'cfg') }).safety;
const MAIL = 'https://mail.google.com/mail/u/0/#inbox/FMfcgzSECRET';

const gateWith = (trust?: 'wake') => {
  const audit = new FakeAudit();
  const gate = new SafetyGate({ safety: SAFETY, confirmer: new FakeConfirmer(), audit, ...(trust ? { trust } : {}) });
  return { gate, audit };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SafetyGate: private-read audit line', () => {
  for (const trust of [undefined, 'wake'] as const) {
    const tier = trust ?? 'trusted';
    it(`a private page read with a tool: one line, tool + trust + private, nothing else (${tier})`, async () => {
      const { gate, audit } = gateWith(trust);
      gate.noteRead(MAIL, 'snapshot');
      await flush();
      expect(audit.entries).toHaveLength(1);
      const { ts: _ts, ...rest } = audit.entries[0]!;
      expect(rest).toEqual({ tool: 'snapshot', kind: 'read', outcome: 'ok', args: { private: true, trust: tier } });
      expect(gate.taintedHosts()).toEqual(['mail.google.com']);
    });

    it(`an account tool read: one line per call, re-reads too (${tier})`, async () => {
      const { gate, audit } = gateWith(trust);
      gate.notePrivateData('gmail', 'gmail_search');
      gate.notePrivateData('gmail', 'gmail_read');
      await flush();
      expect(audit.entries.map((e) => [e.tool, e.args])).toEqual([
        ['gmail_search', { private: true, trust: tier }],
        ['gmail_read', { private: true, trust: tier }],
      ]);
    });
  }

  it('no line for a public page, or without a tool (the pre-read check, --assume-private-read)', async () => {
    const { gate, audit } = gateWith();
    gate.noteRead('https://www.youtube.com/watch?v=1', 'snapshot');
    gate.noteRead(MAIL);
    gate.notePrivateData('private');
    await flush();
    expect(audit.entries).toEqual([]);
    expect(gate.taintedHosts().length).toBe(2); // the taint is still armed
  });

  it('a failed audit write is reported, never thrown, and the taint stays armed', async () => {
    const errors: unknown[] = [];
    const gate = new SafetyGate({
      safety: SAFETY,
      confirmer: new FakeConfirmer(),
      audit: { append: async () => Promise.reject(new Error('disk full')), recent: async () => [] },
      onAuditError: (e) => errors.push(e),
    });
    expect(() => gate.noteRead(MAIL, 'snapshot')).not.toThrow();
    await flush();
    expect(errors).toHaveLength(1);
    expect(gate.wasRead(MAIL)).toBe(true);
  });
});

/** The whole path: tool call, hub, real gate, real audit file on disk. */
async function realSetup(trust?: 'wake') {
  let cfgSeen: ResolvedConfig | undefined;
  const h = await setup({
    extraDeps: {
      ...(trust ? { trust } : {}),
      safetyFactory: (c: ResolvedConfig, d?: SafetyDeps) => {
        cfgSeen = c;
        return createSafety(c, { ...d, confirmer: new FakeConfirmer() });
      },
    },
  });
  const lines = (): AuditEntry[] => {
    try {
      return readFileSync(cfgSeen!.auditLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
    } catch {
      return [];
    }
  };
  return { ...h, lines };
}

describe('private-read audit line over MCP (real gate, real audit log)', () => {
  for (const trust of [undefined, 'wake'] as const) {
    for (const tab of ['z1', 'c1']) {
      it(`snapshot of a private page on ${tab}, trust ${trust ?? 'trusted'}: exactly one line, no URL, host or title`, async () => {
        const h = await realSetup(trust);
        const p = h.manager.addPage(tab, new FakePage(MAIL, 'Inbox (3) - secret subject'));
        p.frameList = [MAIL, 'https://mail.google.com/frame/a', 'https://accounts.google.com/frame/b'];
        const res = await h.call('snapshot', { tab });
        expect(res.isError).toBeFalsy();
        await flush();
        const reads = h.lines().filter((e) => e.kind === 'read');
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ tool: 'snapshot', outcome: 'ok', args: { private: true, trust: trust ?? 'trusted' } });
        expect(JSON.stringify(reads[0])).not.toMatch(/mail\.google|accounts\.google|SECRET|secret subject|Inbox/);
      });
    }
  }

  it('snapshot of a public page: no read line', async () => {
    const h = await realSetup();
    h.manager.addPage('c1', new FakePage('https://www.example.com/', 'Example'));
    expect((await h.call('snapshot', { tab: 'c1' })).isError).toBeFalsy();
    await flush();
    expect(h.lines().filter((e) => e.kind === 'read')).toEqual([]);
  });
});
