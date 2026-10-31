/** One spoken command end to end after transcription: Claude → reply → `say` → chime. Shared by mic and `--text`. */
import type { ClaudeOutcome } from './claude.js';
import { stripForSpeech, type Chimes, type SpeakHandle, type Speaker } from './speech.js';

export interface CommandRunner {
  run(prompt: string): Promise<ClaudeOutcome>;
  cancel(): boolean;
}

export type Phase = 'idle' | 'running' | 'speaking';
export type CommandResult = 'ok' | 'error' | 'cancelled';

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

  async handle(text: string): Promise<CommandResult> {
    const now = this.o.now ?? Date.now;
    const t0 = now();
    this.cancelled = false;
    this.phaseNow = 'running';
    this.o.status('Working…');
    let out: ClaudeOutcome;
    try {
      out = await this.o.runner.run(text);
    } catch (e) {
      out = { kind: 'error', message: (e as Error).message, sessionId: null };
    }
    try {
      if (out.kind === 'cancelled' || this.cancelled) {
        this.o.status('Cancelled.');
        this.o.chimes.play('done');
        return 'cancelled';
      }
      const raw = out.kind === 'ok' ? out.text : out.message;
      const spoken = stripForSpeech(raw) || (out.kind === 'ok' ? 'Done.' : 'Something went wrong.');
      this.o.status(out.kind === 'ok' ? `Stephen: ${spoken}` : `Problem: ${spoken}`);
      let speak = this.o.speak;
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
      return out.kind === 'ok' ? 'ok' : 'error';
    } finally {
      this.phaseNow = 'idle';
    }
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
