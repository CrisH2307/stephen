import { describe, expect, it } from 'vitest';
import { classify } from '../../../src/voice/grammar/classify.js';
import { BUILTIN_DEFAULT_MEDIA, BUILTIN_SITES, builtinLists } from '../../../src/voice/grammar/sites.js';

const lists = builtinLists(['Safari', 'Notion']);

describe('built-in site list (R10b-6)', () => {
  it('the default media site is one of the sites', () => {
    expect(Object.keys(BUILTIN_SITES)).toContain(BUILTIN_DEFAULT_MEDIA);
  });

  it.each([
    ['open youtube', 'open', 'youtube'],
    ['open you tube', 'open', 'youtube'],
    ['open youtube music', 'open', 'youtube music'],
    ['play lofi on youtube', 'play', 'youtube'],
    ['play lofi', 'play', 'youtube music'],
  ])('%s is Tier 1', (text, verb, site) => {
    expect(classify(text, lists)).toMatchObject({ tier: 1, verb, entity: { kind: 'site', name: site } });
  });

  it('with no site list the same commands are Tier 2 (what the listener passed before)', () => {
    expect(classify('open youtube', { apps: ['Safari'], sites: {} })).toMatchObject({ tier: 2, reason: 'unknown_entity' });
  });

  it.each(['open my email and read it', 'what is playing', 'play something relaxing', 'open youtub', 'play lofi on spotify'])('%s stays Tier 2', (text) => {
    expect(classify(text, lists).tier).toBe(2);
  });

  it('apps still resolve next to the sites', () => {
    expect(classify('open safari', lists)).toMatchObject({ tier: 1, entity: { kind: 'app', name: 'Safari' } });
  });
});
