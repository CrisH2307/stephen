/**
 * `serve --confirm dialog|deny`: force how confirmations are asked for this server process. Only these two
 * values are accepted, so the flag can make confirmation stricter but never skip it. The voice listener
 * starts the server with `--confirm dialog`: headless `claude -p` has no one watching the chat, so an
 * in-chat (elicitation) prompt would go unanswered — the macOS dialog is the human channel.
 *
 * `serve --voice`: the voice listener's server — also registers the `announce` tool (speak a short line before
 * playing sound). It takes no value and grants nothing beyond that tool.
 */
export interface ServeArgs {
  confirm?: 'dialog' | 'deny';
  voice?: true;
}

export function parseServeArgs(argv: string[]): ServeArgs | { error: string } {
  const out: ServeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a === '--confirm' ? argv[++i] : a.startsWith('--confirm=') ? a.slice('--confirm='.length) : undefined;
    if (a === '--confirm' || a.startsWith('--confirm=')) {
      if (v !== 'dialog' && v !== 'deny') return { error: '--confirm must be "dialog" or "deny"' };
      out.confirm = v;
    } else if (a === '--voice') out.voice = true;
    else if (a.startsWith('--voice=')) return { error: '--voice takes no value' };
    else return { error: `Unknown option "${a}" for serve.` };
  }
  return out;
}
