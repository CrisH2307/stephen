/**
 * `memory.graph` for the Memory page (UI-PLAN v3.1 section 7a): one node per saved item and per waiting proposal
 * (`new`), a kind from fixed keyword rules, and links between items that share a content word. No model call, so the
 * same memory always draws the same graph.
 */
import { contentWords, memoryWords } from '../memory/intent.js';
import type { MemoryProposal } from '../memory/proposals.js';
import type { MemoryItem } from '../memory/store.js';

export const MEMORY_KINDS = ['people', 'school', 'places', 'habits', 'projects', 'other'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface GraphNode {
  id: string;
  text: string;
  kind: MemoryKind;
  /** A proposal, not yet kept. */
  new: boolean;
}
export interface MemoryGraph {
  nodes: GraphNode[];
  links: { a: string; b: string }[];
}

// First match wins, in this order: "my mom's gym" is about a person, "the gym every morning" is a habit.
const RULES: [Exclude<MemoryKind, 'other'>, RegExp][] = [
  ['people', /\b(?:mom|mum|dad|mother|father|brother|sister|wife|husband|girlfriend|boyfriend|partner|friend|roommate|cousin|aunt|uncle|grandma|grandpa|son|daughter|boss|manager|teammate|prof|professor|dr|doctor|birthday|named|called)\b/],
  ['school', /\b(?:school|university|college|class|course|lab|exam|midterm|final|assignment|homework|quiz|lecture|tutorial|semester|term|study|studying|grade|canvas)\b|\b[a-z]{3,4} ?\d{4}\b/],
  ['projects', /\b(?:project|projects|building|repo|app|startup|hackathon|internship|thesis|portfolio|side project|working on)\b/],
  ['habits', /\b(?:every|usually|always|often|daily|weekly|weekdays|weekends|prefer|like|likes|love|hate|favorite|favourite|morning|night|wake|sleep|coffee|tea|vegetarian|vegan|allergic)\b/],
  ['places', /\b(?:live|lives|living|moved|move|gym|apartment|address|city|street|office|home|near|neighbourhood|neighborhood)\b/],
];

export function memoryKind(text: string): MemoryKind {
  const w = memoryWords(text);
  return RULES.find(([, re]) => re.test(w))?.[0] ?? 'other';
}

/** Words that link two items: content words of 4+ letters ("sofe", "3980", "fit4less"), so "lab" or "gym" alone don't. */
const linkWords = (text: string) => new Set([...contentWords(text)].filter((w) => w.length >= 4));

export function memoryGraph(items: readonly MemoryItem[], proposals: readonly MemoryProposal[]): MemoryGraph {
  const nodes: GraphNode[] = [
    ...items.map((i) => ({ id: i.id, text: i.text, kind: memoryKind(i.text), new: false })),
    ...proposals.map((p) => ({ id: p.id, text: p.text, kind: memoryKind(p.text), new: true })),
  ];
  const words = nodes.map((n) => linkWords(n.text));
  const links: MemoryGraph['links'] = [];
  // ponytail: O(n²) over at most 30 items + 20 proposals.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if ([...words[i]!].some((w) => words[j]!.has(w))) links.push({ a: nodes[i]!.id, b: nodes[j]!.id });
    }
  }
  return { nodes, links };
}
