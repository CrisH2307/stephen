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
});

describe('correctNames', () => {
  const names = ['Okafor', 'Priya', 'Maren', 'Marin'];
  it('fixes a close misspelling', () => {
    expect(correctNames('email okafer about the quiz', names)).toEqual({ text: 'email Okafor about the quiz', unsure: [] });
  });
  it('leaves exact and unrelated words alone', () => {
    expect(correctNames('open the Priya note and play music', names).text).toBe('open the Priya note and play music');
  });
  it('is unsure when a word is close to two entries', () => {
    const r = correctNames('call maran today', names);
    expect(r.text).toBe('call maran today');
    expect(r.unsure).toEqual([['Maren', 'Marin']]);
  });
  it('is unsure when only a weak match', () => {
    expect(correctNames('call priyonko', ['Priyanka']).unsure).toEqual([['Priyanka']]);
  });
  it('matches multi-word course names', () => {
    expect(correctNames('when is csci 2020 u due', ['CSCI 2020U']).text).toBe('when is CSCI 2020U due');
  });
  it('does nothing with an empty list', () => {
    expect(correctNames('hello there', [])).toEqual({ text: 'hello there', unsure: [] });
  });
});
