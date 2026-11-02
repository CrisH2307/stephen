/**
 * Command history for `stephen listen` (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 5): one HistoryStore entry per
 * command, with the names of the tools Claude called, read from `serve --tool-log` (never arguments or results).
 *
 * ToolLogRunner empties the tool log right before each Claude run and reads it back after, so the entry of a memory
 * command handled locally never picks up the previous run's tools. That also slices the log per command when one
 * warm `stephen serve` lives across a whole conversation (phase 3): serve opens the file for every record, and each
 * record is written before the tool result reaches Claude, so nothing of command N can land after command N's
 * result. After a cancel, the old group can still be finishing a tool for up to the kill grace period, so the log is
 * emptied again in the `beforeSend` hook, which the warm runner calls once that group is gone and right before the
 * command goes out (docs/REVIEW-7.md R7-10). Recording never fails a command: errors are only logged.
 */
import type { HistoryStore } from '../history/store.js';
import { readToolLog, resetToolLog, type ToolCallRecord } from '../server/tool-log.js';
import type { ClaudeOutcome } from './claude.js';
import type { CommandReport, CommandRunner, RunHooks, Trust } from './assistant.js';

/** A CommandRunner that resets `<home>/voice/tool-log.jsonl` before every run and keeps what the run logged. */
export class ToolLogRunner implements CommandRunner {
  private calls: ToolCallRecord[] = [];
  constructor(
    private readonly inner: CommandRunner,
    readonly path: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** The tool calls of the last run (empty before the first). */
  tools(): ToolCallRecord[] {
    return this.calls;
  }

  async run(prompt: string, hooks: RunHooks = {}): Promise<ClaudeOutcome> {
    this.calls = [];
    this.reset();
    try {
      return await this.inner.run(prompt, { ...(hooks.trust ? { trust: hooks.trust } : {}), beforeSend: () => this.reset() });
    } finally {
      this.calls = readToolLog(this.path);
    }
  }

  cancel(): boolean {
    return this.inner.cancel();
  }

  followUp(trust?: Trust): boolean {
    return this.inner.followUp?.(trust) ?? false;
  }

  endConversation(): void {
    this.inner.endConversation?.();
  }

  commandEnded(): void {
    this.inner.commandEnded?.();
  }

  prewarm(trust?: Trust): void {
    this.inner.prewarm?.(trust);
  }

  private reset(): void {
    try {
      resetToolLog(this.path);
    } catch (e) {
      this.log(`Note: could not reset the tool log ${this.path} (${(e as Error).message}).`);
    }
  }
}

/** The Assistant's onDone hook: append one history entry per command. Never throws. */
export function historyRecorder(store: HistoryStore, tools: (() => ToolCallRecord[]) | null, log: (line: string) => void): (r: CommandReport) => void {
  return (r) => {
    try {
      store.append({
        id: r.id,
        source: r.source,
        said: r.said,
        reply: r.reply,
        outcome: r.outcome,
        tools: r.ranClaude && tools ? tools() : [],
        followUp: r.followUp,
        ms: r.ms,
        turns: r.turns,
      });
    } catch (e) {
      log(`Note: could not write the command history (${(e as Error).message}).`);
    }
  };
}
