/**
 * Memory commands, recognized by fixed patterns BEFORE anything reaches Claude
 * (docs/PLAN-1.9-MEMORY-DASHBOARD.md sections 4 and 12.3).
 *
 * Only whole utterances that START with the command words count ("remember …", "forget …", "what do you
 * remember"), so "play remember me", "do you remember the song …", "remind me to …" and "forget it" go to Claude
 * as normal commands. The input is the user's own words (the listener's normalized transcript, or typed text);
 * Claude's replies and page text are never parsed here.
 *
 * "Remember X and play Y" is split (owner answer 12.3): the remember text is cut at the first " and ", " and then ",
 * " and also " or " then " that is followed by a command verb from COMMAND_VERBS; X is saved and "play Y" goes to
 * Claude. "remember i play guitar" has no joiner, so it is saved whole.
 */

export type MemoryIntent =
  | { kind: 'remember'; text: string; rest?: string }
  | { kind: 'forget'; query: string }
  | { kind: 'forget-last' }
  | { kind: 'forget-all' }
  | { kind: 'list' }
  /** "remember 4417" / "remember hunter2": a one-word body with a digit looks like a code; refused locally (R5-4). */
  | { kind: 'remember-code' };

/** Verbs that start a command after a joiner in a remember line (12.3; fixed on purpose, no guessing). */
export const COMMAND_VERBS: readonly string[] = [
  'play', 'open', 'put', 'turn', 'set', 'pause', 'skip', 'start', 'launch', 'show', 'find', 'check', 'go', 'search', 'mute',
];

/** "forget that" removes the newest item only if it was saved this recently. */
export const FORGET_LAST_WINDOW_MS = 10 * 60_000;

/** Lower-case, letters/digits/apostrophes only, single spaces (same rule as the listener's plainWords). */
export function memoryWords(text: string): string {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const LIST_RE =
  /^(?:please )?(?:what do you remember(?: about me)?|what do you know about me|what have you remembered|(?:list|show)(?: me)? (?:my|your|all|all my|all your) memories|what are my memories)$/;
const FORGET_ALL_RE =
  /^(?:please )?(?:forget everything(?: you know about me| about me)?|forget all (?:of )?(?:my |your |the )?memories|(?:clear|delete|erase) (?:all )?(?:of )?(?:my |your |the )?memories)$/;
const FORGET_LAST_RE = /^(?:please )?forget (?:that|the last one|the last thing|what i just said)$/;
const FORGET_RE = /^(?:please )?(?:forget|stop remembering|(?:delete|remove) (?:the|my) memory (?:about|of)) (?:about |that )?(.+)$/;
/** Speech to text can leave a wake phrase or "hey" on the front ("hey steven remember ..."); drop it first. */
const LEAD_RE = /^(?:(?:hey|yo|ok|okay) )?(?:(?:stephen|steven) )?(?:please )?/;
/** The natural ways to ask for a save. Group 1 = "that" (explicit), group 2 = the fact. */
const REMEMBER_RES: readonly RegExp[] = [
  /^(?:also )?remember (?:(?:me )?(that) )?(.+)$/,
  /^(?:(?:can|could|would|will) you (?:please )?|(?:i want|i need|i would like|i'd like) you to )remember (?:(?:me )?(that) )?(.+)$/,
  /^(?:don't|dont|do not) forget (?:(that) )?(.+)$/,
  /^(?:make a note|take note|note|keep in mind) (?:(that) )?(.+)$/,
];
/** Openers without the word "remember" (the last two): not accepted from the wake word (R10b-4). */
const NO_REMEMBER_FROM = 2;
/** "can you remember ..." forms: on the voice path they save only with "that" (R10b-1, second layer). */
const POLITE_ASK_RE = /^(?:can|could|would|will) you\b/;
/** Forms that could also be a question or a to-do ("can you remember the song ...") save only with "that" or a first-person fact. */
const NEEDS_FACT_RE = /^(?:(?:can|could|would|will) you|i want|i need|i would like|i'd like|don't|dont|do not|keep in mind|note|make a note|take note)\b/;
const PERSONAL_RE = /^(?:my|i|i'm|i've|i'll|we|our)\b/;
/**
 * A personal word alone ("my keys") is not a fact (R10b-3): it needs a verb after it.
 * ponytail: small fixed word list, so a rare verb is missed (it then needs "that"); extend the list if it bites.
 */
const FACT_VERBS = new Set(
  ('is are was were am be been has have had do does did like likes love loves hate hates need needs want wants live lives ' +
    'work works eat eats prefer prefers meet meets play plays study studies drive drives take takes use uses own owns ' +
    'speak speaks go goes get gets sleep sleeps wake wakes call called named').split(' '),
);
function hasFactVerb(body: string): boolean {
  const w = body.split(' ');
  return /^(?:i'm|i've|i'll)$/.test(w[0]!) || w.slice(1).some((x) => FACT_VERBS.has(x) || /'(?:m|ve|ll|re|d)$/.test(x));
}

/**
 * By voice every saved line needs a fact shape (#137): a verb, not just a thing. "remember the milk", "remember my
 * keys" and "can you remember that song from titanic" are to-dos or questions, so they save nothing; "remember my
 * gym is goodlife" and "remember that i moved to toronto" still save. Voice only, and only ever an extra refusal.
 * ponytail: a fixed verb list plus two simple patterns (a pronoun with 'm 're 's and so on, "i moved"); a fact with a
 * rare verb then needs "is" or similar, and typed text is the fallback (F5 users can type in the Ask box).
 */
const VOICE_FACT_VERBS = new Set([
  ...FACT_VERBS,
  ...('isn\'t aren\'t wasn\'t don\'t doesn\'t didn\'t can can\'t will won\'t should must ' +
    'leave leaves left start starts started end ends ended turn turns turned open opens close closes cost costs ' +
    'born moved lived worked went came come comes made makes said says know knows think thinks belong belongs ' +
    'keep keeps parked park parks stay stays stayed got sold grew quit lands renews changed').split(' '),
]);
const SUBJECT_WORDS = new Set(['i', 'we', 'you', 'they', 'he', 'she', 'it']);
function voiceFactShape(body: string): boolean {
  // A to-do ("i need to pay the rent") or a shared memory ("that time we went to the lake") is not a fact.
  if (/\b(?:need|needs|have|has|got) to\b/.test(body)) return false;
  if (/^(?:the )?(?:last |one |first |good old )?(?:time|times|night|day|days|summer)\b/.test(body)) return false;
  const w = body.split(' ');
  // "i teach grade five", "we live downtown": a first-person statement.
  if ((w[0] === 'i' || w[0] === 'we') && w.length >= 2) return true;
  if (/^(?:i|we|you|they|he|she|it|there|that)'(?:m|re|ve|ll|d|s)$/.test(w[0]!)) return true;
  return w.slice(1).some(
    (x, i) =>
      VOICE_FACT_VERBS.has(x) ||
      /^(?:i|we|you|they|he|she|it|there|that)'(?:m|re|ve|ll|d|s)$/.test(x) ||
      (SUBJECT_WORDS.has(w[i]!) && /^[a-z]{2,}ed$/.test(x)),
  );
}

/** "forget it" and friends are everyday speech, not a memory command. */
const FORGET_NOT_A_QUERY = new Set(['it', 'about it', 'this', 'them', 'him', 'her', 'everything else', 'that one', 'all that', 'it all']);
const TRAILING_POLITE_RE = /(?: (?:please|thanks|thank you|for me))+$/;

/** Split a remember text at the first joiner followed by a command verb: [saved, command] or null. */
export function splitRememberTail(words: string): { text: string; rest: string } | null {
  const w = words.split(' ');
  for (let i = 1; i < w.length - 1; i++) {
    let verbAt = -1;
    if (w[i] === 'and' && (w[i + 1] === 'then' || w[i + 1] === 'also')) verbAt = i + 2;
    else if (w[i] === 'and' || w[i] === 'then') verbAt = i + 1;
    if (verbAt < 0 || verbAt >= w.length) continue;
    if (!COMMAND_VERBS.includes(w[verbAt]!)) continue;
    return { text: w.slice(0, i).join(' '), rest: w.slice(verbAt).join(' ') };
  }
  return null;
}

/**
 * Recognize a memory command in what the user said or typed. null = not a memory command (send it to Claude).
 * `text`, `rest` and `query` are normalized words; use rawTail(raw, words) to recover the original case.
 */
export function parseMemoryIntent(command: string, opts: ParseOpts = {}): MemoryIntent | null {
  return parseDetailed(command, opts)?.intent ?? null;
}

/** `raw` = the transcript with its punctuation (voice); `source` = where it came from (the wake word is the least trusted). */
export interface ParseOpts {
  raw?: string;
  source?: string;
}

/** Like parseMemoryIntent, plus the opener the person said ("remember that", "don't forget") for a remember intent. */
export function parseDetailed(command: string, opts: ParseOpts = {}): { intent: MemoryIntent; opener?: string } | null {
  const voice = opts.source === 'voice-wake' || opts.source === 'voice-ptt';
  const s = memoryWords(command).replace(LEAD_RE, '');
  if (!s) return null;
  if (LIST_RE.test(s)) return { intent: { kind: 'list' } };
  if (FORGET_ALL_RE.test(s)) return { intent: { kind: 'forget-all' } };
  if (FORGET_LAST_RE.test(s)) return { intent: { kind: 'forget-last' } };
  let m = FORGET_RE.exec(s);
  if (m) {
    const query = m[1]!.replace(TRAILING_POLITE_RE, '').trim();
    if (!query || FORGET_NOT_A_QUERY.has(query) || query.startsWith('to ') || query.startsWith('about it ')) return null;
    return { intent: { kind: 'forget', query } };
  }
  // A question mark means a question ("remember my gym?"): when in doubt, do not save.
  // Speech to text drops the "?" from the normalized words, so check the raw transcript too (R10b-1).
  const QUESTION_RE = /\?["')\s]*$/;
  if (QUESTION_RE.test(command) || (opts.raw !== undefined && QUESTION_RE.test(opts.raw))) return null;
  // By voice a "?" anywhere ("remember that? that was crazy", a curly quote after it, a full-width one) is a question too.
  if (voice && opts.raw !== undefined && /[?？¿]/.test(opts.raw)) return null;
  let body: string | null = null;
  let opener = '';
  for (const [i, re] of REMEMBER_RES.entries()) {
    if (i >= NO_REMEMBER_FROM && opts.source === 'voice-wake') break;
    const hit = re.exec(s);
    if (!hit) continue;
    // Second layer for speech without a "?": "can you remember my sister's name" never saves, "... that ..." may.
    if (voice && !hit[1] && POLITE_ASK_RE.test(s)) continue;
    if (hit[1] || !NEEDS_FACT_RE.test(s) || (PERSONAL_RE.test(hit[2]!) && hasFactVerb(hit[2]!))) {
      body = hit[2]!;
      opener = s.slice(0, s.length - body.length).trim();
      break;
    }
  }
  if (body !== null) {
    // "remember to call mom" is a reminder, not a fact; "remember when …" is a question.
    if (/^(?:to|when|what|where|who|how|why|if|me)\b/.test(body)) return null;
    const split = splitRememberTail(body);
    const rest = split?.rest;
    if (split) body = split.text;
    body = body.replace(TRAILING_POLITE_RE, '').trim();
    // One word ("remember that one", "remember goodlife") is too little to be a fact worth saving.
    // But a single word with a digit looks like a code: refuse it here instead of sending it to Claude (review 5, R5-4).
    if (body.split(' ').length < 2) return /\d/.test(body) ? { intent: { kind: 'remember-code' } } : null;
    if (voice && !voiceFactShape(body)) return null;
    return { intent: rest ? { kind: 'remember', text: body, rest } : { kind: 'remember', text: body }, opener };
  }
  return null;
}

/**
 * The original-case words of `raw` that normalize to `words` (the last such run), so a saved memory keeps
 * "Dr. Patel" and a split command keeps "https://example.com". Trailing sentence punctuation is dropped.
 * Falls back to `words` when the run can't be found exactly.
 */
export function rawTail(raw: string, words: string): string {
  const want = memoryWords(words).split(' ').filter(Boolean);
  if (!want.length) return '';
  const tokens = String(raw).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const norm = tokens.map((t) => memoryWords(t).split(' ').filter(Boolean));
  for (let start = tokens.length - 1; start >= 0; start--) {
    if (!norm[start]!.length || norm[start]![0] !== want[0]) continue;
    let k = 0;
    let end = start;
    let ok = true;
    for (; end < tokens.length && k < want.length; end++) {
      for (const w of norm[end]!) {
        if (k >= want.length || w !== want[k]) {
          ok = false;
          break;
        }
        k++;
      }
      if (!ok) break;
    }
    if (ok && k === want.length) {
      return tokens
        .slice(start, end)
        .join(' ')
        .replace(/[.,!?;:…"'”’)\]]+$/u, '')
        .replace(/^["'“‘(\[]+/u, '');
    }
  }
  return want.join(' ');
}

/** Words ignored when matching "forget <query>" against saved items. */
const STOPWORDS = new Set(
  (
    'a an the my your our his her their its i me you we he she they it is are was were be been am to of for in on at by ' +
    'with about from and or but that this these those what which who whom thing things stuff something memory memories ' +
    'one remember forget do does did have has had just please all any some'
  ).split(' '),
);

export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of memoryWords(text).split(' ')) {
    if (!w || STOPWORDS.has(w)) continue;
    out.add(w.replace(/'s$/, '').replace(/^(.{3,}?)s$/, '$1'));
  }
  return out;
}

export type ForgetMatch<T> = { match: T } | { tie: T[] } | { none: true };

/** The item "forget <query>" means: the one sharing the most content words; a tie or no overlap is reported. */
export function matchForget<T extends { text: string }>(items: readonly T[], query: string): ForgetMatch<T> {
  const q = contentWords(query);
  if (!q.size) return { none: true };
  let best = 0;
  let top: T[] = [];
  for (const it of items) {
    const words = contentWords(it.text);
    let n = 0;
    for (const w of q) if (words.has(w)) n++;
    if (n === 0) continue;
    if (n > best) {
      best = n;
      top = [it];
    } else if (n === best) top.push(it);
  }
  if (!top.length) return { none: true };
  return top.length === 1 ? { match: top[0]! } : { tie: top };
}

/** The newest item if it was created within `windowMs` of `now` ("forget that"), else null. Same millisecond: the higher id (saved later; ids are m1, m2, ...). */
export function newestWithin<T extends { id: string; createdAt: string }>(items: readonly T[], now: Date, windowMs = FORGET_LAST_WINDOW_MS): T | null {
  let newest: T | null = null;
  const at = (x: T) => Date.parse(x.createdAt);
  const num = (x: T) => Number(x.id.slice(1));
  for (const it of items) if (!newest || at(it) > at(newest) || (at(it) === at(newest) && num(it) > num(newest))) newest = it;
  if (!newest) return null;
  const age = now.getTime() - Date.parse(newest.createdAt);
  return age >= 0 && age <= windowMs ? newest : null;
}
