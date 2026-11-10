/** Transcript clean-up: what the user said, minus the wake phrase, as plain lower-case words. */

import { HOMOPHONES } from './keywords.js';
import { levenshtein } from '../lib/levenshtein.js';

/** Words speech recognizers commonly hear for each word of a wake phrase (plus HOMOPHONES). */
const SOUNDS_LIKE: Readonly<Record<string, readonly string[]>> = {
  hey: ['hey', 'hay', 'hi', 'he', 'a', 'eh', 'ok', 'okay'],
  yo: ['yo', 'yeah', 'you', 'ya', 'yoh', 'joe', 'hey'],
  ok: ['ok', 'okay', 'okey', 'oh', 'o', 'k', 'hey'],
  okay: ['ok', 'okay', 'okey', 'oh', 'hey'],
  stephen: ['stephen', 'steven', 'stephan', 'stefan', 'stevan', 'stephens', 'stevens'],
};

/**
 * Words that may come before an anchored wake phrase: greetings and hesitations ("um, hey Stephen…"). Anything
 * else before the name means the name was part of a sentence ("Even Stephen agreed…", "play songs by Stephen…").
 */
const LEAD_WORDS = new Set(['hey', 'hay', 'hi', 'yo', 'ok', 'okay', 'oh', 'a', 'eh', 'um', 'uh', 'erm', 'so', 'well']);
/** "Hey Stephen" misheard as "hi steve" (non-native speakers, whisper-tiny): only right at the start. */
const GREETINGS = new Set(['hey', 'hay', 'hi', 'yo', 'ok', 'okay', 'a']);
const NICKNAME = 'steve';

/** Lower-case, digits/letters/apostrophes only, single spaces. "Hey Stephen, open YouTube!" → "hey stephen open youtube". */
export function plainWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether an ASR word plausibly is the wake-phrase word `w`. `strict` (after a bare-"Stephen" wake): only the
 * word itself or a true homophone ("steven"), not sound-alike names ("Stefan and Stella are coming…").
 */
function wordMatches(heard: string, w: string, strict = false): boolean {
  if (heard === w) return true;
  if (strict && w.length >= 4) return (HOMOPHONES[w] ?? []).includes(heard);
  if ((SOUNDS_LIKE[w] ?? []).includes(heard) || (HOMOPHONES[w] ?? []).includes(heard)) return true;
  return w.length >= 5 && levenshtein(heard, w) <= 1;
}

export interface WakeSearch {
  /** Look for the phrase this many words into the transcript (pre-roll speech may come first). Default 6. */
  searchWords?: number;
  /**
   * The phrase must open the transcript (only LEAD_WORDS before it). Used for bare-"Stephen" wakes and for
   * push-to-talk, where there is no pre-roll and earlier words are part of the command.
   */
  anchored?: boolean;
  /** Content words must be the word itself or a homophone (bare-"Stephen" wakes; see wordMatches). */
  strict?: boolean;
}

/**
 * Find the wake phrase among the first words: returns the index just after it, or -1.
 * Optional filler words may be missing; content words (≥ 4 letters, e.g. "stephen") must all be there in order.
 */
export function findWakePhrase(words: readonly string[], wakePhrase: string, search: number | WakeSearch = 6): number {
  return findWakeSpan(words, wakePhrase, typeof search === 'number' ? { searchWords: search } : search)?.end ?? -1;
}

const leadOnly = (words: readonly string[], end: number) => words.slice(0, end).every((w) => LEAD_WORDS.has(w));

function findWakeSpan(words: readonly string[], wakePhrase: string, o: WakeSearch): { start: number; end: number } | null {
  const wake = plainWords(wakePhrase).split(' ');
  // Short filler words ("hey") may be dropped by the recognizer; content words (≥ 4 letters) are required.
  // A phrase made only of short words ("hey max") requires every word.
  const hasContent = wake.some((w) => w.length >= 4);
  const isFiller = (w: string) => hasContent && w.length <= 3;
  const limit = Math.min(words.length, (o.searchWords ?? 6) + wake.length);
  for (let start = 0; start < limit; start++) {
    if (o.anchored && !leadOnly(words, start)) break;
    let i = start;
    let ok = true;
    let matchedContent = false;
    for (const w of wake) {
      if (i < words.length && wordMatches(words[i]!, w, o.strict)) {
        i++;
        if (!isFiller(w)) matchedContent = true;
      } else if (!isFiller(w)) {
        ok = false;
        break;
      }
    }
    if (ok && matchedContent && i > start) return { start, end: i };
  }
  return null;
}

/**
 * The earliest of the wake phrases in `words` (the longest one when several start there), or the misheard
 * "hi steve" / "hey steve" at the very start when a phrase contains "stephen". Returns the index after it, or -1.
 */
export function findAnyWakePhrase(words: readonly string[], wakePhrases: readonly string[], o: WakeSearch = {}): number {
  let best: { start: number; end: number } | null = null;
  for (const p of wakePhrases) {
    const m = findWakeSpan(words, p, o);
    if (m && (!best || m.start < best.start || (m.start === best.start && m.end > best.end))) best = m;
  }
  const hasName = wakePhrases.some((p) => plainWords(p).split(' ').some((w) => (SOUNDS_LIKE.stephen ?? []).includes(w)));
  if (hasName) {
    // "hi steve can you …": greeting + "steve", preceded by nothing but lead words. Never a "steve" later on
    // ("tell steve I'm late" keeps its Steve), and never a bare "steve" (that is someone else's name).
    for (let p = 0; p + 1 < words.length && leadOnly(words, p) && p <= 2; p++) {
      if (GREETINGS.has(words[p]!) && words[p + 1] === NICKNAME) {
        if (!best || p < best.start) best = { start: p, end: p + 2 };
        break;
      }
    }
  }
  return best ? best.end : -1;
}

/**
 * Undo Whisper's repetition loop. On short clips without the wake phrase (push-to-talk "Open YouTube.") whisper-tiny
 * often returns the phrase over and over ("open youtube open youtube open youtube … open"). A run of the same
 * 2+ word phrase (twice or more) or of one word (three times or more) becomes one copy; a dangling start of the
 * phrase at the very end ("… open") is dropped. "very very" and normal sentences are left alone.
 */
export function collapseRepeats(words: readonly string[]): string[] {
  const out: string[] = [];
  const same = (a: number, b: number, k: number) => {
    for (let j = 0; j < k; j++) if (words[a + j] !== words[b + j]) return false;
    return true;
  };
  let i = 0;
  while (i < words.length) {
    let done = false;
    for (let k = 1; k <= Math.floor((words.length - i) / 2) && !done; k++) {
      let r = 1;
      while (i + (r + 1) * k <= words.length && same(i, i + r * k, k)) r++;
      if (r < (k === 1 ? 3 : 2)) continue;
      out.push(...words.slice(i, i + k));
      i += r * k;
      const rest = words.length - i;
      if (rest > 0 && rest < k && same(i, i - k, rest)) i = words.length; // trailing partial copy
      done = true;
    }
    if (!done) out.push(words[i++]!);
  }
  return out;
}

export interface NormalizedTranscript {
  /** The command, e.g. "open youtube" (may be empty). */
  text: string;
  /** Whether the wake phrase was heard in the transcript. */
  hadWake: boolean;
}

/**
 * "Hey Stephen, open YouTube." → { text: "open youtube", hadWake: true }.
 * Any of `wakePhrases` counts. Anything before the wake phrase (pre-roll from earlier speech) is dropped with
 * it, and a repeated wake phrase ("hey stephen hey stephen …") is stripped too. With `anchored`, the phrase must
 * open the transcript; with `strict`, sound-alike names don't count (see WakeSearch).
 */
export function normalizeTranscript(raw: string, wakePhrases: string | readonly string[], o: Omit<WakeSearch, 'searchWords'> = {}): NormalizedTranscript {
  const phrases = typeof wakePhrases === 'string' ? [wakePhrases] : wakePhrases;
  let words = plainWords(raw).split(' ').filter(Boolean);
  let hadWake = false;
  for (let guard = 0; guard < 3; guard++) {
    // A repeated wake phrase must follow right away ("hey stephen hey stephen open…"), never a name later on.
    const end = findAnyWakePhrase(words, phrases, guard === 0 ? { ...o, searchWords: 6 } : { ...o, searchWords: 0, anchored: true });
    if (end < 0) break;
    hadWake = true;
    words = words.slice(end);
  }
  return { text: collapseRepeats(words).join(' '), hadWake };
}

/** Typed commands (`--text`): keep punctuation (URLs!), but one line, trimmed, never option-looking. */
export function cleanTypedCommand(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, 2000);
}
