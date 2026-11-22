/**
 * One command end to end after transcription: memory, timer and job routers → Claude → reply → `say` → chime. Shared by the mic,
 * `--text` and the Stephen app's typed chat (src/app/server.ts): call command(text, {source, raw}).
 */
import { newConversationId, newHistoryId } from '../history/store.js';
import type { ClaudeOutcome, ModelTimes } from './claude.js';
import type { CommandSource, MemoryRouter } from './memory-router.js';
import { stripForSpeech, type Chimes, type SpeakHandle, type Speaker } from './speech.js';

/**
 * How far a conversation is trusted (docs/REVIEW-7.md R7-2). `trusted`: push-to-talk (F5 / Fn+Option), typed text,
 * the app chat, `--text`. `wake`: the wake word, which anyone in the room or a video can say. `phone`: the owner's
 * phone through Remote Control (docs/ADR-005): `wake` data rules, and nobody is at the Mac to answer a confirmation,
 * so the serve declines every one. A conversation has one trust level: a command of another level always starts a
 * fresh one, and a `wake` or `phone` conversation's serve runs with `--trust wake` (email shows only who and when).
 */
export type Trust = 'trusted' | 'wake' | 'phone';

/**
 * True for "play / put on / start playing <something new>", decided from the owner's words (never the model's). Not for
 * a bare "play" (resume) or anything that points back into the conversation ("play it", "play the first one"):
 * those need the follow-up's context.
 */
export function freshForPlay(text: string): boolean {
  const m = /^(?:(?:hey )?stephen,?\s+)?(?:please\s+)?(?:play|put on|start playing)\s+(.+)$/i.exec(text.trim());
  if (!m) return false;
  const what = m[1]!.replace(/[.!?]+$/, '').trim().toLowerCase();
  return !/^(?:it|that|this|them|those|again|it again|that again|the (?:first|second|third|next|last|previous|same|other) ?(?:one|song|video|track)?|(?:the )?(?:one|song|video) (?:from|in|you)\b.*|something from (?:that|it)\b.*)$/.test(what);
}

/** The trust of a command from this source. */
export function trustOf(source: CommandSource): Trust {
  return source === 'voice-wake' ? 'wake' : source === 'phone' ? 'phone' : 'trusted';
}

export interface CommandRunner {
  run(prompt: string, hooks?: RunHooks): Promise<ClaudeOutcome>;
  cancel(): boolean;
  /** Follow-ups (ConversationRunner): decide whether the next run (of this trust) resumes the conversation. */
  followUp?(trust?: Trust): boolean;
  /** Esc / "Stephen stop" / any cancel: end the conversation (the next command starts fresh). */
  endConversation?(): void;
  /** The reply is out (spoken or shown): the follow-up window counts from now. */
  commandEnded?(): void;
  /**
   * The user started talking (wake word: `wake`, F5: `trusted`): start Claude now so it is ready when the transcript
   * is (warm runner). A live process of the other trust is ended first.
   */
  prewarm?(trust?: Trust): void;
}

/** Per-run options: the command's trust, and hooks a runner may call during run() (ToolLogRunner). */
export interface RunHooks {
  /** The command's trust (default `wake`, the most cautious). A conversation of another trust is never continued. */
  trust?: Trust;
  /** The command's id (CommandReport.id). ToolLogRunner writes it to the command id file. A label only. */
  id?: string;
  /**
   * Called right before the command goes to Claude. The warm runner calls it once every earlier process group is
   * gone, so nothing of an earlier, cancelled command can still write after this point (docs/REVIEW-7.md R7-10).
   * The one-shot runner calls it right before it starts Claude, without that guarantee.
   */
  beforeSend?: () => void;
}

/** A deterministic router that runs before Claude (timers, jobs): a reply, or null when the text isn't its command. */
export interface LocalRouter {
  route(text: string, opts: { source: CommandSource; raw?: string }): Promise<{ reply: string; changed: false; rest?: string; said?: string } | null>;
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
  /** Who answered: a local router, or the model (also "remember X and play Y", where the model runs the rest). */
  route: 'memory' | 'timer' | 'job' | 'model';
  /** Milliseconds from the start of the command until the reply text existed (before it was spoken or shown). */
  replyMs: number;
  /** The model run's own times, when the runner measured them (warm process). Numbers only. */
  model?: ModelTimes;
  /** The spoken reply was cut short: ms from the cancel until the speech process ended (a number, for the latency log). */
  silenceMs?: number;
  /** Conversation id (ADR-007): the same for every command of one conversation, a new one when a conversation starts. */
  conv?: string;
}

export interface AssistantOptions {
  runner: CommandRunner;
  speaker: Speaker;
  chimes: Chimes;
  /** A function: read for every reply, so Settings can turn speaking on and off while Stephen runs. */
  speak: boolean | (() => boolean);
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
  timers?: LocalRouter | null;
  /**
   * Job commands ("start a job to …", "stop the job"), handled before Claude after memory and timers
   * (src/jobs/router.ts). Claude has no job tool: a start always goes through the router's native dialog.
   */
  jobs?: LocalRouter | null;
  /** Called once per command with its report (history). A throwing hook is logged, never fails the command. */
  onDone?: (r: CommandReport) => void;
  /** Called when a command starts, before the memory router (the Stephen app shows voice commands live). Same rules. */
  onStart?: (c: { id: string; source: CommandSource; said: string }) => void;
}

export class Assistant {
  private phaseValue: Phase = 'idle';
  private speech: SpeakHandle | null = null;
  private cancelled = false;
  /** When a cancel hit a reply being spoken (assistant clock), and how long the speech took to end after it. */
  private silenceFrom: number | null = null;
  private silenceMs: number | undefined;
  /**
   * The open conversation's id (ADR-007), or null when none is open. A Claude run that is not a follow-up starts a new
   * one; a command a local router answers joins the open one (ADR-007 open question 4).
   * ponytail: a local command after the follow-up window ran out still joins the old id; ask the runner if that matters.
   */
  private conv: string | null = null;
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
    const trust = trustOf(source);
    const id = opts.id ?? newHistoryId();
    this.cancelled = false;
    this.silenceFrom = null;
    this.silenceMs = undefined;
    this.phaseNow = 'running';
    try {
      this.o.onStart?.({ id, source, said: text });
    } catch (e) {
      this.o.status(`Note: could not report the command (${(e as Error).message}).`);
    }
    let said = text;
    let via: CommandReport['route'] = 'model';
    let replyAt = t0;
    let conv = this.conv ?? newConversationId();
    this.conv = conv;
    const report = (r: Omit<CommandReport, 'id' | 'source' | 'said' | 'ms' | 'route' | 'replyMs' | 'conv'>): CommandReport => {
      // A failed or cancelled Claude run ends the conversation (conversation.ts): the next command gets a new id.
      if (r.ranClaude && r.outcome !== 'ok') this.conv = null;
      const full: CommandReport = { ...r, id, source, said, conv, ms: Math.max(0, now() - t0), route: via, replyMs: Math.max(0, replyAt - t0), ...(this.silenceMs !== undefined ? { silenceMs: this.silenceMs } : {}) };
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
      const local = { source, ...(opts.raw !== undefined ? { raw: opts.raw } : {}) };
      const routers: [CommandReport['route'], (() => ReturnType<LocalRouter['route']> | ReturnType<MemoryRouter['route']>) | null][] = [
        ['memory', this.o.memory ? () => this.o.memory!.route(text, { source, raw: opts.raw }) : null],
        ['timer', this.o.timers ? () => this.o.timers!.route(text, local) : null],
        ['job', this.o.jobs ? () => this.o.jobs!.route(text, local) : null],
      ];
      let route: Awaited<ReturnType<MemoryRouter['route']>> | Awaited<ReturnType<LocalRouter['route']>> = null;
      for (const [name, ask] of routers) {
        route = ask ? await ask() : null;
        if (route) {
          if (!route.rest) via = name;
          break;
        }
      }
      replyAt = now();
      if (route) {
        if (route.said !== undefined) said = route.said;
        // A memory change ends the conversation BEFORE anything else runs: a resumed session would keep the old
        // system prompt (claude's --system-prompt-snapshot), so the next command must start fresh.
        if (route.changed) {
          this.o.runner.endConversation?.();
          this.conv = null; // this command keeps its id; the next one starts a new conversation
        }
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
        followUp = this.o.runner.followUp?.(trust) ?? false;
        // "Play <something>" starts a fresh conversation (docs/PLAN-WORK-SPLIT.md §13): a conversation that read
        // private data (Canvas, email…) must confirm before opening YouTube with a query, which the phone and an
        // empty room can't answer. A new conversation has read nothing private, so the normal gate lets it through.
        if (followUp && freshForPlay(prompt)) {
          this.o.runner.endConversation?.();
          followUp = false;
        }
      } catch {
        // run() reports it
      }
      if (!followUp || this.conv === null) conv = newConversationId();
      this.conv = conv;
      this.o.status(followUp ? 'Working… (follow-up)' : 'Working…');
      let out: ClaudeOutcome;
      try {
        out = await this.o.runner.run(prompt, { trust, id });
      } catch (e) {
        out = { kind: 'error', message: (e as Error).message, sessionId: null };
      }
      replyAt = now();
      const claude = { ranClaude: true, followUp, turns: out.kind === 'ok' ? (out.turns ?? 0) : 0, ...(out.kind === 'ok' && out.model ? { model: out.model } : {}) };
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
    // A per-command override can only switch speaking off (typed chat); the global setting always applies.
    let speak = speakOverride !== false && (typeof this.o.speak === 'function' ? this.o.speak() : this.o.speak);
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
      if (this.silenceFrom !== null) this.silenceMs = Math.max(0, now() - this.silenceFrom);
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
    return { id: newHistoryId(), source: 'cli', said: '', reply: text, result: this.cancelled ? 'cancelled' : 'ok', outcome: 'memory', ranClaude: false, followUp: false, turns: 0, ms: Math.max(0, now() - t0), route: 'timer', replyMs: 0 };
  }

  /** The user started talking: let the runner start Claude now (no-op for the one-shot runner). */
  prewarm(trust: Trust = 'wake'): void {
    this.o.runner.prewarm?.(trust);
  }

  /** End the follow-up conversation: the next command starts a fresh Claude session with a fresh gate. */
  endConversation(): void {
    this.conv = null;
    this.o.runner.endConversation?.();
  }

  /** Stop whatever is happening: kill the Claude run, or cut the spoken reply short. */
  cancel(): boolean {
    if (this.phaseNow === 'idle') return false;
    this.cancelled = true;
    if (this.phaseNow === 'running') return this.o.runner.cancel();
    if (this.speech) this.silenceFrom = (this.o.now ?? Date.now)();
    this.speech?.cancel();
    return true;
  }
}
