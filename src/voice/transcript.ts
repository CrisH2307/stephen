/** Transcript clean-up: what the user said, minus the wake phrase, as plain lower-case words. */

import { HOMOPHONES } from './keywords.js';

/** Words speech recognizers commonly hear for each word of a wake phrase (plus HOMOPHONES). */
const SOUNDS_LIKE: Readonly<Record<string, readonly string[]>> = {
  hey: ['hey', 'hay', 'hi', 'he', 'a', 'eh', 'ok', 'okay'],
  stephen: ['stephen', 'steven', 'stephan', 'stefan', 'stevan', 'stephens', 'stevens'],
};

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

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
}

/** Whether an ASR word plausibly is the wake-phrase word `w`. */
function wordMatches(heard: string, w: string): boolean {
  if (heard === w) return true;
  if ((SOUNDS_LIKE[w] ?? []).includes(heard) || (HOMOPHONES[w] ?? []).includes(heard)) return true;
  return w.length >= 5 && levenshtein(heard, w) <= 1;
}

/**
 * Find the wake phrase among the first words: returns the index just after it, or -1.
 * Optional filler words may be missing; content words (≥ 4 letters, e.g. "stephen") must all be there in order.
 */
export function findWakePhrase(words: readonly string[], wakePhrase: string, searchWords = 6): number {
  const wake = plainWords(wakePhrase).split(' ');
  // Short filler words ("hey") may be dropped by the recognizer; content words (≥ 4 letters) are required.
  // A phrase made only of short words ("hey max") requires every word.
  const hasContent = wake.some((w) => w.length >= 4);
  const isFiller = (w: string) => hasContent && w.length <= 3;
  const limit = Math.min(words.length, searchWords + wake.length);
  for (let start = 0; start < limit; start++) {
    let i = start;
    let ok = true;
    let matchedContent = false;
    for (const w of wake) {
      if (i < words.length && wordMatches(words[i]!, w)) {
        i++;
        if (!isFiller(w)) matchedContent = true;
      } else if (!isFiller(w)) {
        ok = false;
        break;
      }
    }
    if (ok && matchedContent && i > start) return i;
  }
  return -1;
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
 * Anything before the wake phrase (pre-roll from earlier speech) is dropped with it, and a repeated wake phrase
 * ("hey stephen hey stephen …") is stripped too.
 */
export function normalizeTranscript(raw: string, wakePhrase: string): NormalizedTranscript {
  let words = plainWords(raw).split(' ').filter(Boolean);
  let hadWake = false;
  for (let guard = 0; guard < 3; guard++) {
    const end = findWakePhrase(words, wakePhrase, guard === 0 ? 6 : 0);
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
