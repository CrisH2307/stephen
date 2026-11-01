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
 * `serve --dry-run --record <file>`: `stephen eval` only. The same tools, but every call is appended to <file> and
 * answered with a fake result — nothing acts (src/eval/dry-server.ts). Both flags are required together, and no
 * other flag may be combined with them, so a dry-run server can never be mistaken for, or mixed into, a real one.
 */
import { isAbsolute } from 'node:path';
import { checkSessionStatePath } from './safety/session-state.js';

export interface ServeArgs {
  confirm?: 'dialog' | 'deny';
  voice?: true;
  sessionState?: string;
  /** --dry-run --record <file>: absolute path of the call log. */
  dryRun?: { record: string };
}

export interface ServeArgsContext {
  /** Stephen's home (loadConfig().home); required for --session-state. */
  home?: string;
}

export function parseServeArgs(argv: string[], ctx: ServeArgsContext = {}): ServeArgs | { error: string } {
  const out: ServeArgs = {};
  let dry = false;
  let record: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a === '--confirm' ? argv[++i] : a.startsWith('--confirm=') ? a.slice('--confirm='.length) : undefined;
    if (a === '--confirm' || a.startsWith('--confirm=')) {
      if (v !== 'dialog' && v !== 'deny') return { error: '--confirm must be "dialog" or "deny"' };
      out.confirm = v;
    } else if (a === '--voice') out.voice = true;
    else if (a.startsWith('--voice=')) return { error: '--voice takes no value' };
    else if (a === '--session-state' || a.startsWith('--session-state=')) {
      if (out.sessionState !== undefined) return { error: '--session-state given twice' };
      const p = a === '--session-state' ? argv[++i] : a.slice('--session-state='.length);
      if (p === undefined) return { error: '--session-state needs a file path' };
      if (!ctx.home) return { error: "--session-state: Stephen's home folder is unknown" };
      const r = checkSessionStatePath(p, ctx.home);
      if ('error' in r) return r;
      out.sessionState = r.path;
    } else if (a === '--dry-run') {
      if (dry) return { error: '--dry-run given twice' };
      dry = true;
    } else if (a === '--record' || a.startsWith('--record=')) {
      if (record !== undefined) return { error: '--record given twice' };
      const p = a === '--record' ? argv[++i] : a.slice('--record='.length);
      if (!p || !isAbsolute(p)) return { error: '--record needs an absolute file path' };
      record = p;
    } else return { error: `Unknown option "${a}" for serve.` };
  }
  if (dry || record !== undefined) {
    if (!dry || record === undefined) return { error: '--dry-run and --record <file> go together' };
    if (out.confirm || out.voice || out.sessionState) return { error: '--dry-run cannot be combined with other serve options' };
    out.dryRun = { record };
  }
  return out;
}
