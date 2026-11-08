/** usage.get (src/app/usage.ts) and the warm stream's context numbers (src/voice/warm-claude.ts). */
import { describe, expect, it } from 'vitest';
import { MEMORY_BUDGET_BYTES, usageReport } from '../../src/app/usage.js';
import { memoryBlock } from '../../src/voice/claude.js';
import { contextTokensOf, contextWindowOf } from '../../src/voice/warm-claude.js';

describe('usageReport', () => {
  it('memory: the bytes of the block a chat loads, against 8 KB; warn from 80%', () => {
    const texts = ['my gym is goodlife', 'my prof for sofe 3980 is dr patel'];
    const r = usageReport(null, texts);
    expect(r.context).toBeNull();
    expect(r.memory.bytes).toBe(Buffer.byteLength(memoryBlock(texts)));
    expect(r.memory).toMatchObject({ budget: MEMORY_BUDGET_BYTES, percent: Math.round((100 * r.memory.bytes) / 8192), warn: false });
    expect(usageReport(null, []).memory).toEqual({ bytes: 0, budget: 8192, percent: 0, warn: false });
    // 30 items of 200 multi-byte characters: over the budget.
    const full = usageReport(null, Array.from({ length: 30 }, () => 'é'.repeat(200)));
    expect(full.memory.percent).toBeGreaterThanOrEqual(80);
    expect(full.memory.warn).toBe(true);
  });

  it('context: percent of the window, warn at exactly 80%', () => {
    expect(usageReport({ tokens: 50_000, window: 200_000 }, []).context).toEqual({ tokens: 50_000, window: 200_000, percent: 25, warn: false });
    expect(usageReport({ tokens: 160_000, window: 200_000 }, []).context).toMatchObject({ percent: 80, warn: true });
  });
});

describe('context numbers from stream-json', () => {
  it('assistant usage: input + cache read + cache write + output; none → null', () => {
    const msg = { type: 'assistant', message: { usage: { input_tokens: 12, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_000, output_tokens: 88 } } };
    expect(contextTokensOf(msg)).toBe(31_100);
    expect(contextTokensOf({ type: 'assistant', message: {} })).toBeNull();
    expect(contextTokensOf({ type: 'assistant', message: { usage: { input_tokens: 'x' } } })).toBeNull();
  });

  it('result modelUsage: the largest contextWindow; none → null', () => {
    expect(contextWindowOf({ modelUsage: { 'claude-haiku': { contextWindow: 200_000 }, 'claude-sonnet': { contextWindow: 1_000_000 } } })).toBe(1_000_000);
    expect(contextWindowOf({ modelUsage: {} })).toBeNull();
    expect(contextWindowOf({})).toBeNull();
  });
});
