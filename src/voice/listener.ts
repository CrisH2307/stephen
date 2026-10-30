/**
 * The listening loop: audio frames → keyword spotter → (after "hey stephen") endpointing → speech-to-text →
 * Assistant. Pure orchestration over injected parts, so it runs the same on a Mac mic, a WAV file, or fakes.
 *
 * Safety rules (docs/STEPHEN.md):
 *  - While Stephen is working or speaking, the wake word never starts a new command. While Claude is running
 *    it cancels the run (a fail-safe barge-in); while Stephen is speaking it is ignored (Stephen's own voice).
 *  - Cooldown: for `cooldownSec` after every command that reached Claude, the wake word is ignored, because
 *    the page or video the command may have opened can keep talking after Stephen is done (and nothing here
 *    can tell a video's "Hey Stephen" from the user's). Pressing Enter (rearm()) ends the cooldown early.
 *    The Claude JSON result doesn't list the tools used, so this applies after every command, not only after
 *    open_url/open_app.
 *  - The stop phrase ("stephen stop") cancels the running command or the spoken reply, at any time.
 *  - Nothing spoken is ever a confirmation: risky actions are confirmed in a macOS dialog by the MCP server.
 */
import type { Assistant, CommandResult } from './assistant.js';
import type { AudioSource } from './audio.js';
import type { KeywordHit, Spotter, Transcriber, Vad } from './engine.js';
import type { Chimes } from './speech.js';
import { normalizeTranscript } from './transcript.js';
import { SAMPLE_RATE, concatSamples } from './wav.js';

export interface ListenerOptions {
  wakePhrase: string;
  silenceSec: number;
  maxCommandSec: number;
  noSpeechTimeoutSec: number;
  verifyWake: boolean;
  /** Exit after the first command. */
  once: boolean;
  /** Seconds (of audio) after a command during which the wake word is ignored; 0 = none. Default 0. */
  cooldownSec?: number;
}

export interface ListenerDeps {
  source: AudioSource;
  spotter: Spotter;
  vad: Vad;
  transcriber: Transcriber;
  assistant: Assistant;
  chimes: Chimes;
  status: (line: string) => void;
  /** Called with each transcript (raw + normalized) — for tests and benchmarks. */
  onTranscript?: (raw: string, command: string, ms: number) => void;
}

/** Audio kept from before the keyword's first token (KWS token times lag the speech a little). */
export const PREROLL_MARGIN_SEC = 0.3;
const MAX_PREROLL_SEC = 3;
const RING_SEC = 4;
/** Speech shorter than this after the wake word (e.g. the tail of "…phen") doesn't count as the command. */
const MIN_COMMAND_SPEECH_SEC = 0.3;
/** Recycle the keyword-spotter stream after this much idle audio (bounded memory on an always-on stream). */
const SPOTTER_RECYCLE_SEC = 60;
const SPOTTER_PRIME_SEC = 2;

/** Last few seconds of audio, for the pre-roll and spotter priming. */
class Ring {
  private readonly frames: Float32Array[] = [];
  private size = 0;
  constructor(private readonly maxSamples: number) {}
  push(f: Float32Array): void {
    this.frames.push(f);
    this.size += f.length;
    while (this.size - (this.frames[0]?.length ?? 0) >= this.maxSamples) this.size -= this.frames.shift()!.length;
  }
  last(sec: number): Float32Array {
    const want = Math.min(this.size, Math.round(sec * SAMPLE_RATE));
    const all = concatSamples(this.frames);
    return all.subarray(all.length - want);
  }
}

type State = 'listening' | 'capturing' | 'busy';

export class Listener {
  private state: State = 'listening';
  private readonly ring = new Ring(RING_SEC * SAMPLE_RATE);
  private capture: Float32Array[] = [];
  private capturedSec = 0;
  private speechSec = 0;
  private heardSpeech = false;
  private sinceRecycleSec = 0;
  private task: Promise<void> = Promise.resolve();
  private cancelToken = { cancelled: false, reachedClaude: false };
  private exitRequested = false;
  private results: CommandResult[] = [];
  private wakeCount = 0;
  /** Seconds of audio left in the post-command cooldown (wake word ignored while > 0). */
  private cooldownLeftSec = 0;
  private ignoredWakes = 0;

  constructor(
    private readonly o: ListenerOptions,
    private readonly d: ListenerDeps,
  ) {}

  /** Wake-word activations so far (tests/benchmarks). */
  get wakes(): number {
    return this.wakeCount;
  }

  get busy(): boolean {
    return this.state === 'busy';
  }

  /** True while the post-command cooldown ignores the wake word. */
  get coolingDown(): boolean {
    return this.cooldownLeftSec > 0;
  }

  /** Wake words ignored because of the cooldown (tests/benchmarks). */
  get wakesIgnored(): number {
    return this.ignoredWakes;
  }

  /** The user pressed Enter: end the cooldown now. Returns false when there was none. */
  rearm(): boolean {
    if (this.cooldownLeftSec <= 0) return false;
    this.cooldownLeftSec = 0;
    if (this.state === 'listening') this.d.status(`Re-armed — listening for "${this.o.wakePhrase}"…`);
    return true;
  }

  /** Ask the loop to finish (Ctrl-C when idle). */
  requestExit(): void {
    this.exitRequested = true;
    void this.d.source.stop();
  }

  /** Cancel the current command (Ctrl-C / stop phrase). Returns false when there was nothing to cancel. */
  cancel(reason: string): boolean {
    if (this.state === 'capturing') {
      this.d.status(`Cancelled (${reason}).`);
      this.toListening();
      return true;
    }
    if (this.state !== 'busy') return false;
    this.cancelToken.cancelled = true;
    this.d.status(`Stopping (${reason})…`);
    this.d.assistant.cancel();
    return true;
  }

  async run(): Promise<number> {
    await this.d.source.start();
    this.d.status(`Listening for "${this.o.wakePhrase}" on ${this.d.source.label}… (Ctrl-C to quit)`);
    try {
      for (;;) {
        if (this.exitRequested) break;
        const frame = await this.d.source.read();
        if (!frame) break;
        this.onFrame(frame);
      }
      if (this.state === 'capturing' && !this.exitRequested) this.finishCapture();
      await this.task;
    } finally {
      await this.d.source.stop();
    }
    if (this.o.once) return this.results[0] === 'ok' ? 0 : 1;
    return 0;
  }

  private onFrame(frame: Float32Array): void {
    this.ring.push(frame);
    const hit = this.d.spotter.accept(frame);
    switch (this.state) {
      case 'listening':
        if (hit?.id === 'WAKE') this.onWake(hit);
        else this.maybeRecycleSpotter(frame.length);
        this.tickCooldown(frame.length);
        break;
      case 'capturing':
        if (hit?.id === 'STOP') this.cancel('stop phrase');
        else this.captureFrame(frame);
        break;
      case 'busy':
        if (hit?.id === 'STOP') this.cancel('stop phrase');
        else if (hit?.id === 'WAKE') {
          // Never starts a new command while busy. Cancelling a running Claude is the safe direction;
          // while speaking, the "wake word" is most likely Stephen's own voice — ignore it.
          if (this.d.assistant.phase === 'running') this.cancel('wake word');
        }
        break;
    }
  }

  private maybeRecycleSpotter(n: number): void {
    this.sinceRecycleSec += n / SAMPLE_RATE;
    if (this.sinceRecycleSec < SPOTTER_RECYCLE_SEC) return;
    this.sinceRecycleSec = 0;
    const hit = this.d.spotter.restart(this.ring.last(SPOTTER_PRIME_SEC));
    if (hit?.id === 'WAKE') this.onWake(hit);
  }

  private onWake(hit: KeywordHit): void {
    if (this.cooldownLeftSec > 0) {
      this.ignoredWakes++;
      this.d.status(
        `Ignored "${this.o.wakePhrase}" — the wake word is paused for ${Math.ceil(this.cooldownLeftSec)} s more after the last command ` +
          '(a page or video may be talking). Press Enter to talk now.',
      );
      return;
    }
    this.beginCapture(hit);
  }

  private tickCooldown(samples: number): void {
    if (this.cooldownLeftSec <= 0) return;
    this.cooldownLeftSec -= samples / SAMPLE_RATE;
    if (this.cooldownLeftSec <= 0) {
      this.cooldownLeftSec = 0;
      this.d.status(`Listening for "${this.o.wakePhrase}"…`);
    }
  }

  private beginCapture(hit: KeywordHit): void {
    this.wakeCount++;
    this.d.chimes.play('wake');
    this.d.status('Wake word heard — listening…');
    const pre = Math.min(hit.startAgoSec + PREROLL_MARGIN_SEC, MAX_PREROLL_SEC);
    // Keep the audio from just before the wake phrase: "Hey Stephen open YouTube" in one breath must not
    // lose "open". The wake phrase itself is stripped from the transcript (and re-checked there).
    this.capture = [this.ring.last(pre).slice()];
    this.capturedSec = 0;
    this.speechSec = 0;
    this.heardSpeech = false;
    this.d.vad.reset();
    this.state = 'capturing';
  }

  private captureFrame(frame: Float32Array): void {
    this.capture.push(frame);
    const dt = frame.length / SAMPLE_RATE;
    this.capturedSec += dt;
    this.d.vad.accept(frame);
    if (this.d.vad.speaking()) {
      this.speechSec += dt;
      if (this.speechSec >= MIN_COMMAND_SPEECH_SEC) this.heardSpeech = true;
    } else if (this.heardSpeech) {
      return this.finishCapture(); // speech, then `silenceSec` of silence: end of command
    } else {
      this.speechSec = 0; // a blip, not a command
    }
    if (!this.heardSpeech && this.capturedSec >= this.o.noSpeechTimeoutSec) {
      // The wake phrase might have run straight into a short command that ended before we started listening
      // for it; transcribe what we have — verifyWake/normalization decide whether it was a command.
      return this.finishCapture();
    }
    if (this.capturedSec >= this.o.maxCommandSec) this.finishCapture();
  }

  private finishCapture(): void {
    const audio = concatSamples(this.capture);
    this.capture = [];
    this.state = 'busy';
    const token = (this.cancelToken = { cancelled: false, reachedClaude: false });
    this.task = this.process(audio, token)
      .catch((e: unknown): CommandResult => {
        this.d.status(`Problem: ${(e as Error).message}`);
        return 'error';
      })
      .then((r) => {
        this.toListening();
        if (r) this.results.push(r);
        // Even a failed or cancelled run may have opened something before it ended.
        const cooldown = token.reachedClaude ? (this.o.cooldownSec ?? 0) : 0;
        if (cooldown > 0) this.cooldownLeftSec = cooldown;
        // --once: one command (a wake the transcript didn't confirm doesn't count).
        if (this.o.once && r) this.requestExit();
        else if (cooldown > 0) {
          this.d.status(
            `Listening for "${this.o.wakePhrase}" again in ${Math.ceil(cooldown)} s, so a page or video I just opened can't command me ` +
              '(press Enter to re-arm now)…',
          );
        } else this.d.status(`Listening for "${this.o.wakePhrase}"…`);
      });
  }

  private toListening(): void {
    this.capture = [];
    this.state = 'listening';
    this.sinceRecycleSec = 0;
    this.d.spotter.restart(); // forget whatever was heard while busy
  }

  private async process(audio: Float32Array, token: { cancelled: boolean; reachedClaude: boolean }): Promise<CommandResult | null> {
    this.d.status('Transcribing…');
    const t0 = Date.now();
    const raw = await this.d.transcriber.transcribe(audio);
    const ms = Date.now() - t0;
    const { text, hadWake } = normalizeTranscript(raw, this.o.wakePhrase);
    this.d.onTranscript?.(raw, text, ms);
    if (token.cancelled) {
      this.d.status('Cancelled.');
      return 'cancelled';
    }
    if (this.o.verifyWake && !hadWake) {
      this.d.status(`Ignored — "${this.o.wakePhrase}" wasn't in the transcript${raw ? ` ("${raw.slice(0, 80)}")` : ''}.`);
      return null;
    }
    if (!text) {
      this.d.status("Didn't hear a command.");
      this.d.chimes.play('done');
      return 'error';
    }
    this.d.status(`Heard: "${text}"`);
    token.reachedClaude = true;
    return this.d.assistant.handle(text);
  }
}
