/** `stephen history [--limit N] | clear`: show or delete the local command history (see store.ts). */
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { Conversation } from '../voice/conversation.js';
import { claudeTranscriptDir, purgeTranscripts } from '../voice/transcripts.js';
import { clean } from '../safety/text.js';
import { parseHistoryConfig } from './config.js';
import { DEFAULT_LIST_LIMIT, HistoryStore, MAX_LIST_LIMIT, localDate, type HistoryEntry } from './store.js';

export const HISTORY_HELP = `stephen history: your recent Stephen commands (kept only on this Mac, never sent to Claude)

  stephen history [--limit N]   newest first (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT})
  stephen history clear         delete all history

Kept for history.retentionDays days in config.json (default 1, 0 to 30; 0 = off).`;

export type HistoryArgs = { cmd: 'list'; limit: number } | { cmd: 'clear' };

export function parseHistoryArgs(argv: string[]): HistoryArgs | { error: string } | 'help' {
  if (argv[0] === 'clear') {
    if (argv.length > 1) return { error: `Unknown option "${argv[1]}" for history clear.` };
    return { cmd: 'clear' };
  }
  let limit = DEFAULT_LIST_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--limit' || a.startsWith('--limit=')) {
      const v = Number(a === '--limit' ? argv[++i] : a.slice('--limit='.length));
      if (!Number.isInteger(v) || v < 1 || v > MAX_LIST_LIMIT) return { error: `--limit must be 1 to ${MAX_LIST_LIMIT}` };
      limit = v;
    } else return { error: `Unknown option "${a}" for history.` };
  }
  return { cmd: 'list', limit };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * One entry as terminal text. Said / reply / tool names are cleaned (control, bidi and escape characters become
 * spaces), since a reply can quote page text and must not drive the terminal.
 */
export function formatEntry(e: HistoryEntry): string {
  const d = new Date(e.ts);
  const when = `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const tools = e.tools.length ? `\n    tools: ${e.tools.map((t) => clean(t.tool, 64) + (t.isError ? ' (error)' : '')).join(', ')}` : '';
  const reply = e.reply ? `\n    ${clean(e.reply, 300)}` : '';
  return `${when}  ${e.source}  ${e.outcome}${e.followUp ? '  follow-up' : ''}\n  > ${clean(e.said, 200)}${reply}${tools}`;
}

export interface HistoryEnv {
  store?: HistoryStore;
  out?: (l: string) => void;
  err?: (l: string) => void;
}

export async function runHistoryCli(argv: string[], e: HistoryEnv = {}): Promise<number> {
  const out = e.out ?? ((l: string) => console.log(l));
  const err = e.err ?? ((l: string) => console.error(l));
  const a = parseHistoryArgs(argv);
  if (a === 'help') {
    out(HISTORY_HELP);
    return 0;
  }
  if ('error' in a) {
    err(`${a.error}\n\n${HISTORY_HELP}`);
    return 2;
  }
  let store = e.store;
  if (!store) {
    const cfg = loadConfig();
    store = new HistoryStore({ home: cfg.home, retentionDays: parseHistoryConfig(cfg.history).retentionDays });
  }
  if (a.cmd === 'clear') {
    // Also Claude Code's own transcripts of voice sessions (review 5, R5-1); the follow-up conversation ends too,
    // so a running listener starts fresh instead of resuming a deleted session.
    if (!e.store) {
      const home = loadConfig().home;
      const voiceDir = join(home, 'voice');
      new Conversation({ dir: voiceDir, windowSec: 0 }).end();
      purgeTranscripts(claudeTranscriptDir(join(voiceDir, 'workdir')), null);
    }
    const n = store.clear();
    out(n ? `Deleted ${n} day${n === 1 ? '' : 's'} of history.` : 'No history to delete.');
    return 0;
  }
  store.purge(); // expired entries go now, even with history off (review 5, R5-6)
  if (!store.enabled) {
    out('History is off (history.retentionDays is 0 in config.json).');
    return 0;
  }
  const entries = store.list({ limit: a.limit });
  if (!entries.length) {
    out('No history yet.');
    return 0;
  }
  out(entries.map(formatEntry).join('\n\n'));
  return 0;
}
