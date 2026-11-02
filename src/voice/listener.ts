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
 *    With Stephen Helper connected there is no fixed cooldown: the wake word is ignored only while the Mac is
 *    playing sound (the helper's `audio.playing`), which is exactly when a page or video could be talking.
 *  - The stop phrase ("stephen stop") cancels the running command or the spoken reply, at any time.
 *  - Follow-ups (src/voice/conversation.ts): any cancel, Esc or the stop phrase — even when idle — also ends the
 *    conversation, so the next command starts a fresh Claude session with a fresh safety gate.
 *  - Push-to-talk (helper: hold F5) needs no wake word: pressing it cancels whatever is running, records
 *    until release (≥ PTT_MIN_HOLD_MS, at most PTT_MAX_HOLD_MS) and sends the transcript. Esc cancels like
 *    "stephen stop". `voice.wakeWord: false` turns the wake word off (push-to-talk only).
 *  - Nothing spoken is ever a confirmation: risky actions are confirmed in a macOS dialog by the MCP server.
 */
import { PTT_MAX_HOLD_MS, PTT_MIN_HOLD_MS } from '../helper/protocol.js';
import type { Assistant, CommandReport, CommandResult } from './assistant.js';
import type { AudioSource } from './audio.js';
import type { KeywordHit, Spotter, Transcriber, Vad } from './engine.js';
import type { HelperBridge, MenuState } from './helper-link.js';
import type { Chimes } from './speech.js';
import { normalizeTranscript, plainWords } from './transcript.js';
import { SAMPLE_RATE, concatSamples } from './wav.js';

export interface ListenerOptions {
  /** Shown in status lines ("Listening for …"); also the only wake phrase when `wakePhrases` is absent. */
  wakePhrase: string;
  /** Every wake phrase the transcript check accepts (default [wakePhrase]). */
  wakePhrases?: readonly string[];
  /** The stop phrase: a capture whose transcript is just this is never sent (a bare "Stephen" started it). */
  stopPhrase?: string;
  silenceSec: number;
  /**
   * Once the user has talked for LONG_COMMAND_AFTER_SEC, a command ends only after this much silence (≥ silenceSec):
   * multi-part requests ("open Notion… and then play lofi") have thinking pauses. Default = silenceSec (off).
   */
  longSilenceSec?: number;
  /**
   * A wake-word command whose transcript ends in a joining word ("…and", "…then", "um") is not sent yet: Stephen
   * keeps listening for up to this many seconds and joins the two parts (once). 0 = off. Default 0.
   */
  continueSec?: number;
  maxCommandSec: number;
  noSpeechTimeoutSec: number;
  verifyWake: boolean;
  /** Exit after the first command. */
  once: boolean;
  /**
   * Seconds (of audio) after a command during which the wake word is ignored; 0 = none. Default 0.
   * Only used while no helper is connected (with the helper, `audio.playing` gates the wake word instead).
   */
  cooldownSec?: number;
  /** false = no wake word at all (push-to-talk only; needs the helper). Default true. */
  wakeWord?: boolean;
  /** Push-to-talk presses shorter than this are ignored. Default PTT_MIN_HOLD_MS. */
  pttMinHoldMs?: number;
  /** Push-to-talk recordings stop (and are sent) at this length. Default PTT_MAX_HOLD_MS. */
  pttMaxHoldMs?: number;
}

export interface ListenerDeps {
  source: AudioSource;
  spotter: Spotter;
  vad: Vad;
  transcriber: Transcriber;
  assistant: Assistant;
  chimes: Chimes;
  status: (line: string) => void;
  /** Stephen Helper (push-to-talk, Esc, audio.playing, menu-bar state); null/absent = not available. */
  helper?: HelperBridge | null;
  /** Called with each transcript (raw + normalized) — for tests and benchmarks. */
  onTranscript?: (raw: string, command: string, ms: number) => void;
  /** Every listener state change (the same states as the menu bar; the Stephen app shows them). */
  onState?: (s: MenuState) => void;
}

/** Audio kept from before the keyword's first token (KWS token times lag the speech a little). */
export const PREROLL_MARGIN_SEC = 0.3;
/**
 * A bare "Stephen" keeps more: a word said right before it ("Even Stephen agreed…") must reach the transcript,
 * where the bare-wake check (anchored) then rejects it.
 */
export const BARE_PREROLL_EXTRA_SEC = 0.7;
const MAX_PREROLL_SEC = 3;
const RING_SEC = 4;
/** Speech shorter than this after the wake word (e.g. the tail of "…phen") doesn't count as the command. */
const MIN_COMMAND_SPEECH_SEC = 0.3;
/** Recycle the keyword-spotter stream after this much idle audio (bounded memory on an always-on stream). */
const SPOTTER_RECYCLE_SEC = 60;
const SPOTTER_PRIME_SEC = 2;
/** Push-to-talk audio kept before the first / after the last frame the VAD calls speech (its detection lags). */
const PTT_LEAD_SEC = 0.5;
const PTT_TAIL_SEC = 0.25;
/** After this much speech in one command, the longer pause (`longSilenceSec`) ends it. */
export const LONG_COMMAND_AFTER_SEC = 2.5;

/** Words a finished request doesn't end with: the user paused mid-sentence. */
const JOINING_WORDS = new Set(['and', 'then', 'also', 'plus', 'or', 'but', 'so', 'with', 'to', 'from', 'for', 'um', 'uh', 'erm', 'the', 'a', 'an', 'my', 'of']);
const JOINING_PAIRS = new Set(['after that', 'and then', 'and also']);

/** True when a (normalized, lower-case) transcript stops mid-sentence: "open notion and", "play um". */
export function endsUnfinished(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false; // a lone "and" is not a command start worth waiting for
  const last = words[words.length - 1]!;
  return JOINING_WORDS.has(last) || JOINING_PAIRS.has(words.slice(-2).join(' '));
}

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

type State = 'listening' | 'capturing' | 'recording' | 'busy';
type Token = { cancelled: boolean; reachedClaude: boolean };

export class Listener {
  private state: State = 'listening';
  private readonly ring = new Ring(RING_SEC * SAMPLE_RATE);
  private capture: Float32Array[] = [];
  private capturedSec = 0;
  private speechSec = 0;
  private heardSpeech = false;
  /** Silence after speech beyond the VAD's own silenceSec (for longSilenceSec). */
  private extraSilenceSec = 0;
  /** Samples seen so far (any state), to recover the audio said while an unfinished part was transcribed. */
  private totalSamples = 0;
  /** totalSamples when the current capture ended. */
  private captureEndSample = 0;
  /** Continuation: the first, unfinished part (already transcribed and wake-checked). */
  private prefix: string | null = null;
  /** The first part's raw transcript (original case, for memory text). */
  private prefixRaw = '';
  private sinceRecycleSec = 0;
  private task: Promise<void> = Promise.resolve();
  private cancelToken: Token = { cancelled: false, reachedClaude: false };
  /** Push-to-talk: per-frame "VAD says speech" (for trimming the edges). */
  private speechFlags: boolean[] = [];
  private pttCount = 0;
  private helperOffs: (() => void)[] = [];
  private exitRequested = false;
  private results: CommandResult[] = [];
  private wakeCount = 0;
  /** Seconds of audio left in the post-command cooldown (wake word ignored while > 0). */
  private cooldownLeftSec = 0;
  private sawHelperUp = false;
  private lastCommandEndMs: number | null = null;
  private ignoredWakes = 0;
  /** The wake that started the current capture was a bare "Stephen" (stricter transcript check). */
  private bareWake = false;

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

  /** Waiting for the wake word or F5: nothing running, nobody talking (submit() would start). */
  get idle(): boolean {
    return this.state === 'listening' && !this.exitRequested;
  }

  /** True while the post-command cooldown ignores the wake word. */
  get coolingDown(): boolean {
    return this.cooldownLeftSec > 0;
  }

  /** Push-to-talk recordings sent to speech-to-text (tests). */
  get ptts(): number {
    return this.pttCount;
  }

  private get wakeOn(): boolean {
    return this.o.wakeWord ?? true;
  }

  private get helperUp(): boolean {
    return !!this.d.helper?.connected;
  }

  private menu(s: MenuState): void {
    this.d.helper?.setState(s);
    this.d.onState?.(s);
  }

  /** The "ready" line printed whenever Stephen is idle again. */
  private readyLine(): string {
    if (!this.wakeOn) return 'Ready — hold F5 to talk…';
    return `Listening for "${this.o.wakePhrase}"…`;
  }

  /** Wake words ignored because of the cooldown or playing sound (tests/benchmarks). */
  get wakesIgnored(): number {
    return this.ignoredWakes;
  }

  /** The user pressed Enter: end the cooldown now. Returns false when there was none. */
  rearm(): boolean {
    if (this.cooldownLeftSec <= 0) return false;
    this.cooldownLeftSec = 0;
    if (this.state === 'listening' && this.wakeOn) this.d.status(`Re-armed — listening for "${this.o.wakePhrase}"…`);
    return true;
  }

  /**
   * Run a typed command (the Stephen app's chat) in the same queue as voice commands: it counts as busy, so the wake
   * word can only cancel it, Esc / "stephen stop" / F5 cancel it, and push-to-talk waits for it. `run` starts
   * the command (assistant.command(...)). Returns null, without running anything, when Stephen is not idle (a command
   * is running or being spoken, or the user is talking).
   */
  submit(run: () => Promise<CommandReport>): Promise<CommandReport> | null {
    if (!this.idle || this.d.assistant.busy) return null;
    this.state = 'busy';
    this.menu('working');
    const token: Token = (this.cancelToken = { cancelled: false, reachedClaude: true });
    const report = this.task.then(run);
    this.task = report.then(
      () => undefined,
      (e: unknown) => this.d.status(`Problem: ${(e as Error).message}`),
    ).then(() => {
      this.lastCommandEndMs = Date.now();
      if (this.cancelToken !== token || this.state !== 'busy') return; // a push-to-talk press took over
      this.toListening();
      // Typed commands can open pages and videos too: same cooldown as a voice command that reached Claude.
      const cooldown = this.wakeOn && !this.helperUp ? (this.o.cooldownSec ?? 0) : 0;
      if (cooldown > 0) this.cooldownLeftSec = cooldown;
      this.d.status(this.readyLine());
    });
    return report;
  }

  /** Ask the loop to finish (Ctrl-C when idle). */
  requestExit(): void {
    this.exitRequested = true;
    void this.d.source.stop();
  }

  /**
   * Cancel the current command (Ctrl-C / stop phrase / Esc / push-to-talk / wake-word barge-in). Returns false when
   * there was nothing to cancel. Always ends the follow-up conversation: the next command starts a fresh Claude
   * session with a fresh gate.
   */
  cancel(reason: string): boolean {
    this.d.assistant.endConversation();
    if (this.state === 'capturing' || this.state === 'recording') {
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
    const ptt = this.d.helper ? ' (or hold F5)' : '';
    this.d.status(
      this.wakeOn
        ? `Listening for "${this.o.wakePhrase}"${ptt} on ${this.d.source.label}… (Ctrl-C to quit)`
        : `Ready on ${this.d.source.label} — hold F5 to talk… (Ctrl-C to quit)`,
    );
    this.attachHelper();
    this.menu('listening');
    try {
      for (;;) {
        if (this.exitRequested) break;
        const frame = await this.d.source.read();
        if (!frame) break;
        this.onFrame(frame);
      }
      if (this.state === 'capturing' && !this.exitRequested) this.finishCapture();
      else if (this.state === 'recording' && !this.exitRequested) this.finishPtt();
      // A push-to-talk press can chain a new task while we wait for the current one.
      for (let t = this.task; ; t = this.task) {
        await t;
        if (t === this.task) break;
      }
    } finally {
      for (const off of this.helperOffs.splice(0)) off();
      this.menu('idle');
      await this.d.source.stop();
    }
    if (this.o.once) return this.results[0] === 'ok' ? 0 : 1;
    return 0;
  }

  private onFrame(frame: Float32Array): void {
    this.ring.push(frame);
    this.totalSamples += frame.length;
    const hit = this.d.spotter.accept(frame);
    switch (this.state) {
      case 'listening':
        if (hit?.id === 'STOP') this.d.assistant.endConversation(); // "Stephen stop" when idle: forget the conversation
        else if (hit?.id === 'WAKE') this.onWake(hit);
        else this.maybeRecycleSpotter(frame.length);
        this.tickCooldown(frame.length);
        break;
      case 'capturing':
        if (hit?.id === 'STOP') this.cancel('stop phrase');
        else this.captureFrame(frame);
        break;
      case 'recording':
        if (hit?.id === 'STOP') this.cancel('stop phrase');
        else this.recordFrame(frame);
        break;
      case 'busy':
        if (hit?.id === 'STOP') this.cancel('stop phrase');
        else if (hit?.id === 'WAKE' && this.wakeOn) {
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
    if (!this.wakeOn) return; // push-to-talk only
    this.syncHelperState();
    if (this.helperUp) {
      // No fixed cooldown with the helper: ignore the wake word only while the Mac is playing sound.
      // Unknown (null: just (re)connected, no audio event yet) is treated like playing — fail closed (review #4 #2).
      if (this.d.helper!.audioPlaying !== false) {
        this.ignoredWakes++;
        this.d.status(`Ignored "${this.o.wakePhrase}" — sound is playing (it may be a video talking). Hold F5 to talk.`);
        return;
      }
      this.beginCapture(hit);
      return;
    }
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

  /**
   * Helper dropped: the audio.playing gate is gone, so fall back to the fixed cooldown right away, so a video
   * the last command started can't trigger the wake word in the gap (review #4 finding 2).
   */
  private syncHelperState(): void {
    const up = this.helperUp;
    if (this.sawHelperUp && !up && this.wakeOn && this.lastCommandEndMs !== null) {
      // Only the part of the cooldown that would still be running since the last command (nothing to guard before).
      const left = (this.o.cooldownSec ?? 0) - (Date.now() - this.lastCommandEndMs) / 1000;
      if (left > 0) this.cooldownLeftSec = Math.max(this.cooldownLeftSec, left);
    }
    this.sawHelperUp = up;
  }

  private tickCooldown(samples: number): void {
    this.syncHelperState();
    if (this.cooldownLeftSec <= 0) return;
    this.cooldownLeftSec -= samples / SAMPLE_RATE;
    if (this.cooldownLeftSec <= 0) {
      this.cooldownLeftSec = 0;
      this.d.status(this.readyLine());
    }
  }

  private beginCapture(hit: KeywordHit): void {
    this.wakeCount++;
    this.bareWake = !!hit.bare;
    this.d.chimes.play('wake');
    this.d.status('Wake word heard — listening…');
    const pre = Math.min(hit.startAgoSec + PREROLL_MARGIN_SEC + (hit.bare ? BARE_PREROLL_EXTRA_SEC : 0), MAX_PREROLL_SEC);
    // Keep the audio from just before the wake phrase: "Hey Stephen open YouTube" in one breath must not
    // lose "open". The wake phrase itself is stripped from the transcript (and re-checked there).
    this.capture = [this.ring.last(pre).slice()];
    this.capturedSec = 0;
    this.speechSec = 0;
    this.heardSpeech = false;
    this.extraSilenceSec = 0;
    this.prefix = null;
    this.d.vad.reset();
    this.state = 'capturing';
    this.menu('recording');
  }

  /**
   * The transcript ended mid-sentence ("open notion and"): listen again for up to continueSec, starting with the
   * audio said while the first part was being transcribed (from the ring), and send both parts joined.
   */
  private beginContinuation(prefix: string, prefixRaw: string): void {
    this.prefix = prefix;
    this.prefixRaw = prefixRaw;
    const gapSec = Math.min((this.totalSamples - this.captureEndSample) / SAMPLE_RATE, RING_SEC);
    this.capture = gapSec > 0 ? [this.ring.last(gapSec).slice()] : [];
    this.capturedSec = 0;
    this.speechSec = 0;
    this.heardSpeech = false;
    this.extraSilenceSec = 0;
    this.d.vad.reset();
    if (gapSec > 0) this.d.vad.accept(this.capture[0]!);
    this.state = 'capturing';
    this.menu('recording');
    this.d.chimes.play('wake');
    this.d.status(`Heard "${prefix}" — still listening…`);
  }

  // ───────────────────────────── helper: push-to-talk, Esc ─────────────────────────────

  private attachHelper(): void {
    const h = this.d.helper;
    if (!h) return;
    this.helperOffs.push(
      h.on('ptt_down', () => this.onPttDown()),
      h.on('ptt_up', (e) => ((e as { aborted?: boolean }).aborted ? this.abortPtt() : this.onPttUp(e.heldMs))),
      h.on('esc', () => {
        // Same path as "stephen stop"; when idle it only ends the follow-up conversation.
        if (this.state !== 'listening') this.cancel('Esc');
        else this.d.assistant.endConversation();
      }),
    );
  }

  private onPttDown(): void {
    if (this.exitRequested || this.state === 'recording') return;
    // A new press cancels whatever is running (Claude or the spoken reply) or an unfinished wake-word capture.
    if (this.state === 'busy') this.cancel('push-to-talk');
    this.capture = [];
    this.speechFlags = [];
    this.capturedSec = 0;
    this.d.vad.reset();
    this.state = 'recording';
    this.d.chimes.play('wake');
    this.menu('recording');
    this.d.status('Recording… (release F5 to send)');
  }

  /** The helper connection dropped mid-press: never send a cut-off command ("close all tabs except…"). */
  private abortPtt(): void {
    if (this.state !== 'recording') return;
    this.d.status('Push-to-talk was interrupted (the helper disconnected) — nothing was sent. Hold F5 and try again.');
    this.toListening();
  }

  private onPttUp(heldMs: number): void {
    if (this.state !== 'recording') return; // already sent at the length cap, or cancelled
    const min = this.o.pttMinHoldMs ?? PTT_MIN_HOLD_MS;
    if (heldMs < min) {
      this.d.status(`Ignored a ${Math.round(heldMs)} ms tap — hold F5 while you speak.`);
      this.toListening();
      return;
    }
    this.finishPtt();
  }

  private recordFrame(frame: Float32Array): void {
    this.capture.push(frame);
    this.d.vad.accept(frame);
    this.speechFlags.push(this.d.vad.speaking());
    this.capturedSec += frame.length / SAMPLE_RATE;
    if (this.capturedSec * 1000 >= (this.o.pttMaxHoldMs ?? PTT_MAX_HOLD_MS)) {
      this.d.status('Push-to-talk limit reached — sending what I have.');
      this.finishPtt();
    }
  }

  /** The recording minus the silence at its edges (null when the VAD heard no speech at all). */
  private trimmedPtt(): Float32Array | null {
    const first = this.speechFlags.indexOf(true);
    if (first < 0) return null;
    const last = this.speechFlags.lastIndexOf(true);
    const offsets: number[] = [];
    let n = 0;
    for (const f of this.capture) {
      offsets.push(n);
      n += f.length;
    }
    const all = concatSamples(this.capture);
    const start = Math.max(0, offsets[first]! - Math.round(PTT_LEAD_SEC * SAMPLE_RATE));
    const end = Math.min(all.length, offsets[last]! + this.capture[last]!.length + Math.round(PTT_TAIL_SEC * SAMPLE_RATE));
    return all.slice(start, end);
  }

  private finishPtt(): void {
    const audio = this.trimmedPtt();
    this.capture = [];
    this.speechFlags = [];
    if (!audio) {
      this.d.status("Didn't hear a command.");
      this.d.chimes.play('done');
      this.toListening();
      return;
    }
    this.pttCount++;
    this.startProcessing(audio, true);
  }

  private captureFrame(frame: Float32Array): void {
    this.capture.push(frame);
    const dt = frame.length / SAMPLE_RATE;
    this.capturedSec += dt;
    this.d.vad.accept(frame);
    if (this.d.vad.speaking()) {
      this.speechSec += dt;
      this.extraSilenceSec = 0;
      if (this.speechSec >= MIN_COMMAND_SPEECH_SEC) this.heardSpeech = true;
    } else if (this.heardSpeech) {
      // speech, then `silenceSec` of silence (the VAD's own hangover): end of command — or, after a long
      // request, wait up to longSilenceSec in total (a thinking pause between parts).
      const long = this.o.longSilenceSec ?? this.o.silenceSec;
      const need = this.speechSec >= LONG_COMMAND_AFTER_SEC ? Math.max(0, long - this.o.silenceSec) : 0;
      this.extraSilenceSec += dt;
      if (this.extraSilenceSec >= need) return this.finishCapture();
    } else {
      this.speechSec = 0; // a blip, not a command
    }
    const noSpeechSec = this.prefix !== null ? Math.min(this.o.noSpeechTimeoutSec, this.o.continueSec ?? 0) : this.o.noSpeechTimeoutSec;
    if (!this.heardSpeech && this.capturedSec >= noSpeechSec) {
      // The wake phrase might have run straight into a short command that ended before we started listening
      // for it; transcribe what we have — verifyWake/normalization decide whether it was a command.
      return this.finishCapture();
    }
    if (this.capturedSec >= this.o.maxCommandSec) this.finishCapture();
  }

  private finishCapture(): void {
    const audio = concatSamples(this.capture);
    this.capture = [];
    this.captureEndSample = this.totalSamples;
    const prefix = this.prefix === null ? null : { text: this.prefix, raw: this.prefixRaw };
    this.prefix = null;
    this.startProcessing(audio, false, prefix);
  }

  private startProcessing(audio: Float32Array, ptt: boolean, prefix: { text: string; raw: string } | null = null): void {
    this.state = 'busy';
    this.menu('working');
    if (ptt) this.d.spotter.restart(); // "hey stephen" said while holding the keys must not cancel this command
    const token: Token = (this.cancelToken = { cancelled: false, reachedClaude: false });
    // The wake phrase must open the transcript after a bare "Stephen" ("Even Stephen agreed…" is not a command)
    // and in push-to-talk (no pre-roll there: earlier words are part of the command, "play songs by Stephen…").
    // After a bare wake the name itself must be there too, not a sound-alike ("Stefan and Stella…").
    const wake = { anchored: ptt || this.bareWake, strict: !ptt && this.bareWake };
    this.bareWake = false;
    // A push-to-talk press may have cancelled a command that is still winding down: run after it.
    const previous = this.task;
    this.task = this.process(audio, token, ptt, wake, previous, prefix)
      .catch((e: unknown): CommandResult => {
        this.d.status(`Problem: ${(e as Error).message}`);
        return 'error';
      })
      .then((r) => {
        if (typeof r === 'object' && r !== null) {
          // Unfinished sentence: keep listening (unless cancelled or a push-to-talk press took over meanwhile).
          if (this.cancelToken === token && this.state === 'busy' && !this.exitRequested) this.beginContinuation(r.prefix, r.raw);
          return;
        }
        if (r) this.results.push(r);
        // A newer push-to-talk press took over: it owns the state now.
        if (token.reachedClaude) this.lastCommandEndMs = Date.now();
        if (this.cancelToken !== token || this.state !== 'busy') return;
        this.toListening();
        // Even a failed or cancelled run may have opened something before it ended. With the helper connected
        // there is no fixed cooldown (the wake word is gated on audio.playing instead).
        const cooldown = token.reachedClaude && this.wakeOn && !this.helperUp ? (this.o.cooldownSec ?? 0) : 0;
        if (cooldown > 0) this.cooldownLeftSec = cooldown;
        // --once: one command (a wake the transcript didn't confirm doesn't count).
        if (this.o.once && r) this.requestExit();
        else if (cooldown > 0) {
          this.d.status(
            `Listening for "${this.o.wakePhrase}" again in ${Math.ceil(cooldown)} s, so a page or video I just opened can't command me ` +
              '(press Enter to re-arm now)…',
          );
        } else this.d.status(this.readyLine());
      });
  }

  private toListening(): void {
    this.capture = [];
    this.prefix = null;
    this.state = 'listening';
    this.sinceRecycleSec = 0;
    this.d.spotter.restart(); // forget whatever was heard while busy
    this.menu('listening');
  }

  private async process(
    audio: Float32Array,
    token: Token,
    ptt: boolean,
    wake: { anchored: boolean; strict: boolean },
    previous: Promise<void>,
    first: { text: string; raw: string } | null = null,
  ): Promise<CommandResult | null | { prefix: string; raw: string }> {
    const prefix = first?.text ?? null;
    this.d.status('Transcribing…');
    const t0 = Date.now();
    const raw = await this.d.transcriber.transcribe(audio);
    const ms = Date.now() - t0;
    const norm = normalizeTranscript(raw, this.o.wakePhrases ?? [this.o.wakePhrase], wake);
    // A continuation carries no wake word (the first part was checked); a repeated "hey stephen" is still stripped.
    const hadWake = prefix !== null || norm.hadWake;
    const text = prefix !== null ? [prefix, norm.hadWake ? norm.text : plainWords(raw)].filter(Boolean).join(' ') : norm.text;
    this.d.onTranscript?.(raw, text, ms);
    if (token.cancelled) {
      this.d.status('Cancelled.');
      return 'cancelled';
    }
    // Push-to-talk needs no wake word (the keys are the intent); a spoken "hey stephen" is still stripped.
    if (!ptt && this.o.verifyWake && !hadWake) {
      this.d.status(`Ignored — "${this.o.wakePhrase}" wasn't in the transcript${raw ? ` ("${raw.slice(0, 80)}")` : ''}.`);
      return null;
    }
    // "Stephen, stop" whose STOP the spotter missed: the bare "Stephen" started a capture of… "stop".
    const stop = this.o.stopPhrase && prefix === null ? normalizeTranscript(raw, [this.o.stopPhrase], { anchored: true }) : null;
    if (stop?.hadWake && !stop.text) {
      this.d.assistant.endConversation();
      this.d.status(`Heard "${this.o.stopPhrase}" — nothing to stop.`);
      return null;
    }
    // Stopped mid-sentence ("open notion and…"): listen a bit more, once, instead of sending half a request.
    if (!ptt && prefix === null && (this.o.continueSec ?? 0) > 0 && text && endsUnfinished(text)) {
      return { prefix: text, raw };
    }
    if (!text) {
      this.d.status("Didn't hear a command.");
      this.d.chimes.play('done');
      return 'error';
    }
    await previous; // never two Claude runs at once
    if (token.cancelled) {
      this.d.status('Cancelled.');
      return 'cancelled';
    }
    this.d.status(`Heard: "${text}"`);
    token.reachedClaude = true;
    // The source decides memory trust: Fn+Option is a key audio can't press; the wake word can come from a video.
    const fullRaw = first ? `${first.raw} ${raw}` : raw;
    return this.d.assistant.handle(text, { source: ptt ? 'voice-ptt' : 'voice-wake', raw: fullRaw });
  }
}
