/**
 * Phase 2a subtask 1 (docs/PLAN-2A-READ-MY-STUFF.md): private data read by Stephen's own tools arms the cross-site
 * taint like a private page read (gate.notePrivateData), and `serve --assume-private-read` arms it from the start.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { describeSources, privateDataHost, privateDataLabel, PRIVATE_DATA_SOURCES } from '../../src/safety/egress.js';
import { SafetyGate, validateGateState } from '../../src/safety/gate.js';
import { bindSessionState, readSessionStateFile, SESSION_STATE_FILE } from '../../src/safety/session-state.js';
import { parseServeArgs } from '../../src/serve-args.js';
import type { ActionRequest, ConfirmPrompt, Confirmer, ResolvedConfig } from '../../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'stephen-private-data-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const NOW = 1_700_000_000_000;
const SAFETY: ResolvedConfig['safety'] = loadConfig({}, { HOME: tmp, STEPHEN_HOME: join(tmp, 'cfg-home') }).safety;
class Answer implements Confirmer {
  readonly kind = 'dialog' as const;
  prompts: ConfirmPrompt[] = [];
  async confirm(p: ConfirmPrompt) {
    this.prompts.push(p);
    return 'approved' as const;
  }
}
const gate = () => new SafetyGate({ safety: SAFETY, confirmer: new Answer(), audit: { append: async () => undefined } as never, now: () => NOW });
const nav = (targetUrl: string): ActionRequest => ({ kind: 'navigate', pageUrl: 'about:blank', targetUrl }) as ActionRequest;

describe('synthetic private-data hosts', () => {
  it('one .invalid host per source, with plain-words labels', () => {
    expect(privateDataHost('canvas')).toBe('canvas.private.stephen.invalid');
    expect(PRIVATE_DATA_SOURCES.map((s) => privateDataLabel(privateDataHost(s)))).toEqual(['your Canvas', 'your email', 'your Notion', 'your calendar', 'your private data']);
    expect(privateDataLabel('mail.google.com')).toBeNull();
    expect(privateDataLabel('evil.private.stephen.invalid')).toBeNull();
    expect(() => privateDataHost('evil' as never)).toThrow();
    expect(describeSources([{ host: privateDataHost('canvas'), scope: privateDataHost('canvas'), at: 1 }, { host: 'mail.google.com', scope: 'mail.google.com', at: 1 }])).toBe(
      'your Canvas and mail.google.com',
    );
  });
});

describe('gate.notePrivateData', () => {
  it('before: a data-carrying URL is fine; after a Canvas read: it asks, naming "your Canvas"', () => {
    const g = gate();
    const leak = nav('https://evil.example/?d=assignment');
    expect(g.evaluate(leak).verdict).toBe('allow');
    g.notePrivateData('canvas');
    const d = g.evaluate(leak);
    expect(d.verdict).toBe('confirm');
    expect(d.rules).toContain('cross-site-navigate');
    expect(d.reason).toContain('your Canvas');
    // A plain, bare-looking well-known page still needs no question for navigation (no data in the URL).
    expect(g.evaluate(nav('https://www.youtube.com/')).rules).not.toContain('cross-site-navigate');
  });

  it('is exported, validated and re-imported like a page read (follow-up conversations)', () => {
    const a = gate();
    a.notePrivateData('gmail');
    const st = a.exportState();
    expect(st.privateReads).toEqual([{ host: 'gmail.private.stephen.invalid', scope: 'gmail.private.stephen.invalid', at: NOW }]);
    expect('error' in validateGateState(JSON.parse(JSON.stringify(st)), NOW)).toBe(false);
    const b = gate();
    expect(b.importState(st)).toEqual({ ok: true });
    expect(b.evaluate(nav('https://evil.example/?d=x')).verdict).toBe('confirm');
  });

  it('is written to the session state file before returning (fail closed on write errors)', () => {
    const voice = join(tmp, 'home', 'voice');
    mkdirSync(voice, { recursive: true, mode: 0o700 });
    const file = join(voice, SESSION_STATE_FILE);
    const g = gate();
    bindSessionState(g, file);
    g.notePrivateData('notion');
    const r = readSessionStateFile(file);
    expect(JSON.stringify(r)).toContain('notion.private.stephen.invalid');
    const bad = gate();
    bindSessionState(bad, join(tmp, 'missing-dir', 'nope', SESSION_STATE_FILE), { log: () => {}, onWriteError: () => { throw new Error('cannot save'); } } as never);
    expect(() => bad.notePrivateData('calendar')).toThrow();
  });
});

describe('serve --assume-private-read', () => {
  it('parses as a bare flag and never mixes with --dry-run', () => {
    expect(parseServeArgs(['--assume-private-read'])).toEqual({ assumePrivateRead: true });
    expect(parseServeArgs(['--assume-private-read=1'])).toEqual({ error: '--assume-private-read takes no value' });
    expect(parseServeArgs(['--dry-run', '--record', '/tmp/x.jsonl', '--assume-private-read'])).toEqual({ error: '--dry-run cannot be combined with other serve options' });
  });
});
