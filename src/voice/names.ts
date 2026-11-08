/**
 * Names in transcription (P7). The speech models Stephen uses (whisper, moonshine, parakeet through sherpa-onnx)
 * take no hotwords or prompt (docs/VOICE.md), so we correct after the fact: a word that sounds close to a name
 * from the owner's own memory is fixed; one that is only roughly close, or close to two names, is NOT guessed,
 * the listener asks "did you mean ...?" instead. Names only bias spelling here; they never become instructions.
 * Contacts: Stephen has no contacts access, none is added. Canvas course names: not cached anywhere today, and
 * reading them at listen time would need a network call, so they are skipped (buildNameList takes them if a
 * cache is added later).
 */

/** Capitalised words that are not names (sentence starters, titles, days, months, the wake words). */
const NOT_NAMES = new Set(
  'the and but for with remember note my our his her their this that these those when what where who why how dr mr mrs ms mx hey stephen steven yes okay monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december'.split(' '),
);

const FIX_AT = 0.8;
const ASK_AT = 0.7;
const MAX_WINDOW = 3;

/** Names from memory item texts (capitalised words) plus whole course names, deduped, memory first. */
export function buildNameList(memoryTexts: readonly string[], courseNames: readonly string[] = []): string[] {
  const out = new Map<string, string>();
  const add = (n: string) => out.has(n.toLowerCase()) || out.set(n.toLowerCase(), n);
  for (const t of memoryTexts) {
    for (const w of t.match(/\b[A-Z][A-Za-z'-]{2,}\b/g) ?? []) if (!NOT_NAMES.has(w.toLowerCase())) add(w);
  }
  for (const c of courseNames) if (c.trim()) add(c.trim());
  return [...out.values()];
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const similarity = (a: string, b: string) => 1 - distance(a, b) / Math.max(a.length, b.length);

export interface NameCheck {
  text: string;
  /** One group per unsure spot: the names it might be. */
  unsure: string[][];
}

/** Fix near-certain misspellings of listed names; report the doubtful ones instead of guessing. */
export function correctNames(text: string, names: readonly string[]): NameCheck {
  const entries = names.map((n) => ({ name: n, key: n.toLowerCase().replace(/\s+/g, '') }));
  const words = [...text.matchAll(/[A-Za-z0-9'-]+/g)].map((m) => ({ s: m[0], at: m.index! }));
  const unsure: string[][] = [];
  let out = '';
  let pos = 0;
  for (let i = 0; i < words.length; ) {
    let best: { sim: number; len: number; close: string[] } | null = null;
    for (let len = 1; len <= Math.min(MAX_WINDOW, words.length - i); len++) {
      const key = words
        .slice(i, i + len)
        .map((w) => w.s)
        .join('')
        .toLowerCase();
      if (key.length < 4) continue;
      const scored = entries.map((e) => ({ name: e.name, sim: len > 1 && key[0] !== e.key[0] ? 0 : similarity(key, e.key) })).filter((e) => e.sim >= ASK_AT);
      if (!scored.length) continue;
      const sim = Math.max(...scored.map((e) => e.sim));
      if (!best || sim > best.sim) best = { sim, len, close: scored.filter((e) => e.sim >= sim - 0.05).map((e) => e.name) };
    }
    if (!best) {
      i++;
      continue;
    }
    const first = words[i]!;
    const last = words[i + best.len - 1]!;
    const written = text.slice(first.at, last.at + last.s.length);
    if (best.close.length === 1 && best.sim >= FIX_AT) {
      out += text.slice(pos, first.at) + best.close[0];
      pos = first.at + written.length;
    } else if (best.sim < 1) unsure.push(best.close);
    i += best.len;
  }
  return { text: out + text.slice(pos), unsure };
}

/** "Did you mean Maren or Marin?" */
export function didYouMean(unsure: readonly string[][]): string {
  const g = unsure[0] ?? [];
  return `Did you mean ${g.length > 1 ? `${g.slice(0, -1).join(', ')} or ${g[g.length - 1]}` : g[0]}?`;
}
