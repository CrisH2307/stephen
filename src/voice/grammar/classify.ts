/**
 * Command-grammar classifier, SHADOW MODE (docs/research/PRODUCT-PLAN-2026-11.md 2.5 and 7.0 E6, PLAN-REVIEW 3.5).
 *
 * Pure and deterministic: no I/O, no clock, no model, no network. It only LABELS a request Tier 1 (would not need
 * the model) or Tier 2 (model); it never acts. The label goes on latency rows. One real use: after a wake word
 * while sound plays, src/voice/media-command.ts lets through only a Tier 1 media verb, run without the model
 * (issue #205). This label never routes a command; the memory, timer and job routers in src/voice/assistant.ts
 * answer their own commands without the model, before the classifier label matters.
 *
 * Trust rule: OwnerLists hold owner-controlled names ONLY (installed app names, owner-written site aliases).
 * NEVER put tab titles, page text, playlists read from a page, or memory text in them: a page could name itself
 * to win a match, and with no model turn there is no second reader.
 *
 * A request is Tier 1 only when the WHOLE normalized transcript parses: a known verb plus, where the verb needs
 * one, an entity that matches EXACTLY ONE list entry. Anything else (ambiguous, leftover words, second clause,
 * question, near-miss) is Tier 2. Doubt always goes to Tier 2. A fuzzy (edit-distance) hit never makes Tier 1.
 *
 * Telemetry: record only `tier` and `reason` (code words). `arg`, `entity`, `normalized` and `hint` can carry
 * what the owner said or named and must stay out of telemetry.
 */
import { levenshtein } from '../../lib/levenshtein.js';
import { plainWords } from '../transcript.js';
import { splitRememberTail } from '../../memory/intent.js';

export type Verb = 'open' | 'play' | 'pause' | 'resume' | 'next' | 'previous' | 'volume' | 'mute' | 'unmute' | 'timer' | 'stop' | 'remember' | 'forget';

/** Fixed code words; never transcript text. */
export type Reason =
  | 'empty' | 'question' | 'compound' | 'no_verb' | 'leftover_words' | 'ambiguous_entity' | 'unknown_entity'
  | 'fuzzy_only' | 'bad_arg' | 'empty_payload' | 'code_like' | 'vague_query';

export interface OwnerLists {
  /** Installed app display names. */
  apps: readonly string[];
  /** Owner-written aliases: name to URL. */
  sites: Readonly<Record<string, string>>;
  /** Key of `sites` that "play <query>" uses when no site is named. */
  defaultMedia?: string;
}

export interface Entity { kind: 'app' | 'site'; name: string }

export type Classification =
  | { tier: 1; verb: Verb; entity?: Entity; arg?: string | number; normalized: string }
  | { tier: 2; reason: Reason; hint?: string };

const no = (reason: Reason, hint?: string): Classification => (hint === undefined ? { tier: 2, reason } : { tier: 2, reason, hint });

/** Exact rewrites of misheard entity names, applied to the entity text only (never to a play query). */
const VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['you tube', 'youtube'],
  ['u tube', 'youtube'],
  ['youtube musics', 'youtube music'],
  ['g mail', 'gmail'],
];
const applyVariants = (s: string): string => VARIANTS.reduce((t, [a, b]) => ` ${t} `.split(` ${a} `).join(` ${b} `).trim(), s);

const POLITE = /^(?:please|can you|could you)(?: |$)/;
const QUESTION_WORDS = new Set([
  'what', "what's", 'whats', 'how', 'who', 'when', 'where', 'why', 'which', 'is', 'are', 'am', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'should', 'has', 'have',
]);
// ponytail: any of these words anywhere means "compound", so a title like "black and white" goes to Tier 2.
const JOINERS = new Set(['and', 'then', 'also', 'plus', 'after', 'while', 'but']);
// ponytail: a second command inside a play query only caught for these verbs; "play lofi stop" is not caught.
const SECOND_VERBS = new Set(['open', 'pause', 'resume', 'mute', 'unmute', 'volume', 'timer', 'remember', 'forget', 'launch', 'play']);
// ponytail: a first-word deny list for vague play queries; titles starting with these ("the scientist") go to Tier 2.
const VAGUE_FIRST = new Set(['something', 'anything', 'some', 'my', 'the', 'a', 'an', 'any', 'new', 'latest', 'music', 'songs', 'song']);
/** "forget it" is everyday speech (same set the memory router ignores). */
const FORGET_NOT_A_QUERY = new Set(['it', 'about it', 'this', 'them', 'him', 'her', 'everything else', 'that one', 'all that', 'it all']);

const UNIT_SECONDS: Record<string, number> = { second: 1, minute: 60, hour: 3600 };
const num = (s: string | undefined, max: number): number | null => (s !== undefined && +s >= 1 && +s <= max ? +s : null);

type ArgFn = (m: RegExpExecArray) => string | number | null | undefined;
/** Whole-phrase patterns for verbs with no entity. First match wins. arg null = out of range. */
// ponytail: digits only for numbers ("thirty" is Tier 2); no "1 hour 30 minutes"; add when the replay set needs it.
const PHRASES: ReadonlyArray<readonly [Verb, RegExp, ArgFn?]> = [
  ['pause', /^pause(?: (?:the )?music| it)?$/],
  ['resume', /^(?:resume|unpause)(?: (?:the )?music| playing| it)?$/],
  ['next', /^(?:next(?: song| track)?|skip(?: this song| this track| song)?)$/],
  ['previous', /^(?:previous(?: song| track)?|go back a (?:song|track))$/],
  ['stop', /^stop(?: (?:the )?music| playing)?$/],
  ['mute', /^mute(?: it| the sound)?$/],
  ['unmute', /^unmute(?: it| the sound)?$/],
  ['volume', /^(?:turn (?:the )?)?volume (up|down)$|^turn (up|down) the volume$/, (m) => m[1] ?? m[2]],
  ['volume', /^(?:set )?(?:the )?volume (?:to )?(\d{1,3})(?: percent)?$/, (m) => ((m[1] ?? '') === '' ? null : num(m[1], 100) ?? (m[1] === '0' ? 0 : null))],
  ['timer', /^(?:set )?(?:a )?timer for (\d{1,5}) (second|minute|hour)s?$/, (m) => { const n = num(m[1], 86400); return n === null ? null : n * (UNIT_SECONDS[m[2]!] ?? 0) <= 86400 ? n * (UNIT_SECONDS[m[2]!] ?? 0) : null; }],
];
const KNOWN_VERBS = new Set<string>(['open', 'play', 'pause', 'resume', 'unpause', 'next', 'skip', 'previous', 'volume', 'mute', 'unmute', 'timer', 'stop', 'set', 'turn']);

/** Resolve entity text against the owner lists: exactly one exact entry, or a Tier 2 reason. */
function resolve(text: string, lists: OwnerLists, kinds: ReadonlyArray<'app' | 'site'>): Entity | Classification {
  const pool: Entity[] = [];
  if (kinds.includes('app')) for (const name of lists.apps) pool.push({ kind: 'app', name });
  if (kinds.includes('site')) for (const name of Object.keys(lists.sites)) pool.push({ kind: 'site', name });
  const t = applyVariants(text);
  const exact = new Map<string, Entity>();
  for (const e of pool) if (plainWords(e.name) === t) exact.set(`${e.kind}:${e.name}`, e);
  if (exact.size === 1) return [...exact.values()][0]!;
  if (exact.size > 1) return no('ambiguous_entity');
  // ponytail: edit distance 1 (2 for names of 8+ letters); a near match only ever yields a hint.
  const near = pool.find((e) => { const n = plainWords(e.name); const max = n.length >= 8 ? 2 : 1; return n.length >= 4 && levenshtein(t, n, max) <= max; });
  return near ? no('fuzzy_only', near.name) : no('unknown_entity');
}
const isEntity = (r: Entity | Classification): r is Entity => 'kind' in r;

function parsePlay(s: string, lists: OwnerLists): Classification {
  if (s === 'play') return { tier: 1, verb: 'play', normalized: s };
  const t = ` ${s.slice(5)}`; // leading space so " on " also finds a leading "on"
  if (t.split(' ').some((w) => SECOND_VERBS.has(w))) return no('compound');
  const i = t.lastIndexOf(' on ');
  const query = (i < 0 ? t : t.slice(0, i)).trim();
  if (!query) return no('empty_payload');
  if (VAGUE_FIRST.has(query.split(' ')[0]!)) return no('vague_query');
  // ponytail: a title with "on" in it and no site ("dancing on my own") is Tier 2; we cannot tell it from "x on spotify".
  const site = i < 0 ? resolve(lists.defaultMedia ? plainWords(lists.defaultMedia) : '', lists, ['site']) : resolve(t.slice(i + 4).trim(), lists, ['site']);
  if (!isEntity(site)) return site;
  return { tier: 1, verb: 'play', entity: site, arg: query, normalized: `play ${query} on ${plainWords(site.name)}` };
}

export function classify(text: string, lists: OwnerLists): Classification {
  let s = plainWords(String(text));
  while (POLITE.test(s)) s = s.replace(POLITE, '');
  if (!s) return no('empty');
  const first = s.split(' ')[0]!;

  if (first === 'remember' || first === 'forget') {
    // The payload comes from the ORIGINAL input, untouched: no lower-casing, no variant table.
    const m = /^\s*(?:(?:please|can you|could you)[\s,]+)*(?:remember|forget)(?![\p{L}\p{N}'])[\s,:]*([\s\S]*)$/iu.exec(String(text));
    const payload = m?.[1]?.trim() ?? '';
    if (!m) return no('leftover_words');
    const words = plainWords(payload);
    if (!words || (first === 'forget' && FORGET_NOT_A_QUERY.has(words))) return no('empty_payload');
    if (splitRememberTail(words)) return no('compound'); // the memory router splits "remember x and play y"
    if (!words.includes(' ') && /\d/.test(words)) return no('code_like'); // the memory router refuses one-word codes
    return { tier: 1, verb: first, arg: payload, normalized: first }; // normalized omits the payload on purpose
  }

  if (String(text).includes('?') || QUESTION_WORDS.has(first)) return no('question');
  const words = s.split(' ');
  if (words.some((w) => JOINERS.has(w)) || /[,;.]\s*\S/.test(String(text).trim())) return no('compound');

  if (first === 'play') return parsePlay(s, lists);
  if (first === 'open') {
    if (words.length === 1) return no('unknown_entity');
    const e = resolve(s.slice(5), lists, ['app', 'site']);
    return isEntity(e) ? { tier: 1, verb: 'open', entity: e, normalized: `open ${applyVariants(s.slice(5))}` } : e;
  }
  for (const [verb, re, arg] of PHRASES) {
    const m = re.exec(s);
    if (!m) continue;
    const a = arg?.(m);
    if (a === null) return no('bad_arg');
    return a === undefined ? { tier: 1, verb, normalized: s } : { tier: 1, verb, arg: a, normalized: s };
  }
  return no(KNOWN_VERBS.has(first) ? 'leftover_words' : 'no_verb');
}
