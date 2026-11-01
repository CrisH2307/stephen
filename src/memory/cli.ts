/** `stephen memory list | add "<text>" | forget <id> | clear` (docs/PLAN-1.9-MEMORY-DASHBOARD.md section 10). */
import { createInterface } from 'node:readline';
import { loadConfig } from '../config.js';
import { AuditLog } from '../safety/audit.js';
import { parseMemoryConfig } from './config.js';
import { MemoryStore, MemoryStoreError, type MemoryItem } from './store.js';

export const MEMORY_USAGE = `stephen memory — what you asked Stephen to remember (sent to Claude with every voice command)

  stephen memory list             show every saved item
  stephen memory add "<text>"     save one short fact (at most 200 characters; no passwords, codes or numbers)
  stephen memory forget <id>      forget one item (ids are shown by list, e.g. m3)
  stephen memory clear            forget everything (asks first)

By voice: "remember my gym is GoodLife", "forget my gym", "what do you remember".`;

export interface MemoryCliEnv {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Ask a question, resolve with the answer line (default: read a line from the terminal). */
  prompt?: (question: string) => Promise<string>;
  /** Build the store (default: from loadConfig(): home, memory.maxItems, the audit log). */
  store?: () => MemoryStore;
}

/** Read one line from stdin after writing `question` to stderr. */
export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    let answered = false;
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      resolve(a);
    });
    rl.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

function defaultStore(): MemoryStore {
  const cfg = loadConfig();
  const mem = parseMemoryConfig(cfg.memory);
  return new MemoryStore({ home: cfg.home, maxItems: mem.maxItems, audit: new AuditLog({ path: cfg.auditLogPath }) });
}

function line(i: MemoryItem): string {
  return `${i.id.padEnd(4)} ${i.text}   (${i.source}, ${i.createdAt.slice(0, 10)})`;
}

export async function runMemoryCli(argv: string[], env: MemoryCliEnv = {}): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const err = env.err ?? ((l: string) => console.error(l));
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    (sub ? out : err)(MEMORY_USAGE);
    return sub ? 0 : 2;
  }
  const usage = (msg: string) => {
    err(`${msg}\n\n${MEMORY_USAGE}`);
    return 2;
  };
  if (sub !== 'list' && sub !== 'add' && sub !== 'forget' && sub !== 'clear') return usage(`Unknown memory command "${sub}".`);
  if ((sub === 'list' || sub === 'clear') && rest.length) return usage(`"stephen memory ${sub}" takes no arguments.`);
  if (sub === 'forget' && rest.length !== 1) return usage('Usage: stephen memory forget <id>   (see "stephen memory list" for ids)');
  if (sub === 'add' && !rest.join(' ').trim()) return usage('Usage: stephen memory add "<text>"');

  let store: MemoryStore;
  try {
    store = (env.store ?? defaultStore)();
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  try {
    if (sub === 'list') {
      const items = await store.list();
      if (!items.length) {
        out('Nothing saved. Add something with: stephen memory add "<text>"  (or say "remember …")');
        return 0;
      }
      for (const i of items) out(line(i));
      out(`${items.length} of ${store.maxItems}.`);
      return 0;
    }
    if (sub === 'add') {
      const r = await store.add(rest.join(' '), 'cli');
      if (!r.ok) {
        err(r.message);
        return 1;
      }
      out(r.duplicate ? `Already saved as ${r.item!.id}: ${r.item!.text}` : `Saved ${r.item!.id}: ${r.item!.text}`);
      return 0;
    }
    if (sub === 'forget') {
      const r = await store.forget(rest[0]!);
      if (!r.ok) {
        err(r.reason === 'not-found' ? `No memory "${rest[0]}". See "stephen memory list" for ids.` : r.message);
        return 1;
      }
      out(`Forgot ${r.item!.id}: ${r.item!.text}`);
      return 0;
    }
    // clear
    const items = await store.list();
    if (!items.length) {
      out('Nothing to forget.');
      return 0;
    }
    const answer = await (env.prompt ?? promptLine)(`Forget all ${items.length} saved ${items.length === 1 ? 'item' : 'items'}? [y/N] `);
    if (!/^\s*y(?:es)?\s*$/i.test(answer)) {
      out('Kept everything.');
      return 1;
    }
    const r = await store.clear();
    if (!r.ok) {
      err(r.message);
      return 1;
    }
    out('Forgot everything.');
    return 0;
  } catch (e) {
    if (e instanceof MemoryStoreError) {
      err(`Can't read memory: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
