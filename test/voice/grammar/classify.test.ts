import { describe, expect, it } from 'vitest';
import { classify, type Classification, type OwnerLists } from '../../../src/voice/grammar/classify.js';

const lists: OwnerLists = {
  apps: ['Spotify', 'Notion', 'Notes', 'Google Chrome', 'Discord', 'Zoom'],
  sites: { youtube: 'https://youtube.com', 'youtube music': 'https://music.youtube.com', gmail: 'https://mail.google.com', canvas: 'https://canvas.example.edu' },
  defaultMedia: 'youtube music',
};
const noDefault: OwnerLists = { ...lists, defaultMedia: undefined };

const t2 = (reason: string) => expect.objectContaining({ tier: 2, reason });
const t1 = (o: object) => expect.objectContaining({ tier: 1, ...o });

describe('verb happy paths', () => {
  const cases: Array<[string, OwnerLists, object]> = [
    ['open spotify', lists, { verb: 'open', entity: { kind: 'app', name: 'Spotify' } }],
    ['Open YouTube.', lists, { verb: 'open', entity: { kind: 'site', name: 'youtube' } }],
    ['please open google chrome', lists, { verb: 'open', entity: { kind: 'app', name: 'Google Chrome' } }],
    ['could you open notion', lists, { verb: 'open', entity: { kind: 'app', name: 'Notion' } }],
    ['play', lists, { verb: 'play' }],
    ['play say so on youtube', lists, { verb: 'play', arg: 'say so', entity: { kind: 'site', name: 'youtube' } }],
    ['play lofi hip hop radio', lists, { verb: 'play', arg: 'lofi hip hop radio', entity: { kind: 'site', name: 'youtube music' } }],
    ['pause', lists, { verb: 'pause' }],
    ['pause the music', lists, { verb: 'pause' }],
    ['resume', lists, { verb: 'resume' }],
    ['next', lists, { verb: 'next' }],
    ['skip this song', lists, { verb: 'next' }],
    ['volume up', lists, { verb: 'volume', arg: 'up' }],
    ['turn the volume down', lists, { verb: 'volume', arg: 'down' }],
    ['set the volume to 30', lists, { verb: 'volume', arg: 30 }],
    ['volume 0', lists, { verb: 'volume', arg: 0 }],
    ['mute', lists, { verb: 'mute' }],
    ['unmute', lists, { verb: 'unmute' }],
    ['set a timer for 10 minutes', lists, { verb: 'timer', arg: 600 }],
    ['timer for 1 hour', lists, { verb: 'timer', arg: 3600 }],
    ['stop', lists, { verb: 'stop' }],
    ['remember my locker is 12', lists, { verb: 'remember', arg: 'my locker is 12' }],
    ['forget my locker', lists, { verb: 'forget', arg: 'my locker' }],
  ];
  it.each(cases)('%s', (say, l, want) => expect(classify(say, l)).toEqual(t1(want)));
});

describe('variant table (exact rewrites, entity text only)', () => {
  it.each([
    ['open you tube', 'youtube'],
    ['open you tube music', 'youtube music'],
    ['open youtube musics', 'youtube music'],
    ['open g mail', 'gmail'],
    ['play x on you tube music', 'youtube music'],
  ])('%s', (say, name) => expect(classify(say, lists)).toEqual(t1({ entity: { kind: 'site', name } })));

  it('never rewrites a play query', () => {
    expect(classify('play you tube lyrics', lists)).toEqual(t1({ arg: 'you tube lyrics' }));
  });
});

describe('over-correction guards', () => {
  it('a real word one edit from an app name is Tier 2 with a hint, never Tier 1', () => {
    expect(classify('open nodes', lists)).toEqual({ tier: 2, reason: 'fuzzy_only', hint: 'Notes' });
    expect(classify('open spotifi', lists)).toEqual({ tier: 2, reason: 'fuzzy_only', hint: 'Spotify' });
    expect(classify('play x on youtub', lists)).toEqual({ tier: 2, reason: 'fuzzy_only', hint: 'youtube' });
  });
  it('unknown names are Tier 2', () => {
    expect(classify('open photoshop', lists)).toEqual(t2('unknown_entity'));
    expect(classify('open', lists)).toEqual(t2('unknown_entity'));
  });
  it('a title with "on" and no listed site is Tier 2, not a guess', () => {
    expect(classify('play x on tidal', lists)).toEqual(t2('unknown_entity'));
    expect(classify('play dancing on my own', lists)).toEqual(t2('unknown_entity'));
  });
  it('play with no site and no default is Tier 2', () => {
    expect(classify('play lofi', noDefault)).toEqual(t2('unknown_entity'));
    expect(classify('play lofi', { ...lists, defaultMedia: 'missing' })).toEqual(t2('unknown_entity'));
  });
  it('vague play queries are Tier 2', () => {
    expect(classify('play something chill', lists)).toEqual(t2('vague_query'));
  });
  it('out-of-range args are Tier 2', () => {
    expect(classify('set the volume to 300', lists)).toEqual(t2('bad_arg'));
    expect(classify('set a timer for 0 minutes', lists)).toEqual(t2('bad_arg'));
    expect(classify('set a timer for 25 hours', lists)).toEqual(t2('bad_arg'));
  });
});

describe('leftover words, compound, question, ambiguous, empty', () => {
  it('leftover words', () => {
    expect(classify('pause the music right now', lists)).toEqual(t2('leftover_words'));
    expect(classify('open spotify please', lists)).toEqual(t2('unknown_entity'));
    expect(classify('set the volume to thirty', lists)).toEqual(t2('leftover_words'));
    expect(classify('banana', lists)).toEqual(t2('no_verb'));
  });
  it.each([
    'open notion and put on some lofi',
    'open youtube then play lofi',
    'open youtube, play lofi',
    'play lofi and then open notes',
    'play lofi open notes',
    'open youtube and spotify and notes',
    'can you open my email and read it',
  ])('compound: %s', (say) => expect(classify(say, lists)).toEqual(t2('compound')));
  it.each(["what's playing", 'what is playing?', 'open youtube?', 'how do i get to my gym', 'do i have class tomorrow'])('question: %s', (say) =>
    expect(classify(say, lists)).toEqual(t2('question')));
  it('an entity matching two list entries is ambiguous', () => {
    const l: OwnerLists = { apps: ['Canvas', 'Zoom'], sites: { canvas: 'https://x.example' } };
    expect(classify('open canvas', l)).toEqual(t2('ambiguous_entity'));
    expect(classify('open zoom', l)).toEqual(t1({ entity: { kind: 'app', name: 'Zoom' } }));
    expect(classify('open chrome', { apps: ['Chrome', 'chrome'], sites: {} })).toEqual(t2('ambiguous_entity'));
  });
  it('empty', () => {
    for (const s of ['', '   ', '...', 'please', 'can you']) expect(classify(s, lists)).toEqual(t2('empty'));
  });
});

describe('remember / forget payload', () => {
  it('is kept verbatim: odd capitals, punctuation, no variant table', () => {
    const r = classify("  Please REMEMBER:  My Prof is Dr. O'Neil (SOFE-3980) -- you tube!  ", lists);
    expect(r).toEqual({ tier: 1, verb: 'remember', arg: "My Prof is Dr. O'Neil (SOFE-3980) -- you tube!", normalized: 'remember' });
    expect(classify('Forget the YOU TUBE thing', lists)).toEqual(t1({ verb: 'forget', arg: 'the YOU TUBE thing' }));
  });
  it('a question mark or "and" inside the payload does not matter', () => {
    expect(classify('remember my bday is may 5 and i like salt and pepper', lists)).toEqual(t1({ verb: 'remember' }));
    expect(classify('remember why? because', lists)).toEqual(t1({ verb: 'remember' }));
  });
  it('edge cases go to Tier 2 like the memory router', () => {
    expect(classify('remember', lists)).toEqual(t2('empty_payload'));
    expect(classify('forget it', lists)).toEqual(t2('empty_payload'));
    expect(classify('remember 4417', lists)).toEqual(t2('code_like'));
    expect(classify('remember to buy milk and play lofi', lists)).toEqual(t2('compound'));
    expect(classify('remembering things', lists)).toEqual(t2('no_verb'));
  });
});

describe('purity', () => {
  it('same input, same output; lists are not mutated', () => {
    const before = JSON.stringify(lists);
    expect(classify('open spotify', lists)).toEqual(classify('open spotify', lists));
    expect(JSON.stringify(lists)).toBe(before);
  });
});

// Labelled set: [say, expected tier]. Tier 2 phrasings come from src/eval/cases.ts. The Tier 1 labels are what the
// owner means by a simple command, so a Tier 1 label this grammar misses is a (safe) miss, not an error.
const LABELLED: Array<[string, 1 | 2]> = [
  ['open youtube', 1], ['open spotify', 1], ['open notion', 1], ['open canvas', 1], ['open you tube music', 1],
  ['Open Discord.', 1], ['please open gmail', 1], ['open google chrome', 1], ['pause', 1], ['pause the music', 1],
  ['resume', 1], ['next', 1], ['skip this song', 1], ['volume up', 1], ['volume down', 1], ['set the volume to 30', 1],
  ['mute', 1], ['unmute', 1], ['set a timer for 10 minutes', 1], ['stop', 1], ['remember i like jazz', 1],
  ['forget my locker number', 1], ['play one call away by charlie puth on youtube music', 1], ['play lofi hip hop radio', 1],
  ['open my gmail', 1], ['hey can you like open notion for me real quick', 1], ['turn it down a bit', 1],
  ['open notion and put on some lofi', 2], ['open my gmail and canvas', 2], ['play some jazz and then open my calendar', 2],
  ['open youtube and spotify and notes', 2], ['open canvas then play lofi hip hop radio', 2],
  ['open google docs and also open discord', 2], ['open google maps then play one call away', 2],
  ['um open youtube uh and play one call away', 2], ['can you give me the routes from my home to two stations', 2],
  ['how do i get from home to school', 2], ['directions to union station by car', 2], ['find coffee near my school', 2],
  ['play something chill', 2], ['put on some music to study', 2], ['open the site where i watch videos', 2],
  ['play the new taylor swift song', 2], ['play my kind of music', 2],
  ['check my canvas assignments and write a summary in a google doc', 2], ['message my friend on discord that i will be late', 2],
  ["what's due on canvas this week", 2], ['do i have any homework due', 2], ["what's on my calendar today", 2],
  ['any email from my prof', 2], ['morning briefing', 2], ['remind me to study for my midterm', 2],
  ['set the volume to thirty and play some lofi', 2], ['turn it down and play the next song', 2], ['delete all my emails', 2],
  ['keep in mind that i like jazz', 2], ['buy the cheapest flight to vancouver', 2],
  ['open bbc news and read me the top headline', 2], ['open hacker news, click the top story and tell me what it is about', 2],
  ["what's playing", 2], ['can you open my email and read it', 2], ['open nodes', 2], ['read me the email from dr patel', 2],
];
const results = LABELLED.map(([say, label]) => ({ say, label, got: classify(say, lists) as Classification }));
const wrongFast = results.filter((r) => r.label === 2 && r.got.tier === 1);
const missed = results.filter((r) => r.label === 1 && r.got.tier === 2);

describe(`labelled set (n=${LABELLED.length}, Tier 1 labels missed=${missed.length})`, () => {
  it('has at least 40 commands', () => expect(LABELLED.length).toBeGreaterThanOrEqual(40));
  it('ZERO Tier 2 commands are classified Tier 1', () => expect(wrongFast.map((r) => r.say)).toEqual([]));
  it('missed Tier 1 labels stay small and are reported', () => {
    console.log(`labelled n=${LABELLED.length}, wrongly fast=${wrongFast.length}, Tier 1 missed=${missed.length}: ${missed.map((r) => r.say).join(' | ')}`);
    expect(missed.length).toBeLessThanOrEqual(5);
  });
});
