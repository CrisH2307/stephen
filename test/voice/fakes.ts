/** Scripted fakes for the listener: audio frames, keyword spotter, VAD, ASR, Claude runner and Stephen Helper. */
import type { CommandRunner } from '../../src/voice/assistant.js';
import type { AudioSource } from '../../src/voice/audio.js';
import type { ClaudeOutcome } from '../../src/voice/claude.js';
import type { KeywordHit, Spotter, Transcriber, Vad } from '../../src/voice/engine.js';
import type { HelperCommand, HelperEvent } from '../../src/helper/protocol.js';
import type { HelperEventOf, HelperEventType, HelperLink, HelperStartResult } from '../../src/voice/helper-link.js';

export const FRAME = 512; // 32 ms
export const SPEECH = 0.5;

/** Frames: 's' = speech, '.' = silence. Each frame's 2nd sample holds its index (to check the pre-roll). */
export function frames(pattern: string): Float32Array[] {
  return [...pattern].map((c, i) => {
    const f = new Float32Array(FRAME);
    f[0] = c === 's' ? SPEECH : 0;
    f[1] = i;
    return f;
  });
}

export class ScriptedSource implements AudioSource {
  readonly label = 'script';
  private i = 0;
  private stopped = false;
  constructor(
    private readonly fs: Float32Array[],
    private readonly gates: Map<number, () => Promise<void> | void> = new Map(),
  ) {}
  async start() {}
  async read() {
    if (this.stopped || this.i >= this.fs.length) return null;
    await this.gates.get(this.i)?.();
    await new Promise((r) => setImmediate(r));
    return this.fs[this.i++]!;
  }
  async stop() {
    this.stopped = true;
  }
}

export class ScriptedSpotter implements Spotter {
  private n = 0;
  restarts = 0;
  /** 'WAKE_BARE' = a bare "Stephen" (a WAKE hit with `bare`). */
  constructor(private readonly hits: Record<number, KeywordHit['id'] | 'WAKE_BARE'>) {}
  accept(): KeywordHit | null {
    const id = this.hits[this.n++];
    if (id === 'WAKE_BARE') return { id: 'WAKE', bare: true, startAgoSec: 0.5 };
    return id ? { id, startAgoSec: 0.5 } : null;
  }
  restart() {
    this.restarts++;
    return null;
  }
}

/** Speaking while frames are speech; silenceSec of hysteresis like Silero in sherpa. */
export class FakeVad implements Vad {
  private silentFor = Infinity;
  constructor(private readonly hangoverFrames = 25) {}
  reset() {
    this.silentFor = Infinity;
  }
  accept(s: Float32Array) {
    this.silentFor = s[0] === SPEECH ? 0 : this.silentFor + 1;
  }
  speaking() {
    return this.silentFor < this.hangoverFrames;
  }
}

export class FakeTranscriber implements Transcriber {
  readonly id = 'fake';
  readonly heard: Float32Array[] = [];
  constructor(private readonly texts: string[]) {}
  async transcribe(s: Float32Array) {
    this.heard.push(s);
    return this.texts.shift() ?? '';
  }
}

export class FakeRunner implements CommandRunner {
  readonly prompts: string[] = [];
  cancels = 0;
  /** endConversation() calls (Esc / "Stephen stop" / cancel end the follow-up conversation). */
  conversationEnds = 0;
  commandEnds = 0;
  /** prewarm(), run, cancel calls in order ("prewarm", "run:<prompt>", "cancel"). */
  readonly calls: string[] = [];
  private release: ((o: ClaudeOutcome) => void) | null = null;
  constructor(private readonly hold = false) {}
  get pending() {
    return this.release !== null;
  }
  /** prewarm() calls (the warm runner starts Claude on wake / F5). */
  get prewarms() {
    return this.calls.filter((c) => c === 'prewarm').length;
  }
  prewarm() {
    this.calls.push(this.pending ? 'prewarm-while-running' : 'prewarm');
  }
  run(prompt: string): Promise<ClaudeOutcome> {
    this.prompts.push(prompt);
    this.calls.push(`run:${prompt}`);
    if (!this.hold) return Promise.resolve({ kind: 'ok', text: `**Opened** ${prompt}.`, sessionId: 's', costUsd: 0, turns: 1 });
    return new Promise((r) => (this.release = r));
  }
  finish(text = 'ok.') {
    this.release?.({ kind: 'ok', text, sessionId: 's', costUsd: 0, turns: 1 });
    this.release = null;
  }
  cancel() {
    this.cancels++;
    this.calls.push('cancel');
    this.release?.({ kind: 'cancelled' });
    this.release = null;
    return true;
  }
  endConversation() {
    this.conversationEnds++;
  }
  commandEnded() {
    this.commandEnds++;
  }
}


/**
 * Stand-in for Stephen Helper (track A's IHelperClient). `emit` delivers an event like the socket would;
 * `sent` records every command. `query_audio` is answered with `playing` (after `answerDelayMs`), unless
 * `answerQueries` is false.
 */
export class FakeHelper implements HelperLink {
  readonly sent: HelperCommand[] = [];
  playing = false;
  answerQueries = true;
  answerDelayMs = 0;
  closed = false;
  connected = true;
  private readonly connHandlers = new Set<(c: boolean) => void>();
  private readonly handlers = new Map<HelperEventType, Set<(e: never) => void>>();
  constructor(private readonly startResult: HelperStartResult = { ok: true, hello: { type: 'hello', version: '1', inputMonitoring: true } }) {}
  async start(): Promise<HelperStartResult> {
    return this.startResult;
  }
  on<T extends HelperEventType>(event: T, fn: (e: HelperEventOf<T>) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    this.handlers.set(event, set);
    set.add(fn as (e: never) => void);
    return () => set.delete(fn as (e: never) => void);
  }
  send(cmd: HelperCommand): void {
    this.sent.push(cmd);
    if (cmd.type === 'query_audio' && this.answerQueries) {
      const answer = () => this.emit({ type: 'audio', playing: this.playing, at: Date.now() });
      if (this.answerDelayMs > 0) setTimeout(answer, this.answerDelayMs);
      else queueMicrotask(answer);
    }
  }
  close(): void {
    this.closed = true;
  }
  onConnection(fn: (c: boolean) => void): () => void {
    this.connHandlers.add(fn);
    return () => this.connHandlers.delete(fn);
  }
  /** Simulate the socket dropping (or coming back). */
  setConnected(c: boolean): void {
    this.connected = c;
    for (const fn of [...this.connHandlers]) fn(c);
  }
  emit(e: HelperEvent): void {
    for (const fn of [...(this.handlers.get(e.type) ?? [])]) (fn as (x: HelperEvent) => void)(e);
  }
  /** The menu-bar states sent so far, in order. */
  get states(): string[] {
    return this.sent.flatMap((c) => (c.type === 'state' ? [c.state] : []));
  }
}
