/** src/app/memory-graph.ts: memory.graph from saved items and proposals, by fixed rules (no model call). */
import { describe, expect, it } from 'vitest';
import { memoryGraph, memoryKind } from '../../src/app/memory-graph.js';
import type { MemoryItem } from '../../src/memory/store.js';
import type { MemoryProposal } from '../../src/memory/proposals.js';

const at = '2026-11-03T12:00:00.000Z';
const item = (id: string, text: string): MemoryItem => ({ id, text, source: 'app', createdAt: at, updatedAt: at });

describe('memory kinds', () => {
  it.each([
    ['my mom is called Lan', 'people'],
    ["Sam's birthday is in May", 'people'],
    ['my prof for sofe 3980 is dr patel', 'people'],
    ['Lab 4 for SOFE 3980 is due Friday', 'school'],
    ['I study at Ontario Tech', 'school'],
    ['I am building Stephen, a voice assistant app', 'projects'],
    ['I go to the gym every morning', 'habits'],
    ['I prefer tea over coffee', 'habits'],
    ['I moved to Oshawa', 'places'],
    ['my gym is Fit4Less', 'places'],
    ['I play guitar', 'other'],
  ])('%s → %s', (text, kind) => {
    expect(memoryKind(text)).toBe(kind);
  });
});

describe('memoryGraph', () => {
  it('one node per item and proposal; proposals are new; links join items sharing a word', () => {
    const items = [item('m1', 'Lab 4 for SOFE 3980 is due Friday'), item('m2', 'my prof for sofe 3980 is dr patel'), item('m3', 'I play guitar')];
    const proposals: MemoryProposal[] = [{ id: 'p1', text: 'I play guitar at church', origin: 'you', untrusted: false, createdAt: at }];
    const g = memoryGraph(items, proposals);
    expect(g.nodes).toEqual([
      { id: 'm1', text: items[0]!.text, kind: 'school', new: false },
      { id: 'm2', text: items[1]!.text, kind: 'people', new: false },
      { id: 'm3', text: 'I play guitar', kind: 'other', new: false },
      { id: 'p1', text: 'I play guitar at church', kind: 'other', new: true },
    ]);
    expect(g.links).toEqual([
      { a: 'm1', b: 'm2' },
      { a: 'm3', b: 'p1' },
    ]);
  });

  it('empty in, empty out; deterministic', () => {
    expect(memoryGraph([], [])).toEqual({ nodes: [], links: [] });
    const items = [item('m1', 'my gym is Fit4Less'), item('m2', 'I go to Fit4Less every morning')];
    expect(memoryGraph(items, [])).toEqual(memoryGraph(items, []));
    expect(memoryGraph(items, []).links).toEqual([{ a: 'm1', b: 'm2' }]);
  });
});
