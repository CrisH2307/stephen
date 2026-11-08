import { describe, expect, it } from 'vitest';
import { buildNameList, correctNames } from '../../src/voice/names.js';

describe('buildNameList', () => {
  it('takes capitalised words from memory items, skips common words and wake words, dedupes', () => {
    const list = buildNameList(['My advisor is Dr. Okafor', 'Okafor likes Stephen to call Priya', 'Remember to buy milk']);
    expect(list).toEqual(['Okafor', 'Priya']);
  });
  it('keeps course names whole', () => {
    expect(buildNameList([], ['CSCI 2020U'])).toEqual(['CSCI 2020U']);
  });
  it('ignores the first word of each item (R9-1)', () => {
    expect(buildNameList(['Call mom on Sundays', 'Gym is Fit4less near home', 'Coffee with Priya'])).toEqual(['Priya']);
  });
});

describe('correctNames', () => {
  const names = ['Okafor', 'Priya', 'Maren', 'Marin'];
  it('fixes a close misspelling', () => {
    expect(correctNames('email okafer about the quiz', names)).toBe('email Okafor about the quiz');
  });
  it('leaves exact and unrelated words alone', () => {
    expect(correctNames('open the Priya note and play music', names)).toBe('open the Priya note and play music');
  });
  it('leaves a word close to two names as heard', () => {
    expect(correctNames('call maran today', names)).toBe('call maran today');
  });
  it('leaves a weak match alone', () => {
    expect(correctNames('call priyonko', ['Priyanka'])).toBe('call priyonko');
  });
  it('matches multi-word course names', () => {
    expect(correctNames('when is csci 2020 u due', ['CSCI 2020U'])).toBe('when is CSCI 2020U due');
  });
  it('does nothing with an empty list', () => {
    expect(correctNames('hello there', [])).toBe('hello there');
  });

  // R9-1: the review's exact probes (memory: Mike, Jake, Dave, Gmail, Paige, Call, Sundays, Gym, Coffee).
  const memory = buildNameList(['My roommate is Mike', 'My brother Jake lives in Toronto', 'My friend Dave', 'I check my email in Gmail', 'My sister is Paige', 'Call mom on Sundays', 'Gym is Fit4less near home', 'Coffee with Priya']);
  it.each([
    'make a timer for ten minutes',
    'play songs I like',
    'take a screenshot',
    'I have a meeting at noon',
    'save this page',
    'check my email',
    'scroll down the page',
    'play fall out boy',
    'set a timer to call back',
  ])('never changes ordinary commands: %s', (cmd) => {
    expect(correctNames(cmd, memory)).toBe(cmd);
  });
  it('still fixes a real name next to ordinary words', () => {
    expect(correctNames('email okafer about the page', [...memory, 'Okafor'])).toBe('email Okafor about the page');
  });
});
