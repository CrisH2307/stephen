/**
 * Phase 3 (docs/ADR-003): one `stephen serve` now lives for a whole follow-up conversation (up to 25 commands or
 * 30 minutes), so its rate limiter counts across commands. The limiter is a sliding window (maxActionsPerMinute
 * allowed actions in any 60 s), not a per-command budget: a long chain of normal commands must pass, and a tight
 * runaway loop must still be stopped.
 */
import { describe, expect, it } from 'vitest';
import { SafetyGate } from '../../src/safety/gate.js';
import type { AuditEntry, IAuditLog } from '../../src/types.js';
import { button, el, FakeConfirmer, req, safetyCfg } from './fixtures.js';

class NoAudit implements IAuditLog {
  async append(_e: Omit<AuditEntry, 'ts'>): Promise<void> {}
  async recent(): Promise<AuditEntry[]> {
    return [];
  }
}

function conversationGate() {
  let t = 1_000_000;
  // The default safety settings (maxActionsPerMinute 40, as in src/config.ts).
  const gate = new SafetyGate({ safety: safetyCfg(), confirmer: new FakeConfirmer('approved'), audit: new NoAudit(), now: () => t });
  return { gate, advance: (ms: number) => (t += ms), now: () => t };
}

/** A heavy normal command: navigate, a few clicks, type, press, scroll (8 counted actions) within ~8 s. */
async function command(g: ReturnType<typeof conversationGate>): Promise<boolean[]> {
  const steps = [
    req({ kind: 'navigate', tool: 'navigate', targetUrl: 'https://example.com/search' }),
    req({ element: button('Search') }),
    req({ kind: 'type', tool: 'type', element: el({ name: 'Search' }), text: 'lofi beats' }),
    req({ kind: 'press', tool: 'press', element: el({ name: 'Search' }), text: 'Enter' }),
    req({ kind: 'scroll', tool: 'scroll' }),
    req({ element: button('Result 1') }),
    req({ element: button('Play') }),
    req({ kind: 'read', tool: 'snapshot' }), // reads are free
    req({ element: button('Like') }),
  ];
  const allowed: boolean[] = [];
  for (const s of steps) {
    allowed.push((await g.gate.check(s)).allowed);
    g.advance(1000);
  }
  return allowed;
}

describe('rate limit across a long-lived conversation', () => {
  it('25 heavy commands over 30 minutes, including bursts of quick follow-ups, never hit the limit', async () => {
    expect(safetyCfg().maxActionsPerMinute).toBe(40);
    const g = conversationGate();
    const start = g.now();
    const results: boolean[] = [];
    for (let i = 0; i < 25; i++) {
      results.push(...(await command(g)));
      // Mostly a command every ~70 s, but commands 5–8 and 15–18 come right after each other (4 in under a minute).
      const quick = (i >= 4 && i < 8) || (i >= 14 && i < 18);
      g.advance(quick ? 6_000 : 60_000);
    }
    expect(g.now() - start).toBeLessThanOrEqual(30 * 60_000);
    expect(results.filter((a) => !a)).toEqual([]);
  });

  it('a tight runaway loop in the same conversation is stopped: never more than 40 actions in any minute', async () => {
    const g = conversationGate();
    const allowedAt: number[] = [];
    for (let i = 0; i < 3000; i++) {
      // a click every 100 ms for 5 minutes
      const r = await g.gate.check(req({ element: button('Next') }));
      if (r.allowed) allowedAt.push(g.now());
      else expect(r.decision.rules).toEqual(['rate-limit']);
      g.advance(100);
    }
    expect(allowedAt.length).toBeGreaterThan(0);
    for (const t of allowedAt) expect(allowedAt.filter((u) => u >= t && u < t + 60_000).length).toBeLessThanOrEqual(40);
    expect(allowedAt.length).toBeLessThanOrEqual(5 * 40 + 40);
    // The first 40 pass at once; the 41st only once the first has slid out of the window.
    expect(allowedAt[40]! - allowedAt[0]!).toBeGreaterThanOrEqual(60_000);
  });

  it('after a runaway burst the window slides: a normal command a minute later works again', async () => {
    const g = conversationGate();
    for (let i = 0; i < 60; i++) await g.gate.check(req({ element: button('Next') }));
    expect((await g.gate.check(req({ element: button('Next') }))).allowed).toBe(false);
    g.advance(60_001);
    expect((await command(g)).every(Boolean)).toBe(true);
  });
});
