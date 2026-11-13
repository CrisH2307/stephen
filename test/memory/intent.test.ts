/** src/memory/intent.ts: anchored memory commands, the 12.3 split, rawTail, matchForget. */
import { describe, expect, it } from 'vitest';
import { COMMAND_VERBS, matchForget, newestWithin, parseMemoryIntent, rawTail, splitRememberTail, type MemoryIntent } from '../../src/memory/intent.js';

const TABLE: Array<[string, MemoryIntent | null]> = [
  // remember
  ['remember my gym is goodlife', { kind: 'remember', text: 'my gym is goodlife' }],
  ['remember that my prof for sofe 3980 is dr patel', { kind: 'remember', text: 'my prof for sofe 3980 is dr patel' }],
  ['please remember i like lofi and r&b', { kind: 'remember', text: 'i like lofi and r b' }],
  ['Remember: my sister is Anna.', { kind: 'remember', text: 'my sister is anna' }],
  ['remember my gym is goodlife please', { kind: 'remember', text: 'my gym is goodlife' }],
  ['remember i play guitar', { kind: 'remember', text: 'i play guitar' }],
  ['remember i play guitar and sing', { kind: 'remember', text: 'i play guitar and sing' }],
  ['remember my cat is tom and my dog is rex', { kind: 'remember', text: 'my cat is tom and my dog is rex' }],
  // 12.3 split
  ['remember my gym is goodlife and play lofi', { kind: 'remember', text: 'my gym is goodlife', rest: 'play lofi' }],
  ['remember my gym is goodlife and play some lofi', { kind: 'remember', text: 'my gym is goodlife', rest: 'play some lofi' }],
  ['remember that my prof is dr patel then open canvas', { kind: 'remember', text: 'my prof is dr patel', rest: 'open canvas' }],
  ['remember my locker is downstairs and then open youtube', { kind: 'remember', text: 'my locker is downstairs', rest: 'open youtube' }],
  ['remember i like jazz and also turn the volume up', { kind: 'remember', text: 'i like jazz', rest: 'turn the volume up' }],
  ['remember i play guitar and open mic is friday', { kind: 'remember', text: 'i play guitar', rest: 'open mic is friday' }], // known misplit (12.3)
  // forget
  ['forget my prof', { kind: 'forget', query: 'my prof' }],
  ['forget about my gym', { kind: 'forget', query: 'my gym' }],
  ['forget that my gym is goodlife', { kind: 'forget', query: 'my gym is goodlife' }],
  ['stop remembering my gym', { kind: 'forget', query: 'my gym' }],
  ['delete the memory about my prof', { kind: 'forget', query: 'my prof' }],
  ['please forget my sister please', { kind: 'forget', query: 'my sister' }],
  ['forget that', { kind: 'forget-last' }],
  ['forget the last one', { kind: 'forget-last' }],
  ['forget everything', { kind: 'forget-all' }],
  ['forget all my memories', { kind: 'forget-all' }],
  ['clear my memories', { kind: 'forget-all' }],
  // list
  ['what do you remember', { kind: 'list' }],
  ['What do you remember?', { kind: 'list' }],
  ['what do you remember about me', { kind: 'list' }],
  ['what do you know about me', { kind: 'list' }],
  ['list my memories', { kind: 'list' }],
  // not memory commands (go to Claude)
  ['play remember me', null],
  ['play remember me by thomas rhett', null],
  ['do you remember the song from the lion king', null],
  ['do you remember what i said', null],
  ['remind me to call mom', null],
  ['remember to call mom', null],
  ['remember when we went to tokyo', null],
  ['remember me', null],
  ['remember that', null],
  ['remember that one', null],
  ['remember goodlife and play lofi', null], // one-word fact: the whole line goes to Claude
  ['forget it', null],
  ['forget about it', null],
  ['oh forget it', null],
  ['never mind forget it', null],
  ["don't forget to call mom", null],
  ['forget to call mom', null],
  ['i forgot my password', null],
  ['open the remember the milk app', null],
  ['what do you remember about the war of 1812', null],
  ['search youtube for remember the name', null],
  ['play forget you', null],
  ['', null],
];

const SAVES: Array<[string, string]> = [
  ["hey steven remember my locker is 12 west", "my locker is 12 west"],
  ["hey stephen, remember my cat is tom", "my cat is tom"],
  ["Stephen remember my cat is tom.", "my cat is tom"],
  ["ok stephen please remember my desk is by the window", "my desk is by the window"],
  ["Please remember that my bike is blue.", "my bike is blue"],
  ["remember me that my bike is blue", "my bike is blue"],
  ["remember this: my bike is blue", "this my bike is blue"],
  ["Remember, my bike is blue", "my bike is blue"],
  ["also remember my bike is blue", "my bike is blue"],
  ["remember my bike is blue for me", "my bike is blue"],
  ["remember my bike is blue thanks", "my bike is blue"],
  ["can you remember that my bike is blue", "my bike is blue"],
  ["could you please remember my bike is blue", "my bike is blue"],
  ["would you remember i like green tea", "i like green tea"],
  ["will you remember that the code word is banana", "the code word is banana"],
  ["i want you to remember my bike is blue", "my bike is blue"],
  ["i need you to remember that the shed is open", "the shed is open"],
  ["i'd like you to remember we meet on fridays", "we meet on fridays"],
  ["don't forget that my bike is blue", "my bike is blue"],
  ["dont forget my bike is blue", "my bike is blue"],
  ["do not forget that the shed is open", "the shed is open"],
  ["note that my bike is blue", "my bike is blue"],
  ["make a note that my bike is blue", "my bike is blue"],
  ["take note that the shed is open", "the shed is open"],
  ["keep in mind that my bike is blue", "my bike is blue"],
  ["keep in mind i like green tea", "i like green tea"],
  ["Hey Steven, could you remember that my bike is blue.", "my bike is blue"],
  ["REMEMBER MY BIKE IS BLUE", "my bike is blue"],
  ["remember that i walk to school", "i walk to school"],
  ["yo stephen remember that my bike is blue and play lofi", "my bike is blue"],
  ["okay remember my bike is blue", "my bike is blue"],
  ["please can you remember that i like green tea", "i like green tea"],
];
const NOT_SAVES: string[] = [
  "do you remember my bike",
  "do you remember that my bike is blue",
  "what do you remember about my bike",
  "remember when we rode the bikes?",
  "remember my bike is blue?",
  "can you remember the song from the movie",
  "could you remember what i said",
  "i don't remember where my bike is",
  "i can't remember my bike lock code",
  "don't forget to lock the bike",
  "don't forget the milk",
  "do not forget about it",
  "note the time",
  "keep in mind the weather",
  "please remember to call mom",
  "remember what i said",
  "remember if i locked it",
  "hey stephen remember me",
  "play the song remember the name",
  "open the note that i saved",
  "search for note that song lyrics",
  "turn on remember the milk",
  "can you remember",
  "note that",
  "i want you to remember",
  "stephen don't forget to call mom",
];

describe('natural remember phrasings', () => {
  it.each(SAVES)('saves %j', (cmd, text) => {
    const i = parseMemoryIntent(cmd);
    expect(i?.kind).toBe('remember');
    if (i?.kind === 'remember') expect(i.text).toBe(text);
  });
  it.each(NOT_SAVES)('does not save %j', (cmd) => {
    expect(parseMemoryIntent(cmd)?.kind).not.toBe('remember');
  });
});

describe('parseMemoryIntent', () => {
  it.each(TABLE)('%j', (cmd, want) => {
    expect(parseMemoryIntent(cmd)).toEqual(want);
  });

  it('the split needs a verb from the fixed list right after the joiner', () => {
    expect(COMMAND_VERBS).toEqual(['play', 'open', 'put', 'turn', 'set', 'pause', 'skip', 'start', 'launch', 'show', 'find', 'check', 'go', 'search', 'mute']);
    expect(splitRememberTail('my gym is goodlife and play lofi')).toEqual({ text: 'my gym is goodlife', rest: 'play lofi' });
    expect(splitRememberTail('i like tea and coffee')).toBeNull();
    expect(splitRememberTail('i like tea then coffee')).toBeNull();
    expect(splitRememberTail('i like tea and')).toBeNull();
    expect(splitRememberTail('and play lofi')).toBeNull(); // never at the very start
    // the FIRST joiner followed by a verb wins
    expect(splitRememberTail('a b and c then open x and play y')).toEqual({ text: 'a b and c', rest: 'open x and play y' });
  });
});

describe('rawTail', () => {
  it('recovers the original-case words for the normalized remainder', () => {
    expect(rawTail('Hey Stephen, remember my prof is Dr. Patel.', 'my prof is dr patel')).toBe('my prof is Dr. Patel');
    expect(rawTail('remember that my gym is GoodLife on King St!', 'my gym is goodlife on king st')).toBe('my gym is GoodLife on King St');
    expect(rawTail("Remember I don't eat pork", "i don't eat pork")).toBe("I don't eat pork");
  });

  it('works for both halves of a split line (and keeps URLs in typed text)', () => {
    const raw = 'Remember my gym is GoodLife and open https://www.goodlifefitness.com/clubs';
    const i = parseMemoryIntent(raw);
    expect(i).toEqual({ kind: 'remember', text: 'my gym is goodlife', rest: 'open https www goodlifefitness com clubs' });
    if (i?.kind !== 'remember') throw new Error('expected remember');
    expect(rawTail(raw, i.text)).toBe('my gym is GoodLife');
    expect(rawTail(raw, i.rest!)).toBe('open https://www.goodlifefitness.com/clubs');
  });

  it('takes the last matching run, and falls back to the normalized words', () => {
    expect(rawTail('My gym. Remember my gym', 'my gym')).toBe('my gym');
    expect(rawTail('something else entirely', 'my prof is dr patel')).toBe('my prof is dr patel');
    expect(rawTail('remember x', '')).toBe('');
  });
});

describe('matchForget', () => {
  const items = [
    { id: 'm1', text: 'My prof for SOFE 3980 is Dr. Patel' },
    { id: 'm2', text: 'my gym is GoodLife on King St' },
    { id: 'm3', text: 'my prof for ENGR 5510 is Dr. Singh' },
    { id: 'm4', text: "my sister's name is Anna" },
  ];

  it('one clear match by content words (stopwords ignored)', () => {
    expect(matchForget(items, 'my gym')).toEqual({ match: items[1] });
    expect(matchForget(items, 'about goodlife')).toEqual({ match: items[1] });
    expect(matchForget(items, 'my prof dr patel')).toEqual({ match: items[0] });
    expect(matchForget(items, 'my sister')).toEqual({ match: items[3] }); // "sister's" ~ "sister"
    expect(matchForget(items, 'my sisters name')).toEqual({ match: items[3] });
  });

  it('a tie lists the candidates; no overlap is none', () => {
    expect(matchForget(items, 'my prof')).toEqual({ tie: [items[0], items[2]] });
    expect(matchForget(items, 'my dentist')).toEqual({ none: true });
    expect(matchForget(items, 'the')).toEqual({ none: true });
    expect(matchForget([], 'gym')).toEqual({ none: true });
  });
});

describe('newestWithin', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  it('returns the newest item only if saved within 10 minutes', () => {
    const a = { id: 'm1', createdAt: '2026-11-01T11:00:00Z' };
    const b = { id: 'm2', createdAt: '2026-11-01T11:55:00Z' };
    expect(newestWithin([b, a], now)).toBe(b);
    expect(newestWithin([a], now)).toBeNull();
    expect(newestWithin([], now)).toBeNull();
  });
  it('two items saved in the same millisecond: the later-saved (higher id) wins, in any list order', () => {
    const same = '2026-11-01T11:59:00.000Z';
    const earlier = { id: 'm4', createdAt: same };
    const later = { id: 'm5', createdAt: same };
    expect(newestWithin([earlier, later], now)).toBe(later);
    expect(newestWithin([later, earlier], now)).toBe(later);
  });
});
