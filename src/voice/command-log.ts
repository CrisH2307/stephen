/**
 * Command history for `stephen listen` (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 5): one HistoryStore entry per
 * command, with the names of the tools Claude called, read from `serve --tool-log` (never arguments or results).
 *
 * ToolLogRunner empties the tool log right before each Claude run and reads it back after, so the entry of a memory
 * command handled locally never picks up the previous run's tools. Recording never fails a command: errors are
 * only logged.
 */
import type { HistoryStore } from '../history/store.js';
import { readToolLog, resetToolLog, type ToolCallRecord } from '../server/tool-log.js';
import type { ClaudeOutcome } from './claude.js';
import type { CommandReport, CommandRunner } from './assistant.js';

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

  async run(prompt: string): Promise<ClaudeOutcome> {
    this.calls = [];
    try {
      resetToolLog(this.path);
    } catch (e) {
      this.log(`Note: could not reset the tool log ${this.path} (${(e as Error).message}).`);
    }
    try {
      return await this.inner.run(prompt);
    } finally {
      this.calls = readToolLog(this.path);
    }
  }

  cancel(): boolean {
    return this.inner.cancel();
  }

  followUp(): boolean {
    return this.inner.followUp?.() ?? false;
  }

  endConversation(): void {
    this.inner.endConversation?.();
  }

  commandEnded(): void {
    this.inner.commandEnded?.();
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
