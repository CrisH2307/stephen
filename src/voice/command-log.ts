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
 *
 * The command id file (plan A2, src/lib/command-id.ts) follows the same two steps. It is removed when a run starts,
 * so a cancelled command's group that is still dying writes records without an id, never with the new one. The new
 * id is written in `beforeSend`, right after the log reset. It stays after the run: a late record of that command
 * still gets the right id. With the one-shot runner (voice.warm false) `beforeSend` has no "group is gone" promise:
 * a cancelled command's serve can take up to 8 s to shut down (src/server/index.ts), and an audit entry it writes in
 * that time gets the next command's id. The id is a label for joining logs, so that is a wrong label, nothing more.
 */
import { readCommandSteps, type ChatStep } from '../app/steps.js';
import type { HistoryStore } from '../history/store.js';
import type { AuditEntry } from '../types.js';
import { clearCommandFile, validCommandId, writeCommandFile } from '../lib/command-id.js';
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
    /** `<home>/voice/command.json`, or null: no command id file. */
    readonly commandFile: string | null = null,
  ) {}

  /** The tool calls of the last run (empty before the first). */
  tools(): ToolCallRecord[] {
    return this.calls;
  }

  async run(prompt: string, hooks: RunHooks = {}): Promise<ClaudeOutcome> {
    this.calls = [];
    this.reset();
    this.commandId(undefined);
    const beforeSend = () => {
      this.reset();
      this.commandId(hooks.id);
    };
    try {
      return await this.inner.run(prompt, { ...(hooks.trust ? { trust: hooks.trust } : {}), beforeSend });
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

  /** Write the id of the command going out, or remove the file (no id, or one that is not a command id). */
  private commandId(id: string | undefined): void {
    if (!this.commandFile) return;
    try {
      // A valid id replaces the file in one rename. Anything else removes it, so an old id never stays.
      if (validCommandId(id)) writeCommandFile(this.commandFile, id!);
      else clearCommandFile(this.commandFile);
    } catch (e) {
      this.log(`Note: could not write the command id file ${this.commandFile} (${(e as Error).message}).`);
    }
  }

  private reset(): void {
    try {
      resetToolLog(this.path);
    } catch (e) {
      this.log(`Note: could not reset the tool log ${this.path} (${(e as Error).message}).`);
    }
  }
}

/**
 * Append one history entry per command (finishCommand calls it). Never throws.
 * A tool's `cmd` is left out: the entry has the id itself, and history lines stay as they were before plan A2.
 * `calls`: the command's tools captured when it ended (the runner's list moves on with the next command); without
 * them `tools()` is read now.
 */
export function historyRecorder(
  store: HistoryStore,
  tools: (() => ToolCallRecord[]) | null,
  log: (line: string) => void,
): (r: CommandReport, steps?: ChatStep[], calls?: ToolCallRecord[]) => void {
  return (r, steps, calls) => {
    try {
      store.append({
        id: r.id,
        source: r.source,
        said: r.said,
        reply: r.reply,
        outcome: r.outcome,
        tools: r.ranClaude && (calls || tools) ? (calls ?? tools!()).map(({ tool, isError, ms }) => ({ tool, isError, ms })) : [],
        followUp: r.followUp,
        ms: r.ms,
        turns: r.turns,
        ...(r.conv ? { conv: r.conv } : {}),
        ...(steps ? { steps } : {}),
      });
    } catch (e) {
      log(`Note: could not write the command history (${(e as Error).message}).`);
    }
  };
}

/**
 * ADR-007 point 6: the steps are built BEFORE the history append. One audit read, then the same list goes to the
 * history line (one append, never updated) and to chat.done. A failed or slow read: neither has steps. Never rejects.
 */
export async function finishCommand(
  r: CommandReport,
  calls: ToolCallRecord[],
  o: {
    audit: { recent(limit: number): Promise<AuditEntry[]> } | null;
    record?: (r: CommandReport, steps?: ChatStep[], calls?: ToolCallRecord[]) => void;
    app?: { commandEnding(): void; commandDone(r: CommandReport, tools: string[], steps?: ChatStep[]): void } | null;
  },
): Promise<void> {
  o.app?.commandEnding();
  const steps = await readCommandSteps(o.audit, calls, r.id, r.ms, Date.now());
  o.record?.(r, steps, calls);
  o.app?.commandDone(r, calls.map((t) => t.tool), steps);
}
