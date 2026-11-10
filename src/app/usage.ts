/**
 * `usage.get` for the window's ⋯ menu (UI-PLAN §5, ROADMAP P2): how full this chat's context is, when Claude Code
 * reported it (warm conversations only), and how much of the memory budget one chat loads.
 */
import { memoryBlock } from '../voice/claude.js';
import type { ContextUsage } from '../voice/warm-claude.js';

/** Memory loaded per chat, in bytes (owner default 4: 8 KB). */
export const MEMORY_BUDGET_BYTES = 8 * 1024;
/** Bars turn amber from this percent (owner default 4). */
export const USAGE_WARN_PERCENT = 80;

export interface UsageBar {
  percent: number;
  warn: boolean;
}
export interface UsageReport {
  /** null when unknown: no conversation yet, it ended, or one `claude -p` per command (voice.warm off). */
  context: (UsageBar & ContextUsage) | null;
  memory: UsageBar & { bytes: number; budget: number };
}

const bar = (used: number, of: number): UsageBar => {
  const percent = Math.round((100 * used) / of);
  return { percent, warn: percent >= USAGE_WARN_PERCENT };
};

/** The report from the current conversation's context and the memory texts a chat would load. */
export function usageReport(context: ContextUsage | null, memoryTexts: readonly string[]): UsageReport {
  const bytes = Buffer.byteLength(memoryBlock(memoryTexts));
  return {
    context: context ? { ...context, ...bar(context.tokens, context.window) } : null,
    memory: { bytes, budget: MEMORY_BUDGET_BYTES, ...bar(bytes, MEMORY_BUDGET_BYTES) },
  };
}
