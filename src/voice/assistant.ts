/**
 * One command end to end after transcription: memory router → Claude → reply → `say` → chime. Shared by the mic,
 * `--text` and the Stephen app's typed chat (src/app/server.ts): call command(text, {source, raw}).
 */
import { newHistoryId } from '../history/store.js';
import type { ClaudeOutcome } from './claude.js';
import type { CommandSource, MemoryRouter } from './memory-router.js';
import { stripForSpeech, type Chimes, type SpeakHandle, type Speaker } from './speech.js';

export interface CommandRunner {
  run(prompt: string): Promise<ClaudeOutcome>;
  cancel(): boolean;
  /** Follow-ups (ConversationRunner): decide whether the next run resumes the conversation. */
  followUp?(): boolean;
  /** Esc / "Stephen stop" / any cancel: end the conversation (the next command starts fresh). */
  endConversation?(): void;
  /** The reply is out (spoken or shown): the follow-up window counts from now. */
  commandEnded?(): void;
}

export type Phase = 'idle' | 'running' | 'speaking';
export type CommandResult = 'ok' | 'error' | 'cancelled';

export interface HandleOptions {
  /** Who sent it (memory trust and history). Default 'voice-wake', the most cautious. */
  source?: CommandSource;
  /** The original-case text (ASR transcript or typed text); memory keeps "Dr. Patel" from it. Default: `text`. */
  raw?: string;
  /** Override AssistantOptions.speak for this command (typed app chat is shown, not spoken). */
  speak?: boolean;
  /** History entry id for this command (the app hands it out in chat.accepted). Default: a fresh newHistoryId(). */
  id?: string;
}

/** What happened to one command (onDone, and the return value of command()). */
export interface CommandReport {
  /** History entry id (HandleOptions.id or a fresh one). */
  id: string;
  result: CommandResult;
  /** History outcome: 'memory' = a memory command handled locally, Claude never started. */
  outcome: 'ok' | 'error' | 'cancelled' | 'memory';
  source: CommandSource;
  said: string;
  /** The reply as spoken or shown ('' when cancelled before a reply). */
  reply: string;
  /** Claude was started for this command (its tool log belongs to it). */
  ranClaude: boolean;
  /** The Claude run resumed the follow-up conversation. */
  followUp: boolean;
  ms: number;
  /** Claude turns (0 when Claude didn't run or didn't say). */
  turns: number;
}

export interface AssistantOptions {
  runner: CommandRunner;
  speaker: Speaker;
  chimes: Chimes;
  speak: boolean;
  status: (line: string) => void;
  now?: () => number;
  /** Phase changes (the listener mirrors them in the menu bar). */
  onPhase?: (p: Phase) => void;
  /**
   * Asked once the reply is ready: true = the Mac is playing sound (music or a video Claude just started), so the
   * reply is printed and only the done chime plays. Absent (no helper): always speak.
   */
  soundPlaying?: () => Promise<boolean>;
  /** Memory commands, handled before Claude (absent or memory.enabled false: everything goes to Claude). */
  memory?: MemoryRouter | null;
  /** Timer / reminder commands, handled before Claude like memory (src/timers/router.ts). */
  timers?: { route(text: string, opts: { source: CommandSource; raw?: string }): Promise<{ reply: string; changed: false; rest?: string; said?: string } | null> } | null;
  /** Called once per command with its report (history). A throwing hook is logged, never fails the command. */
  onDone?: (r: CommandReport) => void;
  /** Called when a command starts, before the memory router (the Stephen app shows voice commands live). Same rules. */
  onStart?: (c: { id: string; source: CommandSource; said: string }) => void;
}

export class Assistant {
  private phaseValue: Phase = 'idle';
  private speech: SpeakHandle | null = null;
  private cancelled = false;
  constructor(private readonly o: AssistantOptions) {}

  get phase(): Phase {
    return this.phaseValue;
  }

  private set phaseNow(p: Phase) {
    if (p === this.phaseValue) return;
    this.phaseValue = p;
    this.o.onPhase?.(p);
  }

  private get phaseNow(): Phase {
    return this.phaseValue;
  }

  /** True while a command is running or its reply is being spoken. */
  get busy(): boolean {
    return this.phaseValue !== 'idle';
  }

  async handle(text: string, opts: HandleOptions = {}): Promise<CommandResult> {
    return (await this.command(text, opts)).result;
  }

  /**
   * Run one command: a memory command is handled locally (Claude never starts); "remember X and play Y" saves X and
   * runs "play Y" through Claude; anything else goes to Claude. Resolves with the report once the reply is out.
   * Not re-entrant: callers queue (the listener awaits the previous command); `busy` tells whether one is running.
   */
  async command(text: string, opts: HandleOptions = {}): Promise<CommandReport> {
    const now = this.o.now ?? Date.now;
    const t0 = now();
    const source: CommandSource = opts.source ?? 'voice-wake';
    const id = opts.id ?? newHistoryId();
    this.cancelled = false;
    this.phaseNow = 'running';
    try {
      this.o.onStart?.({ id, source, said: text });
    } catch (e) {
      this.o.status(`Note: could not report the command (${(e as Error).message}).`);
    }
    let said = text;
    const report = (r: Omit<CommandReport, 'id' | 'source' | 'said' | 'ms'>): CommandReport => {
      const full: CommandReport = { ...r, id, source, said, ms: Math.max(0, now() - t0) };
      try {
        this.o.onDone?.(full);
      } catch (e) {
        this.o.status(`Note: could not record the command (${(e as Error).message}).`);
      }
      return full;
    };
    try {
      let prefix = '';
      let prompt = text;
      const route =
        (this.o.memory ? await this.o.memory.route(text, { source, raw: opts.raw }) : null) ??
        (this.o.timers ? await this.o.timers.route(text, { source, ...(opts.raw !== undefined ? { raw: opts.raw } : {}) }) : null);
      if (route) {
        if (route.said !== undefined) said = route.said;
        // A memory change ends the conversation BEFORE anything else runs: a resumed session would keep the old
        // system prompt (claude's --system-prompt-snapshot), so the next command must start fresh.
        if (route.changed) this.o.runner.endConversation?.();
        if (this.cancelled) return report({ result: 'cancelled', outcome: 'cancelled', reply: '', ranClaude: false, followUp: false, turns: 0 });
        if (!route.rest) {
          await this.deliver(route.reply, true, opts.speak, t0);
          return report({ result: this.cancelled ? 'cancelled' : 'ok', outcome: 'memory', reply: route.reply, ranClaude: false, followUp: false, turns: 0 });
        }
        this.o.status(`Stephen: ${route.reply}`);
        prefix = route.reply;
        prompt = route.rest;
      }
      let followUp = false;
      try {
        followUp = this.o.runner.followUp?.() ?? false;
      } catch {
        // run() reports it
      }
      this.o.status(followUp ? 'Working… (follow-up)' : 'Working…');
      let out: ClaudeOutcome;
      try {
        out = await this.o.runner.run(prompt);
      } catch (e) {
        out = { kind: 'error', message: (e as Error).message, sessionId: null };
      }
      const claude = { ranClaude: true, followUp, turns: out.kind === 'ok' ? (out.turns ?? 0) : 0 };
      if (out.kind === 'cancelled' || this.cancelled) {
        this.o.status('Cancelled.');
        this.o.chimes.play('done');
        return report({ result: 'cancelled', outcome: 'cancelled', reply: '', ...claude });
      }
      const raw = out.kind === 'ok' ? out.text : out.message;
      const spoken = [prefix, stripForSpeech(raw) || (out.kind === 'ok' ? 'Done.' : 'Something went wrong.')].filter(Boolean).join(' ');
      await this.deliver(spoken, out.kind === 'ok', opts.speak, t0);
      if (out.kind === 'ok' && !this.cancelled) this.o.runner.commandEnded?.();
      const result: CommandResult = out.kind === 'ok' ? 'ok' : 'error';
      return report({ result, outcome: result, reply: spoken, ...claude });
    } finally {
      this.phaseNow = 'idle';
    }
  }

  /** Show the reply, speak it (unless sound is playing or speaking is off), chime, and print the time taken. */
  private async deliver(spoken: string, ok: boolean, speakOverride: boolean | undefined, t0: number): Promise<void> {
    const now = this.o.now ?? Date.now;
    this.o.status(ok ? `Stephen: ${spoken}` : `Problem: ${spoken}`);
    let speak = speakOverride ?? this.o.speak;
    if (speak && this.o.soundPlaying) {
      let playing = false;
      try {
        playing = await this.o.soundPlaying();
      } catch {
        // unknown → speak, as without the helper
      }
      if (playing) {
        speak = false;
        this.o.status('Sound is playing — reply shown here instead of spoken.');
      }
    }
    if (speak && !this.cancelled) {
      this.phaseNow = 'speaking';
      this.speech = this.o.speaker.speak(spoken);
      await this.speech.done;
      this.speech = null;
    }
    this.o.chimes.play('done');
    const secs = ((now() - t0) / 1000).toFixed(1);
    this.o.status(this.cancelled ? 'Stopped.' : `Done (${secs} s)`);
  }

  /**
   * Say a timer/reminder alert like a reply (shown, spoken unless sound is playing, done chime). Run it through
   * Listener.submit so it waits for idle and counts as busy while it speaks (no wake word, no recording on top;
   * review 6, R6-5). Not recorded in history.
   */
  async announce(text: string): Promise<CommandReport> {
    const now = this.o.now ?? Date.now;
    const t0 = now();
    this.cancelled = false;
    try {
      await this.deliver(text, true, undefined, t0);
    } finally {
      this.phaseNow = 'idle';
    }
    return { id: newHistoryId(), source: 'cli', said: '', reply: text, result: this.cancelled ? 'cancelled' : 'ok', outcome: 'memory', ranClaude: false, followUp: false, turns: 0, ms: Math.max(0, now() - t0) };
  }

  /** End the follow-up conversation: the next command starts a fresh Claude session with a fresh gate. */
  endConversation(): void {
    this.o.runner.endConversation?.();
  }

  /** Stop whatever is happening: kill the Claude run, or cut the spoken reply short. */
  cancel(): boolean {
    if (this.phaseNow === 'idle') return false;
    this.cancelled = true;
    if (this.phaseNow === 'running') return this.o.runner.cancel();
    this.speech?.cancel();
    return true;
  }
}
