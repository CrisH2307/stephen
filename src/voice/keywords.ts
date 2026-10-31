/**
 * Keyword-file generation for the sherpa-onnx open-vocabulary keyword spotter.
 *
 * The KWS model (zipformer, GigaSpeech, BPE-500) needs each phrase written in its own BPE units, e.g.
 * "HEY STEPHEN" → "▁HE Y ▁ST E PH EN". sherpa-onnx does this with `sherpa-onnx-cli text2token`
 * (Python sentencepiece). We do it in TypeScript instead, by reading the model's own `bpe.model`
 * (a sentencepiece ModelProto) and running sentencepiece's BPE merge algorithm — so custom
 * `voice.wakePhrases` work at runtime with no Python. test/voice/keywords.test.ts checks the output
 * against Python sentencepiece on ~340 phrases. (Despite the file name, icefall's "bpe.model" is a
 * sentencepiece *unigram* model; both model types are supported.)
 */

// ───────────────────────────── sentencepiece model (protobuf) ─────────────────────────────

/** sentencepiece ModelProto.SentencePiece.Type */
const PieceType = { NORMAL: 1, UNKNOWN: 2, CONTROL: 3, USER_DEFINED: 4, UNUSED: 5, BYTE: 6 } as const;

export interface SentencePiece {
  piece: string;
  score: number;
  type: number;
}

/** sentencepiece TrainerSpec.ModelType */
export type SentencePieceModelType = 'unigram' | 'bpe';

export interface SentencePieceModel {
  type: SentencePieceModelType;
  pieces: SentencePiece[];
}

class ProtoReader {
  pos = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly end: number = buf.length,
    start = 0,
  ) {
    this.pos = start;
  }
  done(): boolean {
    return this.pos >= this.end;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error('truncated varint');
      const b = this.buf[this.pos++]!;
      if (shift < 49) result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error('bad varint');
    }
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint(); // (not `this.pos += this.varint()`: that reads pos before the varint advances it)
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (this.pos > this.end) throw new Error('truncated field');
  }
}

/** Read the pieces (ModelProto field 1) and model type (trainer_spec.model_type) from a sentencepiece `.model` file. */
export function readSentencePieceModel(buf: Uint8Array): SentencePieceModel {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new ProtoReader(buf);
  const pieces: SentencePiece[] = [];
  let modelType = 1; // UNIGRAM (the proto default)
  const dec = new TextDecoder('utf-8', { fatal: true });
  while (!r.done()) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const len = r.varint();
      const end = r.pos + len;
      if (end > buf.length) throw new Error('truncated piece');
      const pr = new ProtoReader(buf, end, r.pos);
      const sp: SentencePiece = { piece: '', score: 0, type: PieceType.NORMAL as number };
      while (!pr.done()) {
        const k = pr.varint();
        const f = Math.floor(k / 8);
        const w = k & 7;
        if (f === 1 && w === 2) {
          const l = pr.varint();
          sp.piece = dec.decode(buf.subarray(pr.pos, pr.pos + l));
          pr.pos += l;
        } else if (f === 2 && w === 5) {
          sp.score = dv.getFloat32(pr.pos, true);
          pr.pos += 4;
        } else if (f === 3 && w === 0) {
          sp.type = pr.varint();
        } else pr.skip(w);
      }
      pieces.push(sp);
      r.pos = end;
    } else if (field === 2 && wire === 2) {
      // trainer_spec: we only need model_type (field 3)
      const len = r.varint();
      const end = r.pos + len;
      const tr = new ProtoReader(buf, Math.min(end, buf.length), r.pos);
      while (!tr.done()) {
        const k = tr.varint();
        if (Math.floor(k / 8) === 3 && (k & 7) === 0) modelType = tr.varint();
        else tr.skip(k & 7);
      }
      r.pos = end;
    } else r.skip(wire);
  }
  if (pieces.length === 0) throw new Error('no pieces in sentencepiece model');
  if (modelType !== 1 && modelType !== 2) throw new Error(`unsupported sentencepiece model type ${modelType} (need unigram or bpe)`);
  return { type: modelType === 2 ? 'bpe' : 'unigram', pieces };
}

/** Tokenizer for text that is already normalized (upper-case words separated by single spaces). */
export interface PieceEncoder {
  encode(text: string): string[];
}

export function createEncoder(model: SentencePieceModel): PieceEncoder {
  return model.type === 'bpe' ? new BpeEncoder(model.pieces) : new UnigramEncoder(model.pieces);
}

const toSymbols = (text: string) => SPACE + text.trim().split(/\s+/).join(SPACE);

/**
 * sentencepiece unigram encoder (port of unigram_model.cc `Model::EncodeOptimized`): Viterbi over the
 * pieces' log-probability scores; ties keep the first candidate found (earliest start, shortest piece).
 */
export class UnigramEncoder implements PieceEncoder {
  private readonly pieces = new Map<string, number>();
  private readonly maxLen: number;
  private readonly unkScore: number;
  constructor(model: readonly SentencePiece[]) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of model) {
      if (p.type === PieceType.NORMAL) {
        min = Math.min(min, p.score);
        max = Math.max(max, p.score);
      }
    }
    let maxLen = 1;
    for (const p of model) {
      if (this.pieces.has(p.piece)) continue;
      const len = Array.from(p.piece).length;
      if (p.type === PieceType.NORMAL) this.pieces.set(p.piece, p.score);
      else if (p.type === PieceType.USER_DEFINED) this.pieces.set(p.piece, len * max - 0.1);
      else continue;
      maxLen = Math.max(maxLen, len);
    }
    this.maxLen = maxLen;
    this.unkScore = min - 10; // kUnkPenalty
  }
  encode(text: string): string[] {
    const chars = Array.from(toSymbols(text));
    const n = chars.length;
    const best: { score: number; start: number }[] = Array.from({ length: n + 1 }, () => ({ score: 0, start: -1 }));
    best[0]!.start = 0;
    for (let i = 0; i < n; i++) {
      if (best[i]!.start < 0 && i > 0) continue;
      const base = best[i]!.score;
      let singleChar = false;
      let piece = '';
      for (let len = 1; len <= this.maxLen && i + len <= n; len++) {
        piece += chars[i + len - 1];
        const sc = this.pieces.get(piece);
        if (sc === undefined) continue;
        if (len === 1) singleChar = true;
        const node = best[i + len]!;
        const cand = base + sc;
        if (node.start === -1 || cand > node.score) {
          node.score = cand;
          node.start = i;
        }
      }
      if (!singleChar) {
        const node = best[i + 1]!;
        const cand = base + this.unkScore;
        if (node.start === -1 || cand > node.score) {
          node.score = cand;
          node.start = i;
        }
      }
    }
    const out: string[] = [];
    for (let end = n; end > 0; ) {
      const start = best[end]!.start;
      out.push(chars.slice(start, end).join(''));
      end = start;
    }
    return out.reverse();
  }
}

const SPACE = '▁'; // ▁

/**
 * sentencepiece BPE encoder (port of bpe_model.cc `Model::SampleEncode` without sampling):
 * start from characters, repeatedly merge the adjacent pair whose concatenation is a vocabulary piece with
 * the highest score (ties → leftmost), then re-split any UNUSED piece via the recorded merges.
 */
export class BpeEncoder implements PieceEncoder {
  private readonly pieces = new Map<string, { score: number; unused: boolean }>();
  constructor(model: readonly SentencePiece[]) {
    for (const p of model) {
      if (p.type === PieceType.NORMAL || p.type === PieceType.USER_DEFINED || p.type === PieceType.UNUSED) {
        if (!this.pieces.has(p.piece)) this.pieces.set(p.piece, { score: p.score, unused: p.type === PieceType.UNUSED });
      }
    }
  }

  /** Encode already-normalized text (words separated by single spaces). */
  encode(text: string): string[] {
    const sym = Array.from(toSymbols(text)).map((piece, i, arr) => ({ piece, prev: i - 1, next: i + 1 < arr.length ? i + 1 : -1 }));
    type Pair = { left: number; right: number; score: number; size: number };
    const agenda: Pair[] = [];
    const revMerge = new Map<string, [string, string]>();
    const better = (a: Pair, b: Pair) => a.score > b.score || (a.score === b.score && a.left < b.left);
    const push = (p: Pair) => {
      agenda.push(p);
      let i = agenda.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!better(agenda[i]!, agenda[parent]!)) break;
        [agenda[i], agenda[parent]] = [agenda[parent]!, agenda[i]!];
        i = parent;
      }
    };
    const pop = (): Pair => {
      const top = agenda[0]!;
      const last = agenda.pop()!;
      if (agenda.length) {
        agenda[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < agenda.length && better(agenda[l]!, agenda[m]!)) m = l;
          if (r < agenda.length && better(agenda[r]!, agenda[m]!)) m = r;
          if (m === i) break;
          [agenda[i], agenda[m]] = [agenda[m]!, agenda[i]!];
          i = m;
        }
      }
      return top;
    };
    const maybeAdd = (left: number, right: number) => {
      if (left < 0 || right < 0) return;
      const a = sym[left]!.piece;
      const b = sym[right]!.piece;
      const merged = a + b;
      const info = this.pieces.get(merged);
      if (!info) return;
      push({ left, right, score: info.score, size: merged.length });
      if (info.unused) revMerge.set(merged, [a, b]);
    };
    for (let i = 1; i < sym.length; i++) maybeAdd(i - 1, i);
    while (agenda.length) {
      const top = pop();
      const l = sym[top.left]!;
      const r = sym[top.right]!;
      if (!l.piece || !r.piece || l.piece.length + r.piece.length !== top.size) continue;
      l.piece += r.piece;
      l.next = r.next;
      if (r.next >= 0) sym[r.next]!.prev = top.left;
      r.piece = '';
      maybeAdd(l.prev, top.left);
      maybeAdd(top.left, l.next);
    }
    const out: string[] = [];
    const resegment = (w: string) => {
      const info = this.pieces.get(w);
      if (info && !info.unused) return void out.push(w);
      const split = revMerge.get(w);
      if (!split) return void out.push(w); // unknown — caller validates against the token list
      resegment(split[0]);
      resegment(split[1]);
    };
    for (let i = 0; i >= 0 && i < sym.length; i = sym[i]!.next) if (sym[i]!.piece) resegment(sym[i]!.piece);
    return out;
  }
}

// ───────────────────────────── keywords file ─────────────────────────────

/**
 * Same-sounding spellings, so the spotter accepts whichever one its BPE decoder prefers. On our test audio the
 * model emitted "STEVEN" for some voices — "Stephen" and "Steven" are pronounced identically.
 */
export const HOMOPHONES: Readonly<Record<string, readonly string[]>> = {
  stephen: ['steven'],
  steven: ['stephen'],
  // Different BPE units ("▁O K" vs "▁OKAY"), same word.
  ok: ['okay'],
  okay: ['ok'],
};

/** All spellings of a phrase (homophones substituted), the original first, at most `max`. */
export function phraseVariants(phrase: string, max = 4): string[] {
  let acc: string[][] = [[]];
  for (const w of phrase.toLowerCase().trim().split(/\s+/)) {
    const options = [w, ...(HOMOPHONES[w] ?? [])];
    acc = acc.flatMap((prefix) => options.map((o) => [...prefix, o]));
  }
  return acc.map((ws) => ws.join(' ')).slice(0, max);
}

export interface KeywordSpec {
  /** Returned as the spotter's `keyword` (sherpa's `@` field). WAKE_BARE = a one-word wake phrase ("stephen"). */
  id: 'WAKE' | 'WAKE_BARE' | 'STOP';
  phrase: string;
  threshold: number;
  score: number;
}

/**
 * Build the keywords file text: one line per spelling, `<bpe tokens> :<boost> #<threshold> @<ID>`.
 * Throws if a token is not in the model's tokens.txt (the phrase can't be spotted).
 */
export function buildKeywordsFile(specs: readonly KeywordSpec[], encoder: PieceEncoder, tokens: ReadonlySet<string>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    for (const v of phraseVariants(s.phrase)) {
      const toks = encoder.encode(v.toUpperCase());
      const missing = toks.filter((t) => !tokens.has(t));
      if (missing.length) {
        throw new Error(`"${v}" can't be used as a keyword: the wake-word model has no unit for ${missing.map((m) => `"${m}"`).join(', ')}`);
      }
      const key = toks.join(' ');
      if (seen.has(key)) continue; // "ok stephen" + "okay stephen" give the same spellings: the first one wins
      seen.add(key);
      lines.push(`${key} :${s.score} #${s.threshold} @${s.id}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Parse a sherpa-onnx tokens.txt (`<token> <id>` per line). */
export function parseTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/)[0];
    if (t) out.add(t);
  }
  return out;
}
