/**
 * Names in transcription (P7). The speech models Stephen uses (whisper, moonshine, parakeet through sherpa-onnx)
 * take no hotwords or prompt (docs/VOICE.md), so we correct after the fact: a word that is not an ordinary English
 * word and is one edit away from exactly one name in the owner's own memory is fixed. Anything unsure is left as
 * heard: a command is never blocked or questioned over a name. Names only bias spelling here; they never become
 * instructions. Contacts: Stephen has no contacts access, none is added. Canvas course names: not cached anywhere
 * today (buildNameList takes them if a cache is added later).
 */

import { levenshtein } from '../lib/levenshtein.js';

/** Capitalised words that are not names (sentence starters, titles, days, months, the wake words). */
const NOT_NAMES = new Set(
  'the and but for with remember note my our his her their this that these those when what where who why how dr mr mrs ms mx hey stephen steven yes okay monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december'.split(' '),
);

/** Ordinary words a command may hold; never rewritten into a name. ponytail: short list, extend when a real word gets rewritten. */
const COMMON = new Set(
  `about above across after again alarm album all also always amazon android answer any app apple apps around ask audio back bank before behind below best better between bluetooth book bookmark bookmarks both brightness browser button call calendar camera can check chrome class classes clear click close cloud code coffee come copy course create date delete desktop dinner display document download down draft email emails enter event every file files find finder first follow folder food forget friend from game gmail good google great group have help here home hour inbox into item items just keep keys know last later less like line link list listen little local lock look made make mail map mark maybe media meet meeting memory menu message messages minute minutes mode month more most move movie music name need never news next night note notes nothing notion number only open other page pages paste pause people phone photo photos pick place play playlist please podcast post press print quick quiz read ready reminder remind reply restart right save scroll search select send settings share show shut sleep small some song songs sound space speak spotify start still stop store study summarize summary switch take tell text thanks thing think this time timer title today tomorrow tonight turn type under until update upload volume wait wake watch water week weather what when where which while window with word work write yesterday youtube zoom`.split(/\s+/),
);

/** Names from memory item texts (capitalised words, not the first word of an item) plus whole course names. */
export function buildNameList(memoryTexts: readonly string[], courseNames: readonly string[] = []): string[] {
  const out = new Map<string, string>();
  const add = (n: string) => out.has(n.toLowerCase()) || out.set(n.toLowerCase(), n);
  for (const t of memoryTexts) {
    // The first word is capitalised by grammar, not because it is a name ("Call mom", "Sundays I run").
    for (const w of t.replace(/^\s*\S+/, '').match(/\b[A-Z][A-Za-z'-]{2,}\b/g) ?? []) if (!NOT_NAMES.has(w.toLowerCase().replace(/s$/, ''))) add(w);
  }
  for (const c of courseNames) if (c.trim()) add(c.trim());
  return [...out.values()];
}

const MAX_WINDOW = 3;

/** Fix a word that is one edit from exactly one name of 5+ letters; ordinary English words and unsure matches stay as heard. */
export function correctNames(text: string, names: readonly string[]): string {
  const entries = names.map((n) => ({ name: n, key: n.toLowerCase().replace(/\s+/g, '') })).filter((e) => e.key.length >= 5);
  const words = [...text.matchAll(/[A-Za-z0-9'-]+/g)].map((m) => ({ s: m[0], at: m.index! }));
  let out = '';
  let pos = 0;
  for (let i = 0; i < words.length; ) {
    let hit: { len: number; name: string } | null = null;
    for (let len = Math.min(MAX_WINDOW, words.length - i); len >= 1 && !hit; len--) {
      const key = words
        .slice(i, i + len)
        .map((w) => w.s)
        .join('')
        .toLowerCase();
      if (key.length < 5 || (len === 1 && COMMON.has(key))) continue;
      const close = entries.filter((e) => key[0] === e.key[0] && levenshtein(key, e.key, 1) <= 1);
      if (close.length === 1) hit = { len, name: close[0]!.name };
    }
    if (!hit) {
      i++;
      continue;
    }
    const first = words[i]!;
    const last = words[i + hit.len - 1]!;
    out += text.slice(pos, first.at) + hit.name;
    pos = last.at + last.s.length;
    i += hit.len;
  }
  return out + text.slice(pos);
}
