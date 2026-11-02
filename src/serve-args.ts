/**
 * `serve --confirm dialog|deny`: force how confirmations are asked for this server process. Only these two
 * values are accepted, so the flag can make confirmation stricter but never skip it. The voice listener
 * starts the server with `--confirm dialog`: headless `claude -p` has no one watching the chat, so an
 * in-chat (elicitation) prompt would go unanswered — the macOS dialog is the human channel.
 *
 * `serve --voice`: the voice listener's server — also registers the `announce` tool (speak a short line before
 * playing sound). It takes no value and grants nothing beyond that tool.
 *
 * `serve --session-state <file>`: the voice listener's follow-up conversations. The gate's private reads and
 * approved hosts are loaded from and saved to this file, so they last exactly as long as Claude's conversation
 * (src/safety/session-state.ts). Only an absolute path directly inside `<stephen home>/voice/` is accepted
 * (checked with lstat/realpath; see checkSessionStatePath). The flag can only ADD remembered taint, never remove it.
 *
 * `serve --tool-log <file>`: append `{tool,isError,ms}` for every tool call to <file> (never arguments or results), so
 * the listener can show tool names in the history (src/server/tool-log.ts). Same path rule as --session-state, but
 * a `.jsonl` file (see checkToolLogPath). It records only; it changes no tool's behaviour.
 *
 * `serve --instance <id>`: the voice listener's Claude process (docs/REVIEW-7.md R7-1). `<id>` is 32 hex characters, a
 * fresh random one per Claude process. The first serve of an id takes `<home>/run/serve-<id>.lock`; a serve that finds
 * that lock already taken is a restart by Claude Code and refuses every tool call (src/server/instance.ts). The id is
 * a name, not a path, so the flag can only switch tools off.
 *
 * `serve --assume-private-read`: the gate starts as if private data had already been read (phase 2a), so the
 * cross-site egress rules apply from the first action. Takes no value; it can only make the gate stricter.
 *
 * `serve --dry-run --record <file>`: `stephen eval` only. The same tools, but every call is appended to <file> and
 * answered with a fake result — nothing acts (src/eval/dry-server.ts). Both flags are required together, and no
 * other flag may be combined with them, so a dry-run server can never be mistaken for, or mixed into, a real one.
 * `--fake-page <file>` (absolute path) only goes with --dry-run: the page-reading tools answer with that file's text
 * (the prompt-injection eval cases).
 */
import { isAbsolute } from 'node:path';
import { checkSessionStatePath } from './safety/session-state.js';
import { SERVE_INSTANCE_RE } from './server/instance.js';
import { checkToolLogPath } from './server/tool-log.js';

export interface ServeArgs {
  confirm?: 'dialog' | 'deny';
  voice?: true;
  /** --assume-private-read: taint armed from the start. */
  assumePrivateRead?: true;
  sessionState?: string;
  /** --tool-log <file>: absolute path directly inside <home>/voice/. */
  toolLog?: string;
  /** --instance <id>: 32 hex characters (one serve per id; a second one refuses every call). */
  instance?: string;
  /** --dry-run --record <file>: absolute path of the call log; --fake-page <file>: what the pages "say". */
  dryRun?: { record: string; fakePage?: string };
}

export interface ServeArgsContext {
  /** Stephen's home (loadConfig().home); required for --session-state, --tool-log and --instance. */
  home?: string;
}

export function parseServeArgs(argv: string[], ctx: ServeArgsContext = {}): ServeArgs | { error: string } {
  const out: ServeArgs = {};
  let dry = false;
  let record: string | undefined;
  let fakePage: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a === '--confirm' ? argv[++i] : a.startsWith('--confirm=') ? a.slice('--confirm='.length) : undefined;
    if (a === '--confirm' || a.startsWith('--confirm=')) {
      if (v !== 'dialog' && v !== 'deny') return { error: '--confirm must be "dialog" or "deny"' };
      out.confirm = v;
    } else if (a === '--voice') out.voice = true;
    else if (a.startsWith('--voice=')) return { error: '--voice takes no value' };
    else if (a === '--assume-private-read') out.assumePrivateRead = true;
    else if (a.startsWith('--assume-private-read=')) return { error: '--assume-private-read takes no value' };
    else if (a === '--session-state' || a.startsWith('--session-state=')) {
      if (out.sessionState !== undefined) return { error: '--session-state given twice' };
      const p = a === '--session-state' ? argv[++i] : a.slice('--session-state='.length);
      if (p === undefined) return { error: '--session-state needs a file path' };
      if (!ctx.home) return { error: "--session-state: Stephen's home folder is unknown" };
      const r = checkSessionStatePath(p, ctx.home);
      if ('error' in r) return r;
      out.sessionState = r.path;
    } else if (a === '--tool-log' || a.startsWith('--tool-log=')) {
      if (out.toolLog !== undefined) return { error: '--tool-log given twice' };
      const p = a === '--tool-log' ? argv[++i] : a.slice('--tool-log='.length);
      if (p === undefined) return { error: '--tool-log needs a file path' };
      if (!ctx.home) return { error: "--tool-log: Stephen's home folder is unknown" };
      const r = checkToolLogPath(p, ctx.home);
      if ('error' in r) return r;
      out.toolLog = r.path;
    } else if (a === '--instance' || a.startsWith('--instance=')) {
      if (out.instance !== undefined) return { error: '--instance given twice' };
      const id = a === '--instance' ? argv[++i] : a.slice('--instance='.length);
      if (id === undefined || !SERVE_INSTANCE_RE.test(id)) return { error: '--instance needs 32 lowercase hex characters' };
      if (!ctx.home) return { error: "--instance: Stephen's home folder is unknown" };
      out.instance = id;
    } else if (a === '--dry-run') {
      if (dry) return { error: '--dry-run given twice' };
      dry = true;
    } else if (a === '--record' || a.startsWith('--record=')) {
      if (record !== undefined) return { error: '--record given twice' };
      const p = a === '--record' ? argv[++i] : a.slice('--record='.length);
      if (!p || !isAbsolute(p)) return { error: '--record needs an absolute file path' };
      record = p;
    } else if (a === '--fake-page' || a.startsWith('--fake-page=')) {
      if (fakePage !== undefined) return { error: '--fake-page given twice' };
      const p = a === '--fake-page' ? argv[++i] : a.slice('--fake-page='.length);
      if (!p || !isAbsolute(p)) return { error: '--fake-page needs an absolute file path' };
      fakePage = p;
    } else return { error: `Unknown option "${a}" for serve.` };
  }
  if (fakePage !== undefined && !dry) return { error: '--fake-page only goes with --dry-run' };
  if (dry || record !== undefined) {
    if (!dry || record === undefined) return { error: '--dry-run and --record <file> go together' };
    if (out.confirm || out.voice || out.sessionState || out.toolLog || out.assumePrivateRead || out.instance) return { error: '--dry-run cannot be combined with other serve options' };
    out.dryRun = { record, ...(fakePage !== undefined ? { fakePage } : {}) };
  }
  return out;
}
