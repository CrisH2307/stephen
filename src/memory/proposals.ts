/**
 * Memory proposals: `<home>/memory-proposals.json` (UI-PLAN v3.1 section 7a; threat model in
 * docs/SYSTEM-DESIGN-STEPHEN.md, "Memory proposals").
 *
 * A proposal is NOT memory. It is never sent to Claude and never read into a chat; it only waits on the Memory page
 * until the owner presses Keep (src/app/server.ts memory.keep, which saves it through MemoryStore.add) or Skip.
 * Nothing Claude can reach imports src/memory (test/memory/boundary.test.ts), so the model can't propose, keep or
 * skip by itself.
 *
 * Rules:
 *  - Text goes through checkMemoryText (cleaned, one line, 200 characters at most, secret-looking text refused), the
 *    same rule as memory itself, so a planted "my password is …" is refused before it is even stored.
 *  - At most MAX_PROPOSALS; the oldest is dropped when a new one comes in. Same text twice → the existing one.
 *  - Every proposal says where it came from (`origin`). email, canvas and web are third-party text: `untrusted`.
 *  - Written atomically, 0600 (src/lib/fs.ts). A broken file reads as empty.
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFileSync } from '../lib/fs.js';
import { MEMORY_MESSAGES, PROPOSAL_ORIGINS, checkMemoryText, type ProposalOrigin } from './store.js';

export { PROPOSAL_ORIGINS, type ProposalOrigin };

export const PROPOSALS_FILE = 'memory-proposals.json';
export const MAX_PROPOSALS = 20;

export function isUntrustedOrigin(o: ProposalOrigin): boolean {
  return o === 'email' || o === 'canvas' || o === 'web';
}

export interface MemoryProposal {
  /** "p3" */
  id: string;
  text: string;
  origin: ProposalOrigin;
  untrusted: boolean;
  createdAt: string;
}

type Stored = Omit<MemoryProposal, 'untrusted'>;
interface ProposalsFile {
  version: 1;
  nextId: number;
  items: Stored[];
}

export type ProposeResult =
  | { ok: true; proposal: MemoryProposal }
  | { ok: false; reason: 'empty' | 'too-long' | 'secret'; message: string };

const ID_RE = /^p[1-9]\d{0,8}$/;

export function isProposalId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

const withTrust = (p: Stored): MemoryProposal => ({ ...p, untrusted: isUntrustedOrigin(p.origin) });

// ponytail: no lock file; only `stephen listen` (app.sock) writes this file. Add the MemoryStore lock if a second writer appears.
export class ProposalStore {
  readonly path: string;
  private readonly now: () => Date;

  constructor(o: { home: string; now?: () => Date }) {
    this.path = join(o.home, PROPOSALS_FILE);
    this.now = o.now ?? (() => new Date());
  }

  /** Waiting proposals, newest first. */
  list(): MemoryProposal[] {
    return this.read().items.map(withTrust).reverse();
  }

  get(id: string): MemoryProposal | null {
    const p = isProposalId(id) ? this.read().items.find((i) => i.id === id) : undefined;
    return p ? withTrust(p) : null;
  }

  propose(text: string, origin: ProposalOrigin): ProposeResult {
    const c = checkMemoryText(text);
    if (!('text' in c)) return { ok: false, reason: c.reason, message: MEMORY_MESSAGES[c.reason] };
    const f = this.read();
    const same = f.items.find((i) => i.text.toLowerCase() === c.text.toLowerCase());
    if (same) return { ok: true, proposal: withTrust(same) };
    const p: Stored = { id: `p${f.nextId}`, text: c.text, origin, createdAt: this.now().toISOString() };
    f.nextId += 1;
    f.items = [...f.items, p].slice(-MAX_PROPOSALS);
    writePrivateJsonFileSync(this.path, f);
    return { ok: true, proposal: withTrust(p) };
  }

  /** Remove one (kept or skipped). False when it is not waiting. */
  remove(id: string): boolean {
    const f = this.read();
    const items = f.items.filter((i) => i.id !== id);
    if (items.length === f.items.length) return false;
    writePrivateJsonFileSync(this.path, { ...f, items });
    return true;
  }

  private read(): ProposalsFile {
    const r = readPrivateJsonFile(this.path);
    const raw = 'state' in r ? (r.state as Partial<ProposalsFile> | null) : null;
    const items: Stored[] = [];
    let maxN = 0;
    for (const it of Array.isArray(raw?.items) ? raw.items : []) {
      const o = (it ?? {}) as Record<string, unknown>;
      if (!isProposalId(o.id) || items.some((i) => i.id === o.id)) continue;
      if (!PROPOSAL_ORIGINS.includes(o.origin as ProposalOrigin) || typeof o.createdAt !== 'string' || Number.isNaN(Date.parse(o.createdAt))) continue;
      const c = checkMemoryText(String(o.text ?? ''));
      if (!('text' in c)) continue;
      maxN = Math.max(maxN, Number(o.id.slice(1)));
      items.push({ id: o.id, text: c.text, origin: o.origin as ProposalOrigin, createdAt: o.createdAt });
    }
    const n = raw?.nextId;
    const nextId = typeof n === 'number' && Number.isInteger(n) && n > maxN && n < 1e9 ? n : maxN + 1;
    return { version: 1, nextId, items: items.slice(-MAX_PROPOSALS) };
  }
}
